//! Metric collection. Only the subsystems we report are refreshed, so a sample costs
//! a few reads in /proc and /sys.

use serde::Serialize;
use std::collections::HashSet;
use std::time::Instant;
use sysinfo::{
    Components, CpuRefreshKind, Disks, MemoryRefreshKind, Networks, RefreshKind, System,
};

// Wire format shared with server/hosts.go (agentInfo / agentMetrics). Keep both in sync.
#[derive(Serialize)]
pub struct Info {
    hostname: String,
    os: String,
    kernel: String,
    arch: String,
    cpu_model: String,
    cpu_cores: usize,
    mem_total: u64,
    agent_version: &'static str,
    boot_time: u64,
}

#[derive(Serialize)]
pub struct Disk {
    mount: String,
    fs: String,
    used: u64,
    total: u64,
}

#[derive(Serialize)]
pub struct Temp {
    label: String,
    c: f32,
}

#[derive(Serialize)]
pub struct Iface {
    name: String,
    rx: f64,
    tx: f64,
}

#[derive(Serialize)]
pub struct Metrics {
    cpu: f32,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    disk_used: u64,
    disk_total: u64,
    net_rx: f64,
    net_tx: f64,
    load1: f64,
    temp: Option<f32>,
    cpu_temp: Option<f32>,
    disks: Vec<Disk>,
    temps: Vec<Temp>,
    ifaces: Vec<Iface>,
}

pub struct Collector {
    sys: System,
    disks: Disks,
    nets: Networks,
    comps: Components,
    last_net: Instant,
}

const PSEUDO_FS: &[&str] = &[
    "tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "ramfs", "efivarfs", "fuse.lxcfs",
];

// shortcut: interfaces are excluded by name prefix to avoid counting bridged/virtual
// traffic twice; upgrade to /sys/class/net/*/device detection if a host is miscounted.
const VIRTUAL_IFACES: &[&str] = &[
    "lo", "veth", "docker", "br-", "virbr", "vmbr", "tap", "fwbr", "fwpr", "fwln", "tun", "wg",
    "cni", "flannel", "cali", "vnet",
];

/// CPU temperature from the sensor that best represents the package, by driver label:
/// AMD (k10temp Tctl/Tdie, zenpower), Intel (coretemp Package id 0), ARM SoCs (cpu_thermal),
/// falling back to the hottest Intel core. Virtual machines expose none.
fn cpu_temp(temps: &[Temp]) -> Option<f32> {
    const PREFERRED: &[&str] = &["tctl", "tdie", "package id 0", "cpu_thermal", "soc_thermal", "cpu temp", "zenpower", "k10temp", "cpu"];
    let lower: Vec<(String, f32)> = temps.iter().map(|t| (t.label.to_lowercase(), t.c)).collect();
    PREFERRED
        .iter()
        .find_map(|p| lower.iter().find(|(l, _)| l.contains(p)).map(|(_, c)| *c))
        .or_else(|| lower.iter().filter(|(l, _)| l.starts_with("coretemp core")).map(|(_, c)| *c).reduce(f32::max))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn t(label: &str, c: f32) -> Temp {
        Temp { label: label.into(), c }
    }

    #[test]
    fn picks_the_cpu_sensor() {
        assert_eq!(cpu_temp(&[t("nvme Composite", 61.0), t("k10temp Tctl", 48.5)]), Some(48.5));
        assert_eq!(cpu_temp(&[t("coretemp Core 0", 50.0), t("coretemp Package id 0", 55.0)]), Some(55.0));
        assert_eq!(cpu_temp(&[t("coretemp Core 0", 50.0), t("coretemp Core 1", 53.0)]), Some(53.0));
        assert_eq!(cpu_temp(&[t("cpu_thermal temp1", 45.0)]), Some(45.0));
        assert_eq!(cpu_temp(&[t("nvme Composite", 40.0), t("acpitz temp1", 27.8)]), None);
    }
}

impl Collector {
    pub fn new() -> Self {
        let sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::everything()),
        );
        Collector {
            sys,
            disks: Disks::new_with_refreshed_list(),
            nets: Networks::new_with_refreshed_list(),
            comps: Components::new_with_refreshed_list(),
            last_net: Instant::now(),
        }
    }

    pub fn info(&self) -> Info {
        let cpus = self.sys.cpus();
        Info {
            hostname: System::host_name().unwrap_or_default(),
            os: System::long_os_version().unwrap_or_default(),
            kernel: System::kernel_version().unwrap_or_default(),
            arch: System::cpu_arch(),
            cpu_model: cpus.first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
            cpu_cores: cpus.len(),
            mem_total: self.sys.total_memory(),
            agent_version: crate::VERSION,
            boot_time: System::boot_time(),
        }
    }

    pub fn collect(&mut self) -> Metrics {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.disks.refresh(true);
        self.nets.refresh(true);
        self.comps.refresh(true);

        let mut seen = HashSet::new();
        let mut disks = Vec::new();
        let (mut disk_used, mut disk_total) = (0, 0);
        for d in self.disks.list() {
            let fs = d.file_system().to_string_lossy().to_string();
            if PSEUDO_FS.contains(&fs.as_str()) || d.total_space() == 0 {
                continue;
            }
            let used = d.total_space().saturating_sub(d.available_space());
            // A device mounted several times (bind mounts, btrfs subvolumes) counts once in the total.
            if seen.insert(d.name().to_os_string()) {
                disk_used += used;
                disk_total += d.total_space();
            }
            disks.push(Disk {
                mount: d.mount_point().to_string_lossy().to_string(),
                fs,
                used,
                total: d.total_space(),
            });
        }

        let secs = self.last_net.elapsed().as_secs_f64().max(0.001);
        self.last_net = Instant::now();
        let mut ifaces = Vec::new();
        let (mut rx, mut tx) = (0.0, 0.0);
        for (name, n) in self.nets.list() {
            let (r, t) = (n.received() as f64 / secs, n.transmitted() as f64 / secs);
            if !VIRTUAL_IFACES.iter().any(|p| name.starts_with(p)) {
                rx += r;
                tx += t;
            }
            ifaces.push(Iface { name: name.clone(), rx: r, tx: t });
        }

        let temps: Vec<Temp> = self
            .comps
            .list()
            .iter()
            .filter_map(|c| {
                let t = c.temperature()?;
                (t.is_finite() && t > 0.0).then(|| Temp { label: c.label().to_string(), c: t })
            })
            .collect();

        Metrics {
            cpu: self.sys.global_cpu_usage(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            swap_used: self.sys.used_swap(),
            swap_total: self.sys.total_swap(),
            disk_used,
            disk_total,
            net_rx: rx,
            net_tx: tx,
            load1: System::load_average().one,
            temp: temps.iter().map(|t| t.c).reduce(f32::max),
            cpu_temp: cpu_temp(&temps),
            disks,
            temps,
            ifaces,
        }
    }
}
