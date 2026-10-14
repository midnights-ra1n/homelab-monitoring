//! Actions requested from the dashboard.
//!
//! The agent is unprivileged, so apt actions go through a root-owned helper: the agent writes
//! "refresh" or "upgrade" to APT_REQUEST, hlm-agent-apt.path starts apt-action.sh as root, which
//! only accepts those two words, runs apt and reports in APT_STATUS. The agent never runs
//! anything as root itself.

use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

const APT_HELPER: &str = "/usr/local/lib/hlm-agent/apt-action.sh";
const APT_STATUS: &str = "/var/lib/hlm-agent/apt/status.json";
const APT_LOG: &str = "/var/lib/hlm-agent/apt/log";

fn request_path() -> String {
    std::env::var("STATE_DIRECTORY").unwrap_or_else(|_| "/var/lib/hlm-agent/state".into()) + "/apt-request"
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Asks the root helper to run `apt-get update` (refresh) or update + upgrade (upgrade).
pub fn request_apt(kind: &str) -> Result<(), String> {
    if !std::path::Path::new(APT_HELPER).exists() {
        return Err("Mises à jour à distance non installées sur cette machine (relancez install.sh, sans REMOTE_UPDATES=false)".into());
    }
    let path = request_path();
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, kind).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("{path}: {e}"))
}

/// Result of the last apt action, once finished after `since`: (ok, message).
pub fn apt_result(since: u64) -> Option<(bool, String)> {
    let st: Value = serde_json::from_slice(&std::fs::read(APT_STATUS).ok()?).ok()?;
    if st["state"] == "running" || st["finished_at"].as_u64()? < since {
        return None;
    }
    let ok = st["state"] == "done";
    let log = std::fs::read_to_string(APT_LOG).unwrap_or_default();
    // The tail of apt's output is what explains a failure (or summarises the upgrade).
    let tail: String = log.lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    Some((ok, tail))
}
