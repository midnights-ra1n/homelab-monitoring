import { useMemo, useState } from "react";
import { ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { api, certDays, fmtAgo, fmtDate, fmtMs, statusLabel, type Monitor, type MonitorInput, type MonitorType, type Series } from "../api";
import { Alert, Button, Card, Chart, Dialog, Field, Link, Segmented, StatusBadge, Switch, UptimeBars, navigate, usePoll, useToast, fmtLatency, BadgeIcon } from "../ui";

const TYPES: Record<MonitorType, string> = { http: "HTTP(S)", tcp: "Port TCP", dns: "DNS", ssl: "Certificat SSL" };
const TARGET_HINT: Record<MonitorType, [string, string]> = {
  http: ["URL", "https://nextcloud.example.fr/status.php"],
  tcp: ["Hôte et port", "192.168.1.10:22"],
  dns: ["Nom de domaine", "example.fr"],
  ssl: ["Domaine (port facultatif)", "example.fr ou example.fr:8443"],
};

/** Certificate expiry badge: always paired with a text label, never colour alone. */
export function CertBadge({ m }: { m: Monitor }) {
  const d = certDays(m);
  if (d == null) return <span className="tertiary">—</span>;
  const warn = m.config.warn_days ?? 14;
  const cls = d <= 0 ? "s-major_outage" : d < warn ? "s-degraded" : "s-operational";
  const label = d <= 0 ? "Expiré" : d < warn ? `Expire dans ${d} j` : `${d} jours`;
  return <span className={`badge ${cls}`} title={m.cert_expires_at ? `Expire le ${fmtDate(m.cert_expires_at)}` : undefined}><BadgeIcon cls={cls} />{label}</span>;
}

export function MonitorsPage() {
  const { data, error, refresh } = usePoll(() => api.get<Monitor[]>("/api/monitors"), 15000);
  const [editing, setEditing] = useState<Monitor | "new">();
  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Sondes</h1><p className="muted">Points de terminaison HTTP et TCP, serveurs DNS et expiration des certificats.</p></div>
        <div className="actions"><Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>Ajouter une sonde</Button></div>
      </div>
      {error && <Alert tone="danger" title="Impossible de charger les sondes">{error}</Alert>}
      <Card flush>
        {data && data.length === 0 ? (
          <div className="empty">
            <p>Aucune sonde. Ajoutez un service à surveiller : site web, port, serveur DNS ou certificat.</p>
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>Ajouter une sonde</Button>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nom</th><th>Type</th><th>État</th><th className="r">Latence</th><th>Certificat</th><th style={{ minWidth: 240 }}>30 derniers jours</th><th>Dernière vérification</th></tr></thead>
              <tbody>
                {data?.map((m) => (
                  <tr key={m.id} className="link" onClick={() => navigate(`/monitors/${m.id}`)}>
                    <td><Link to={`/monitors/${m.id}`}>{m.name}</Link><div className="xs tertiary mono ellipsis" style={{ maxWidth: 280 }}>{m.target}</div></td>
                    <td className="muted">{TYPES[m.type]}</td>
                    <td><StatusBadge status={m.enabled ? m.status : "unknown"} /></td>
                    <td className="r">{fmtMs(m.latency_ms)}</td>
                    <td><CertBadge m={m} /></td>
                    <td><UptimeBars days={(m.days ?? []).slice(-30)} /></td>
                    <td className="muted">{m.enabled ? fmtAgo(m.last_check / 1000) : "Désactivée"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <MonitorDialog monitor={editing === "new" ? undefined : editing} onClose={(changed) => { setEditing(undefined); if (changed) refresh(); }} />}
    </div>
  );
}

const blank: MonitorInput = { name: "", type: "http", target: "", interval_s: 60, timeout_s: 10, config: {}, enabled: true, maintenance: false, public: false };

function MonitorDialog({ monitor, onClose }: { monitor?: Monitor; onClose: (changed: boolean, m?: Monitor) => void }) {
  // Only send editable fields: the API rejects unknown ones.
  const [m, setM] = useState<MonitorInput>(() => monitor ? {
    name: monitor.name, type: monitor.type, target: monitor.target, interval_s: monitor.interval_s, timeout_s: monitor.timeout_s,
    config: { ...monitor.config }, enabled: monitor.enabled, maintenance: monitor.maintenance, public: monitor.public,
  } : blank);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = <K extends keyof MonitorInput>(k: K, v: MonitorInput[K]) => setM((x) => ({ ...x, [k]: v }));
  const cfg = <K extends keyof MonitorInput["config"]>(k: K, v: MonitorInput["config"][K]) => setM((x) => ({ ...x, config: { ...x.config, [k]: v } }));
  const num = (v: string) => (v === "" ? undefined : Number(v));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const saved = monitor ? await api.put<Monitor>(`/api/monitors/${monitor.id}`, m) : await api.post<Monitor>("/api/monitors", m);
      toast(monitor ? "Sonde mise à jour" : "Sonde créée, première vérification en cours");
      onClose(true, saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [targetLabel, targetPh] = TARGET_HINT[m.type];

  return (
    <Dialog open onClose={() => onClose(false)} wide title={monitor ? `Modifier ${monitor.name}` : "Ajouter une sonde"}
      footer={<><Button onClick={() => onClose(false)}>Annuler</Button><Button variant="primary" type="submit" form="monitor-form" loading={busy}>{monitor ? "Enregistrer la sonde" : "Créer la sonde"}</Button></>}>
      <form id="monitor-form" className="form" onSubmit={submit} noValidate>
        {error && <Alert tone="danger" title={error} />}
        <Field label="Type">
          <Segmented label="Type de sonde" value={m.type} onChange={(t) => setM((x) => ({ ...x, type: t, config: {} }))} options={Object.entries(TYPES) as [MonitorType, string][]} />
        </Field>
        <div className="row">
          <Field label="Nom" htmlFor="m-name"><input id="m-name" className="input" value={m.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label={targetLabel} htmlFor="m-target"><input id="m-target" className="input mono" placeholder={targetPh} value={m.target} onChange={(e) => set("target", e.target.value)} /></Field>
        </div>
        <div className="row">
          <Field label="Intervalle (secondes)" htmlFor="m-int"><input id="m-int" className="input num" type="number" min={10} value={m.interval_s} onChange={(e) => set("interval_s", Number(e.target.value))} /></Field>
          <Field label="Délai d'attente (secondes)" htmlFor="m-to"><input id="m-to" className="input num" type="number" min={1} max={60} value={m.timeout_s} onChange={(e) => set("timeout_s", Number(e.target.value))} /></Field>
          <Field label="Échecs avant alerte" htmlFor="m-th" hint="Évite les fausses alertes"><input id="m-th" className="input num" type="number" min={1} max={10} placeholder="2" value={m.config.failure_threshold ?? ""} onChange={(e) => cfg("failure_threshold", num(e.target.value))} /></Field>
        </div>
        {m.type === "http" && (
          <>
            <div className="row">
              <Field label="Méthode" htmlFor="m-meth">
                <select id="m-meth" className="select" value={m.config.method ?? "GET"} onChange={(e) => cfg("method", e.target.value)}><option>GET</option><option>HEAD</option></select>
              </Field>
              <Field label="Codes HTTP attendus" htmlFor="m-codes" hint="Plages ou liste, ex. 200-299,301"><input id="m-codes" className="input mono" placeholder="200-399" value={m.config.expected_status ?? ""} onChange={(e) => cfg("expected_status", e.target.value)} /></Field>
            </div>
            <Field label="Mot-clé attendu (facultatif)" htmlFor="m-kw"><input id="m-kw" className="input" value={m.config.keyword ?? ""} onChange={(e) => cfg("keyword", e.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={!!m.config.ignore_tls} onChange={(e) => cfg("ignore_tls", e.target.checked)} />Accepter les certificats auto-signés</label>
            <label className="check">
              <input type="checkbox" checked={!!m.config.check_ssl} disabled={!m.target.startsWith("https://")} onChange={(e) => cfg("check_ssl", e.target.checked)} />
              Vérifier le certificat SSL (jours avant expiration)
            </label>
            {!m.target.startsWith("https://") && <span className="hint xs tertiary" style={{ marginTop: -12 }}>Disponible pour une URL https://</span>}
          </>
        )}
        {m.type === "dns" && (
          <div className="row">
            <Field label="Enregistrement" htmlFor="m-rr">
              <select id="m-rr" className="select" value={m.config.record_type ?? "A"} onChange={(e) => cfg("record_type", e.target.value)}>
                {["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Serveur DNS (facultatif)" htmlFor="m-dns" hint="Vide : résolveur du système"><input id="m-dns" className="input mono" placeholder="192.168.1.53" value={m.config.dns_server ?? ""} onChange={(e) => cfg("dns_server", e.target.value)} /></Field>
            <Field label="Réponse attendue (facultatif)" htmlFor="m-exp"><input id="m-exp" className="input mono" value={m.config.expected ?? ""} onChange={(e) => cfg("expected", e.target.value)} /></Field>
          </div>
        )}
        {(m.type === "ssl" || (m.type === "http" && m.config.check_ssl)) && (
          <Field label="Avertir par e-mail avant expiration (jours)" htmlFor="m-warn" hint="Un seul e-mail par certificat, par exemple 3 jours avant">
            <input id="m-warn" className="input num" type="number" min={1} max={365} placeholder="14" value={m.config.warn_days ?? ""} onChange={(e) => cfg("warn_days", num(e.target.value))} />
          </Field>
        )}
        {m.type !== "ssl" && (
          <Field label="Seuil de lenteur en ms (facultatif)" htmlFor="m-slow" hint="Au-delà, la sonde passe en « performances dégradées »">
            <input id="m-slow" className="input num" type="number" min={0} value={m.config.degraded_ms ?? ""} onChange={(e) => cfg("degraded_ms", num(e.target.value))} />
          </Field>
        )}
        <div className="row" style={{ gap: 24 }}>
          <Switch label="Activée" checked={m.enabled} onChange={(v) => set("enabled", v)} />
          <Switch label="Maintenance" checked={m.maintenance} onChange={(v) => set("maintenance", v)} />
        </div>
      </form>
    </Dialog>
  );
}

type Range = "1h" | "24h" | "7d" | "30d" | "90d";

export function MonitorDetailPage({ id }: { id: number }) {
  const mon = usePoll(() => api.get<Monitor>(`/api/monitors/${id}`), 15000, [id]);
  const [range, setRange] = useState<Range>("24h");
  const res = usePoll(() => api.get<Series>(`/api/monitors/${id}/results?range=${range}`), 30000, [id, range]);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const series = useMemo(() => [{ label: "Latence", values: res.data?.latency ?? [] }], [res.data]);
  const m = mon.data;

  if (mon.error) return <div className="page"><Alert tone="danger" title="Sonde introuvable">{mon.error}</Alert></div>;
  if (!m) return null;
  const lat = (res.data?.latency ?? []).filter((v): v is number => v != null);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb"><Link to="/monitors">Sondes</Link><ChevronRight size={14} aria-hidden />{m.name}</div>
          <h1>{m.name}</h1>
          <p className="muted" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge status={m.status} /><span className="mono small">{m.target}</span>
          </p>
        </div>
        <div className="actions">
          <Button icon={<Pencil />} onClick={() => setEditing(true)}>Modifier</Button>
          <Button variant="ghost" icon={<Trash2 />} onClick={() => setConfirmDelete(true)}>Supprimer</Button>
        </div>
      </div>
      {m.message && m.status !== "operational" && <Alert tone={m.status === "degraded" ? "warning" : m.status === "maintenance" ? "info" : "danger"} title={statusLabel[m.status]}>{m.message}</Alert>}
      <div className="grid kpis">
        <div className="card kpi"><span className="label">Dernière latence</span><span className="value">{fmtMs(m.latency_ms)}</span></div>
        <div className="card kpi"><span className="label">Latence moyenne</span><span className="value">{fmtMs(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null)}</span></div>
        <div className="card kpi"><span className="label">Latence max.</span><span className="value">{fmtMs(lat.length ? Math.max(...lat) : null)}</span></div>
        {certDays(m) != null ? (
          <div className="card kpi"><span className="label">Certificat SSL</span>
            <span className="value">{certDays(m)! <= 0 ? "Expiré" : `${certDays(m)} jours`}</span>
            <span className="small muted">Expire le {fmtDate(m.cert_expires_at!)} · avertissement {m.config.warn_days ?? 14} j avant</span>
          </div>
        ) : null}
        <div className="card kpi">
          <span className="label">Dernière vérification</span>
          <span className="value" style={{ fontSize: "var(--text-lg)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {m.last_check ? fmtAgo(m.last_check / 1000) : "Jamais"}{m.last_check > 0 && <StatusBadge status={m.status} />}
          </span>
          {m.last_check > 0 && <span className="small muted num">{new Date(m.last_check).toLocaleString("fr-FR")}</span>}
          {m.message && <span className="small muted">{m.message}</span>}
        </div>
      </div>
      <Card title="Latence" actions={<Segmented label="Période" value={range} onChange={setRange} options={[["1h", "1 h"], ["24h", "24 h"], ["7d", "7 j"], ["30d", "30 j"], ["90d", "90 j"]]} />}>
        <Chart t={res.data?.t ?? []} series={series} format={fmtLatency} height={260} />
      </Card>
      <Card title="Disponibilité sur 90 jours"><UptimeBars days={m.days ?? []} /></Card>
      {editing && <MonitorDialog monitor={m} onClose={(changed, saved) => { setEditing(false); if (changed && saved) mon.setData(saved); }} />}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Supprimer ${m.name}`} description="La sonde et son historique seront supprimés définitivement."
        footer={<><Button onClick={() => setConfirmDelete(false)}>Annuler</Button>
          <Button variant="danger" onClick={() => api.del(`/api/monitors/${id}`).then(() => { toast("Sonde supprimée"); navigate("/monitors"); })}>Supprimer la sonde</Button></>}>
        <p className="small muted">Cette action est irréversible.</p>
      </Dialog>
    </div>
  );
}
