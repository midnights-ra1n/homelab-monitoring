//! SMART disk data. Reading SMART needs raw device access (root) while the agent runs
//! unprivileged, so the work is split:
//!   - smart-collect.sh, root-owned and run by hlm-agent-smart.timer without network, only
//!     calls smartctl and writes one JSON file per disk into SMART_DIR. It is deliberately
//!     not this binary: the agent can rewrite its own binary (self-update), and root must
//!     never execute a file the unprivileged user can modify.
//!   - the agent reads SMART_DIR, normalises the data and sends it to the hub, which
//!     computes the health verdict (server/smart.go).

use serde::Serialize;
use serde_json::Value;
use std::time::UNIX_EPOCH;

pub const SMART_DIR: &str = "/var/lib/hlm-agent/smart";

// Wire format shared with server/smart.go (smartDisk). Keep both in sync.
#[derive(Serialize, Default, Debug)]
pub struct Disk {
    name: String,
    model: String,
    serial: String,
    kind: &'static str,
    capacity_bytes: u64,
    smart_passed: Option<bool>,
    temperature_c: Option<f64>,
    power_on_hours: Option<f64>,
    power_cycles: Option<f64>,
    reallocated: Option<f64>,
    pending: Option<f64>,
    offline_uncorrectable: Option<f64>,
    reported_uncorrect: Option<f64>,
    crc_errors: Option<f64>,
    wear_used_pct: Option<f64>,
    available_spare_pct: Option<f64>,
    spare_threshold_pct: Option<f64>,
    media_errors: Option<f64>,
    critical_warning: Option<f64>,
    data_written_bytes: Option<f64>,
}

#[derive(Serialize)]
pub struct Report {
    disks: Vec<Disk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    pub collected_at: u64,
}

fn normalize(d: &Value) -> Option<Disk> {
    let name = d["device"]["name"].as_str()?.to_string();
    let attr = |id: u64| -> Option<&Value> {
        d["ata_smart_attributes"]["table"].as_array()?.iter().find(|a| a["id"].as_u64() == Some(id))
    };
    let raw = |id: u64| attr(id).and_then(|a| a["raw"]["value"].as_f64());
    let nvme = &d["nvme_smart_health_information_log"];
    let is_nvme = d["device"]["type"].as_str() == Some("nvme") || nvme.is_object();
    let kind = if is_nvme {
        "nvme"
    } else if d["rotation_rate"].as_u64() == Some(0) {
        "ssd"
    } else {
        "hdd"
    };
    // ATA SSD wear: vendors expose it as a normalised "life left" value starting at 100.
    let ata_wear = [231u64, 233, 177, 202, 169]
        .iter()
        .find_map(|id| attr(*id).and_then(|a| a["value"].as_f64()))
        .filter(|_| kind == "ssd")
        .map(|left| (100.0 - left).clamp(0.0, 100.0));
    Some(Disk {
        name,
        model: d["model_name"].as_str().or(d["scsi_model_name"].as_str()).unwrap_or("").to_string(),
        serial: d["serial_number"].as_str().unwrap_or("").to_string(),
        kind,
        capacity_bytes: d["user_capacity"]["bytes"].as_u64().or(d["nvme_total_capacity"].as_u64()).unwrap_or(0),
        smart_passed: d["smart_status"]["passed"].as_bool(),
        temperature_c: d["temperature"]["current"].as_f64(),
        power_on_hours: d["power_on_time"]["hours"].as_f64(),
        power_cycles: d["power_cycle_count"].as_f64(),
        reallocated: raw(5),
        pending: raw(197),
        offline_uncorrectable: raw(198),
        reported_uncorrect: raw(187),
        crc_errors: raw(199),
        wear_used_pct: nvme["percentage_used"].as_f64().or(ata_wear),
        available_spare_pct: nvme["available_spare"].as_f64(),
        spare_threshold_pct: nvme["available_spare_threshold"].as_f64(),
        media_errors: nvme["media_errors"].as_f64(),
        critical_warning: nvme["critical_warning"].as_f64(),
        data_written_bytes: nvme["data_units_written"]
            .as_f64()
            .map(|u| u * 512_000.0)
            .or(raw(241).map(|lbas| lbas * 512.0)),
    })
}

/// Reads the root collector's output; None when the timer never ran (not installed).
pub fn read_report() -> Option<Report> {
    let dir = std::fs::read_dir(SMART_DIR).ok()?;
    let collected_at = std::fs::metadata(SMART_DIR).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let mut disks = Vec::new();
    let mut error = None;
    for e in dir.flatten() {
        let path = e.path();
        if path.file_name().is_some_and(|n| n == "ERROR") {
            error = Some("smartctl introuvable : installez le paquet smartmontools".to_string());
        } else if path.extension().is_some_and(|x| x == "json") {
            let doc = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            disks.extend(doc.as_ref().and_then(normalize));
        }
    }
    disks.sort_by(|a, b| a.name.cmp(&b.name));
    Some(Report { disks, error, collected_at })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_ata_hdd_and_nvme() {
        let hdd = json!({
            "device": {"name": "/dev/sda", "type": "sat"}, "model_name": "WDC WD40EFRX", "serial_number": "WD-1",
            "rotation_rate": 5400, "user_capacity": {"bytes": 4000787030016u64}, "smart_status": {"passed": true},
            "temperature": {"current": 34}, "power_on_time": {"hours": 30000},
            "ata_smart_attributes": {"table": [
                {"id": 5, "value": 200, "raw": {"value": 8}},
                {"id": 197, "value": 200, "raw": {"value": 0}}
            ]}
        });
        let d = normalize(&hdd).unwrap();
        assert_eq!(d.kind, "hdd");
        assert_eq!(d.reallocated, Some(8.0));
        assert_eq!(d.pending, Some(0.0));
        assert_eq!(d.wear_used_pct, None, "no wear indicator on a hard drive");

        let nvme = json!({
            "device": {"name": "/dev/nvme0", "type": "nvme"}, "model_name": "Samsung 980",
            "smart_status": {"passed": true}, "nvme_total_capacity": 1000204886016u64,
            "nvme_smart_health_information_log": {"percentage_used": 7, "available_spare": 100,
                "available_spare_threshold": 10, "media_errors": 0, "critical_warning": 0, "data_units_written": 2000000}
        });
        let n = normalize(&nvme).unwrap();
        assert_eq!(n.kind, "nvme");
        assert_eq!(n.wear_used_pct, Some(7.0));
        assert_eq!(n.data_written_bytes, Some(2000000.0 * 512000.0));

        let ssd = json!({"device": {"name": "/dev/sdb"}, "rotation_rate": 0,
            "ata_smart_attributes": {"table": [{"id": 177, "value": 92, "raw": {"value": 120}}]}});
        assert_eq!(normalize(&ssd).unwrap().wear_used_pct, Some(8.0));
    }
}
