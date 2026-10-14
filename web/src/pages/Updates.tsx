import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Download, RefreshCw } from "lucide-react";
import { actionBusy, api, fmtAgo, fmtDate, type Host } from "../api";
import { Alert, Button, Card, Dialog, IconButton, Kpi, Link, Switch, usePoll } from "../ui";
import { useHostAction } from "./AgentVersion";

export function updateTotals(hosts: Host[]) {
  const reporting = hosts.filter((h) => h.updates);
  return {
    reporting: reporting.length,
    pending: reporting.reduce((a, h) => a + (h.updates?.pending ?? 0), 0),
    security: reporting.reduce((a, h) => a + (h.updates?.security ?? 0), 0),
    reboot: reporting.filter((h) => h.updates?.reboot_required).length,
    upToDate: reporting.filter((h) => !h.updates?.pending).length,
  };
}

export function UpdateKpis({ hosts }: { hosts: Host[] }) {
  const t = updateTotals(hosts);
  return (
    <div className="grid kpis">
      <Kpi label="Paquets en attente" value={<span className="num">{t.pending}</span>} detail={`${t.reporting} hôte(s) analysé(s)`} />
      <Kpi label="Mises à jour de sécurité" value={<span className="num">{t.security}</span>} />
      <Kpi label="Redémarrages requis" value={<span className="num">{t.reboot}</span>} />
      <Kpi label="Hôtes à jour" value={<span className="num">{t.upToDate} / {t.reporting}</span>} />
    </div>
  );
}

function ActionStatus({ h }: { h: Host }) {
  const a = h.action;
  if (!a || a.action === "update_agent") return null;
  const what = a.action === "apply_updates" ? "Installation des mises à jour" : "Vérification";
  if (actionBusy(h)) return <span className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span className="spinner" aria-hidden />{what} en cours…</span>;
  if (a.state === "pending" || a.state === "running") return <span className="small" style={{ color: "var(--danger-fg)" }}>{what} sans réponse</span>;
  return (
    <details className="small">
      <summary style={{ cursor: "pointer", color: a.state === "failed" ? "var(--danger-fg)" : "var(--text-secondary)" }}>
        {what} {a.state === "failed" ? "en échec" : "terminée"} {fmtAgo(a.at)}
      </summary>
      {a.message && <pre className="codeblock" style={{ marginTop: 6, paddingRight: 12, maxHeight: 220, overflow: "auto" }}>{a.message}</pre>}
    </details>
  );
}

