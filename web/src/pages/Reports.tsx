import { useState } from "react";
import { Printer, Send } from "lucide-react";
import { api, fmtDate, fmtMs, fmtPct, type Monitor, type Status } from "../api";
import { Alert, BadgeIcon, Button, Card, Kpi, Link, StatusBadge, usePoll, useToast } from "../ui";
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

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Rapport mensuel</h1><p className="muted">État global de l'infrastructure sur le mois.</p></div>
        <div className="actions no-print">
          <select className="select" style={{ width: "auto" }} aria-label="Mois" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <Button icon={<Printer />} onClick={() => window.print()}>Imprimer ou PDF</Button>
          <Button icon={<Send />} loading={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/api/reports/monthly/send?month=${month}`); toast("Rapport envoyé par e-mail"); } catch (e) { toast((e as Error).message); }
            setBusy(false);
          }}>Envoyer par e-mail</Button>
        </div>
      </div>
      {error && <Alert tone="danger" title="Impossible de générer le rapport">{error}</Alert>}
      {data && (
        <>
          <div className="grid kpis">
            <Kpi label="Disponibilité moyenne des sondes" value={ratio(data.uptime)} />
            <Kpi label="Disponibilité moyenne des hôtes" value={ratio(data.host_availability)} detail="Part des relevés d'agent reçus" />
            <Kpi label="Jours d'incident" value={<span className="num">{data.incident_days}</span>} detail="Cumul des sondes" />
            <Kpi label="Mises à jour en attente" value={<span className="num">{data.pending_updates}</span>} detail={`dont ${data.security_updates} de sécurité`} />
          </div>
          <Card title="Sondes" sub="Classées de la moins disponible à la plus disponible" flush>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Sonde</th><th>Pire état</th><th className="r">Disponibilité</th><th className="r">Latence moyenne</th><th className="r">Jours d'incident</th></tr></thead>
                <tbody>{data.monitors.map((m) => (
                  <tr key={m.id}><td><Link to={`/monitors/${m.id}`}>{m.name}</Link></td><td><StatusBadge status={m.worst} /></td>
                    <td className="r">{ratio(m.uptime)}</td><td className="r">{fmtMs(m.avg_latency_ms)}</td><td className="r">{m.incident_days}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
          <Card title="Hôtes" flush>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Hôte</th><th className="r">Disponibilité</th><th className="r">CPU moyen</th><th className="r">Mémoire moyenne</th></tr></thead>
                <tbody>{data.hosts.map((h) => (
                  <tr key={h.id}><td><Link to={`/hosts/${h.id}`}>{h.name}</Link></td><td className="r">{ratio(h.availability)}</td>
                    <td className="r">{fmtPct(h.cpu_avg)}</td><td className="r">{fmtPct(h.mem_avg)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
          <Card title="Mises à jour" sub={`${data.pending_updates} paquet(s) dont ${data.security_updates} de sécurité${data.docker_updates ? ` · ${data.docker_updates} image(s) Docker` : ""} — situation actuelle`} flush>
            {data.updates.length === 0 ? <div className="empty small">Tous les hôtes sont à jour.</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Hôte</th><th className="r">Paquets</th><th className="r">Sécurité</th><th className="r">Images Docker</th><th>Redémarrage</th></tr></thead>
                  <tbody>{data.updates.map((u) => (
                    <tr key={u.host_id}><td><Link to={`/hosts/${u.host_id}`}>{u.host}</Link></td><td className="r">{u.pending}</td>
                      <td className="r">{u.security > 0 ? <span className="badge s-minor_outage"><BadgeIcon cls="s-minor_outage" />{u.security}</span> : 0}</td>
                      <td className="r">{u.images}</td>
                      <td>{u.reboot_required ? <span className="badge s-degraded"><BadgeIcon cls="s-degraded" />Requis</span> : <span className="muted">Non</span>}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
          <div className="grid cols-2">
            <Card title="Certificats expirant sous 30 jours" flush>
              {data.certificates_expiring.length === 0 ? <div className="empty small">Aucun.</div> : (
                <div className="list">{data.certificates_expiring.map((m) => (
                  <div key={m.id} className="list-item"><div>{m.name}</div><span className="small muted">{m.cert_expires_at ? fmtDate(m.cert_expires_at) : "—"}</span></div>
                ))}</div>
              )}
            </Card>
            <Card title="Disques à surveiller" flush>
              {data.disks_attention.length === 0 ? <div className="empty small">Tous les disques sont en bon état.</div> : (
                <div className="list">{data.disks_attention.map((d) => (
                  <div key={d.name + d.serial} className="list-item"><div><div className="ellipsis">{d.name} · {d.model}</div><div className="xs muted">{d.summary}</div></div><span className="small">{fmtLife(d.life_left_days)}</span></div>
                ))}</div>
              )}
            </Card>
          </div>
          <p className="xs tertiary">Généré le {fmtDate(data.generated_at)}. Disponibilité calculée à partir des relevés journaliers ; la disponibilité des hôtes suppose l'intervalle d'agent actuel.</p>
        </>
      )}
    </div>
  );
}
