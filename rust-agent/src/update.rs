//! Daily self-update from GitHub releases. The new binary is verified against the
//! release's SHA-256 file, swapped in atomically, then the process exits so systemd
//! restarts it (Restart=always).

use sha2::{Digest, Sha256};
use std::io::Write;
use std::time::Duration;

const MAX_BINARY: u64 = 64 << 20;

fn asset_name() -> String {
    format!("hlm-agent-linux-{}", std::env::consts::ARCH)
}

fn get(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .https_only(true)
        .build()
        .into();
    agent
        .get(url)
        .header("User-Agent", concat!("hlm-agent/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_vec()
        .map_err(|e| e.to_string())
}

/// Returns Ok(true) when a new binary was installed.
pub fn check(repo: &str) -> Result<bool, String> {
    if crate::VERSION == "dev" {
        return Ok(false);
    }
    let body = get(&format!("https://api.github.com/repos/{repo}/releases/latest"), 1 << 20)?;
    let rel: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let tag = rel["tag_name"].as_str().ok_or("release without tag")?;
    if tag == crate::VERSION {
        return Ok(false);
    }
    let name = asset_name();
    let url_of = |n: &str| {
        rel["assets"].as_array()?.iter().find(|a| a["name"] == n)?["browser_download_url"]
            .as_str()
            .map(String::from)
    };
    let bin_url = url_of(&name).ok_or("no binary for this architecture")?;
    let sum_url = url_of(&format!("{name}.sha256")).ok_or("no checksum published")?;
    // Only follow links that stay on GitHub.
    for u in [&bin_url, &sum_url] {
        if !u.starts_with(&format!("https://github.com/{repo}/releases/download/")) {
            return Err(format!("unexpected download URL {u}"));
        }
    }
    let sum = String::from_utf8(get(&sum_url, 4096)?).map_err(|e| e.to_string())?;
    let want = sum.split_whitespace().next().ok_or("empty checksum file")?.to_lowercase();
    let bin = get(&bin_url, MAX_BINARY)?;
    let got: String = Sha256::digest(&bin).iter().map(|b| format!("{b:02x}")).collect();
    if got != want {
        return Err("checksum mismatch, update refused".into());
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let tmp = exe.with_extension("new");
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(&tmp)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.write_all(&bin).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &exe).map_err(|e| format!("replace binary: {e}"))?;
    eprintln!("hlm-agent: updated {} -> {tag}", crate::VERSION);
    Ok(true)
}
