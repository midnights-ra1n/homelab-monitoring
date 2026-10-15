import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, Columns2, Eye, EyeOff, LayoutGrid, PackageCheck, Radar, RotateCcw, Server, ShieldAlert, Square, Timer } from "lucide-react";
import { api, certDays, fmtMs, pct, statusLabel, type Overview, type Status } from "../api";
import { updateTotals } from "./Updates";
import { incidents } from "./Incidents";
import { AgentVersion } from "./AgentVersion";
import { AlertBanner } from "../layout";
import {
  Alert, Badge, Button, ButtonLink, Card, CardBody, CardHeader, EmptyState, IconButton, Link, Meter, STAT_GRID, SectionTitle, Skeleton, Stat,
  StatusBadge, StatusIcon, UptimeBars, cn, fmtLatency, formatPct, kindTone, statusKind, usePoll, useToast,
} from "../ui";

type WidgetId = "kpis" | "problems" | "latency" | "updates" | "uptime" | "hosts";
interface Widget { id: WidgetId; visible: boolean; full: boolean }

const WIDGETS: Record<WidgetId, string> = {
  kpis: "Indicateurs",
  problems: "Incidents en cours",
  latency: "Latence moyenne (24 h)",
  updates: "Mises à jour",
  uptime: "Disponibilité sur 90 jours",
  hosts: "Ressources des hôtes",
};
const DEFAULT_LAYOUT: Widget[] = [
  { id: "kpis", visible: true, full: true },
  { id: "latency", visible: true, full: false },
  { id: "problems", visible: true, full: false },
  { id: "updates", visible: true, full: false },
  { id: "uptime", visible: true, full: true },
  { id: "hosts", visible: true, full: true },
];

function parseLayout(raw: string): Widget[] {
  try {
    const saved = JSON.parse(raw) as Widget[];
    const known = saved.filter((w) => w.id in WIDGETS);
    // Widgets added in a later version appear at the end.
    return [...known, ...DEFAULT_LAYOUT.filter((d) => !known.some((k) => k.id === d.id))];
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function OverviewPage() {
  const { data, error } = usePoll(() => api.get<Overview>("/api/overview"), 15000);
  const [layout, setLayout] = useState<Widget[]>(DEFAULT_LAYOUT);
  const [editing, setEditing] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.get<{ settings: Record<string, string> }>("/api/settings").then((s) => setLayout(parseLayout(s.settings.dashboard_layout)), () => {});
  }, []);

  const save = async () => {
    await api.put("/api/settings", { dashboard_layout: JSON.stringify(layout) });
    setEditing(false);
    toast("Disposition enregistrée");
  };
  const move = (i: number, d: number) => setLayout((l) => {
    const n = [...l];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    return n;
  });
  const patch = (i: number, p: Partial<Widget>) => setLayout((l) => l.map((w, j) => (j === i ? { ...w, ...p } : w)));

  return (
    <>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 sm:mb-12">
        <div className="min-w-0">
          <h1 className="text-4xl font-bold tracking-tight text-h1 sm:text-5xl">Vue d'<span className="text-accent-text">ensemble</span></h1>
          {data && <p className="mt-2 flex items-center gap-2 text-meta"><StatusIcon status={data.status} />État global : {statusLabel[data.status].toLowerCase()}</p>}
        </div>
        <div className="mm-btn-group">
          {editing ? (
            <>
              <Button variant="secondary" onClick={() => setLayout(DEFAULT_LAYOUT)}>Rétablir par défaut</Button>
              <Button onClick={save}>Enregistrer la disposition</Button>
            </>
          ) : <Button variant="secondary" icon={<LayoutGrid size={16} />} onClick={() => setEditing(true)}>Personnaliser</Button>}
        </div>
      </header>
      {error && <Alert kind="error" title="Impossible de charger les données" className="mb-8">{error}</Alert>}
      {!data && !error && <Skeleton className="h-72" />}
      {data && (
        <div className="grid grid-cols-1 gap-8 xl:gap-10">
          <AlertBanner list={incidents(data)} />
          <div className="grid gap-8 lg:grid-cols-2 xl:gap-10">
            {layout.map((w, i) => (!w.visible && !editing ? null : (
              <div key={w.id} className={cn("min-w-0", w.full && "lg:col-span-2", !w.visible && "opacity-50")}>
                {editing && (
                  <div className="mb-2 flex items-center gap-1 rounded-full border border-dashed border-line py-1 pl-4 pr-1">
                    <span className="mm-label-caps flex-1 truncate">{WIDGETS[w.id]}</span>
                    <IconButton label="Monter" icon={<ArrowUp size={15} />} disabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton label="Descendre" icon={<ArrowDown size={15} />} disabled={i === layout.length - 1} onClick={() => move(i, 1)} />
                    <IconButton label={w.full ? "Demi-largeur" : "Pleine largeur"} icon={w.full ? <Columns2 size={15} /> : <Square size={15} />} onClick={() => patch(i, { full: !w.full })} />
                    <IconButton label={w.visible ? "Masquer" : "Afficher"} icon={w.visible ? <Eye size={15} /> : <EyeOff size={15} />} onClick={() => patch(i, { visible: !w.visible })} />
                  </div>
                )}
                <WidgetView id={w.id} data={data} />
              </div>
            )))}
          </div>
        </div>
      )}
    </>
  );
}

