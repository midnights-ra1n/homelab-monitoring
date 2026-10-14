import { useMemo, useState } from "react";
import { ChevronRight, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, fmtAgo, fmtBytes, fmtDate, fmtPct, pct, type Host, type HostSeries, type Install } from "../api";
import { Alert, Button, Card, Chart, Dialog, Link, Progress, Segmented, StatusBadge, Switch, navigate, usePoll, useToast } from "../ui";
import { DiskCard, type HostDisks } from "./Disks";
import { AddHostWizard, InstallInstructions } from "./AddHostWizard";

export function HostsPage() {
  const { data, error, refresh } = usePoll(() => api.get<Host[]>("/api/hosts"), 15000);
  const [adding, setAdding] = useState(false);
  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Hôtes</h1><p className="muted">Machines virtuelles, serveurs Proxmox, serveurs physiques et postes équipés de l'agent.</p></div>
        <div className="actions"><Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Ajouter un hôte</Button></div>
      </div>
      {error && <Alert tone="danger" title="Impossible de charger les hôtes">{error}</Alert>}
      <Card flush>
        {data && data.length === 0 ? (
          <div className="empty">
            <p>Aucun hôte n'est encore supervisé. Ajoutez-en un pour obtenir la commande d'installation de l'agent.</p>
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Ajouter un hôte</Button>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nom</th><th>État</th><th>Système</th><th className="r">CPU</th><th className="r">Mémoire</th><th className="r">Disque</th><th className="r">Réseau ↓ / ↑</th><th>Dernier contact</th></tr></thead>
              <tbody>
                {data?.map((h) => (
                  <tr key={h.id} className="link" onClick={() => navigate(`/hosts/${h.id}`)}>
                    <td><Link to={`/hosts/${h.id}`}>{h.name}</Link></td>
                    <td><StatusBadge status={h.status} /></td>
                    <td className="muted">{h.info.os || "—"}</td>
                    <td className="r">{fmtPct(h.latest.cpu)}</td>
                    <td className="r">{fmtPct(pct(h.latest.mem_used, h.latest.mem_total))}</td>
                    <td className="r">{fmtPct(pct(h.latest.disk_used, h.latest.disk_total))}</td>
                    <td className="r">{fmtBytes(h.latest.net_rx, true)} / {fmtBytes(h.latest.net_tx, true)}</td>
                    <td className="muted">{fmtAgo(h.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <AddHostWizard open={adding} onClose={() => { setAdding(false); refresh(); }} />
    </div>
  );
}

type Range = "1h" | "24h" | "7d" | "30d";

export function HostDetailPage({ id }: { id: number }) {
  const host = usePoll(() => api.get<Host>(`/api/hosts/${id}`), 10000, [id]);
  const [range, setRange] = useState<Range>("24h");
  const metrics = usePoll(() => api.get<HostSeries>(`/api/hosts/${id}/metrics?range=${range}`), 30000, [id, range]);
  const disks = usePoll(() => api.get<HostDisks[]>("/api/disks"), 300000, [id]);
  const myDisks = disks.data?.find((d) => d.host_id === id);
  const [install, setInstall] = useState<Install>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const h = host.data;
  const m = metrics.data;

  const charts = useMemo(() => m && {
    t: m.t as number[],
    cpu: [{ label: "CPU", values: m.cpu }],
    mem: [{ label: "Mémoire", values: m.mem }, { label: "Swap", values: m.swap }],
    net: [{ label: "Reçu", values: m.net_rx }, { label: "Envoyé", values: m.net_tx }],
    disk: [{ label: "Disque", values: m.disk }],
    temp: [{ label: "Température max.", values: m.temp }],
    load: [{ label: "Charge (1 min)", values: m.load1 }],
  }, [m]);

  const update = async (patch: Partial<Host>) => {
    try {
      host.setData(await api.patch<Host>(`/api/hosts/${id}`, patch));
    } catch (e) { toast((e as Error).message); }
  };

  if (host.error) return <div className="page"><Alert tone="danger" title="Hôte introuvable">{host.error}</Alert></div>;
  if (!h) return null;
  const l = h.latest;
  const pctFmt = (v: number) => `${Math.round(v)} %`;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb"><Link to="/hosts">Hôtes</Link><ChevronRight size={14} aria-hidden />{h.name}</div>
          <h1>{h.name}</h1>
          <p className="muted" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge status={h.status} />{h.connected ? "Agent connecté" : `Dernier contact ${fmtAgo(h.last_seen)}`}
          </p>
        </div>
        <div className="actions">
          <Switch label="Maintenance" checked={h.maintenance} onChange={(v) => update({ maintenance: v })} />
          <Button icon={<KeyRound />} onClick={() => api.post<{ install: Install }>(`/api/hosts/${id}/token`).then((r) => setInstall(r.install))}>Régénérer le jeton</Button>
          <Button variant="ghost" icon={<Trash2 />} onClick={() => setConfirmDelete(true)}>Supprimer</Button>
        </div>
      </div>

      <div className="grid split">
        <Card title="Utilisation" sub={`Mesure ${fmtAgo(h.last_seen)}`}>
          <div className="form">
            <Progress label="CPU" value={l.cpu ?? null} />
            <Progress label="Mémoire" value={pct(l.mem_used, l.mem_total)} text={`${fmtBytes(l.mem_used)} / ${fmtBytes(l.mem_total)}`} />
            {!!l.swap_total && <Progress label="Swap" value={pct(l.swap_used, l.swap_total)} text={`${fmtBytes(l.swap_used)} / ${fmtBytes(l.swap_total)}`} />}
            {l.disks?.map((d) => (
              <Progress key={d.mount} label={`Disque ${d.mount}`} value={pct(d.used, d.total)} text={`${fmtBytes(d.used)} / ${fmtBytes(d.total)}`} />
            ))}
          </div>
        </Card>
        <Card title="Informations">
          <dl className="kv">
            <dt>Nom d'hôte</dt><dd>{h.info.hostname || "—"}</dd>
            <dt>Système</dt><dd>{h.info.os || "—"}</dd>
            <dt>Noyau</dt><dd className="mono">{h.info.kernel || "—"}</dd>
            <dt>Architecture</dt><dd>{h.info.arch || "—"}</dd>
            <dt>Processeur</dt><dd>{h.info.cpu_model || "—"}{h.info.cpu_cores ? ` · ${h.info.cpu_cores} cœurs` : ""}</dd>
            <dt>Mémoire</dt><dd>{fmtBytes(h.info.mem_total)}</dd>
            <dt>Démarré le</dt><dd>{h.info.boot_time ? fmtDate(h.info.boot_time) : "—"}</dd>
            <dt>Charge</dt><dd className="num">{l.load1?.toFixed(2).replace(".", ",") ?? "—"}</dd>
            <dt>Agent</dt><dd className="mono">{h.info.agent_version || "—"}</dd>
          </dl>
        </Card>
      </div>

      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2>Historique</h2>
        <Segmented label="Période" value={range} onChange={setRange} options={[["1h", "1 h"], ["24h", "24 h"], ["7d", "7 j"], ["30d", "30 j"]]} />
      </div>
      {charts && (
        <div className="grid cols-2">
          <Card title="CPU"><Chart t={charts.t} series={charts.cpu} format={pctFmt} max={100} /></Card>
          <Card title="Mémoire"><Chart t={charts.t} series={charts.mem} format={pctFmt} max={100} /></Card>
          <Card title="Bande passante"><Chart t={charts.t} series={charts.net} format={(v) => fmtBytes(v, true)} /></Card>
          <Card title="Disque"><Chart t={charts.t} series={charts.disk} format={pctFmt} max={100} /></Card>
          <Card title="Température"><Chart t={charts.t} series={charts.temp} format={(v) => `${Math.round(v)} °C`} /></Card>
          <Card title="Charge système"><Chart t={charts.t} series={charts.load} format={(v) => v.toFixed(1).replace(".", ",")} /></Card>
        </div>
      )}

      {myDisks && (
        <>
          <h2>Santé des disques</h2>
          {myDisks.error && <Alert tone="info" title={myDisks.error} />}
          {myDisks.disks.length === 0 && !myDisks.error && <p className="small muted">Aucun disque compatible SMART (machine virtuelle ?).</p>}
          <div className="grid cols-2">{myDisks.disks.map((d) => <DiskCard key={d.name + d.serial} d={d} />)}</div>
        </>
      )}

      <div className="grid cols-2">
        <Card title="Interfaces réseau" flush>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Interface</th><th className="r">Reçu</th><th className="r">Envoyé</th></tr></thead>
              <tbody>{l.ifaces?.map((i) => <tr key={i.name}><td className="mono">{i.name}</td><td className="r">{fmtBytes(i.rx, true)}</td><td className="r">{fmtBytes(i.tx, true)}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
        <Card title="Capteurs de température" flush>
          {l.temps?.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Capteur</th><th className="r">Température</th></tr></thead>
                <tbody>{l.temps.map((t, i) => <tr key={i}><td>{t.label}</td><td className="r">{Math.round(t.c)} °C</td></tr>)}</tbody>
              </table>
            </div>
          ) : <div className="empty small">Aucun capteur exposé par cette machine.</div>}
        </Card>
      </div>

      <Dialog open={!!install} onClose={() => setInstall(undefined)} wide title="Nouveau jeton" description="L'ancien jeton est révoqué et l'agent a été déconnecté."
        footer={<Button variant="primary" onClick={() => setInstall(undefined)}>Terminer</Button>}>
        {install && <InstallInstructions install={install} name={h.name} />}
      </Dialog>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Supprimer ${h.name}`}
        description="L'hôte et tout son historique de métriques seront supprimés définitivement."
        footer={<><Button onClick={() => setConfirmDelete(false)}>Annuler</Button>
          <Button variant="danger" onClick={() => api.del(`/api/hosts/${id}`).then(() => { toast("Hôte supprimé"); navigate("/hosts"); })}>Supprimer l'hôte</Button></>}>
        <p className="small muted">L'agent installé sur la machine ne pourra plus se connecter.</p>
      </Dialog>
    </div>
  );
}
