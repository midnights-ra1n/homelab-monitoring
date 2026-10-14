export type Status = "operational" | "degraded" | "maintenance" | "minor_outage" | "major_outage" | "unknown";

export const statusLabel: Record<Status, string> = {
  operational: "Opérationnel",
  degraded: "Performances dégradées",
  maintenance: "Maintenance",
  minor_outage: "Panne partielle",
  major_outage: "Panne majeure",
  unknown: "En attente",
};

export interface HostInfo {
  hostname?: string; os?: string; kernel?: string; arch?: string; cpu_model?: string;
  cpu_cores?: number; mem_total?: number; agent_version?: string; boot_time?: number;
}
export interface HostLatest {
  cpu?: number; mem_used?: number; mem_total?: number; swap_used?: number; swap_total?: number;
  disk_used?: number; disk_total?: number; net_rx?: number; net_tx?: number; load1?: number; temp?: number | null; cpu_temp?: number | null;
  disks?: { mount: string; fs: string; used: number; total: number }[];
  temps?: { label: string; c: number }[];
  ifaces?: { name: string; rx: number; tx: number }[];
}
export interface Package { name: string; current: string; candidate: string; security: boolean }
export interface HostUpdates {
  manager: string; packages?: Package[]; reboot_required: boolean; lists_updated_at: number;
  checked_at: number; pending: number; security: number;
}
export interface Host {
  id: number; name: string; status: Status; last_seen: number; maintenance: boolean; public: boolean;
  connected: boolean; info: HostInfo; latest: HostLatest; updates: HostUpdates | null; created_at: number;
  action: HostAction | null; agent_latest: string; agent_outdated: boolean; docker: DockerSnapshot | null;
}
export type ImageUpdate = "up_to_date" | "available" | "unknown" | "local" | "pinned";
export interface DockerContainer {
  id: string; name: string; image: string; state: string; health: string; started_at: string; restart_count: number;
  cpu_pct: number | null; mem_used: number | null; mem_limit: number | null; net_rx: number | null; net_tx: number | null;
  compose_project: string; compose_service: string; update: ImageUpdate;
}
export interface DockerSnapshot { containers: DockerContainer[]; error?: string; collected_at: number; running: number; updates_available: number }
export type HostActionName = "check_updates" | "apply_updates" | "update_agent" | "update_container";
export interface HostAction { action: HostActionName; target?: string; state: "pending" | "running" | "done" | "failed"; message: string; at: number }
export const actionBusy = (h: Host) => !!h.action && (h.action.state === "pending" || h.action.state === "running") && Date.now() / 1000 - h.action.at < 7200;
export interface Install { hub_url: string; key: string; token: string; command: string }

export type MonitorType = "http" | "tcp" | "dns" | "ssl";
export interface MonitorConfig {
  method?: string; expected_status?: string; keyword?: string; ignore_tls?: boolean; check_ssl?: boolean; degraded_ms?: number;
  dns_server?: string; record_type?: string; expected?: string; warn_days?: number; failure_threshold?: number;
}
export interface Day { day: number; uptime: number | null; worst: Status }
export interface Monitor {
  id: number; name: string; type: MonitorType; target: string; interval_s: number; timeout_s: number;
  config: MonitorConfig; enabled: boolean; maintenance: boolean; public: boolean; status: Status;
  message: string; latency_ms: number | null; last_check: number; cert_expires_at: number | null; days?: Day[];
}

/** Days until the monitored certificate expires, or null when not tracked. */
export function certDays(m: Monitor) {
  if (m.cert_expires_at == null || !(m.type === "ssl" || m.config.check_ssl)) return null;
  return Math.floor((m.cert_expires_at * 1000 - Date.now()) / 86400000);
}
export type MonitorInput = Pick<Monitor, "name" | "type" | "target" | "interval_s" | "timeout_s" | "config" | "enabled" | "maintenance" | "public">;

export interface Series { t: number[]; latency: (number | null)[]; worst: Status[]; name?: string }
export interface Overview { status: Status; hosts: Host[]; monitors: Monitor[]; latency: Series[] }
export type HostSeries = Record<"t" | "cpu" | "mem" | "swap" | "disk" | "net_rx" | "net_tx" | "load1" | "temp" | "cpu_temp", (number | null)[]>;

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("hlm:unauthorized"));
    throw new ApiError(res.status, data.error || `Erreur ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => req<T>("POST", p, b),
  put: <T>(p: string, b: unknown) => req<T>("PUT", p, b),
  patch: <T>(p: string, b: unknown) => req<T>("PATCH", p, b),
  del: (p: string) => req<void>("DELETE", p),
};

const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
export const fmtNum = (n: number | null | undefined, digits = 1) =>
  n == null ? "—" : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(n);
export const fmtPct = (n: number | null | undefined) => (n == null ? "—" : `${nf.format(n)} %`);
export function fmtBytes(n: number | null | undefined, perSec = false) {
  if (n == null) return "—";
  const u = ["o", "Ko", "Mo", "Go", "To", "Po"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${nf.format(n)} ${u[i]}${perSec ? "/s" : ""}`;
}
export const fmtMs = (n: number | null | undefined) => (n == null ? "—" : `${fmtNum(n, 0)} ms`);
export const fmtDate = (unix: number) =>
  unix ? new Date(unix * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
export function fmtAgo(unix: number) {
  if (!unix) return "jamais";
  const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
export const pct = (used?: number, total?: number) => (used != null && total ? (used / total) * 100 : null);
