//! Docker containers. The agent never touches the Docker socket (root-equivalent): the
//! root-owned docker-helper.sh writes a snapshot every minute, the agent reads it here.
//! Image updates are checked by the agent itself, unprivileged, by comparing the local
//! image digest with the registry's (a HEAD request on the manifest: nothing is pulled).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, UNIX_EPOCH};

const SNAPSHOT: &str = "/var/lib/hlm-agent/docker/snapshot";

// Wire format shared with server/docker.go (dockerContainer). Keep both in sync.
#[derive(Serialize, Clone, Debug, Default)]
pub struct Container {
    id: String,
    name: String,
    image: String,
    state: String,
    health: String,
    started_at: String,
    restart_count: u64,
    cpu_pct: Option<f64>,
    mem_used: Option<f64>,
    mem_limit: Option<f64>,
    net_rx: Option<f64>,
    net_tx: Option<f64>,
    compose_project: String,
    compose_service: String,
    /// up_to_date, available, unknown (registry unreachable or private), local (built here), pinned (by digest)
    update: String,
    #[serde(skip)]
    repo_digests: Vec<String>,
}

#[derive(Serialize)]
pub struct Snapshot {
    containers: Vec<Container>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    pub collected_at: u64,
}

/// Parses docker's human sizes: "12.5MiB", "1.2kB", "0B".
fn parse_size(s: &str) -> Option<f64> {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: f64 = num.trim().parse().ok()?;
    let mult = match unit.trim() {
        "" | "B" => 1.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        "KiB" => 1024.0,
        "MiB" => 1024f64.powi(2),
        "GiB" => 1024f64.powi(3),
        "TiB" => 1024f64.powi(4),
        _ => return None,
    };
    Some(n * mult)
}

/// "used / total" pairs from docker stats.
fn pair(s: &str) -> (Option<f64>, Option<f64>) {
    match s.split_once('/') {
        Some((a, b)) => (parse_size(a), parse_size(b)),
        None => (None, None),
    }
}

/// Reads the root helper's snapshot; None when Docker is absent (no helper output).
pub fn read_snapshot() -> Option<Snapshot> {
    let collected_at = std::fs::metadata(SNAPSHOT).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let read_json = |f: &str| std::fs::read(format!("{SNAPSHOT}/{f}")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let error = std::fs::read_to_string(format!("{SNAPSHOT}/error")).ok().map(|e| e.trim().to_string()).filter(|e| !e.is_empty());

    let digests: HashMap<String, Vec<String>> = read_json("images.json")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|i| {
            let d = i["RepoDigests"].as_array()?.iter().filter_map(|x| x.as_str().map(String::from)).collect();
            Some((i["Id"].as_str()?.to_string(), d))
        })
        .collect();
    let stats: HashMap<String, Value> = std::fs::read_to_string(format!("{SNAPSHOT}/stats.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| Some((v["ID"].as_str()?.to_string(), v)))
        .collect();

    let mut containers: Vec<Container> = read_json("inspect.json")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            let id = c["Id"].as_str()?.to_string();
            let labels = &c["Config"]["Labels"];
            let st = stats.get(&id).or_else(|| stats.get(&id[..12.min(id.len())]));
            let (mem_used, mem_limit) = st.map(|s| pair(s["MemUsage"].as_str().unwrap_or(""))).unwrap_or_default();
            let (net_rx, net_tx) = st.map(|s| pair(s["NetIO"].as_str().unwrap_or(""))).unwrap_or_default();
            Some(Container {
                name: c["Name"].as_str().unwrap_or("").trim_start_matches('/').to_string(),
                image: c["Config"]["Image"].as_str().unwrap_or("").to_string(),
                state: c["State"]["Status"].as_str().unwrap_or("").to_string(),
                health: c["State"]["Health"]["Status"].as_str().unwrap_or("").to_string(),
                started_at: c["State"]["StartedAt"].as_str().unwrap_or("").to_string(),
                restart_count: c["RestartCount"].as_u64().unwrap_or(0),
                cpu_pct: st.and_then(|s| s["CPUPerc"].as_str()?.trim_end_matches('%').parse().ok()),
                mem_used,
                mem_limit,
                net_rx,
                net_tx,
                compose_project: labels["com.docker.compose.project"].as_str().unwrap_or("").to_string(),
                compose_service: labels["com.docker.compose.service"].as_str().unwrap_or("").to_string(),
                update: "unknown".into(),
                repo_digests: c["Image"].as_str().and_then(|i| digests.get(i)).cloned().unwrap_or_default(),
                id: id.chars().take(12).collect(),
            })
        })
        .collect();
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    Some(Snapshot { containers, error, collected_at })
}

