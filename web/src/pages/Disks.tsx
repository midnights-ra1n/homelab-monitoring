import { CircleAlert, CircleCheck, HardDrive, TriangleAlert } from "lucide-react";
import { api, fmtAgo, fmtBytes, fmtNum } from "../api";
import { Alert, Badge, Card, EmptyState, Link, Meter, PageHeader, SECTIONS, STAT_GRID, SectionTitle, Skeleton, Stat, StatusIcon, TONE_VAR, type Tone, usePoll } from "../ui";

export type DiskHealthLevel = "good" | "watch" | "replace" | "failing";
export interface Disk {
  name: string; model: string; serial: string; kind: "hdd" | "ssd" | "nvme"; capacity_bytes: number;
  smart_passed: boolean | null; temperature_c: number | null; power_on_hours: number | null; wear_used_pct: number | null;
  data_written_bytes: number | null; reallocated: number | null; pending: number | null;
  health: DiskHealthLevel; score: number; usable: boolean; summary: string; reasons: string[];
  life_left_days: number | null; life_basis: string;
}
export interface HostDisks { host_id: number; host: string; disks: Disk[]; error?: string; collected_at: number }

const HEALTH: Record<DiskHealthLevel, [string, Tone]> = {
  good: ["Bon état", "green"],
  watch: ["À surveiller", "yellow"],
  replace: ["À remplacer", "orange"],
  failing: ["Défaillant", "red"],
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
  const [label, tone] = HEALTH[d.health];
  const years = d.power_on_hours != null ? d.power_on_hours / 8760 : null;
  const facts: [string, string][] = [
    ["Durée restante", fmtLife(d.life_left_days)],
    ...(d.wear_used_pct != null ? [["Usure", `${fmtNum(d.wear_used_pct, 0)} %`] as [string, string]] : []),
    ...(years != null ? [["Fonctionnement", years < 1 ? `${fmtNum(d.power_on_hours, 0)} h` : `${fmtNum(years, 1)} an${years >= 2 ? "s" : ""}`] as [string, string]] : []),
    ...(d.temperature_c != null ? [["Température", `${fmtNum(d.temperature_c, 0)} °C`] as [string, string]] : []),
    ...(d.data_written_bytes != null ? [["Données écrites", fmtBytes(d.data_written_bytes)] as [string, string]] : []),
    ...(d.serial ? [["N° de série", d.serial] as [string, string]] : []),
  ];
  return (
    <Card className="p-5" style={tone === "red" || tone === "orange" ? { borderColor: `color-mix(in srgb, ${TONE_VAR[tone]} 40%, var(--mm-border))` } : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text"><HardDrive size={16} aria-hidden /></span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-h1">{d.model || "Disque"}</p>
            <p className="truncate font-mono text-xs text-meta">{KIND[d.kind]} · {fmtBytes(d.capacity_bytes)} · {d.name}</p>
          </div>
        </div>
        <Badge tone={tone} dot>{label}</Badge>
      </div>
      <p className="mt-4 flex items-start gap-2 text-sm text-body">
        <StatusIcon kind={d.usable ? "ok" : "down"} className="mt-0.5" />
        <span><span className="font-medium text-h1">{d.usable ? "Utilisable" : "Ne plus compter sur ce disque"}</span> — {d.summary}</span>
      </p>
      <Meter className="mt-4" label="Santé globale" value={d.score} detail={`${d.score} / 100`} tone={d.score >= 75 ? "green" : d.score >= 50 ? "yellow" : "red"} />
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-meta">{k}</dt>
            <dd className="mt-0.5 truncate font-mono text-h2" title={v}>{v}</dd>
          </div>
        ))}
      </dl>
      {d.life_basis && <p className="mt-3 text-xs text-meta">{d.life_basis}</p>}
      {d.reasons.length > 0 && (
        <ul className="mt-3 grid list-disc gap-1 pl-5 text-sm text-body">
          {d.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </Card>
  );
}

export function DisksPage() {
  const { data, error } = usePoll(() => api.get<HostDisks[]>("/api/disks"), 60000);
  const all = (data ?? []).flatMap((h) => h.disks);
  const count = (l: DiskHealthLevel) => all.filter((d) => d.health === l).length;
  return (
    <>
      <PageHeader title="Disques" description="Santé SMART des disques durs et SSD, relevée toutes les heures. Les durées restantes sont des estimations." />
      {error && <Alert kind="error" title="Impossible de charger les disques" className="mb-6">{error}</Alert>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && (
        <div className={SECTIONS}>
          <div className={STAT_GRID}>
            <Stat label="Disques suivis" value={all.length} icon={<HardDrive size={16} />} />
            <Stat label="Bon état" value={count("good")} icon={<CircleCheck size={16} />} tone="green" />
            <Stat label="À surveiller" value={count("watch")} icon={<TriangleAlert size={16} />} tone={count("watch") ? "yellow" : undefined} />
            <Stat label="À remplacer ou défaillants" value={count("replace") + count("failing")} icon={<CircleAlert size={16} />} tone={count("replace") + count("failing") ? "red" : undefined} />
          </div>
          {data.length === 0 && (
            <EmptyState icon={<HardDrive size={20} />} title="Aucune donnée SMART">
              L'agent installe smartmontools et relève les disques toutes les heures ; les machines virtuelles n'exposent généralement pas de SMART.
            </EmptyState>
          )}
          {data.map((h) => (
            <section key={h.host_id} aria-label={h.host}>
              <SectionTitle actions={<span className="font-mono text-xs text-meta">relevé {fmtAgo(h.collected_at)}</span>}>
                <Link to={`/hosts/${h.host_id}`} className="text-inherit no-underline hover:text-accent-text">{h.host}</Link>
              </SectionTitle>
              {h.error && <Alert kind="info" title={h.error} className="mb-4" />}
              {!h.error && h.disks.length === 0 && <p className="text-sm text-meta">Aucun disque compatible SMART (machine virtuelle ?).</p>}
              <div className="grid gap-4 lg:grid-cols-2 xl:gap-6">{h.disks.map((d) => <DiskCard key={d.name + d.serial} d={d} />)}</div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
