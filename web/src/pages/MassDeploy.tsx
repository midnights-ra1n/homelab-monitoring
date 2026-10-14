import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, fmtAgo, fmtDate, type Install } from "../api";
import { Alert, Button, CodeBlock, Dialog, Field, IconButton, Segmented, Switch } from "../ui";
import { HubUrlField, UNINSTALL_COMMAND, installCommand } from "./AddHostWizard";

interface EnrollToken { id: number; name: string; prefix: string; expires_at: number | null; created_at: number; last_used_at: number; uses: number }

const EXPIRY: [string, string, number | null][] = [["1", "24 heures", 1], ["7", "7 jours", 7], ["30", "30 jours", 30], ["never", "Jamais", null]];

/**
 * Shared enrollment token: one TOKEN + KEY for every machine. Each agent enrolls itself
 * under its hostname on first connection and then switches to a personal token.
 */
export function MassDeployDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tokens, setTokens] = useState<EnrollToken[]>([]);
  const [name, setName] = useState("Déploiement");
  const [expiry, setExpiry] = useState("7");
  const [created, setCreated] = useState<Install>();
  const [hub, setHub] = useState("");
  const [method, setMethod] = useState<"curl" | "ansible">("ansible");
  const [withLxc, setWithLxc] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.get<EnrollToken[]>("/api/enroll-tokens").then(setTokens, () => {});
  useEffect(() => { if (open) load(); }, [open]);

  const create = async () => {
    setError(undefined);
    const days = EXPIRY.find((x) => x[0] === expiry)?.[2];
    try {
      const r = await api.post<{ install: Install }>("/api/enroll-tokens", { name, expires_at: days ? Math.floor(Date.now() / 1000) + days * 86400 : null });
      setCreated(r.install);
      setHub(r.install.hub_url);
      load();
    } catch (e) { setError((e as Error).message); }
  };
  const close = () => { setCreated(undefined); setError(undefined); onClose(); };
  const install = created && { ...created, hub_url: hub.trim().replace(/\/$/, "") };

  return (
    <Dialog open={open} onClose={close} wide title="Déploiement en masse"
      description="Un seul jeton et une seule clé pour toutes les machines : chacune s'inscrit sous son nom à sa première connexion."
      footer={<Button variant="primary" onClick={close}>Terminer</Button>}>
      <div className="form">
        {!install ? (
          <>
            {error && <Alert tone="danger" title={error} />}
            <div className="row" style={{ alignItems: "flex-end" }}>
              <Field label="Nom du jeton" htmlFor="enr-name"><input id="enr-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Valable" htmlFor="enr-exp">
                <select id="enr-exp" className="select" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  {EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <div><Button variant="primary" icon={<Plus />} onClick={create}>Créer le jeton commun</Button></div>
            </div>
            <p className="small muted">Le jeton commun ne sert qu'à inscrire de nouvelles machines ; chacune reçoit ensuite son propre jeton. Une durée courte suffit : les machines déjà inscrites continuent de fonctionner après l'expiration.</p>
          </>
        ) : (
          <>
            <Alert tone="warning" title="Le jeton ne sera plus affiché">Copiez-le maintenant (dans un vault Ansible, par exemple).</Alert>
            <HubUrlField value={hub} onChange={setHub} />
            <Segmented label="Méthode" value={method} onChange={setMethod} options={[["ansible", "Ansible"], ["curl", "Commande"]]} />
            {method === "ansible" ? (
              <>
                <p className="small muted">Dans <span className="mono">group_vars/&lt;groupe&gt;/main.yml</span> de votre playbook, avec le rôle <span className="mono">hlm_agent</span> (voir docs/ANSIBLE.md) :</p>
                <CodeBlock text={[
                  `hlm_hub_url: ${install.hub_url}`,
                  `hlm_key: "${install.key}"`,
                  `hlm_agent_token: "{{ vault_hlm_agent_token }}"`,
                ].join("\n")} />
                <p className="small muted">et dans le vault (<span className="mono">ansible-vault create group_vars/&lt;groupe&gt;/vault.yml</span>) :</p>
                <CodeBlock text={`vault_hlm_agent_token: ${install.token}`} />
              </>
            ) : (
              <>
                <p className="small muted">La même ligne fonctionne sur toutes les machines :</p>
                <Switch label="Sur un Proxmox, installer aussi dans ses conteneurs LXC" checked={withLxc} onChange={setWithLxc} />
                <CodeBlock text={installCommand(install, { smart: true, autoUpdate: true, lxcToken: withLxc ? install.token : undefined })} />
              </>
            )}
          </>
        )}

        {tokens.length > 0 && (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Jeton commun</th><th>Expiration</th><th className="r">Inscriptions</th><th>Dernière</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>{tokens.map((t) => {
                  const expired = t.expires_at != null && t.expires_at * 1000 < Date.now();
                  return (
                    <tr key={t.id}>
                      <td>{t.name} <span className="mono xs tertiary">{t.prefix}…</span></td>
                      <td>{t.expires_at == null ? "Jamais" : expired ? <span className="badge s-minor_outage">Expiré</span> : fmtDate(t.expires_at)}</td>
                      <td className="r">{t.uses}</td>
                      <td className="muted">{t.last_used_at ? fmtAgo(t.last_used_at) : "—"}</td>
                      <td className="r"><IconButton label={`Révoquer ${t.name}`} icon={<Trash2 />} className="sm" onClick={() => api.del(`/api/enroll-tokens/${t.id}`).then(load)} /></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </div>
        )}
        <details className="small">
          <summary className="muted" style={{ cursor: "pointer" }}>Désinstaller l'agent d'une machine</summary>
          <div style={{ marginTop: 8 }}><CodeBlock text={UNINSTALL_COMMAND} /></div>
        </details>
      </div>
    </Dialog>
  );
}