/* ---------- Registry checks ---------- */

#[derive(Debug, PartialEq)]
struct ImageRef {
    registry: String, // host to query
    repo: String,
    tag: String,
}

/// Splits "nginx", "user/app:1.2", "ghcr.io/o/r:tag", "localhost:5000/x" into registry/repo/tag.
/// Returns None for digest-pinned references ("x@sha256:…"), which cannot be outdated.
fn parse_ref(image: &str) -> Option<ImageRef> {
    if image.contains('@') {
        return None;
    }
    let (first, rest) = image.split_once('/').unwrap_or(("", image));
    let (registry, path) = if !first.is_empty() && (first.contains('.') || first.contains(':') || first == "localhost") {
        (first.to_string(), rest.to_string())
    } else {
        ("docker.io".to_string(), image.to_string())
    };
    let (repo, tag) = match path.rsplit_once(':') {
        Some((r, t)) if !t.contains('/') => (r.to_string(), t.to_string()),
        _ => (path.clone(), "latest".to_string()),
    };
    let (registry, repo) = if registry == "docker.io" {
        let repo = if repo.contains('/') { repo } else { format!("library/{repo}") };
        ("registry-1.docker.io".to_string(), repo)
    } else {
        (registry, repo)
    };
    Some(ImageRef { registry, repo, tag })
}

const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/// Parses `Bearer realm="…",service="…",scope="…"`.
fn bearer_params(h: &str) -> HashMap<String, String> {
    h.trim_start_matches("Bearer ")
        .split(',')
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            Some((k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        })
        .collect()
}

/// Digest of the manifest currently published for this reference (anonymous access only).
fn remote_digest(r: &ImageRef) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .https_only(r.registry != "localhost" && !r.registry.starts_with("localhost:"))
        .build()
        .into();
    let url = format!("https://{}/v2/{}/manifests/{}", r.registry, r.repo, r.tag);
    let head = |token: Option<&str>| {
        let mut req = agent.head(&url).header("Accept", MANIFEST_TYPES).header("User-Agent", concat!("hlm-agent/", env!("CARGO_PKG_VERSION")));
        if let Some(t) = token {
            req = req.header("Authorization", &format!("Bearer {t}"));
        }
        req.call().map_err(|e| e.to_string())
    };
    let mut resp = head(None)?;
    if resp.status() == 401 {
        let www = resp.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let p = bearer_params(&www);
        let realm = p.get("realm").ok_or("registry asks for credentials")?;
        let scope = p.get("scope").cloned().unwrap_or_else(|| format!("repository:{}:pull", r.repo));
        let mut tr = agent.get(realm).query("scope", &scope);
        if let Some(svc) = p.get("service") {
            tr = tr.query("service", svc);
        }
        let mut tresp = tr.call().map_err(|e| e.to_string())?;
        if tresp.status() != 200 {
            return Err(format!("token refused ({})", tresp.status()));
        }
        let body: Value = serde_json::from_slice(&tresp.body_mut().with_config().limit(1 << 16).read_to_vec().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let tok = body["token"].as_str().or(body["access_token"].as_str()).ok_or("no token")?.to_string();
        resp = head(Some(&tok))?;
    }
    if resp.status() != 200 {
        return Err(format!("registry answered {}", resp.status()));
    }
    resp.headers()
        .get("docker-content-digest")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or_else(|| "no digest header".into())
}