const details = (to: string, label = "Détails") => <ButtonLink to={to} variant="ghost" size="sm" icon={<ArrowUpRight size={14} />}>{label}</ButtonLink>;

function WidgetView({ id, data }: { id: WidgetId; data: Overview }) {
  // 24 h average over every probe's 5-minute buckets.
  const latency = useMemo(() => {
    const v = data.latency.flatMap((s) => s.latency).filter((x): x is number => x != null);
    return { avg: v.length ? v.reduce((a, x) => a + x, 0) / v.length : null, probes: data.latency.filter((s) => s.latency.some((x) => x != null)).length };
  }, [data.latency]);

  const isUp = (s: Status) => s === "operational" || s === "degraded" || s === "maintenance";
  switch (id) {
    case "kpis": {
      const hostsUp = data.hosts.filter((h) => isUp(h.status)).length;
      const monUp = data.monitors.filter((m) => isUp(m.status)).length;
      const lat = data.monitors.filter((m) => m.latency_ms != null && m.type !== "ssl");
      const avg = lat.length ? lat.reduce((a, m) => a + (m.latency_ms ?? 0), 0) / lat.length : null;
      const ssl = data.monitors.filter((m) => { const d = certDays(m); return d != null && d < (m.config.warn_days ?? 14); }).length;
      return (
        <div className={STAT_GRID}>
          <Stat href="/hosts" label="Hôtes en ligne" value={`${hostsUp}/${data.hosts.length}`} icon={<Server size={16} />}
            tone={hostsUp < data.hosts.length ? "red" : undefined} detail={hostsUp < data.hosts.length ? `${data.hosts.length - hostsUp} hors ligne` : "Tous joignables"} />
          <Stat href="/monitors" label="Sondes opérationnelles" value={`${monUp}/${data.monitors.length}`} icon={<Radar size={16} />}
            tone={monUp < data.monitors.length ? "red" : undefined} detail={monUp < data.monitors.length ? `${data.monitors.length - monUp} en panne` : "HTTP(S), TCP, DNS, SSL"} />
          <Stat href="/monitors" label="Latence moyenne" value={fmtMs(avg)} icon={<Timer size={16} />} detail={`Sur ${lat.length} sonde(s)`} />
          <Stat href="/monitors" label="Certificats à renouveler" value={ssl} icon={<ShieldAlert size={16} />} tone={ssl ? "yellow" : undefined} detail="Selon le seuil de chaque sonde" />
        </div>
      );
    }
    case "problems": {
      const items = incidents(data);
      return (
        <Card className="h-full">
          <CardHeader overline="Incidents" title={items.length ? `${items.length} point(s) d'attention` : "Tout est au vert"} actions={details("/incidents")} />
          <CardBody>
            {items.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-green"><span aria-hidden="true">✓</span> Aucun hôte ni aucune sonde en anomalie.</p>
            ) : (
              <ul className="grid max-h-72 gap-1.5 overflow-y-auto">
                {items.map((it) => (
                  <li key={it.key}>
                    <Link to={it.to} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm no-underline hover:bg-page">
                      <StatusIcon status={it.status} size={15} />
                      <span className="min-w-0 flex-1 truncate text-h2">{it.name}<span className="text-meta"> · {it.kind === "Hôte" ? `Hôte · ${it.detail}` : it.detail || statusLabel[it.status]}</span></span>
                      <StatusBadge status={it.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      );
    }
    case "updates": {
      const t = updateTotals(data.hosts);
      const top = data.hosts.filter((h) => h.updates?.pending).sort((a, b) => (b.updates!.security - a.updates!.security) || (b.updates!.pending - a.updates!.pending)).slice(0, 5);
      return (
        <Card className="h-full">
          <CardHeader overline="Mises à jour" title={t.reporting ? `${t.pending} paquet(s) en attente` : "Aucune donnée"} actions={details("/updates")} />
          <CardBody className="grid gap-5">
            <dl className="grid grid-cols-3 gap-3">
              {[
                { label: "Sécurité", value: t.security, icon: ShieldAlert },
                { label: "Redémarrages", value: t.reboot, icon: RotateCcw },
                { label: "À jour", value: `${t.upToDate}/${t.reporting}`, icon: PackageCheck },
              ].map((k) => (
                <div key={k.label} className="rounded-xl border border-line-subtle bg-page p-3">
                  <dt className="flex items-center gap-1.5 text-xs text-meta"><k.icon size={13} aria-hidden="true" /> {k.label}</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold text-h1">{k.value}</dd>
                </div>
              ))}
            </dl>
            {top.length === 0 ? (
              <p className="text-sm text-meta">{t.reporting ? "Tous les hôtes sont à jour." : "Les agents remontent les mises à jour au démarrage puis toutes les 6 heures."}</p>
            ) : (
              <ul className="grid gap-1">
                {top.map((h) => (
                  <li key={h.id}>
                    <Link to="/updates" className="flex items-center gap-3 rounded-lg px-2 py-2 no-underline hover:bg-page">
                      <StatusIcon kind={h.updates!.security ? "down" : "warn"} size={15} />
                      <span className="min-w-0 flex-1 truncate text-sm text-h2">{h.name}</span>
                      {h.updates!.security > 0 && <Badge tone="red">{h.updates!.security} sécu.</Badge>}
                      <span className="w-10 shrink-0 text-right font-mono text-sm text-h2">{h.updates!.pending}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      );
    }
    case "latency":
      return (
        <Card className="h-full">
          <CardHeader overline="Latence" title="Moyenne des sondes, dernières 24 h" actions={details("/monitors", "Sondes")} />
          <CardBody>
            <p className="font-mono text-4xl font-semibold tracking-tight text-h1 tabular-nums">{latency.avg == null ? "—" : fmtLatency(latency.avg)}</p>
            <p className="mt-1 text-sm text-meta">{latency.probes ? `Sur ${latency.probes} sonde(s)` : "Aucune mesure sur les dernières 24 h"}</p>
          </CardBody>
        </Card>
      );
    case "uptime":
      return (
        <section>
          <SectionTitle actions={details("/monitors", "Sondes")}>Disponibilité sur 90 jours</SectionTitle>
          {data.monitors.length === 0 ? <EmptyState title="Aucune sonde">Ajoute une sonde pour suivre sa disponibilité.</EmptyState> : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.monitors.map((m) => {
                const kind = statusKind(m.status, m);
                const days = m.days ?? [];
                const known = days.filter((d) => d.uptime != null);
                const up = known.length ? (known.reduce((a, d) => a + d.uptime!, 0) / known.length) * 100 : null;
                return (
                  <li key={m.id} className={cn("grid gap-3 rounded-xl border border-line-subtle bg-box p-4", !m.enabled && "opacity-60")}
                    style={kind === "down" ? { borderColor: `color-mix(in srgb, ${kindTone("down")} 40%, var(--mm-border))` } : undefined}>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <StatusIcon kind={kind} size={18} />
                      <Link to={`/monitors/${m.id}`} className="min-w-0 flex-1 truncate font-medium text-h1 no-underline hover:text-accent-text" title={m.target}>{m.name}</Link>
                      <span className="shrink-0 rounded-full border border-line-subtle px-1.5 font-mono text-[0.65rem] uppercase text-meta">{m.type}</span>
                      <span className="shrink-0 font-mono text-sm font-semibold text-h1">{formatPct(up, 1)}</span>
                    </div>
                    <UptimeBars days={days.slice(-30)} height={16} />
                    <p className={cn("truncate font-mono text-xs", kind === "down" ? "text-red" : "text-meta")} title={m.message}>
                      {kind === "down" || kind === "warn" ? m.message || "—" : m.latency_ms != null ? fmtLatency(m.latency_ms) : m.message || "—"}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      );
    case "hosts":
      return (
        <section>
          <SectionTitle actions={details("/hosts", "Hôtes")}>Ressources des hôtes</SectionTitle>
          {data.hosts.length === 0 ? <EmptyState title="Aucun hôte">Installe l'agent depuis la page Hôtes.</EmptyState> : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.hosts.map((h) => {
                const kind = statusKind(h.status);
                const live = kind !== "down" && h.last_seen > 0;
                const temp = h.latest.cpu_temp ?? h.latest.temp;
                return (
                  <li key={h.id} className="relative grid gap-3 rounded-xl border border-line-subtle bg-box p-4 transition-colors hover:border-line-strong">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <StatusIcon kind={kind} size={18} />
                      <Link to={`/hosts/${h.id}`} className="min-w-0 flex-1 truncate font-medium text-h1 no-underline after:absolute after:inset-0 after:rounded-xl" title={h.info.os}>{h.name}</Link>
                      {temp != null && <span className={cn("shrink-0 font-mono text-xs", temp > 80 ? "text-red" : "text-meta")}>{Math.round(temp)} °C</span>}
                      <span className="relative z-[1]"><AgentVersion h={h} compact /></span>
                    </div>
                    {live ? (
                      <div className="grid grid-cols-3 gap-3">
                        <Meter size="sm" label="CPU" value={h.latest.cpu} />
                        <Meter size="sm" label="RAM" value={pct(h.latest.mem_used, h.latest.mem_total)} />
                        <Meter size="sm" label="Disque" value={pct(h.latest.disk_used, h.latest.disk_total)} />
                      </div>
                    ) : <p className="text-xs text-meta">Aucune donnée récente de l'agent.</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      );
  }
}
