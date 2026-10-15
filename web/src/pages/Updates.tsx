import { Fragment, useState } from "react";
import { ArrowUpRight, ChevronRight, Container, Download, LoaderCircle, PackageCheck, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { actionBusy, api, fmtAgo, fmtDate, type Host } from "../api";
import {
  Alert, Badge, Button, Card, Dialog, EmptyState, IconButton, Link, PageHeader, SECTIONS, STAT_GRID, Skeleton, Stat, StatusIcon, Switch, cn, usePoll,
} from "../ui";
import { useHostAction } from "./AgentVersion";

export function updateTotals(hosts: Host[]) {
  const reporting = hosts.filter((h) => h.updates);
  return {
    reporting: reporting.length,
    pending: reporting.reduce((a, h) => a + (h.updates?.pending ?? 0), 0),
    security: reporting.reduce((a, h) => a + (h.updates?.security ?? 0), 0),
    reboot: reporting.filter((h) => h.updates?.reboot_required).length,
    images: hosts.reduce((a, h) => a + (h.docker?.updates_available ?? 0), 0),
    upToDate: reporting.filter((h) => !h.updates?.pending).length,
  };
}

export function UpdateKpis({ hosts }: { hosts: Host[] }) {
  const t = updateTotals(hosts);
  return (
    <div className={STAT_GRID}>
      <Stat label="Hôtes à jour" value={`${t.upToDate}/${t.reporting}`} icon={<PackageCheck size={16} />} tone={t.upToDate === t.reporting ? "green" : undefined} detail={`${t.reporting} hôte(s) analysé(s)`} />
      <Stat label="Paquets en attente" value={t.pending} detail="tous hôtes confondus" />
      <Stat label="Sécurité" value={t.security} detail="correctifs de sécurité" icon={<ShieldAlert size={16} />} tone={t.security ? "red" : undefined} />
      <Stat label="Redémarrages" value={t.reboot} detail="hôte(s) à redémarrer" icon={<RotateCcw size={16} />} tone={t.reboot ? "yellow" : undefined} />
    </div>
  );
}

const logClass = "mt-2 max-h-56 overflow-auto rounded-xl border border-line bg-field p-3 font-mono text-xs whitespace-pre-wrap text-h2";

function ActionStatus({ h }: { h: Host }) {
  const a = h.action;
  if (!a || a.action === "update_agent") return null;
  const what = a.action === "apply_updates" ? "Installation des mises à jour" : "Vérification";
  if (actionBusy(h)) return <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-meta"><LoaderCircle size={12} className="animate-spin" aria-hidden />{what} en cours…</span>;
  if (a.state === "pending" || a.state === "running") return <span className="mt-1 block text-xs text-red">{what} sans réponse</span>;
  return (
    <details className="mt-1 text-xs">
      <summary className={cn("cursor-pointer", a.state === "failed" ? "text-red" : "text-meta")}>{what} {a.state === "failed" ? "en échec" : "terminée"} {fmtAgo(a.at)}</summary>
      {a.message && <pre className={logClass}>{a.message}</pre>}
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
  const images = updateTotals(hosts).images;

  return (
    <>
      <PageHeader title="Mises à jour" description="Paquets en attente sur chaque hôte (apt), relevés toutes les 6 heures par l'agent, ou à la demande."
        actions={<Button variant="secondary" icon={<RefreshCw size={16} />} disabled={!hosts.some(ready)} onClick={() => hosts.filter(ready).forEach((h) => run(h, "check_updates"))}>Tout vérifier</Button>} />
      {error && <Alert kind="error" title="Impossible de charger les mises à jour" className="mb-6">{error}</Alert>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && (
        <div className={SECTIONS}>
          <UpdateKpis hosts={hosts} />
          {images > 0 && (
            <Link to="/containers?filtre=maj" className="-mt-6 flex items-center gap-2.5 rounded-xl border border-line-subtle bg-box px-4 py-3 text-sm no-underline hover:border-line-strong">
              <Container size={16} className="text-accent-text" aria-hidden />
              <span className="flex-1 text-h2">{images} image(s) Docker à mettre à jour</span>
              <ArrowUpRight size={14} className="text-meta" aria-hidden />
            </Link>
          )}
          {hosts.length === 0 ? (
            <EmptyState icon={<PackageCheck size={20} />} title="Aucun hôte">Installe l'agent depuis la page Hôtes.</EmptyState>
          ) : (
            <Card flush title="Hôtes" sub={`${hosts.length} hôte(s)`} actions={<Switch label="Sécurité uniquement" checked={securityOnly} onChange={setSecurityOnly} />}>
              <div className="mm-table-wrap">
                <table className="mm-table min-w-[60rem]">
                  <thead><tr><th scope="col" className="mm-col-check"><span className="sr-only">Détail</span></th><th scope="col">Hôte</th><th scope="col" className="mm-col-num">En attente</th><th scope="col" className="mm-col-num">Sécurité</th><th scope="col">Redémarrage</th><th scope="col">Listes apt</th><th scope="col">Analyse</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {hosts.map((h) => {
                      const u = h.updates;
                      const pkgs = (u?.packages ?? []).filter((p) => !securityOnly || p.security);
                      const isOpen = !!open[h.id];
                      return (
                        <Fragment key={h.id}>
                          <tr className="group">
                            <td className="mm-col-check">{!!u?.pending && (
                              <IconButton label={isOpen ? "Masquer les paquets" : "Afficher les paquets"} aria-expanded={isOpen} className="size-6!"
                                icon={<ChevronRight size={14} className={cn("transition-transform duration-[120ms]", isOpen && "rotate-90")} />} onClick={() => setOpen({ ...open, [h.id]: !isOpen })} />
                            )}</td>
                            <td className="mm-col-strong max-w-[22rem]">
                              <Link to={`/hosts/${h.id}`} className="flex min-w-0 items-center gap-2.5 py-1.5 text-inherit no-underline hover:text-accent-text">
                                <StatusIcon kind={!u ? "pending" : u.security ? "down" : u.pending || u.reboot_required ? "warn" : "ok"} />
                                <span className="min-w-0"><span className="block truncate">{h.name}</span><span className="block truncate font-mono text-xs font-normal text-meta">{h.info.os || (h.connected ? "" : "Agent hors ligne")}</span></span>
                              </Link>
                              <ActionStatus h={h} />
                            </td>
                            <td className="mm-col-num font-mono">{u ? u.pending : "—"}</td>
                            <td className="mm-col-num">{!u ? "—" : u.security > 0 ? <Badge tone="red">{u.security} sécu.</Badge> : <span className="font-mono">0</span>}</td>
                            <td>{!u ? "—" : u.reboot_required ? <Badge tone="yellow" dot>Requis</Badge> : <span className="text-meta">Non</span>}</td>
                            <td className="mm-col-muted" title={u?.lists_updated_at ? fmtDate(u.lists_updated_at) : undefined}>{u?.lists_updated_at ? fmtAgo(u.lists_updated_at) : "—"}</td>
                            <td className="mm-col-muted">{u ? fmtAgo(u.checked_at) : "Pas encore"}</td>
                            <td className="w-px">
                              <div className="flex justify-end gap-1">
                                <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} disabled={!ready(h)} loading={busy === `${h.id}:check_updates`}
                                  title={h.connected ? "apt-get update puis nouvelle analyse" : "Agent hors ligne"} onClick={() => run(h, "check_updates")}>Vérifier</Button>
                                <Button variant="secondary" size="sm" icon={<Download size={14} />} disabled={!ready(h) || !u?.pending} loading={busy === `${h.id}:apply_updates`}
                                  onClick={() => setConfirm(h)}>Mettre à jour</Button>
                              </div>
                            </td>
                          </tr>
                          {isOpen && u && (
                            <tr><td colSpan={8} className="bg-page p-0!">
                              <table className="mm-table mm-table--dense">
                                <thead><tr><th scope="col" className="pl-14!">Paquet</th><th scope="col">Version installée</th><th scope="col">Nouvelle version</th><th scope="col">Type</th></tr></thead>
                                <tbody>
                                  {pkgs.length === 0 && <tr><td colSpan={4} className="pl-14! text-meta">Aucune mise à jour de sécurité.</td></tr>}
                                  {pkgs.map((p) => (
                                    <tr key={p.name}>
                                      <td className="mm-col-strong pl-14! font-mono text-xs">{p.name}</td>
                                      <td className="mm-col-muted font-mono text-xs">{p.current || "nouveau"}</td>
                                      <td className="font-mono text-xs">{p.candidate}</td>
                                      <td>{p.security ? <Badge tone="red" dot>Sécurité</Badge> : <Badge>Standard</Badge>}</td>
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
            </Card>
          )}
        </div>
      )}
      <Dialog open={!!confirm} onClose={() => setConfirm(undefined)} size="sm" title={`Mettre à jour ${confirm?.name ?? ""}`}
        footer={<><Button variant="secondary" onClick={() => setConfirm(undefined)}>Annuler</Button>
          <Button icon={<Download size={16} />} onClick={() => { const h = confirm!; setConfirm(undefined); run(h, "apply_updates"); }}>Installer les mises à jour</Button></>}>
        <p className="text-sm leading-relaxed text-body">
          {confirm?.updates?.pending ?? 0} paquet(s) seront installés (apt-get upgrade, configuration locale conservée, aucun paquet supprimé).
          L'hôte n'est pas redémarré automatiquement{confirm?.updates?.reboot_required ? " ; un redémarrage est déjà requis" : ""}. Le journal apt s'affiche sous le nom de l'hôte une fois l'opération terminée.
        </p>
      </Dialog>
    </>
  );
}
