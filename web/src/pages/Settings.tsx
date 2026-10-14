import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Send, Upload } from "lucide-react";
import { api, fmtBytes } from "../api";
import { Alert, Button, Field, Link, Segmented, Switch, useToast, type Palette, type ThemeMode } from "../ui";
import { EmailEditor } from "./EmailEditor";
import { ApiSection } from "./ApiTokens";

type S = Record<string, string>;
interface SettingsResp { settings: S; db_size: number; version: string }

function Section({ title, desc, children, wide }: { title: string; desc: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`settings-section${wide ? " wide" : ""}`}>
      <div><h2 style={{ fontSize: "var(--text-base)" }}>{title}</h2><p>{desc}</p></div>
      <div className="form">{children}</div>
    </section>
  );
}

export function SettingsPage({ theme }: { theme: { mode: ThemeMode; setMode: (m: ThemeMode) => void; palette: Palette; setPalette: (p: Palette) => void } }) {
  const [data, setData] = useState<SettingsResp>();
  const [draft, setDraft] = useState<S>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const toast = useToast();

  useEffect(() => { api.get<SettingsResp>("/api/settings").then((d) => { setData(d); setDraft({ ...d.settings, smtp_pass: "" }); }, (e) => setError(e.message)); }, []);
  if (!data) return <div className="page">{error && <Alert tone="danger" title={error} />}</div>;

  const v = (k: string) => draft[k] ?? "";
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setDraft({ ...draft, [k]: e.target.value });
  const bool = (k: string) => draft[k] === "true";
  const save = async (section: string, keys: string[]) => {
    setBusy(section);
    setError(undefined);
    try {
      const body = Object.fromEntries(keys.map((k) => [k, draft[k] ?? ""]));
      const d = await api.put<SettingsResp>("/api/settings", body);
      setData(d);
      setDraft((x) => ({ ...x, ...d.settings, smtp_pass: "" }));
      toast("Réglages enregistrés");
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(undefined);
    }
  };
  const input = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <Field label={label} htmlFor={`s-${k}`} hint={hint}><input id={`s-${k}`} className="input" value={v(k)} onChange={set(k)} {...props} /></Field>
  );

  return (
    <div className="page">
      <div className="page-header"><div><h1>Réglages</h1><p className="muted">Version {data.version}</p></div></div>
      {error && <Alert tone="danger" title="Enregistrement impossible">{error}</Alert>}
      <div className="card"><div className="card-body">
        <Section title="Apparence" desc="Mémorisée sur cet appareil.">
          <Field label="Thème"><Segmented label="Thème" value={theme.palette} onChange={theme.setPalette} options={[["classic", "Midnights Classic"], ["mint", "Midnights Mint"]]} /></Field>
          <Field label="Mode"><Segmented label="Mode" value={theme.mode} onChange={theme.setMode} options={[["system", "Système"], ["light", "Clair"], ["dark", "Sombre"]]} /></Field>
        </Section>

        <Section title="Fuseau horaire" desc="Utilisé pour les heures des e-mails, des rapports mensuels et des messages des sondes. Le tableau de bord affiche toujours l'heure de votre navigateur.">
          <Field label="Fuseau" htmlFor="s-tz" hint={`Heure actuelle dans ce fuseau : ${(() => { try { return new Date().toLocaleString("fr-FR", { timeZone: v("timezone"), dateStyle: "short", timeStyle: "short" }); } catch { return "—"; } })()}`}>
            <select id="s-tz" className="select" value={v("timezone")} onChange={set("timezone")}>
              {Intl.supportedValuesOf("timeZone").concat(Intl.supportedValuesOf("timeZone").includes(v("timezone")) ? [] : [v("timezone")]).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <div className="row">
            <Button variant="primary" loading={busy === "tz"} onClick={() => save("tz", ["timezone"])}>Enregistrer le fuseau</Button>
            {Intl.DateTimeFormat().resolvedOptions().timeZone !== v("timezone") && (
              <Button onClick={() => setDraft({ ...draft, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}>
                Utiliser celui de ce navigateur ({Intl.DateTimeFormat().resolvedOptions().timeZone})
              </Button>
            )}
          </div>
        </Section>

        <Section title="Collecte et rétention" desc="Un intervalle plus long et une rétention plus courte allègent le serveur. Les données plus anciennes sont supprimées toutes les heures.">
          <div className="row">
            {input("agent_interval_s", "Intervalle des agents (s)", { type: "number", min: 5 })}
            {input("retention_metrics_days", "Métriques des hôtes (jours)", { type: "number", min: 1 })}
          </div>
          <div className="row">
            {input("retention_results_days", "Résultats des sondes (jours)", { type: "number", min: 1 })}
            {input("retention_daily_days", "Disponibilité journalière (jours)", { type: "number", min: 90 })}
          </div>
          <p className="small muted">Taille de la base : <span className="num">{fmtBytes(data.db_size)}</span></p>
          <div className="row">
            <Button variant="primary" loading={busy === "ret"} onClick={() => save("ret", ["agent_interval_s", "retention_metrics_days", "retention_results_days", "retention_daily_days"])}>Enregistrer la rétention</Button>
            <Button loading={busy === "vac"} onClick={async () => {
              setBusy("vac");
              try { setData(await api.post<SettingsResp>("/api/maintenance/vacuum")); toast("Base nettoyée et compactée"); } catch (e) { setError((e as Error).message); }
              setBusy(undefined);
            }}>Nettoyer et compacter la base</Button>
          </div>
        </Section>

        <Section title="Notifications par e-mail" desc="Les changements d'état survenant pendant la fenêtre de regroupement sont envoyés dans un seul message.">
          <Switch label="Activer les notifications" checked={bool("smtp_enabled")} onChange={(c) => setDraft({ ...draft, smtp_enabled: String(c) })} />
          <div className="row">
            {input("smtp_host", "Serveur SMTP", { placeholder: "smtp.example.fr" })}
            {input("smtp_port", "Port", { type: "number" })}
            <Field label="Chiffrement" htmlFor="s-tls">
              <select id="s-tls" className="select" value={v("smtp_tls")} onChange={set("smtp_tls")}>
                <option value="starttls">STARTTLS</option><option value="tls">TLS implicite</option><option value="none">Aucun</option>
              </select>
            </Field>
          </div>
          <div className="row">
            {input("smtp_user", "Utilisateur (facultatif)", { autoComplete: "off" })}
            {input("smtp_pass", "Mot de passe", { type: "password", autoComplete: "new-password", placeholder: data.settings.smtp_pass_set === "true" ? "Inchangé" : "" })}
          </div>
          {input("smtp_from", "Expéditeur", { placeholder: "Homelab <alertes@example.fr>" })}
          {input("smtp_to", "Destinataires", { placeholder: "moi@example.fr, autre@example.fr" }, "Séparés par des virgules")}
          {input("notify_window_s", "Fenêtre de regroupement (s)", { type: "number", min: 0 }, "0 : envoi immédiat de chaque changement")}
          {input("status_title", "Nom de l'infrastructure", {}, "Utilisé dans les e-mails ({titre}) et les rapports")}
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontSize: "var(--text-sm)", fontWeight: 500, marginBottom: 6 }}>Alerter aussi pour</legend>
            <div className="form" style={{ gap: 10 }}>
              <label className="check"><input type="checkbox" checked={bool("notify_security_updates")} onChange={(e) => setDraft({ ...draft, notify_security_updates: String(e.target.checked) })} />Nouvelles mises à jour de sécurité</label>
              <label className="check"><input type="checkbox" checked={bool("notify_reboot")} onChange={(e) => setDraft({ ...draft, notify_reboot: String(e.target.checked) })} />Redémarrage requis</label>
              <label className="check"><input type="checkbox" checked={bool("notify_docker_updates")} onChange={(e) => setDraft({ ...draft, notify_docker_updates: String(e.target.checked) })} />Nouvelles images Docker disponibles</label>
              <Field label="Santé des disques (SMART)" htmlFor="s-smartlvl">
                <select id="s-smartlvl" className="select" value={v("notify_smart_level")} onChange={set("notify_smart_level")}>
                  <option value="watch">Dès qu'un disque est à surveiller</option>
                  <option value="replace">Quand un disque est à remplacer</option>
                  <option value="failing">Seulement en cas de défaillance</option>
                  <option value="off">Jamais</option>
                </select>
              </Field>
            </div>
            <span className="hint xs tertiary" style={{ display: "block", marginTop: 6 }}>Chaque mise à jour, redémarrage, image ou disque n'est signalé qu'une fois ; ils rejoignent le même e-mail que les autres alertes de la fenêtre de regroupement.</span>
          </fieldset>
          <div className="row">
            <Button variant="primary" loading={busy === "smtp"} onClick={() => save("smtp", ["smtp_enabled", "smtp_host", "smtp_port", "smtp_tls", "smtp_user", "smtp_pass", "smtp_from", "smtp_to", "notify_window_s", "status_title", "notify_security_updates", "notify_reboot", "notify_docker_updates", "notify_smart_level"])}>Enregistrer les notifications</Button>
            <Button icon={<Send />} loading={busy === "test"} onClick={async () => {
              setBusy("test");
              try { await api.post("/api/settings/test-email"); toast("E-mail de test envoyé"); } catch (e) { setError((e as Error).message); }
              setBusy(undefined);
            }}>Envoyer un e-mail de test</Button>
          </div>
        </Section>

        <Section wide title="Modèle d'e-mail" desc="Composez le message d'alerte avec des blocs, ou passez en HTML avancé. L'aperçu utilise des événements fictifs.">
          <EmailEditor draft={draft} setDraft={setDraft} save={save} busy={busy} />
        </Section>

        <Section title="Page de statut publique" desc="Composez la page avec des blocs : services, disponibilité, graphiques, textes.">
          <div className="row"><Link to="/status-page" className="btn">Modifier la page de statut</Link><a className="btn" href="/status" target="_blank" rel="noopener">Ouvrir la page</a></div>
        </Section>

        <Section title="Rapport mensuel" desc="Bilan du mois précédent (disponibilité, latence, incidents, mises à jour, disques), envoyé par e-mail le 1er du mois à 8 h.">
          <Switch label="Envoyer le rapport chaque mois" checked={bool("report_monthly_enabled")} onChange={(c) => setDraft({ ...draft, report_monthly_enabled: String(c) })} />
          <div className="row">
            <Button variant="primary" loading={busy === "report"} onClick={() => save("report", ["report_monthly_enabled"])}>Enregistrer</Button>
            <Button icon={<Send />} loading={busy === "sendrep"} onClick={async () => {
              setBusy("sendrep");
              try { await api.post("/api/reports/monthly/send"); toast("Rapport du mois dernier envoyé"); } catch (e) { setError((e as Error).message); }
              setBusy(undefined);
            }}>Envoyer le rapport du mois dernier</Button>
            <Link to="/reports" className="btn">Voir les rapports</Link>
          </div>
        </Section>

        <ApiSection draft={draft} setDraft={setDraft} save={save} busy={busy} />

        <ImportExportSection />
        <PasswordSection />
      </div></div>
    </div>
  );
}

