import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, actionBusy, type Host, type HostActionName } from "../api";
import { Button, useToast } from "../ui";

/** Sends an action to a host's agent; returns the updated host. */
export function useHostAction(onDone?: (h: Host) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  const run = async (h: Host, action: HostActionName) => {
    setBusy(`${h.id}:${action}`);
    try {
      const updated = await api.post<Host>(`/api/hosts/${h.id}/action`, { action });
      onDone?.(updated);
      toast(action === "update_agent" ? `Mise à jour de l'agent demandée sur ${h.name}` : action === "apply_updates" ? `Installation des mises à jour lancée sur ${h.name}` : `Vérification lancée sur ${h.name}`);
    } catch (e) {
      toast(`${h.name} : ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
    }
  };
  return { run, busy };
}

/** Installed agent version with an "up to date / update available" badge. */
export function AgentVersion({ h, onUpdate, updating }: { h: Host; onUpdate?: () => void; updating?: boolean }) {
  const v = h.info.agent_version;
  if (!v) return <span className="tertiary">—</span>;
  const pending = h.action?.action === "update_agent" && actionBusy(h);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span className="mono small">{v}</span>
      {!/^v\d+\.\d+\.\d+$/.test(v) ? <span className="badge">Développement</span>
        : h.agent_outdated ? <span className="badge s-degraded" title={`Dernière version : ${h.agent_latest}`}><span className="dot" aria-hidden />{h.agent_latest} disponible</span>
        : h.agent_latest ? <span className="badge s-operational"><span className="dot" aria-hidden />À jour</span> : null}
      {onUpdate && h.agent_outdated && h.connected && (
        <Button size="sm" icon={<RefreshCw />} loading={updating || pending} onClick={(e) => { e.stopPropagation(); onUpdate(); }}>Mettre à jour l'agent</Button>
      )}
    </span>
  );
}
