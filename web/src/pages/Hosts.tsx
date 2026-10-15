import { useMemo, useState } from "react";
import { ChevronRight, Cpu, HardDrive, KeyRound, MemoryStick, Plus, Server, Thermometer, Trash2, Users } from "lucide-react";
import { api, fmtAgo, fmtBytes, fmtDate, fmtPct, pct, type Host, type HostSeries, type Install } from "../api";
import {
  Alert, Button, Card, CardBody, CardHeader, Chart, CodeBlock, Dialog, EmptyState, Link, Meter, PageHeader, SECTIONS, STAT_GRID, SectionTitle, Segmented,
  Skeleton, Stat, StatusBadge, StatusIcon, Switch, Tag, cn, navigate, usePoll, useTitle, useToast,
} from "../ui";
import { DiskCard, type HostDisks } from "./Disks";
import { AddHostWizard, InstallInstructions, UNINSTALL_COMMAND } from "./AddHostWizard";
import { MassDeployDialog } from "./MassDeploy";
import { AgentVersion, useHostAction } from "./AgentVersion";
import { ContainersTable } from "./Containers";

export function HostsPage() {
  const { data, error, refresh } = usePoll(() => api.get<Host[]>("/api/hosts"), 15000);
  const [adding, setAdding] = useState(false);
  const [mass, setMass] = useState(false);
  const online = data?.filter((h) => h.connected).length ?? 0;
  return (
    <>
      <PageHeader title="Hôtes" description="Machines virtuelles, serveurs Proxmox, serveurs physiques et postes équipés de l'agent."
        actions={<>
          <Button variant="secondary" icon={<Users size={16} />} onClick={() => setMass(true)}>Déploiement en masse</Button>
          <Button icon={<Plus size={16} />} onClick={() => setAdding(true)}>Ajouter un hôte</Button>
        </>} />
      {error && <Alert kind="error" title="Impossible de charger les hôtes" className="mb-6">{error}</Alert>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && data.length === 0 && (
        <EmptyState icon={<Server size={20} />} title="Aucun hôte supervisé"
          action={<Button icon={<Plus size={16} />} onClick={() => setAdding(true)}>Ajouter un hôte</Button>}>
          Ajoute un hôte pour obtenir la commande d'installation de l'agent.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <Card flush title="Hôtes" sub={`${data.length} hôte(s) · ${online} agent(s) connecté(s)`}>
          <ul className="mm-list sm:hidden">
            {data.map((h) => (
              <li key={h.id}>
                <Link to={`/hosts/${h.id}`} className="mm-list__item items-center no-underline">
                  <span className="flex min-w-0 items-center gap-3">
                    <StatusIcon status={h.status} size={18} />
                    <span className="min-w-0">
                      <span className="mm-list__title block">{h.name}</span>
                      <span className="mm-list__meta block truncate font-mono">CPU {fmtPct(h.latest.cpu)} · RAM {fmtPct(pct(h.latest.mem_used, h.latest.mem_total))}</span>
                    </span>
                  </span>
                  <StatusBadge status={h.status} />
                </Link>
              </li>
            ))}
          </ul>
          <div className="mm-table-wrap hidden sm:block">
            <table className="mm-table min-w-[60rem]">
              <thead><tr><th scope="col">Nom</th><th scope="col">État</th><th scope="col">Système</th><th scope="col" className="mm-col-num">CPU</th><th scope="col" className="mm-col-num">Mémoire</th><th scope="col" className="mm-col-num">Disque</th><th scope="col" className="mm-col-num">Réseau ↓ / ↑</th><th scope="col">Agent</th><th scope="col">Dernier contact</th></tr></thead>
              <tbody>
                {data.map((h) => (
                  <tr key={h.id} className="cursor-pointer" onClick={() => navigate(`/hosts/${h.id}`)}>
                    <td className="mm-col-strong">
                      <Link to={`/hosts/${h.id}`} className="flex min-w-0 items-center gap-2.5 text-inherit no-underline hover:text-accent-text">
                        <StatusIcon status={h.status} />
                        <span className="min-w-0">
                          <span className="block truncate">{h.name}</span>
                          {h.info.hostname && h.info.hostname !== h.name && <span className="block truncate font-mono text-xs font-normal text-meta">{h.info.hostname}</span>}
                        </span>
                      </Link>
                    </td>
                    <td><StatusBadge status={h.status} /></td>
                    <td className="mm-col-muted max-w-56 truncate">{h.info.os || "—"}</td>
                    <td className="mm-col-num font-mono text-xs">{fmtPct(h.latest.cpu)}</td>
                    <td className="mm-col-num font-mono text-xs">{fmtPct(pct(h.latest.mem_used, h.latest.mem_total))}</td>
                    <td className="mm-col-num font-mono text-xs">{fmtPct(pct(h.latest.disk_used, h.latest.disk_total))}</td>
                    <td className="mm-col-num font-mono text-xs">{fmtBytes(h.latest.net_rx, true)} / {fmtBytes(h.latest.net_tx, true)}</td>
                    <td><AgentVersion h={h} /></td>
                    <td className="mm-col-muted">{fmtAgo(h.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <AddHostWizard open={adding} onClose={() => { setAdding(false); refresh(); }} />
      <MassDeployDialog open={mass} onClose={() => { setMass(false); refresh(); }} />
    </>
  );
}

type Range = "1h" | "24h" | "7d" | "30d";

export function HostDetailPage({ id }: { id: number }) {
  const host = usePoll(() => api.get<Host>(`/api/hosts/${id}`), 10000, [id]);
  const [range, setRange] = useState<Range>("24h");
  const metrics = usePoll(() => api.get<HostSeries>(`/api/hosts/${id}/metrics?range=${range}`), 30000, [id, range]);
  const agentAction = useHostAction((updated) => host.setData(updated));
  const disks = usePoll(() => api.get<HostDisks[]>("/api/disks"), 300000, [id]);
  const myDisks = disks.data?.find((d) => d.host_id === id);
  const [install, setInstall] = useState<Install>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const h = host.data;
  useTitle(h?.name ?? "Hôtes");
  const m = metrics.data;

  const charts = useMemo(() => m && {
    t: m.t as number[],
    cpu: [{ label: "CPU", values: m.cpu }],
    mem: [{ label: "Mémoire", values: m.mem }, { label: "Swap", values: m.swap }],
    net: [{ label: "Reçu", values: m.net_rx }, { label: "Envoyé", values: m.net_tx }],
    disk: [{ label: "Disque", values: m.disk }],
    temp: m.cpu_temp?.some((v) => v != null)
      ? [{ label: "CPU", values: m.cpu_temp }, { label: "Capteur le plus chaud", values: m.temp }]
      : [{ label: "Capteur le plus chaud", values: m.temp }],
    load: [{ label: "Charge (1 min)", values: m.load1 }],
  }, [m]);

  const update = async (patch: Partial<Host>) => {
    try {
      host.setData(await api.patch<Host>(`/api/hosts/${id}`, patch));
    } catch (e) { toast((e as Error).message, "error"); }
  };

  if (host.error) return <Alert kind="error" title="Hôte introuvable">{host.error}</Alert>;
  if (!h) return <Skeleton className="h-72" />;
  const l = h.latest;
  const pctFmt = (v: number) => `${Math.round(v)} %`;
  const temp = l.cpu_temp ?? l.temp;

  return (
    <>
      <PageHeader
        crumbs={<><Link to="/hosts" className="text-meta no-underline hover:text-accent-text">Hôtes</Link><ChevronRight size={14} aria-hidden /><span className="text-h2">{h.name}</span></>}
        title={<span className="flex items-center gap-3"><StatusIcon status={h.status} size={26} />{h.name}</span>}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={h.status} />{h.info.os && <Tag>{h.info.os}</Tag>}{h.connected ? "Agent connecté" : `Dernier contact ${fmtAgo(h.last_seen)}`}</span>}
        actions={<>
          <Switch label="Maintenance" checked={h.maintenance} onChange={(v) => update({ maintenance: v })} />
          <Button variant="secondary" icon={<KeyRound size={16} />} onClick={() => api.post<{ install: Install }>(`/api/hosts/${id}/token`).then((r) => setInstall(r.install))}>Régénérer le jeton</Button>
          <Button variant="danger-ghost" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>Supprimer</Button>
        </>} />

      <div className={SECTIONS}>
        <div className={STAT_GRID}>
          <Stat label="CPU" value={fmtPct(l.cpu)} icon={<Cpu size={16} />} tone={(l.cpu ?? 0) >= 90 ? "red" : undefined} detail={h.info.cpu_cores ? `${h.info.cpu_cores} cœurs · charge ${l.load1?.toFixed(2).replace(".", ",") ?? "—"}` : undefined} />
          <Stat label="Mémoire" value={fmtPct(pct(l.mem_used, l.mem_total))} icon={<MemoryStick size={16} />} detail={`${fmtBytes(l.mem_used)} / ${fmtBytes(l.mem_total)}`} />
          <Stat label="Disque" value={fmtPct(pct(l.disk_used, l.disk_total))} icon={<HardDrive size={16} />} detail={`${fmtBytes(l.disk_used)} / ${fmtBytes(l.disk_total)}`} />
          <Stat label="Température" value={temp != null ? `${Math.round(temp)} °C` : "—"} icon={<Thermometer size={16} />} tone={temp != null && temp > 80 ? "red" : undefined} detail={`Réseau ↓ ${fmtBytes(l.net_rx, true)} · ↑ ${fmtBytes(l.net_tx, true)}`} />
        </div>

        <div className="grid gap-8 xl:grid-cols-3 xl:gap-10">
          <Card className="xl:col-span-2">
            <CardHeader overline="Utilisation" title={`Mesure ${fmtAgo(h.last_seen)}`} />
            <CardBody className="grid gap-4">
              <Meter label="CPU" value={l.cpu ?? null} />
              <Meter label="Mémoire" value={pct(l.mem_used, l.mem_total)} detail={`${fmtBytes(l.mem_used)} / ${fmtBytes(l.mem_total)}`} />
              {!!l.swap_total && <Meter label="Swap" value={pct(l.swap_used, l.swap_total)} detail={`${fmtBytes(l.swap_used)} / ${fmtBytes(l.swap_total)}`} />}
              {l.disks?.map((d) => (
                <Meter key={d.mount} label={`Disque ${d.mount}`} value={pct(d.used, d.total)} detail={`${fmtBytes(d.used)} / ${fmtBytes(d.total)}`} />
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader overline="Machine" title={h.info.hostname || h.name} />
            <CardBody>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {([
                  ["Système", h.info.os],
                  ["Noyau", h.info.kernel],
                  ["Architecture", h.info.arch],
                  ["Mémoire", fmtBytes(h.info.mem_total)],
                  ["Démarré le", h.info.boot_time ? fmtDate(h.info.boot_time) : ""],
                  ["Charge", l.load1?.toFixed(2).replace(".", ",")],
                ] as [string, string | undefined][]).map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-meta">{k}</dt>
                    <dd className="mt-0.5 truncate font-mono text-h2" title={v}>{v || "—"}</dd>
                  </div>
                ))}
                <div className="col-span-2 min-w-0">
                  <dt className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-meta">Processeur</dt>
                  <dd className="mt-0.5 truncate font-mono text-h2" title={h.info.cpu_model}>{h.info.cpu_model || "—"}{h.info.cpu_cores ? ` · ${h.info.cpu_cores} cœurs` : ""}</dd>
                </div>
                <div className="col-span-2 min-w-0">
                  <dt className="mb-1 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-meta">Agent</dt>
                  <dd><AgentVersion h={h} onUpdate={() => agentAction.run(h, "update_agent")} updating={agentAction.busy === `${h.id}:update_agent`} />
                    {h.action?.action === "update_agent" && h.action.state === "failed" && <p className="mt-1 text-xs text-red">{h.action.message}</p>}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>
        </div>

        <section aria-labelledby="history-title">
          <SectionTitle id="history-title" actions={<Segmented size="sm" label="Période" value={range} onChange={setRange} options={[["1h", "1 h"], ["24h", "24 h"], ["7d", "7 j"], ["30d", "30 j"]]} />}>Historique</SectionTitle>
          {charts ? (
            <div className="grid gap-4 lg:grid-cols-2 xl:gap-6">
              <Card title="CPU"><Chart t={charts.t} series={charts.cpu} format={pctFmt} max={100} /></Card>
              <Card title="Mémoire"><Chart t={charts.t} series={charts.mem} format={pctFmt} max={100} /></Card>
              <Card title="Bande passante"><Chart t={charts.t} series={charts.net} format={(v) => fmtBytes(v, true)} /></Card>
              <Card title="Disque"><Chart t={charts.t} series={charts.disk} format={pctFmt} max={100} /></Card>
              <Card title="Température"><Chart t={charts.t} series={charts.temp} format={(v) => `${Math.round(v)} °C`} /></Card>
              <Card title="Charge système"><Chart t={charts.t} series={charts.load} format={(v) => v.toFixed(1).replace(".", ",")} /></Card>
            </div>
          ) : <Skeleton className="h-64" />}
        </section>

        {h.docker && (
          <section aria-labelledby="docker-title">
            <SectionTitle id="docker-title">Conteneurs Docker</SectionTitle>
            <Card flush title={`${h.docker.running}/${h.docker.containers.length} en cours`} sub={`Relevé ${fmtAgo(h.docker.collected_at)}`}>
              <ContainersTable h={h} onChanged={host.refresh} />
            </Card>
          </section>
        )}

        {myDisks && (
          <section aria-labelledby="disks-title">
            <SectionTitle id="disks-title">Santé des disques</SectionTitle>
            {myDisks.error && <Alert kind="info" title={myDisks.error} className="mb-4" />}
            {myDisks.disks.length === 0 && !myDisks.error && <p className="text-sm text-meta">Aucun disque compatible SMART (machine virtuelle ?).</p>}
            <div className="grid gap-4 lg:grid-cols-2 xl:gap-6">{myDisks.disks.map((d) => <DiskCard key={d.name + d.serial} d={d} />)}</div>
          </section>
        )}

        <div className="grid gap-8 lg:grid-cols-2 xl:gap-10">
          <Card flush title="Interfaces réseau" sub={`${l.ifaces?.length ?? 0} interface(s)`}>
            <div className="mm-table-wrap">
              <table className="mm-table">
                <thead><tr><th scope="col">Interface</th><th scope="col" className="mm-col-num">Reçu</th><th scope="col" className="mm-col-num">Envoyé</th></tr></thead>
                <tbody>{l.ifaces?.map((i) => <tr key={i.name}><td className="mm-col-strong font-mono">{i.name}</td><td className="mm-col-num font-mono text-xs">{fmtBytes(i.rx, true)}</td><td className="mm-col-num font-mono text-xs">{fmtBytes(i.tx, true)}</td></tr>)}</tbody>
              </table>
            </div>
          </Card>
          <Card flush title="Capteurs de température" sub={`${l.temps?.length ?? 0} capteur(s)`}>
            {l.temps?.length ? (
              <div className="mm-table-wrap">
                <table className="mm-table">
                  <thead><tr><th scope="col">Capteur</th><th scope="col" className="mm-col-num">Température</th></tr></thead>
                  <tbody>{l.temps.map((t, i) => <tr key={i}><td>{t.label}</td><td className={cn("mm-col-num font-mono text-xs", t.c > 80 && "text-red")}>{Math.round(t.c)} °C</td></tr>)}</tbody>
                </table>
              </div>
            ) : <p className="px-5 py-8 text-center text-sm text-meta">Aucun capteur exposé par cette machine.</p>}
          </Card>
        </div>
      </div>

      <Dialog open={!!install} onClose={() => setInstall(undefined)} size="lg" title="Nouveau jeton" description="L'ancien jeton est révoqué et l'agent a été déconnecté."
        footer={<Button onClick={() => setInstall(undefined)}>Terminer</Button>}>
        {install && <InstallInstructions install={install} name={h.name} />}
      </Dialog>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} size="sm" title={`Supprimer ${h.name}`}
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(false)}>Annuler</Button>
          <Button variant="danger" onClick={() => api.del(`/api/hosts/${id}`).then(() => { toast("Hôte supprimé"); navigate("/hosts"); })}>Supprimer l'hôte</Button></>}>
        <div className="grid gap-4">
          <p className="text-sm leading-relaxed text-body">L'hôte et tout son historique de métriques seront supprimés définitivement. L'agent ne pourra plus se connecter ; pour le retirer aussi de la machine :</p>
          <CodeBlock text={UNINSTALL_COMMAND} />
        </div>
      </Dialog>
    </>
  );
}
