import { CheckCircle2, CircleAlert, HardDrive } from "lucide-react";
import { api, fmtAgo, fmtBytes, fmtNum } from "../api";
import { Alert, Card, Kpi, Link, Progress, usePoll } from "../ui";

export type DiskHealthLevel = "good" | "watch" | "replace" | "failing";
export interface Disk {
  name: string; model: string; serial: string; kind: "hdd" | "ssd" | "nvme"; capacity_bytes: number;
  smart_passed: boolean | null; temperature_c: number | null; power_on_hours: number | null; wear_used_pct: number | null;
  data_written_bytes: number | null; reallocated: number | null; pending: number | null;
  health: DiskHealthLevel; score: number; usable: boolean; summary: string; reasons: string[];
  life_left_days: number | null; life_basis: string;
}
export interface HostDisks { host_id: number; host: string; disks: Disk[]; error?: string; collected_at: number }

const HEALTH: Record<DiskHealthLevel, [string, string]> = {
  good: ["Bon état", "s-operational"],
  watch: ["À surveiller", "s-degraded"],
  replace: ["À remplacer", "s-minor_outage"],
  failing: ["Défaillant", "s-major_outage"],
};
const KIND: Record<Disk["kind"], string> = { hdd: "Disque dur", ssd: "SSD SATA", nvme: "SSD NVMe" };

export function fmtLife(days: number | null) {
  if (days == null) return "Non estimable";
  if (days <= 0) return "À remplacer maintenant";
  if (days > 3650) return "Plus de 10 ans";
  const months = Math.max(1, Math.round(days / 30.44));
  const y = Math.floor(months / 12), m = months % 12;
  if (y === 0) return `Environ ${m} mois`;
  return `Environ ${y} an${y > 1 ? "s" : ""}${m ? ` et ${m} mois` : ""}`;
}

export function DiskCard({ d }: { d: Disk }) {
  const [label, cls] = HEALTH[d.health];
  const years = d.power_on_hours != null ? d.power_on_hours / 8760 : null;
  return (
    <section className="card">
      <div className="card-header">
        <HardDrive size={20} aria-hidden className="tertiary" />
        <div>
          <h3 className="ellipsis">{d.model || "Disque"}</h3>
          <div className="sub">{KIND[d.kind]} · {fmtBytes(d.capacity_bytes)} · <span className="mono">{d.name}</span></div>
        </div>
        <span className={`badge ${cls}`}><span className="dot" aria-hidden />{label}</span>
      </div>
      <div className="card-body form" style={{ paddingTop: 0, gap: 12 }}>
        <p style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {d.usable ? <CheckCircle2 size={18} aria-hidden style={{ color: "var(--success-solid)", flex: "none" }} /> : <CircleAlert size={18} aria-hidden style={{ color: "var(--danger-solid)", flex: "none" }} />}
          <span><strong style={{ fontWeight: 600 }}>{d.usable ? "Utilisable" : "Ne plus compter sur ce disque"}</strong> — {d.summary}</span>
        </p>
        <Progress label="Santé globale" value={d.score} text={`${d.score} / 100`} higherIsBetter />
        <dl className="kv">
          <dt>Durée restante estimée</dt><dd><strong style={{ fontWeight: 600 }}>{fmtLife(d.life_left_days)}</strong><div className="xs tertiary">{d.life_basis}</div></dd>
          {d.wear_used_pct != null && <><dt>Usure</dt><dd className="num">{fmtNum(d.wear_used_pct, 0)} %</dd></>}
          {years != null && <><dt>Fonctionnement</dt><dd className="num">{years < 1 ? `${fmtNum(d.power_on_hours, 0)} h` : `${fmtNum(years, 1)} an${years >= 2 ? "s" : ""}`}</dd></>}
          {d.temperature_c != null && <><dt>Température</dt><dd className="num">{fmtNum(d.temperature_c, 0)} °C</dd></>}
          {d.data_written_bytes != null && <><dt>Données écrites</dt><dd className="num">{fmtBytes(d.data_written_bytes)}</dd></>}
          {d.serial && <><dt>N° de série</dt><dd className="mono">{d.serial}</dd></>}
        </dl>
        {d.reasons.length > 0 && (
          <ul className="small" style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
            {d.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

export function DisksPage() {
  const { data, error } = usePoll(() => api.get<HostDisks[]>("/api/disks"), 60000);
  const all = (data ?? []).flatMap((h) => h.disks);
  const count = (l: DiskHealthLevel) => all.filter((d) => d.health === l).length;
  return (
    <div className="page">
      <div className="page-header"><div><h1>Disques</h1><p className="muted">Santé SMART des disques durs et SSD, relevée toutes les heures. Les durées restantes sont des estimations.</p></div></div>
      {error && <Alert tone="danger" title="Impossible de charger les disques">{error}</Alert>}
      {data && (
        <div className="grid kpis">
          <Kpi label="Disques suivis" value={<span className="num">{all.length}</span>} />
          <Kpi label="Bon état" value={<span className="num">{count("good")}</span>} />
          <Kpi label="À surveiller" value={<span className="num">{count("watch")}</span>} />
          <Kpi label="À remplacer ou défaillants" value={<span className="num">{count("replace") + count("failing")}</span>} />
        </div>
      )}
      {data?.length === 0 && (
        <Card><div className="empty small">Aucune donnée SMART. L'agent installe smartmontools et relève les disques toutes les heures ; les machines virtuelles n'exposent généralement pas de SMART.</div></Card>
      )}
      {data?.map((h) => (
        <div key={h.host_id} className="form" style={{ gap: 8 }}>
          <h2 style={{ fontSize: "var(--text-base)" }}><Link to={`/hosts/${h.host_id}`}>{h.host}</Link> <span className="small muted" style={{ fontWeight: 400 }}>· relevé {fmtAgo(h.collected_at)}</span></h2>
          {h.error && <Alert tone="info" title={h.error} />}
          {!h.error && h.disks.length === 0 && <p className="small muted">Aucun disque compatible SMART (machine virtuelle ?).</p>}
          <div className="grid cols-2">{h.disks.map((d) => <DiskCard key={d.name + d.serial} d={d} />)}</div>
        </div>
      ))}
    </div>
  );
}
