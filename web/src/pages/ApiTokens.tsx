import { useEffect, useState } from "react";
import { BookOpen, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, fmtAgo, fmtDate } from "../api";
import {
  Alert, Badge, Button, ButtonAnchor, Card, CardBody, Checkbox, CodeBlock, Dialog, FIELD_ROW, FORM_ACTIONS, Field, IconButton, SectionTitle, Switch, Tag,
  inputClass, useToast,
} from "../ui";

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
    <section id="api" aria-labelledby="api-title" className="scroll-mt-8">
      <SectionTitle id="api-title" actions={
        <ButtonAnchor variant="ghost" size="sm" href="https://github.com/midnights-ra1n/homelab-monitoring/blob/stable/docs/API.md" target="_blank" rel="noopener" icon={<BookOpen size={14} />}>Documentation</ButtonAnchor>
      }>API</SectionTitle>
      <div className="grid gap-6">
        <Card>
          <CardBody className="grid gap-5">
            <p className="text-sm text-body">API REST en lecture (et maintenance) pour intégrer le monitoring à un autre outil, comme homelab-management. Authentification par jeton, limitée aux scopes choisis.</p>
            <Switch label="Activer l'API (/api/v1)" checked={enabled} onChange={(c) => setDraft({ ...draft, api_enabled: String(c) })} />
            <Field label="Origines autorisées depuis un navigateur (facultatif)" htmlFor="s-cors" hint="Séparées par des virgules, ex. https://gestion.example.fr. Inutile pour un appel côté serveur.">
              <input id="s-cors" className={`${inputClass} font-mono`} value={draft.api_cors_origins ?? ""} onChange={(e) => setDraft({ ...draft, api_cors_origins: e.target.value })} />
            </Field>
            <div className={FORM_ACTIONS}><Button loading={busy === "api"} onClick={() => save("api", ["api_enabled", "api_cors_origins"])}>Enregistrer l'API</Button></div>
          </CardBody>
        </Card>
        <Card flush title="Jetons" sub={`${tokens.length} jeton(s)`} actions={<Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>Créer un jeton</Button>}>
          {tokens.length === 0 ? <p className="px-5 py-8 text-center text-sm text-meta">Aucun jeton. Crée-en un par application qui interroge l'API.</p> : (
            <div className="mm-table-wrap">
              <table className="mm-table min-w-[48rem]">
                <thead><tr><th scope="col">Nom</th><th scope="col">Scopes</th><th scope="col">Expiration</th><th scope="col">Dernière utilisation</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {tokens.map((t) => {
                    const expired = t.expires_at != null && t.expires_at * 1000 < Date.now();
                    return (
                      <tr key={t.id}>
                        <td className="mm-col-strong">
                          <span className="block">{t.name}</span>
                          <span className="block font-mono text-xs font-normal text-meta">{t.prefix}…</span>
                        </td>
                        <td className="whitespace-normal"><div className="flex max-w-[18rem] flex-wrap gap-1">{t.scopes.map((s) => <Tag key={s}>{s}</Tag>)}</div></td>
                        <td>{t.expires_at == null ? <span className="text-meta">Jamais</span> : expired ? <Badge tone="red" dot>Expiré</Badge> : <span className="font-mono text-xs">{fmtDate(t.expires_at)}</span>}</td>
                        <td className="mm-col-muted">{t.last_used_at ? fmtAgo(t.last_used_at) : "Jamais"}</td>
                        <td className="w-px"><IconButton label={`Révoquer ${t.name}`} icon={<Trash2 size={15} />} onClick={() => setRevoking(t)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {creating && <CreateTokenDialog scopes={scopes} onClose={() => { setCreating(false); load(); }} />}
      <Dialog open={!!revoking} onClose={() => setRevoking(undefined)} size="sm" title="Confirmer la révocation"
        footer={<><Button variant="secondary" onClick={() => setRevoking(undefined)}>Annuler</Button>
          <Button variant="danger" onClick={() => revoking && api.del(`/api/tokens/${revoking.id}`).then(() => { toast("Jeton révoqué"); setRevoking(undefined); load(); })}>Révoquer</Button></>}>
        <p className="text-sm leading-relaxed text-body">Révoquer « {revoking?.name} » ? Les applications qui l'utilisent perdront immédiatement l'accès.</p>
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
    <Dialog open onClose={onClose} size="lg" title={token ? "Jeton créé" : "Créer un jeton API"}
      description={token ? undefined : "Un jeton par application : tu pourras le révoquer sans toucher aux autres."}
      footer={token ? <Button onClick={onClose}>Terminer</Button> : (
        <><Button variant="secondary" onClick={onClose}>Annuler</Button><Button type="submit" form="tok-form" icon={<KeyRound size={16} />} loading={busy}>Créer le jeton</Button></>
      )}>
      {token ? (
        <div className="grid gap-5">
          <Alert kind="warning" title="Le jeton ne sera plus affiché">Copiez-le maintenant et stockez-le comme un mot de passe.</Alert>
          <Field label="Jeton"><CodeBlock text={token} /></Field>
          <Field label="Exemple"><CodeBlock text={`curl -H "Authorization: Bearer ${token}" ${location.origin}/api/v1/status`} /></Field>
        </div>
      ) : (
        <form id="tok-form" className="grid gap-5" onSubmit={submit} noValidate>
          {error && <Alert kind="error" title={error} />}
          <Field label="Nom" htmlFor="tok-name" hint="Par exemple homelab-management"><input id="tok-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <div className={FIELD_ROW}>
            <Field label="Expiration" htmlFor="tok-exp">
              <select id="tok-exp" className={inputClass} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            {expiry === "custom" && (
              <Field label="Date" htmlFor="tok-date"><input id="tok-date" className={inputClass} type="date" min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            )}
          </div>
          {expiry === "never" && <Alert kind="info" title="Jeton sans expiration">À réserver à un service interne de confiance ; révoquez-le s'il fuite.</Alert>}
          <fieldset className="mm-field">
            <legend className="mm-field__label mb-1.5">Scopes</legend>
            <div className="grid gap-3 rounded-[18px] border border-line-strong bg-field px-4 py-3">
              {Object.entries(scopes).map(([s, desc]) => (
                <Checkbox key={s} label={<span className="font-mono">{s}</span>} hint={desc} checked={picked.includes(s)} onChange={() => toggle(s)} />
              ))}
            </div>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}
