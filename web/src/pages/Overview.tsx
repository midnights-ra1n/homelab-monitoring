import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Columns2, Square } from "lucide-react";
import { api, certDays, fmtMs, fmtPct, pct, statusLabel, type Overview, type Status } from "../api";
import { updateTotals } from "./Updates";
import { AgentVersion } from "./AgentVersion";
import { Alert, Button, Card, Chart, IconButton, Kpi, Link, StatusBadge, StatusIcon, UptimeBars, navigate, usePoll, useToast, fmtLatency } from "../ui";

type WidgetId = "kpis" | "problems" | "latency" | "updates" | "uptime" | "hosts";
interface Widget { id: WidgetId; visible: boolean; full: boolean }

const WIDGETS: Record<WidgetId, string> = {
  kpis: "Indicateurs",
  problems: "Incidents en cours",
  latency: "Latence des sondes (24 h)",
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
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Vue d'ensemble</h1>
          <p className="muted">{data ? `État global : ${statusLabel[data.status].toLowerCase()}` : "Chargement…"}</p>
        </div>
        <div className="actions">
          {editing ? (
            <>
              <Button onClick={() => setLayout(DEFAULT_LAYOUT)}>Rétablir par défaut</Button>
              <Button variant="primary" onClick={save}>Enregistrer la disposition</Button>
            </>
          ) : <Button onClick={() => setEditing(true)}>Personnaliser</Button>}
        </div>
      </div>
      {error && <Alert tone="danger" title="Impossible de charger les données">{error}</Alert>}
      <div className="grid cols-2">
        {layout.map((w, i) => (!w.visible && !editing ? null : (
          <div key={w.id} style={{ gridColumn: w.full ? "1 / -1" : undefined, opacity: w.visible ? 1 : 0.5, minWidth: 0 }}>
            {editing && (
              <div className="row" style={{ alignItems: "center", marginBottom: 8, gap: 4 }}>
                <strong className="small" style={{ flex: 1 }}>{WIDGETS[w.id]}</strong>
                <IconButton label="Monter" icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton label="Descendre" icon={<ArrowDown />} disabled={i === layout.length - 1} onClick={() => move(i, 1)} />
                <IconButton label={w.full ? "Demi-largeur" : "Pleine largeur"} icon={w.full ? <Columns2 /> : <Square />} onClick={() => patch(i, { full: !w.full })} />
                <IconButton label={w.visible ? "Masquer" : "Afficher"} icon={w.visible ? <Eye /> : <EyeOff />} onClick={() => patch(i, { visible: !w.visible })} />
              </div>
            )}
            {data && <WidgetView id={w.id} data={data} />}
          </div>
        )))}
      </div>
    </div>
  );
}

