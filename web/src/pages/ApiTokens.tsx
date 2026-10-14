import { useEffect, useState } from "react";
import { BookOpen, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, fmtAgo, fmtDate } from "../api";
import { Alert, Button, CodeBlock, Dialog, Field, IconButton, Switch, useToast } from "../ui";

interface Token { id: number; name: string; prefix: string; scopes: string[]; expires_at: number | null; created_at: number; last_used_at: number }

const EXPIRY: [string, string, number | null][] = [
  ["30", "30 jours", 30], ["90", "90 jours", 90], ["365", "1 an", 365], ["custom", "Date précise", null], ["never", "Jamais", null],
];

export function ApiSection({ draft, setDraft, save, busy }: {
  draft: Record<string, string>; setDraft: (s: Record<string, string>) => void; save: (section: string, keys: string[]) => void; busy?: string;
}) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Token>();
  const toast = useToast();
  const load = () => api.get<{ tokens: Token[]; scopes: Record<string, string> }>("/api/tokens").then((r) => { setTokens(r.tokens); setScopes(r.scopes); });
  useEffect(() => { load(); }, []);
  const enabled = draft.api_enabled === "true";

  return (
    <section className="settings-section wide">
      <div>
        <h2 style={{ fontSize: "var(--text-base)" }}>API</h2>
        <p>API REST en lecture (et maintenance) pour intégrer le monitoring à un autre outil. Authentification par jeton, limitée aux scopes choisis.</p>
        <p><a href="https://github.com/midnights-ra1n/homelab-monitoring/blob/stable/docs/API.md" target="_blank" rel="noopener"><BookOpen size={14} aria-hidden style={{ verticalAlign: "-2px" }} /> Documentation de l'API</a></p>
      </div>
      <div className="form">
        <Switch label="Activer l'API (/api/v1)" checked={enabled} onChange={(c) => setDraft({ ...draft, api_enabled: String(c) })} />
        <Field label="Origines autorisées depuis un navigateur (facultatif)" htmlFor="s-cors" hint="Séparées par des virgules, ex. https://gestion.example.fr. Inutile pour un appel côté serveur.">
          <input id="s-cors" className="input mono" value={draft.api_cors_origins ?? ""} onChange={(e) => setDraft({ ...draft, api_cors_origins: e.target.value })} />
        </Field>
        <div><Button variant="primary" loading={busy === "api"} onClick={() => save("api", ["api_enabled", "api_cors_origins"])}>Enregistrer l'API</Button></div>

        <div className="card" style={{ marginTop: 8 }}>
          <div className="card-header">
            <div><h3>Jetons</h3><div className="sub">{tokens.length} jeton(s)</div></div>
            <Button size="sm" icon={<Plus />} onClick={() => setCreating(true)}>Créer un jeton</Button>
          </div>
          <div className="flush">
            {tokens.length === 0 ? <div className="empty small">Aucun jeton. Créez-en un par application qui interroge l'API.</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Nom</th><th>Jeton</th><th>Scopes</th><th>Expiration</th><th>Dernière utilisation</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {tokens.map((t) => {
                      const expired = t.expires_at != null && t.expires_at * 1000 < Date.now();
                      return (
                        <tr key={t.id}>
                          <td>{t.name}</td>
                          <td className="mono muted">{t.prefix}…</td>
                          <td className="wrap" style={{ maxWidth: 280 }}>{t.scopes.map((s) => <span key={s} className="badge" style={{ margin: "2px 4px 2px 0" }}>{s}</span>)}</td>
                          <td>{t.expires_at == null ? <span className="muted">Jamais</span> : expired ? <span className="badge s-minor_outage">Expiré</span> : fmtDate(t.expires_at)}</td>
                          <td className="muted">{t.last_used_at ? fmtAgo(t.last_used_at) : "Jamais"}</td>
                          <td className="r"><IconButton label={`Révoquer ${t.name}`} icon={<Trash2 />} className="sm" onClick={() => setRevoking(t)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      {creating && <CreateTokenDialog scopes={scopes} onClose={() => { setCreating(false); load(); }} />}
      <Dialog open={!!revoking} onClose={() => setRevoking(undefined)} title={`Révoquer ${revoking?.name ?? ""}`}
        description="Les applications qui utilisent ce jeton perdront immédiatement l'accès."
        footer={<><Button onClick={() => setRevoking(undefined)}>Annuler</Button>
          <Button variant="danger" onClick={() => revoking && api.del(`/api/tokens/${revoking.id}`).then(() => { toast("Jeton révoqué"); setRevoking(undefined); load(); })}>Révoquer le jeton</Button></>}>
        <p className="small muted">Cette action est irréversible.</p>
      </Dialog>
    </section>
  );
}

function CreateTokenDialog({ scopes, onClose }: { scopes: Record<string, string>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(["status:read"]);
  const [expiry, setExpiry] = useState("90");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string>();
  const [token, setToken] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let expires_at: number | null = null;
    const days = EXPIRY.find((x) => x[0] === expiry)?.[2];
    if (days) expires_at = Math.floor(Date.now() / 1000) + days * 86400;
    if (expiry === "custom") {
      if (!date) { setError("Choisissez une date d'expiration"); return; }
      expires_at = Math.floor(new Date(`${date}T23:59:59`).getTime() / 1000);
    }
    setBusy(true);
    try {
      const r = await api.post<{ token: string }>("/api/tokens", { name, scopes: picked, expires_at });
      setToken(r.token);
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  const toggle = (s: string) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));

  return (
    <Dialog open onClose={onClose} wide title={token ? "Jeton créé" : "Créer un jeton API"}
      description={token ? undefined : "Un jeton par application : vous pourrez le révoquer sans toucher aux autres."}
      footer={token ? <Button variant="primary" onClick={onClose}>Terminer</Button> : (
        <><Button onClick={onClose}>Annuler</Button><Button variant="primary" type="submit" form="tok-form" icon={<KeyRound />} loading={busy}>Créer le jeton</Button></>
      )}>
      {token ? (
        <div className="form">
          <Alert tone="warning" title="Le jeton ne sera plus affiché">Copiez-le maintenant et stockez-le comme un mot de passe.</Alert>
          <Field label="Jeton"><CodeBlock text={token} /></Field>
          <Field label="Exemple"><CodeBlock text={`curl -H "Authorization: Bearer ${token}" ${location.origin}/api/v1/status`} /></Field>
        </div>
      ) : (
        <form id="tok-form" className="form" onSubmit={submit} noValidate>
          {error && <Alert tone="danger" title={error} />}
          <Field label="Nom" htmlFor="tok-name" hint="Par exemple homelab-management"><input id="tok-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <div className="row">
            <Field label="Expiration" htmlFor="tok-exp">
              <select id="tok-exp" className="select" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            {expiry === "custom" && (
              <Field label="Date" htmlFor="tok-date"><input id="tok-date" className="input" type="date" min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            )}
          </div>
          {expiry === "never" && <Alert tone="info" title="Jeton sans expiration">À réserver à un service interne de confiance ; révoquez-le s'il fuite.</Alert>}
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ fontSize: "var(--text-sm)", fontWeight: 500, marginBottom: 6 }}>Scopes</legend>
            <div className="picker" style={{ maxHeight: "none" }}>
              {Object.entries(scopes).map(([s, desc]) => (
                <label key={s} className="check" style={{ alignItems: "flex-start" }}>
                  <input type="checkbox" checked={picked.includes(s)} onChange={() => toggle(s)} style={{ marginTop: 2 }} />
                  <span><span className="mono">{s}</span><br /><span className="xs muted">{desc}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}