function ImportExportSection() {
  const [metrics, setMetrics] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string }>();
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      const r = await api.post<{ monitors_added: number; settings_applied: number }>("/api/import", doc);
      setMsg({ tone: "success", text: `${r.monitors_added} sonde(s) ajoutée(s), ${r.settings_applied} réglage(s) appliqué(s). Rechargez la page pour voir les changements.` });
    } catch (err) {
      setMsg({ tone: "danger", text: (err as Error).message });
    }
  };
  return (
    <Section title="Import et export" desc="Exporte les réglages, les sondes et la liste des hôtes au format JSON. Les secrets (mot de passe SMTP, jetons d'agent) ne sont jamais exportés.">
      {msg && <Alert tone={msg.tone} title={msg.text} />}
      <label className="check"><input type="checkbox" checked={metrics} onChange={(e) => setMetrics(e.target.checked)} />Inclure l'historique des métriques</label>
      <div className="row">
        <a className="btn" href={`/api/export${metrics ? "?metrics=1" : ""}`} download><Download size={16} aria-hidden />Exporter</a>
        <Button icon={<Upload />} onClick={() => file.current?.click()}>Importer un fichier</Button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={onImport} />
      </div>
    </Section>
  );
}

function PasswordSection() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState<string>();
  const toast = useToast();
  return (
    <Section title="Sécurité" desc="Changer le mot de passe déconnecte toutes les autres sessions.">
      <Field label="Mot de passe actuel" htmlFor="pw-cur"><input id="pw-cur" className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
      <Field label="Nouveau mot de passe" htmlFor="pw-new" hint="12 caractères minimum" error={err}><input id="pw-new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <div><Button variant="primary" onClick={() => api.post("/api/auth/password", { current: cur, new: next }).then(() => { setCur(""); setNext(""); setErr(undefined); toast("Mot de passe modifié"); }, (e) => setErr(e.message))}>Changer le mot de passe</Button></div>
    </Section>
  );
}