function WidgetView({ id, data }: { id: WidgetId; data: Overview }) {
  const latency = useMemo(() => {
    // Align every monitor's buckets on a shared time axis.
    const ts = [...new Set(data.latency.flatMap((s) => s.t))].sort((a, b) => a - b);
    return {
      t: ts,
      series: data.latency.map((s) => {
        const m = new Map(s.t.map((t, i) => [t, s.latency[i]]));
        return { label: s.name ?? "", values: ts.map((t) => m.get(t) ?? null) };
      }),
    };
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
        <div className="grid kpis">
          <Kpi label="Hôtes en ligne" value={<span className="num">{hostsUp} / {data.hosts.length}</span>} />
          <Kpi label="Sondes opérationnelles" value={<span className="num">{monUp} / {data.monitors.length}</span>} />
          <Kpi label="Latence moyenne" value={fmtMs(avg)} />
          <Kpi label="Certificats bientôt expirés" value={<span className="num">{ssl}</span>} />
        </div>
      );
    }
    case "problems": {
      const items = [
        ...data.hosts.filter((h) => h.status !== "operational" && h.status !== "unknown").map((h) => ({ key: `h${h.id}`, name: h.name, status: h.status, msg: "Hôte", to: `/hosts/${h.id}` })),
        ...data.monitors.filter((m) => m.status !== "operational" && m.status !== "unknown").map((m) => ({ key: `m${m.id}`, name: m.name, status: m.status, msg: m.message, to: `/monitors/${m.id}` })),
      ];
      return (
        <Card title="Incidents en cours" sub={items.length ? `${items.length} élément(s) à surveiller` : "Tout fonctionne normalement"} flush>
          {items.length === 0 ? <div className="empty small">Aucun hôte ni aucune sonde en anomalie.</div> : (
            <div className="list">
              {items.map((it) => (
                <Link key={it.key} to={it.to} className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
                  <StatusIcon status={it.status} />
                  <div><div className="ellipsis">{it.name}</div><div className="small muted ellipsis">{it.msg}</div></div>
                  <StatusBadge status={it.status} />
                </Link>
              ))}
            </div>
          )}
        </Card>
      );
    }
    case "updates": {
      const t = updateTotals(data.hosts);
      const top = data.hosts.filter((h) => h.updates?.pending).sort((a, b) => (b.updates!.security - a.updates!.security) || (b.updates!.pending - a.updates!.pending)).slice(0, 5);
      return (
        <Card title="Mises à jour" sub={t.reporting ? `${t.pending} paquet(s) en attente sur ${t.reporting} hôte(s)` : "Aucune donnée"} actions={<Link to="/updates" className="small">Tout voir</Link>} flush>
          <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", padding: 16, gap: 8 }}>
            <div><div className="small muted">Sécurité</div><div className="num" style={{ fontSize: "var(--text-xl)", fontWeight: 600 }}>{t.security}</div></div>
            <div><div className="small muted">Redémarrages</div><div className="num" style={{ fontSize: "var(--text-xl)", fontWeight: 600 }}>{t.reboot}</div></div>
            <div><div className="small muted">À jour</div><div className="num" style={{ fontSize: "var(--text-xl)", fontWeight: 600 }}>{t.upToDate} / {t.reporting}</div></div>
          </div>
          <div className="list" style={{ borderTop: "1px solid var(--border-subtle)" }}>
            {top.length === 0 && <div className="empty small">{t.reporting ? "Tous les hôtes sont à jour." : "Les agents remontent les mises à jour au démarrage puis toutes les 6 heures."}</div>}
            {top.map((h) => (
              <Link key={h.id} to="/updates" className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
                <div className="ellipsis">{h.name}</div>
                {h.updates!.security > 0 && <span className="badge s-minor_outage">{h.updates!.security} sécurité</span>}
                <span className="badge">{h.updates!.pending} paquet(s)</span>
              </Link>
            ))}
          </div>
        </Card>
      );
    }
    case "latency":
      return (
        <Card title="Latence des sondes" sub="Moyenne par tranche de 5 minutes, dernières 24 h">
          <Chart t={latency.t} series={latency.series} format={fmtLatency} />
        </Card>
      );
    case "uptime":
      return (
        <Card title="Disponibilité sur 90 jours" flush>
          {data.monitors.length === 0 ? <div className="empty small">Ajoutez une sonde pour suivre sa disponibilité.</div> : (
            <div className="list">
              {data.monitors.map((m) => (
                <div key={m.id} className="list-item" style={{ flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 160px" }}><Link to={`/monitors/${m.id}`}>{m.name}</Link></div>
                  <StatusBadge status={m.status} />
                  <div style={{ flex: "1 1 100%" }}><UptimeBars days={m.days ?? []} /></div>
                </div>
              ))}
            </div>
          )}
        </Card>
      );
    case "hosts":
      return (
        <Card title="Ressources des hôtes" flush>
          {data.hosts.length === 0 ? <div className="empty small">Aucun hôte. Installez l'agent depuis la page Hôtes.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Hôte</th><th>État</th><th className="r">CPU</th><th className="r">Mémoire</th><th className="r">Disque</th><th className="r">Temp.</th><th>Agent</th></tr></thead>
                <tbody>
                  {data.hosts.map((h) => (
                    <tr key={h.id} className="link" onClick={() => navigate(`/hosts/${h.id}`)}>
                      <td><Link to={`/hosts/${h.id}`}>{h.name}</Link></td>
                      <td><StatusBadge status={h.status} /></td>
                      <td className="r">{fmtPct(h.latest.cpu)}</td>
                      <td className="r">{fmtPct(pct(h.latest.mem_used, h.latest.mem_total))}</td>
                      <td className="r">{fmtPct(pct(h.latest.disk_used, h.latest.disk_total))}</td>
                      <td className="r">{(h.latest.cpu_temp ?? h.latest.temp) != null ? `${Math.round((h.latest.cpu_temp ?? h.latest.temp)!)} °C` : "—"}</td>
                      <td><AgentVersion h={h} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      );
  }
}
