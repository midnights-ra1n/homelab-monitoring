import { useState } from "react";
import { CircleAlert, Printer, Radar, Send, Server, ShieldAlert } from "lucide-react";
import { api, fmtDate, fmtMs, fmtPct, type Monitor, type Status } from "../api";
import {
  Alert, Badge, Button, Card, Link, PageHeader, SECTIONS, STAT_GRID, Skeleton, Stat, StatusBadge, StatusIcon, cn, inputClass, usePoll, useToast,
} from "../ui";
import { fmtLife, type Disk } from "./Disks";

interface Report {
  month: string; from: number; to: number; uptime: number | null; host_availability: number | null; incident_days: number;
  monitors: { id: number; name: string; type: string; uptime: number | null; avg_latency_ms: number | null; incident_days: number; worst: Status }[];
  hosts: { id: number; name: string; availability: number | null; cpu_avg: number | null; mem_avg: number | null }[];
  certificates_expiring: Monitor[]; pending_updates: number; security_updates: number; disks_attention: Disk[]; generated_at: number;
  updates: { host_id: number; host: string; pending: number; security: number; reboot_required: boolean; images: number }[]; docker_updates: number;
}

const ratio = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(2).replace(".", ",")} %`);

function lastMonths(n: number) {
  const out: [string, string][] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    d.setMonth(d.getMonth() - 1);
    const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push([v, d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })]);
  }
  // Current month so far, at the top.
  const now = new Date();
  out.unshift([`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`, `${now.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })} (en cours)`]);
  return out;
}

export function ReportsPage() {
  const months = lastMonths(12);
  const [month, setMonth] = useState(months[1][0]);
  const { data, error } = usePoll(() => api.get<Report>(`/api/reports/monthly?month=${month}`), 300000, [month]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const strong = "text-inherit no-underline hover:text-accent-text";
  return (
    <>
      <PageHeader title="Rapport mensuel" description="État global de l'infrastructure sur le mois."
        actions={<div className="mm-btn-group print:hidden">
          <select className={cn(inputClass, "w-auto")} aria-label="Mois" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <Button variant="secondary" icon={<Printer size={16} />} onClick={() => window.print()}>Imprimer ou PDF</Button>
          <Button variant="secondary" icon={<Send size={16} />} loading={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/api/reports/monthly/send?month=${month}`); toast("Rapport envoyé par e-mail"); } catch (e) { toast((e as Error).message, "error"); }
            setBusy(false);
          }}>Envoyer par e-mail</Button>
        </div>} />
      {error && <Alert kind="error" title="Impossible de générer le rapport" className="mb-6">{error}</Alert>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && (
        <div className={SECTIONS}>
          <div className={STAT_GRID}>
            <Stat label="Disponibilité des sondes" value={ratio(data.uptime)} icon={<Radar size={16} />} detail="moyenne du mois" />
            <Stat label="Disponibilité des hôtes" value={ratio(data.host_availability)} icon={<Server size={16} />} detail="Part des relevés d'agent reçus" />
            <Stat label="Jours d'incident" value={data.incident_days} icon={<CircleAlert size={16} />} tone={data.incident_days ? "red" : undefined} detail="Cumul des sondes" />
            <Stat label="Mises à jour en attente" value={data.pending_updates} icon={<ShieldAlert size={16} />} tone={data.security_updates ? "red" : undefined} detail={`dont ${data.security_updates} de sécurité`} />
          </div>
          <Card flush title="Sondes" sub="Classées de la moins disponible à la plus disponible">
            <div className="mm-table-wrap">
              <table className="mm-table">
                <thead><tr><th scope="col">Sonde</th><th scope="col">Pire état</th><th scope="col" className="mm-col-num">Disponibilité</th><th scope="col" className="mm-col-num">Latence moyenne</th><th scope="col" className="mm-col-num">Jours d'incident</th></tr></thead>
                <tbody>{data.monitors.map((m) => (
                  <tr key={m.id}>
                    <td className="mm-col-strong"><Link to={`/monitors/${m.id}`} className={cn("flex items-center gap-2.5", strong)}><StatusIcon status={m.worst} />{m.name}</Link></td>
                    <td><StatusBadge status={m.worst} /></td>
                    <td className="mm-col-num font-mono text-xs">{ratio(m.uptime)}</td><td className="mm-col-num font-mono text-xs">{fmtMs(m.avg_latency_ms)}</td><td className="mm-col-num font-mono text-xs">{m.incident_days}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
          <Card flush title="Hôtes" sub={`${data.hosts.length} hôte(s)`}>
            <div className="mm-table-wrap">
              <table className="mm-table">
                <thead><tr><th scope="col">Hôte</th><th scope="col" className="mm-col-num">Disponibilité</th><th scope="col" className="mm-col-num">CPU moyen</th><th scope="col" className="mm-col-num">Mémoire moyenne</th></tr></thead>
                <tbody>{data.hosts.map((h) => (
                  <tr key={h.id}>
                    <td className="mm-col-strong"><Link to={`/hosts/${h.id}`} className={strong}>{h.name}</Link></td>
                    <td className="mm-col-num font-mono text-xs">{ratio(h.availability)}</td>
                    <td className="mm-col-num font-mono text-xs">{fmtPct(h.cpu_avg)}</td><td className="mm-col-num font-mono text-xs">{fmtPct(h.mem_avg)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
          <Card flush title="Mises à jour" sub={`${data.pending_updates} paquet(s) dont ${data.security_updates} de sécurité${data.docker_updates ? ` · ${data.docker_updates} image(s) Docker` : ""} — situation actuelle`}>
            {data.updates.length === 0 ? <p className="px-5 py-8 text-center text-sm text-meta">Tous les hôtes sont à jour.</p> : (
              <div className="mm-table-wrap">
                <table className="mm-table">
                  <thead><tr><th scope="col">Hôte</th><th scope="col" className="mm-col-num">Paquets</th><th scope="col" className="mm-col-num">Sécurité</th><th scope="col" className="mm-col-num">Images Docker</th><th scope="col">Redémarrage</th></tr></thead>
                  <tbody>{data.updates.map((u) => (
                    <tr key={u.host_id}>
                      <td className="mm-col-strong"><Link to={`/hosts/${u.host_id}`} className={strong}>{u.host}</Link></td>
                      <td className="mm-col-num font-mono text-xs">{u.pending}</td>
                      <td className="mm-col-num">{u.security > 0 ? <Badge tone="red">{u.security} sécu.</Badge> : <span className="font-mono text-xs">0</span>}</td>
                      <td className="mm-col-num font-mono text-xs">{u.images}</td>
                      <td>{u.reboot_required ? <Badge tone="yellow" dot>Requis</Badge> : <span className="text-meta">Non</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
          <div className="grid gap-8 lg:grid-cols-2 xl:gap-10">
            <Card flush title="Certificats expirant sous 30 jours">
              <ul className="divide-y divide-line-subtle">
                {data.certificates_expiring.length === 0 && <li className="px-5 py-6 text-center text-sm text-meta">Aucun.</li>}
                {data.certificates_expiring.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span className="truncate font-mono text-sm text-h2">{m.name}</span>
                    <span className="font-mono text-xs text-meta">{m.cert_expires_at ? fmtDate(m.cert_expires_at) : "—"}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card flush title="Disques à surveiller">
              <ul className="divide-y divide-line-subtle">
                {data.disks_attention.length === 0 && <li className="px-5 py-6 text-center text-sm text-meta">Tous les disques sont en bon état.</li>}
                {data.disks_attention.map((d) => (
                  <li key={d.name + d.serial} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-h2">{d.name} · {d.model}</span>
                      <span className="block truncate font-mono text-xs text-meta">{d.summary}</span>
                    </span>
                    <span className="shrink-0 text-xs text-body">{fmtLife(d.life_left_days)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <p className="-mt-6 font-mono text-xs text-meta">Généré le {fmtDate(data.generated_at)}. Disponibilité calculée à partir des relevés journaliers ; la disponibilité des hôtes suppose l'intervalle d'agent actuel.</p>
        </div>
      )}
    </>
  );
}