export function UpdatesPage() {
  const { data, error, refresh } = usePoll(() => api.get<Host[]>("/api/hosts?packages=1"), 8000);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [securityOnly, setSecurityOnly] = useState(false);
  const [confirm, setConfirm] = useState<Host>();
  const { run, busy } = useHostAction(() => refresh());
  const hosts = data ?? [];
  const ready = (h: Host) => h.connected && !actionBusy(h);

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Mises à jour</h1><p className="muted">Paquets en attente sur chaque hôte (apt), relevés toutes les 6 heures par l'agent, ou à la demande.</p></div>
        <div className="actions" style={{ alignItems: "center" }}>
          <Switch label="Sécurité uniquement" checked={securityOnly} onChange={setSecurityOnly} />
          <Button icon={<RefreshCw />} disabled={!hosts.some(ready)} onClick={() => hosts.filter(ready).forEach((h) => run(h, "check_updates"))}>Tout vérifier</Button>
        </div>
      </div>
      {error && <Alert tone="danger" title="Impossible de charger les mises à jour">{error}</Alert>}
      {data && <UpdateKpis hosts={hosts} />}
      <Card flush>
        {data && hosts.length === 0 ? <div className="empty small">Aucun hôte. Installez l'agent depuis la page Hôtes.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 44 }}><span className="sr-only">Détail</span></th><th>Hôte</th><th className="r">En attente</th><th className="r">Sécurité</th><th>Redémarrage</th><th>Listes apt</th><th>Analyse</th><th className="r">Actions</th></tr></thead>
              <tbody>
                {hosts.map((h) => {
                  const u = h.updates;
                  const pkgs = (u?.packages ?? []).filter((p) => !securityOnly || p.security);
                  const isOpen = !!open[h.id];
                  return (
                    <Fragment key={h.id}>
                      <tr>
                        <td>{!!u?.pending && <IconButton label={isOpen ? "Masquer les paquets" : "Afficher les paquets"} aria-expanded={isOpen} icon={isOpen ? <ChevronDown /> : <ChevronRight />} className="sm" onClick={() => setOpen({ ...open, [h.id]: !isOpen })} />}</td>
                        <td><Link to={`/hosts/${h.id}`}>{h.name}</Link><div className="xs tertiary">{h.info.os || (h.connected ? "" : "Agent hors ligne")}</div><ActionStatus h={h} /></td>
                        <td className="r">{u ? u.pending : "—"}</td>
                        <td className="r">{!u ? "—" : u.security > 0 ? <span className="badge s-minor_outage">{u.security}</span> : 0}</td>
                        <td>{!u ? "—" : u.reboot_required ? <span className="badge s-degraded"><span className="dot" aria-hidden />Requis</span> : <span className="muted">Non</span>}</td>
                        <td className="muted" title={u?.lists_updated_at ? fmtDate(u.lists_updated_at) : undefined}>{u?.lists_updated_at ? fmtAgo(u.lists_updated_at) : "—"}</td>
                        <td className="muted">{u ? fmtAgo(u.checked_at) : "Pas encore"}</td>
                        <td className="r" style={{ whiteSpace: "nowrap" }}>
                          <Button size="sm" variant="ghost" icon={<RefreshCw />} disabled={!ready(h)} loading={busy === `${h.id}:check_updates`}
                            title={h.connected ? "apt-get update puis nouvelle analyse" : "Agent hors ligne"} onClick={() => run(h, "check_updates")}>Vérifier</Button>
                          <Button size="sm" icon={<Download />} disabled={!ready(h) || !u?.pending} loading={busy === `${h.id}:apply_updates`}
                            onClick={() => setConfirm(h)}>Mettre à jour</Button>
                        </td>
                      </tr>
                      {isOpen && u && (
                        <tr><td colSpan={8} style={{ padding: 0, background: "var(--bg-subtle)" }}>
                          <table>
                            <thead><tr><th style={{ paddingLeft: 56 }}>Paquet</th><th>Version installée</th><th>Nouvelle version</th><th>Type</th></tr></thead>
                            <tbody>
                              {pkgs.length === 0 && <tr><td colSpan={4} className="muted" style={{ paddingLeft: 56 }}>Aucune mise à jour de sécurité.</td></tr>}
                              {pkgs.map((p) => (
                                <tr key={p.name}>
                                  <td className="mono" style={{ paddingLeft: 56 }}>{p.name}</td>
                                  <td className="mono muted">{p.current || "nouveau"}</td>
                                  <td className="mono">{p.candidate}</td>
                                  <td>{p.security ? <span className="badge s-minor_outage">Sécurité</span> : <span className="badge">Standard</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Dialog open={!!confirm} onClose={() => setConfirm(undefined)} title={`Mettre à jour ${confirm?.name ?? ""}`}
        description={`${confirm?.updates?.pending ?? 0} paquet(s) seront installés (apt-get upgrade, configuration locale conservée, aucun paquet supprimé).`}
        footer={<><Button onClick={() => setConfirm(undefined)}>Annuler</Button>
          <Button variant="primary" icon={<Download />} onClick={() => { const h = confirm!; setConfirm(undefined); run(h, "apply_updates"); }}>Installer les mises à jour</Button></>}>
        <p className="small muted">L'hôte n'est pas redémarré automatiquement{confirm?.updates?.reboot_required ? " ; un redémarrage est déjà requis" : ""}. Le journal apt s'affiche sous le nom de l'hôte une fois l'opération terminée.</p>
      </Dialog>
    </div>
  );
}
