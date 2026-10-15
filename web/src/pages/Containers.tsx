import { useState } from "react";
import { CircleAlert, Container, Download, LoaderCircle, Server } from "lucide-react";
import { actionBusy, api, fmtAgo, fmtBytes, fmtPct, type DockerContainer, type Host } from "../api";
import {
  Alert, Badge, Button, Card, Dialog, EmptyState, Link, PageHeader, SECTIONS, STAT_GRID, SectionTitle, Segmented, Skeleton, Stat, StatusIcon, cn,
  type StatusKind, type Tone, usePoll,
} from "../ui";
import { useHostAction } from "./AgentVersion";

const STATE: Record<string, [string, Tone]> = {
  running: ["En cours", "green"], exited: ["Arrêté", "muted"], restarting: ["Redémarre", "yellow"],
  paused: ["En pause", "blue"], created: ["Créé", "muted"], dead: ["Mort", "red"],
};
const UPDATE: Record<string, [string, Tone, string]> = {
  available: ["Mise à jour", "yellow", "Une image plus récente est publiée pour ce tag"],
  up_to_date: ["À jour", "green", "L'image locale correspond à celle du registre"],
  unknown: ["Inconnu", "muted", "Registre injoignable, privé, ou pas encore vérifié"],
  local: ["Image locale", "muted", "Image construite sur la machine, sans registre"],
  pinned: ["Figée", "muted", "Image référencée par empreinte : elle ne change jamais"],
};

function ContainerAction({ h, c, onAsk }: { h: Host; c: DockerContainer; onAsk: () => void }) {
  const a = h.action?.action === "update_container" && h.action.target === c.name ? h.action : undefined;
  if (a && actionBusy(h)) return <span className="inline-flex items-center gap-1.5 text-xs text-meta"><LoaderCircle size={12} className="animate-spin" aria-hidden />Mise à jour…</span>;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {a && a.state !== "pending" && a.state !== "running" && (
        <details className="text-left text-xs">
          <summary className={cn("cursor-pointer", a.state === "failed" ? "text-red" : "text-meta")}>{a.state === "failed" ? "Échec" : "Mis à jour"} {fmtAgo(a.at)}</summary>
          {a.message && <pre className="mt-2 max-h-52 max-w-[26rem] overflow-auto rounded-xl border border-line bg-field p-3 font-mono text-xs whitespace-pre-wrap text-h2">{a.message}</pre>}
        </details>
      )}
      {c.update === "available" && (
        c.compose_project
          ? <Button variant="secondary" size="sm" icon={<Download size={14} />} disabled={!h.connected || actionBusy(h)} title={h.connected ? undefined : "Agent hors ligne"} onClick={onAsk}>Mettre à jour</Button>
          : <span className="text-xs text-meta" title="Seuls les conteneurs Docker Compose peuvent être recréés automatiquement">Hors Compose</span>
      )}
    </span>
  );
}

const containerKind = (c: DockerContainer): StatusKind =>
  c.health === "unhealthy" ? "down" : c.state === "running" ? (c.health === "starting" ? "warn" : "ok") : c.state === "exited" || c.state === "created" ? "paused" : c.state === "dead" ? "down" : "warn";

