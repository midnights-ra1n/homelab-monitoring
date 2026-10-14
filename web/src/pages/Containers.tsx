import { useState } from "react";
import { Download } from "lucide-react";
import { actionBusy, api, fmtAgo, fmtBytes, fmtPct, type DockerContainer, type Host } from "../api";
import { Alert, Button, Card, Dialog, Kpi, Link, Segmented, usePoll } from "../ui";
import { useHostAction } from "./AgentVersion";

const STATE: Record<string, [string, string]> = {
  running: ["En cours", "s-operational"], exited: ["Arrêté", "s-unknown"], restarting: ["Redémarre", "s-degraded"],
  paused: ["En pause", "s-maintenance"], created: ["Créé", "s-unknown"], dead: ["Mort", "s-major_outage"],
};
const UPDATE: Record<string, [string, string, string]> = {
  available: ["Mise à jour disponible", "s-degraded", "Une image plus récente est publiée pour ce tag"],
  up_to_date: ["À jour", "s-operational", "L'image locale correspond à celle du registre"],
  unknown: ["Inconnu", "s-unknown", "Registre injoignable, privé, ou pas encore vérifié"],
  local: ["Image locale", "s-unknown", "Image construite sur la machine, sans registre"],
  pinned: ["Figée", "s-unknown", "Image référencée par empreinte : elle ne change jamais"],
};

function ContainerAction({ h, c, onAsk }: { h: Host; c: DockerContainer; onAsk: () => void }) {
  const a = h.action?.action === "update_container" && h.action.target === c.name ? h.action : undefined;
  if (a && actionBusy(h)) return <span className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span className="spinner" aria-hidden />Mise à jour…</span>;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
      {a && a.state !== "pending" && a.state !== "running" && (
        <details className="small" style={{ textAlign: "left" }}>
          <summary style={{ cursor: "pointer", color: a.state === "failed" ? "var(--danger-fg)" : "var(--text-secondary)" }}>{a.state === "failed" ? "Échec" : "Mis à jour"} {fmtAgo(a.at)}</summary>
          {a.message && <pre className="codeblock" style={{ marginTop: 6, paddingRight: 12, maxHeight: 200, maxWidth: 420, overflow: "auto" }}>{a.message}</pre>}
        </details>
      )}
      {c.update === "available" && (
        c.compose_project
          ? <Button size="sm" icon={<Download />} disabled={!h.connected || actionBusy(h)} title={h.connected ? undefined : "Agent hors ligne"} onClick={onAsk}>Mettre à jour</Button>
          : <span className="xs tertiary" title="Seuls les conteneurs Docker Compose peuvent être recréés automatiquement">Hors Compose</span>
      )}
    </span>
  );
}

