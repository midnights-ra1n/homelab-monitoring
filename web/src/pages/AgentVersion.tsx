import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, actionBusy, type Host, type HostActionName } from "../api";
import { Badge, Button, useToast } from "../ui";

/** Sends an action to a host's agent; returns the updated host. */
export function useHostAction(onDone?: (h: Host) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  const run = async (h: Host, action: HostActionName, target?: string) => {
    setBusy(`${h.id}:${action}${target ? ":" + target : ""}`);
    try {
      const updated = await api.post<Host>(`/api/hosts/${h.id}/action`, { action, target });
      onDone?.(updated);
      toast(action === "update_agent" ? `Mise à jour de l'agent demandée sur ${h.name}`
        : action === "apply_updates" ? `Installation des mises à jour lancée sur ${h.name}`
        : action === "update_container" ? `Mise à jour de ${target} lancée sur ${h.name}`
        : `Vérification lancée sur ${h.name}`);
    } catch (e) {
      toast(`${h.name} : ${(e as Error).message}`, "error");
    } finally {
      setBusy(undefined);
    }
  };
  return { run, busy };
}

/** Installed agent version with an "up to date / update available" badge; `compact` shows the badge only. */
export function AgentVersion({ h, onUpdate, updating, compact }: { h: Host; onUpdate?: () => void; updating?: boolean; compact?: boolean }) {
  const v = h.info.agent_version;
  if (!v) return compact ? null : <span className="text-meta">—</span>;
  const pending = h.action?.action === "update_agent" && actionBusy(h);
  const badge = !/^v\d+\.\d+\.\d+$/.test(v) ? <Badge>dev</Badge>
    : h.agent_outdated ? <Badge tone="yellow" dot title={`Dernière version : ${h.agent_latest}`}>{h.agent_latest} disponible</Badge>
    : h.agent_latest && !compact ? <Badge tone="green" dot>À jour</Badge> : null;
  if (compact) return badge;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-h2">{v}</span>
      {badge}
      {onUpdate && h.agent_outdated && h.connected && (
        <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={updating || pending} onClick={(e) => { e.stopPropagation(); onUpdate(); }}>Mettre à jour l'agent</Button>
      )}
    </span>
  );
}
