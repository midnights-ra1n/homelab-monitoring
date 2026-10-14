import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, fmtAgo, fmtDate, type Host } from "../api";
import { Alert, Card, IconButton, Kpi, Link, Switch, usePoll } from "../ui";

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

export function UpdatesPage() {
  const { data, error } = usePoll(() => api.get<Host[]>("/api/hosts?packages=1"), 60000);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [securityOnly, setSecurityOnly] = useState(false);
  const hosts = data ?? [];
  const missing = hosts.filter((h) => !h.updates);

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Mises à jour</h1><p className="muted">Paquets en attente sur chaque hôte (apt), relevés toutes les 6 heures par l'agent.</p></div>
        <div className="actions"><Switch label="Sécurité uniquement" checked={securityOnly} onChange={setSecurityOnly} /></div>
      </div>
      {error && <Alert tone="danger" title="Impossible de charger les mises à jour">{error}</Alert>}
      {data && <UpdateKpis hosts={hosts} />}
      <Card flush>
        <div className="table-wrap">
          <table>
            <thead><tr><th style={{ width: 44 }}><span className="sr-only">Détail</span></th><th>Hôte</th><th className="r">En attente</th><th className="r">Sécurité</th><th>Redémarrage</th><th>Listes apt</th><th>Analyse</th></tr></thead>
            <tbody>
              {hosts.filter((h) => h.updates).map((h) => {
                const u = h.updates!;
                const pkgs = (u.packages ?? []).filter((p) => !securityOnly || p.security);
                const isOpen = !!open[h.id];
                return (
                  <Fragment key={h.id}>
                    <tr>
                      <td>{u.pending > 0 && <IconButton label={isOpen ? "Masquer les paquets" : "Afficher les paquets"} aria-expanded={isOpen} icon={isOpen ? <ChevronDown /> : <ChevronRight />} className="sm" onClick={() => setOpen({ ...open, [h.id]: !isOpen })} />}</td>
                      <td><Link to={`/hosts/${h.id}`}>{h.name}</Link><div className="xs tertiary">{h.info.os}</div></td>
                      <td className="r">{u.pending}</td>
                      <td className="r">{u.security > 0 ? <span className="badge s-minor_outage">{u.security}</span> : 0}</td>
                      <td>{u.reboot_required ? <span className="badge s-degraded"><span className="dot" aria-hidden />Requis</span> : <span className="muted">Non</span>}</td>
                      <td className="muted" title={u.lists_updated_at ? fmtDate(u.lists_updated_at) : undefined}>{u.lists_updated_at ? fmtAgo(u.lists_updated_at) : "—"}</td>
                      <td className="muted">{fmtAgo(u.checked_at)}</td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={7} style={{ padding: 0, background: "var(--bg-subtle)" }}>
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
        {data && hosts.every((h) => !h.updates) && <div className="empty small">Aucun hôte n'a encore remonté ses mises à jour. L'agent les analyse au démarrage puis toutes les 6 heures (Debian / apt).</div>}
      </Card>
      {missing.length > 0 && hosts.some((h) => h.updates) && (
        <p className="small muted">Sans données : {missing.map((h) => h.name).join(", ")} (agent hors ligne ou système sans apt).</p>
      )}
    </div>
  );
}