/** Containers of one host, with resource usage and image update status. */
export function ContainersTable({ h, filter = "all", onChanged }: { h: Host; filter?: "all" | "updates" | "stopped"; onChanged?: () => void }) {
  const [confirm, setConfirm] = useState<DockerContainer>();
  const { run } = useHostAction(() => onChanged?.());
  const list = (h.docker?.containers ?? []).filter((c) => filter === "all" || (filter === "updates" ? c.update === "available" : c.state !== "running"));
  return (
    <>
      {h.docker?.error && <Alert tone="danger" title="Docker n'a pas répondu">{h.docker.error}</Alert>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Conteneur</th><th>État</th><th>Image</th><th className="r">CPU</th><th className="r">Mémoire</th><th className="r">Réseau ↓ / ↑</th><th>Image à jour</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={8} className="muted">Aucun conteneur{filter !== "all" ? " dans ce filtre" : ""}.</td></tr>}
            {list.map((c) => {
              const [st, stCls] = STATE[c.state] ?? [c.state, "s-unknown"];
              const [up, upCls, upHint] = UPDATE[c.update] ?? UPDATE.unknown;
              return (
                <tr key={c.id}>
                  <td>
                    <span className="mono small">{c.name}</span>
                    {c.compose_project && <div className="xs tertiary">Compose : {c.compose_project} / {c.compose_service}</div>}
                  </td>
                  <td>
                    <span className={`badge ${stCls}`}><span className="dot" aria-hidden />{st}</span>
                    {c.health && c.health !== "healthy" && <div className="xs" style={{ color: c.health === "unhealthy" ? "var(--danger-fg)" : "var(--text-tertiary)" }}>{c.health === "unhealthy" ? "Healthcheck en échec" : "Démarrage…"}</div>}
                    {c.restart_count > 0 && <div className="xs tertiary">{c.restart_count} redémarrage(s)</div>}
                  </td>
                  <td className="mono xs ellipsis" style={{ maxWidth: 260 }} title={c.image}>{c.image}</td>
                  <td className="r">{c.state === "running" ? fmtPct(c.cpu_pct) : "—"}</td>
                  <td className="r">{c.state === "running" && c.mem_used != null ? fmtBytes(c.mem_used) : "—"}</td>
                  <td className="r">{c.state === "running" && c.net_rx != null ? `${fmtBytes(c.net_rx)} / ${fmtBytes(c.net_tx)}` : "—"}</td>
                  <td><span className={`badge ${upCls}`} title={upHint}><span className="dot" aria-hidden />{up}</span></td>
                  <td className="r"><ContainerAction h={h} c={c} onAsk={() => setConfirm(c)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Dialog open={!!confirm} onClose={() => setConfirm(undefined)} title={`Mettre à jour ${confirm?.name ?? ""}`}
        description={`docker compose pull ${confirm?.compose_service ?? ""} puis docker compose up -d ${confirm?.compose_service ?? ""}, dans le projet ${confirm?.compose_project ?? ""}.`}
        footer={<><Button onClick={() => setConfirm(undefined)}>Annuler</Button>
          <Button variant="primary" icon={<Download />} onClick={() => { const c = confirm!; setConfirm(undefined); run(h, "update_container", c.name); }}>Mettre à jour le conteneur</Button></>}>
        <p className="small muted">Le conteneur est recréé avec la nouvelle image : le service est interrompu quelques secondes. Les volumes et la configuration du fichier Compose sont conservés.</p>
      </Dialog>
    </>
  );
}

export function ContainersPage() {
  const { data, error, refresh } = usePoll(() => api.get<Host[]>("/api/hosts"), 10000);
  const [filter, setFilter] = useState<"all" | "updates" | "stopped">(() => (new URLSearchParams(location.search).get("filtre") === "maj" ? "updates" : "all"));
  const hosts = (data ?? []).filter((h) => h.docker);
  const all = hosts.flatMap((h) => h.docker!.containers);
  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Conteneurs</h1><p className="muted">Conteneurs Docker de chaque hôte, relevés toutes les minutes. Les images sont comparées à leur registre toutes les 6 heures.</p></div>
        <div className="actions"><Segmented label="Filtre" value={filter} onChange={setFilter} options={[["all", "Tous"], ["updates", "Mises à jour"], ["stopped", "Arrêtés"]]} /></div>
      </div>
      {error && <Alert tone="danger" title="Impossible de charger les conteneurs">{error}</Alert>}
      {data && (
        <div className="grid kpis">
          <Kpi label="Conteneurs" value={<span className="num">{all.length}</span>} detail={`${hosts.length} hôte(s) avec Docker`} />
          <Kpi label="En cours" value={<span className="num">{all.filter((c) => c.state === "running").length}</span>} />
          <Kpi label="Arrêtés ou en erreur" value={<span className="num">{all.filter((c) => c.state !== "running" || c.health === "unhealthy").length}</span>} />
          <Kpi label="Images à mettre à jour" value={<span className="num">{all.filter((c) => c.update === "available").length}</span>} />
        </div>
      )}
      {data && hosts.length === 0 && <Card><div className="empty small">Aucun hôte avec Docker. L'agent active le suivi Docker automatiquement quand Docker est installé (relancez install.sh après avoir installé Docker).</div></Card>}
      {hosts.map((h) => (
        <Card key={h.id} title={<Link to={`/hosts/${h.id}`}>{h.name}</Link>} sub={`${h.docker!.running} en cours sur ${h.docker!.containers.length} · relevé ${fmtAgo(h.docker!.collected_at)}`} flush>
          <ContainersTable h={h} filter={filter} onChanged={refresh} />
        </Card>
      ))}
    </div>
  );
}
