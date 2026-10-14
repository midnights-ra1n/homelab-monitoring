//! Pending system updates on Debian, read without privileges: `apt-get -s` only simulates
//! from the package lists that apt-daily.timer refreshes, and writes nothing.

use serde::Serialize;
use std::process::Command;
use std::time::UNIX_EPOCH;

// Wire format shared with server/hosts.go (agentUpdates / agentPackage).
#[derive(Serialize, Debug, PartialEq)]
pub struct Package {
    name: String,
    current: String,
    candidate: String,
    security: bool,
}

#[derive(Serialize)]
pub struct Updates {
    manager: &'static str,
    packages: Vec<Package>,
    reboot_required: bool,
    lists_updated_at: u64,
}

/// None when apt is not available (non-Debian host): nothing is reported.
pub fn check() -> Option<Updates> {
    let out = Command::new("apt-get")
        .args([
            "-s", "-q", "-o", "Debug::NoLocking=1",
            // Never try to write the binary caches (the service filesystem is read-only).
            "-o", "Dir::Cache::pkgcache=", "-o", "Dir::Cache::srcpkgcache=",
            "dist-upgrade",
        ])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !out.status.success() {
        eprintln!("hlm-agent: apt-get -s failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        return None;
    }
    let lists_updated_at = std::fs::metadata("/var/lib/apt/lists")
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    Some(Updates {
        manager: "apt",
        packages: parse(&String::from_utf8_lossy(&out.stdout)),
        reboot_required: std::path::Path::new("/run/reboot-required").exists(),
        lists_updated_at,
    })
}

/// Parses lines like `Inst libssl3 [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])`.
fn parse(out: &str) -> Vec<Package> {
    out.lines()
        .filter_map(|l| {
            let rest = l.strip_prefix("Inst ")?;
            let (name, rest) = rest.split_once(' ')?;
            let (current, rest) = match rest.strip_prefix('[') {
                Some(r) => r.split_once("] ")?,
                None => ("", rest), // new package pulled in by an upgrade
            };
            let inner = rest.strip_prefix('(')?;
            let (candidate, origin) = inner.split_once(' ').unwrap_or((inner.trim_end_matches(')'), ""));
            Some(Package {
                name: name.to_string(),
                current: current.to_string(),
                candidate: candidate.to_string(),
                security: origin.to_lowercase().contains("security"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_apt_simulation() {
        let out = "Reading package lists...\n\
            Inst libssl3 [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])\n\
            Inst tzdata [2024a-0+deb12u1] (2024b-0+deb12u1 Debian:12.7/stable [all])\n\
            Inst linux-image-6.1.0-26-amd64 (6.1.112-1 Debian:12.7/stable [amd64])\n\
            Conf libssl3 (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])\n";
        let p = parse(out);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0], Package { name: "libssl3".into(), current: "3.0.11-1~deb12u1".into(), candidate: "3.0.11-1~deb12u2".into(), security: true });
        assert!(!p[1].security);
        assert_eq!(p[2].current, "");
        assert_eq!(p[2].candidate, "6.1.112-1");
    }
}
