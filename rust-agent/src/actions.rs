//! Actions requested from the dashboard.
//!
//! The agent is unprivileged, so apt actions go through a root-owned helper: the agent writes
//! "refresh" or "upgrade" to APT_REQUEST, hlm-agent-apt.path starts apt-action.sh as root, which
//! only accepts those two words, runs apt and reports in APT_STATUS. The agent never runs
//! anything as root itself.

use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

const APT_HELPER: &str = "/usr/local/lib/hlm-agent/apt-action.sh";
const DOCKER_HELPER: &str = "/usr/local/lib/hlm-agent/docker-helper.sh";

/// Where a root helper reports: (status file, log file).
pub const APT_OUTPUT: (&str, &str) = ("/var/lib/hlm-agent/apt/status.json", "/var/lib/hlm-agent/apt/log");
pub const DOCKER_OUTPUT: (&str, &str) = ("/var/lib/hlm-agent/docker/update-status.json", "/var/lib/hlm-agent/docker/update-log");

fn state_file(name: &str) -> String {
    std::env::var("STATE_DIRECTORY").unwrap_or_else(|_| "/var/lib/hlm-agent/state".into()) + "/" + name
}

fn drop_request(file: &str, content: &str) -> Result<(), String> {
    let path = state_file(file);
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, content).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("{path}: {e}"))
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Asks the root helper to run `apt-get update` (refresh) or update + upgrade (upgrade).
pub fn request_apt(kind: &str) -> Result<(), String> {
    if !std::path::Path::new(APT_HELPER).exists() {
        return Err("Mises à jour à distance non installées sur cette machine (relancez install.sh, sans REMOTE_UPDATES=false)".into());
    }
    drop_request("apt-request", kind)
}

/// Asks the root helper to pull and recreate one Docker Compose container.
pub fn request_container_update(name: &str) -> Result<(), String> {
    if !std::path::Path::new(DOCKER_HELPER).exists() {
        return Err("Gestion Docker non installée sur cette machine (relancez install.sh)".into());
    }
    if name.is_empty() || name.len() > 200 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
        return Err("Nom de conteneur invalide".into());
    }
    drop_request("docker-request", name)
}

/// Result of a root helper's last action, once finished after `since`: (ok, message).
pub fn helper_result((status, log): (&str, &str), since: u64) -> Option<(bool, String)> {
    let st: Value = serde_json::from_slice(&std::fs::read(status).ok()?).ok()?;
    if st["state"] == "running" || st["finished_at"].as_u64()? < since {
        return None;
    }
    let ok = st["state"] == "done";
    let log = std::fs::read_to_string(log).unwrap_or_default();
    // The tail of apt's output is what explains a failure (or summarises the upgrade).
    let tail: String = log.lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    Some((ok, tail))
}
