import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Send, Upload } from "lucide-react";
import { api, fmtBytes } from "../api";
import {
  Alert, Button, ButtonAnchor, ButtonLink, Card, CardBody, Checkbox, FIELD_ROW, FORM_ACTIONS, Field, PageHeader, SECTIONS, SectionTitle, SettingsSection,
  Skeleton, Switch, ThemeSwitch, inputClass, useToast,
} from "../ui";
import { EmailEditor } from "./EmailEditor";
import { ApiSection } from "./ApiTokens";

type S = Record<string, string>;
interface SettingsResp { settings: S; db_size: number; version: string }

export function SettingsPage({ version }: { version: string }) {
  const [data, setData] = useState<SettingsResp>();
  const [draft, setDraft] = useState<S>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const toast = useToast();

  useEffect(() => { api.get<SettingsResp>("/api/settings").then((d) => { setData(d); setDraft({ ...d.settings, smtp_pass: "" }); }, (e) => setError(e.message)); }, []);
  if (!data) return error ? <Alert kind="error" title={error} /> : <Skeleton className="h-[40rem]" />;

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
    <Field label={label} htmlFor={`s-${k}`} hint={hint}><input id={`s-${k}`} className={inputClass} value={v(k)} onChange={set(k)} {...props} /></Field>
  );

  const tzNow = (() => { try { return new Date().toLocaleString("fr-FR", { timeZone: v("timezone"), dateStyle: "short", timeStyle: "short" }); } catch { return "—"; } })();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <>
      <PageHeader title="Configuration" description="Apparence, collecte et rétention, notifications, page de statut, API, sauvegardes et compte." />
      {error && <Alert kind="error" title="Enregistrement impossible" className="mb-6">{error}</Alert>}
      <div className={SECTIONS}>
        <div className="grid gap-8 lg:grid-cols-2 xl:gap-10">
          <section aria-labelledby="appearance">
            <SectionTitle id="appearance">Apparence</SectionTitle>
            <Card>
              <CardBody className="grid gap-4">
                <p className="text-sm text-body">Interface Midnights Classic. « Auto » suit le réglage clair / sombre du système. Mémorisée sur cet appareil.</p>
                <ThemeSwitch className="w-fit" />
                <Field label="Fuseau horaire" htmlFor="s-tz" hint={`Heures des e-mails, des rapports et des messages des sondes. Heure actuelle : ${tzNow}`}>
                  <select id="s-tz" className={inputClass} value={v("timezone")} onChange={set("timezone")}>
                    {Intl.supportedValuesOf("timeZone").concat(Intl.supportedValuesOf("timeZone").includes(v("timezone")) ? [] : [v("timezone")]).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
                  </select>
                </Field>
                <div className={FORM_ACTIONS}>
                  {browserTz !== v("timezone") && (
                    <Button variant="ghost" onClick={() => setDraft({ ...draft, timezone: browserTz })}>Utiliser {browserTz.replace(/_/g, " ")}</Button>
                  )}
                  <Button loading={busy === "tz"} onClick={() => save("tz", ["timezone"])}>Enregistrer le fuseau</Button>
                </div>
              </CardBody>
            </Card>
          </section>
          <section aria-labelledby="about">
            <SectionTitle id="about">À propos</SectionTitle>
            <Card>
              <CardBody>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  {[["Version", version], ["Base de données", fmtBytes(data.db_size)], ["Intervalle des agents", `${v("agent_interval_s")} s`], ["Rétention des métriques", `${v("retention_metrics_days")} j`]].map(([k, val]) => (
                    <div key={k} className="min-w-0">
                      <dt className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-meta">{k}</dt>
                      <dd className="mt-0.5 truncate font-mono text-h2" title={val}>{val}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>
          </section>
        </div>

        <SettingsSection id="retention" title="Collecte et rétention"
          description="Un intervalle plus long et une rétention plus courte allègent le serveur. Les données plus anciennes sont supprimées toutes les heures."
          actions={<>
            <Button variant="secondary" loading={busy === "vac"} onClick={async () => {
              setBusy("vac");
              try { setData(await api.post<SettingsResp>("/api/maintenance/vacuum")); toast("Base nettoyée et compactée"); } catch (e) { setError((e as Error).message); }
              setBusy(undefined);
            }}>Nettoyer et compacter la base</Button>
            <Button loading={busy === "ret"} onClick={() => save("ret", ["agent_interval_s", "retention_metrics_days", "retention_results_days", "retention_daily_days"])}>Enregistrer la rétention</Button>
          </>}>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {input("agent_interval_s", "Intervalle des agents (s)", { type: "number", min: 5 })}
            {input("retention_metrics_days", "Métriques des hôtes (jours)", { type: "number", min: 1 })}
            {input("retention_results_days", "Résultats des sondes (jours)", { type: "number", min: 1 })}
            {input("retention_daily_days", "Disponibilité journalière (jours)", { type: "number", min: 90 })}
          </div>
          <p className="font-mono text-xs text-meta">Taille de la base : {fmtBytes(data.db_size)}</p>
        </SettingsSection>

        <SettingsSection id="notifications" title="Notifications par e-mail"
          description="Les changements d'état survenant pendant la fenêtre de regroupement sont envoyés dans un seul message."
          actions={<>
            <Button variant="secondary" icon={<Send size={16} />} loading={busy === "test"} onClick={async () => {
              setBusy("test");
              try { await api.post("/api/settings/test-email"); toast("E-mail de test envoyé"); } catch (e) { setError((e as Error).message); }
              setBusy(undefined);
            }}>Envoyer un e-mail de test</Button>
            <Button loading={busy === "smtp"} onClick={() => save("smtp", ["smtp_enabled", "smtp_host", "smtp_port", "smtp_tls", "smtp_user", "smtp_pass", "smtp_from", "smtp_to", "notify_window_s", "status_title", "notify_security_updates", "notify_reboot", "notify_docker_updates", "notify_smart_level"])}>Enregistrer les notifications</Button>
          </>}>
          <Switch label="Activer les notifications" checked={bool("smtp_enabled")} onChange={(c) => setDraft({ ...draft, smtp_enabled: String(c) })} />
          <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            {input("smtp_host", "Serveur SMTP", { placeholder: "smtp.example.fr" })}
            {input("smtp_port", "Port", { type: "number" })}
            <Field label="Chiffrement" htmlFor="s-tls">
              <select id="s-tls" className={inputClass} value={v("smtp_tls")} onChange={set("smtp_tls")}>
                <option value="starttls">STARTTLS</option><option value="tls">TLS implicite</option><option value="none">Aucun</option>
              </select>
            </Field>
          </div>
          <div className={FIELD_ROW}>
            {input("smtp_user", "Utilisateur (facultatif)", { autoComplete: "off" })}
            {input("smtp_pass", "Mot de passe", { type: "password", autoComplete: "new-password", placeholder: data.settings.smtp_pass_set === "true" ? "Inchangé" : "" })}
          </div>
          <div className={FIELD_ROW}>
            {input("smtp_from", "Expéditeur", { placeholder: "Homelab <alertes@example.fr>" })}
            {input("smtp_to", "Destinataires", { placeholder: "moi@example.fr, autre@example.fr" }, "Séparés par des virgules")}
          </div>
          <div className={FIELD_ROW}>
            {input("notify_window_s", "Fenêtre de regroupement (s)", { type: "number", min: 0 }, "0 : envoi immédiat de chaque changement")}
            {input("status_title", "Nom de l'infrastructure", {}, "Utilisé dans les e-mails ({titre}) et les rapports")}
          </div>
          <fieldset className="grid gap-3 border-t border-line-subtle pt-5">
            <legend className="mm-label-caps float-left mb-3 w-full">Alerter aussi pour</legend>
            <Checkbox label="Nouvelles mises à jour de sécurité" checked={bool("notify_security_updates")} onChange={(e) => setDraft({ ...draft, notify_security_updates: String(e.target.checked) })} />
            <Checkbox label="Redémarrage requis" checked={bool("notify_reboot")} onChange={(e) => setDraft({ ...draft, notify_reboot: String(e.target.checked) })} />
            <Checkbox label="Nouvelles images Docker disponibles" checked={bool("notify_docker_updates")} onChange={(e) => setDraft({ ...draft, notify_docker_updates: String(e.target.checked) })} />
            <Field label="Santé des disques (SMART)" htmlFor="s-smartlvl" className="mt-2 sm:max-w-sm"
              hint="Chaque mise à jour, redémarrage, image ou disque n'est signalé qu'une fois, dans le même e-mail que les autres alertes de la fenêtre.">
              <select id="s-smartlvl" className={inputClass} value={v("notify_smart_level")} onChange={set("notify_smart_level")}>
                <option value="watch">Dès qu'un disque est à surveiller</option>
                <option value="replace">Quand un disque est à remplacer</option>
                <option value="failing">Seulement en cas de défaillance</option>
                <option value="off">Jamais</option>
              </select>
            </Field>
          </fieldset>
        </SettingsSection>

        <section id="email" aria-labelledby="email-title">
          <SectionTitle id="email-title">Modèle d'e-mail</SectionTitle>
          <p className="-mt-1 mb-4 text-sm text-body">Compose le message d'alerte avec des blocs, ou passe en HTML avancé. L'aperçu utilise des événements fictifs.</p>
          <EmailEditor draft={draft} setDraft={setDraft} save={save} busy={busy} />
        </section>

        <div className="grid gap-8 lg:grid-cols-2 xl:gap-10">
          <SettingsSection id="status" title="Page de statut publique" description="Compose la page avec des blocs : services, disponibilité, graphiques, textes."
            actions={<>
              <ButtonAnchor variant="ghost" href="/status" target="_blank" rel="noopener" icon={<ExternalLink size={16} />}>Ouvrir la page</ButtonAnchor>
              <ButtonLink to="/status-page" variant="secondary">Modifier la page de statut</ButtonLink>
            </>}>
            {null}
          </SettingsSection>
          <SettingsSection id="report" title="Rapport mensuel"
            description="Bilan du mois précédent (disponibilité, latence, incidents, mises à jour, disques), envoyé par e-mail le 1er du mois à 8 h."
            actions={<>
              <ButtonLink to="/reports" variant="ghost">Voir les rapports</ButtonLink>
              <Button variant="secondary" icon={<Send size={16} />} loading={busy === "sendrep"} onClick={async () => {
                setBusy("sendrep");
                try { await api.post("/api/reports/monthly/send"); toast("Rapport du mois dernier envoyé"); } catch (e) { setError((e as Error).message); }
                setBusy(undefined);
              }}>Envoyer le dernier</Button>
              <Button loading={busy === "report"} onClick={() => save("report", ["report_monthly_enabled"])}>Enregistrer</Button>
            </>}>
            <Switch label="Envoyer le rapport chaque mois" checked={bool("report_monthly_enabled")} onChange={(c) => setDraft({ ...draft, report_monthly_enabled: String(c) })} />
          </SettingsSection>
        </div>

        <ApiSection draft={draft} setDraft={setDraft} save={save} busy={busy} />

        <div className="grid gap-8 lg:grid-cols-2 xl:gap-10">
          <ImportExportSection />
          <PasswordSection />
        </div>
      </div>
    </>
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
    <SettingsSection id="data" title="Sauvegarde & restauration"
      description="Exporte les réglages, les sondes et la liste des hôtes au format JSON. Les secrets (mot de passe SMTP, jetons d'agent) ne sont jamais exportés."
      actions={<>
        <Button variant="secondary" icon={<Upload size={16} />} onClick={() => file.current?.click()}>Importer un fichier</Button>
        <ButtonAnchor href={`/api/export${metrics ? "?metrics=1" : ""}`} download icon={<Download size={16} />}>Exporter</ButtonAnchor>
      </>}>
      {msg && <Alert kind={msg.tone === "danger" ? "error" : "success"}>{msg.text}</Alert>}
      <Checkbox label="Inclure l'historique des métriques" checked={metrics} onChange={(e) => setMetrics(e.target.checked)} />
      <input ref={file} type="file" accept="application/json,.json" hidden onChange={onImport} />
    </SettingsSection>
  );
}

function PasswordSection() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState<string>();
  const toast = useToast();
  return (
    <SettingsSection id="account" title="Compte" description="Changer le mot de passe déconnecte toutes les autres sessions."
      actions={<Button onClick={() => api.post("/api/auth/password", { current: cur, new: next }).then(() => { setCur(""); setNext(""); setErr(undefined); toast("Mot de passe modifié"); }, (e) => setErr(e.message))}>Changer le mot de passe</Button>}>
      <Field label="Mot de passe actuel" htmlFor="pw-cur"><input id="pw-cur" className={inputClass} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
      <Field label="Nouveau mot de passe" htmlFor="pw-new" hint="12 caractères minimum" error={err}><input id="pw-new" className={inputClass} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
    </SettingsSection>
  );
}