/** Containers of one host, with resource usage and image update status. */
export function ContainersTable({ h, filter = "all", onChanged }: { h: Host; filter?: "all" | "updates" | "stopped"; onChanged?: () => void }) {
  const [confirm, setConfirm] = useState<DockerContainer>();
  const { run } = useHostAction(() => onChanged?.());
  const list = (h.docker?.containers ?? []).filter((c) => filter === "all" || (filter === "updates" ? c.update === "available" : c.state !== "running"));
  return (
    <>
      {h.docker?.error && <Alert kind="error" title="Docker n'a pas répondu" className="m-4">{h.docker.error}</Alert>}
      <div className="mm-table-wrap">
        <table className="mm-table min-w-[60rem]">
          <thead><tr><th scope="col">Conteneur</th><th scope="col">État</th><th scope="col">Image</th><th scope="col" className="mm-col-num">CPU</th><th scope="col" className="mm-col-num">Mémoire</th><th scope="col" className="mm-col-num">Réseau ↓ / ↑</th><th scope="col">Image à jour</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={8} className="text-center text-meta">Aucun conteneur{filter !== "all" ? " dans ce filtre" : ""}.</td></tr>}
            {list.map((c) => {
              const [st, stTone] = STATE[c.state] ?? [c.state, "muted" as Tone];
              const [up, upTone, upHint] = UPDATE[c.update] ?? UPDATE.unknown;
              return (
                <tr key={c.id}>
                  <td className="mm-col-strong max-w-[20rem]">
                    <span className="flex min-w-0 items-center gap-2.5 py-1.5">
                      <StatusIcon kind={containerKind(c)} />
                      <span className="min-w-0">
                        <span className="block truncate">{c.name}</span>
                        {c.compose_project && <span className="block truncate font-mono text-xs font-normal text-meta">{c.compose_project} / {c.compose_service}</span>}
                      </span>
                    </span>
                  </td>
                  <td>
                    <Badge tone={stTone} dot>{c.health && c.health !== "healthy" ? `${st} · ${c.health}` : st}</Badge>
                    {c.restart_count > 0 && <span className="mt-0.5 block text-xs text-meta">{c.restart_count} redémarrage(s)</span>}
                  </td>
                  <td className="max-w-64 truncate font-mono text-xs text-meta" title={c.image}>{c.image}</td>
                  <td className="mm-col-num font-mono text-xs">{c.state === "running" ? fmtPct(c.cpu_pct) : "—"}</td>
                  <td className="mm-col-num font-mono text-xs">{c.state === "running" && c.mem_used != null ? fmtBytes(c.mem_used) : "—"}</td>
                  <td className="mm-col-num font-mono text-xs">{c.state === "running" && c.net_rx != null ? `${fmtBytes(c.net_rx)} / ${fmtBytes(c.net_tx)}` : "—"}</td>
                  <td><Badge tone={upTone} title={upHint}>{up}</Badge></td>
                  <td className="w-px text-right"><ContainerAction h={h} c={c} onAsk={() => setConfirm(c)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Dialog open={!!confirm} onClose={() => setConfirm(undefined)} size="sm" title={`Mettre à jour ${confirm?.name ?? ""}`}
        description={`docker compose pull ${confirm?.compose_service ?? ""} puis up -d, dans le projet ${confirm?.compose_project ?? ""}.`}
        footer={<><Button variant="secondary" onClick={() => setConfirm(undefined)}>Annuler</Button>
          <Button icon={<Download size={16} />} onClick={() => { const c = confirm!; setConfirm(undefined); run(h, "update_container", c.name); }}>Mettre à jour le conteneur</Button></>}>
        <p className="text-sm leading-relaxed text-body">Le conteneur est recréé avec la nouvelle image : le service est interrompu quelques secondes. Les volumes et la configuration du fichier Compose sont conservés.</p>
      </Dialog>
    </>
  );
}

export function ContainersPage() {
  const { data, error, refresh } = usePoll(() => api.get<Host[]>("/api/hosts"), 10000);
  const [filter, setFilter] = useState<"all" | "updates" | "stopped">(() => (new URLSearchParams(location.search).get("filtre") === "maj" ? "updates" : "all"));
  const hosts = (data ?? []).filter((h) => h.docker);
  const all = hosts.flatMap((h) => h.docker!.containers);
  const running = all.filter((c) => c.state === "running").length;
  const failing = all.filter((c) => c.state !== "running" || c.health === "unhealthy").length;
  const updates = all.filter((c) => c.update === "available").length;
  return (
    <>
      <PageHeader title="Conteneurs" description="Conteneurs Docker de chaque hôte, relevés toutes les minutes. Les images sont comparées à leur registre toutes les 6 heures."
        actions={<Segmented label="Filtre" value={filter} onChange={setFilter} options={[["all", "Tous"], ["updates", "Mises à jour"], ["stopped", "Arrêtés"]]} />} />
      {error && <Alert kind="error" title="Impossible de charger les conteneurs" className="mb-6">{error}</Alert>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && (
        <div className={SECTIONS}>
          <div className={STAT_GRID}>
            <Stat label="Conteneurs" value={`${running}/${all.length}`} detail={`actifs · ${hosts.length} hôte(s) avec Docker`} icon={<Container size={16} />} />
            <Stat label="Arrêtés ou en erreur" value={failing} icon={<CircleAlert size={16} />} tone={failing ? "red" : undefined} />
            <Stat label="Images à mettre à jour" value={updates} icon={<Download size={16} />} tone={updates ? "yellow" : undefined} />
            <Stat label="Hôtes Docker" value={hosts.length} icon={<Server size={16} />} />
          </div>
          {hosts.length === 0 && (
            <EmptyState icon={<Container size={20} />} title="Aucun hôte avec Docker">
              L'agent active le suivi Docker automatiquement quand Docker est installé (relance install.sh après avoir installé Docker).
            </EmptyState>
          )}
          {hosts.map((h) => (
            <section key={h.id} aria-label={h.name}>
              <SectionTitle actions={<span className="font-mono text-xs text-meta">relevé {fmtAgo(h.docker!.collected_at)}</span>}>
                <Link to={`/hosts/${h.id}`} className="text-inherit no-underline hover:text-accent-text">{h.name}</Link>
                <span className="text-meta"> · {h.docker!.running}/{h.docker!.containers.length} actifs</span>
              </SectionTitle>
              <Card className="overflow-hidden"><ContainersTable h={h} filter={filter} onChanged={refresh} /></Card>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