/// Update status of each image reference, cached between checks (refs are the cache keys).
pub type UpdateCache = HashMap<String, String>;

/// Checks every distinct image of the snapshot against its registry. Blocking: run in spawn_blocking.
pub fn check_updates(images: Vec<(String, Vec<String>)>) -> UpdateCache {
    let mut out = UpdateCache::new();
    for (image, local) in images {
        if out.contains_key(&image) {
            continue;
        }
        let status = match parse_ref(&image) {
            None => "pinned".to_string(),
            Some(_) if local.is_empty() => "local".to_string(),
            Some(r) => match remote_digest(&r) {
                // RepoDigests look like "nginx@sha256:…": compare the digest part.
                Ok(d) if local.iter().any(|l| l.rsplit_once('@').map(|x| x.1) == Some(d.as_str())) => "up_to_date".into(),
                Ok(_) => "available".into(),
                Err(e) => {
                    eprintln!("hlm-agent: image check {image}: {e}");
                    "unknown".into()
                }
            },
        };
        out.insert(image, status);
    }
    out
}

impl Snapshot {
    /// Distinct (image reference, local digests) pairs to check.
    pub fn images(&self) -> Vec<(String, Vec<String>)> {
        let mut seen = std::collections::HashSet::new();
        self.containers.iter().filter(|c| seen.insert(c.image.clone())).map(|c| (c.image.clone(), c.repo_digests.clone())).collect()
    }

    pub fn apply(&mut self, cache: &UpdateCache) {
        for c in &mut self.containers {
            if let Some(s) = cache.get(&c.image) {
                c.update = s.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sizes_and_pairs() {
        assert_eq!(parse_size("12.5MiB"), Some(12.5 * 1048576.0));
        assert_eq!(parse_size("1.2kB"), Some(1200.0));
        assert_eq!(parse_size("0B"), Some(0.0));
        assert_eq!(pair("1.5GiB / 7.6GiB").0, Some(1.5 * 1073741824.0));
        assert_eq!(parse_size("--"), None);
    }

    #[test]
    fn parses_image_references() {
        let r = |reg: &str, repo: &str, tag: &str| Some(ImageRef { registry: reg.into(), repo: repo.into(), tag: tag.into() });
        assert_eq!(parse_ref("nginx"), r("registry-1.docker.io", "library/nginx", "latest"));
        assert_eq!(parse_ref("louislam/uptime-kuma:1"), r("registry-1.docker.io", "louislam/uptime-kuma", "1"));
        assert_eq!(parse_ref("ghcr.io/home-assistant/home-assistant:stable"), r("ghcr.io", "home-assistant/home-assistant", "stable"));
        assert_eq!(parse_ref("localhost:5000/app"), r("localhost:5000", "app", "latest"));
        assert_eq!(parse_ref("redis@sha256:abc"), None);
    }

    #[test]
    fn parses_bearer_challenge() {
        let p = bearer_params(r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull""#);
        assert_eq!(p["realm"], "https://auth.docker.io/token");
        assert_eq!(p["scope"], "repository:library/nginx:pull");
    }

    /// Network test against public registries: cargo test -- --ignored live_registries
    #[test]
    #[ignore]
    fn live_registries() {
        for img in ["nginx:alpine", "louislam/uptime-kuma:1", "ghcr.io/home-assistant/home-assistant:stable"] {
            let d = remote_digest(&parse_ref(img).unwrap());
            println!("{img}: {d:?}");
            assert!(d.unwrap().starts_with("sha256:"));
        }
        let c = check_updates(vec![("nginx:alpine".into(), vec!["nginx@sha256:0000".into()])]);
        assert_eq!(c["nginx:alpine"], "available");
    }
}
