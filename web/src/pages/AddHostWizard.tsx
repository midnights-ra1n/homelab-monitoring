import { useEffect, useState } from "react";
import { Check, Cpu, HardDrive, Laptop, LoaderCircle, Server } from "lucide-react";
import { api, fmtBytes, fmtPct, type Host, type Install } from "../api";
import { Alert, Button, CodeBlock, Dialog, Field, Segmented, Switch, cn, inputClass, navigate, useToast } from "../ui";

type Kind = "vm" | "proxmox" | "physical" | "client";
const KINDS: { id: Kind; label: string; hint: string; icon: typeof Server; smart: boolean }[] = [
  { id: "vm", label: "Machine virtuelle", hint: "VM ou conteneur LXC, sans SMART", icon: Cpu, smart: false },
  { id: "proxmox", label: "Serveur Proxmox", hint: "Hyperviseur avec ses disques", icon: Server, smart: true },
  { id: "physical", label: "Serveur physique", hint: "NAS, serveur dédié", icon: HardDrive, smart: true },
  { id: "client", label: "Poste client", hint: "Ordinateur sous Debian", icon: Laptop, smart: true },
];

export interface InstallOptions { smart: boolean; autoUpdate: boolean; lxcToken?: string }

const REPO = "midnights-ra1n/homelab-monitoring";

export const UNINSTALL_COMMAND = `curl -fsSL https://raw.githubusercontent.com/${REPO}/stable/rust-agent/uninstall.sh | sudo sh`;

const validHubUrl = (u: string) => /^https?:\/\/[^\s'"`$\\]+$/.test(u);

/** Hub address as seen by the machines; editable, remembered for the next installs. */
export function HubUrlField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState(value);
  const [serverError, setServerError] = useState<string>();
  const save = () => {
    const v = value.trim().replace(/\/$/, "");
    if (v === saved || !validHubUrl(v)) return;
    api.put("/api/settings", { agent_hub_url: v }).then(
      () => { setSaved(v); setServerError(undefined); toast("Adresse du hub mémorisée pour les prochains hôtes"); },
      (e) => setServerError((e as Error).message));
  };
  return (
    <Field label="Adresse du hub" htmlFor="hub-url" error={validHubUrl(value) ? serverError : "L'adresse doit commencer par http:// ou https://"}
      hint="Adresse que la machine utilise pour joindre ce serveur (IP du LAN, nom de domaine…). Mémorisée pour les prochains hôtes.">
      <input id="hub-url" className={`${inputClass} font-mono`} value={value} onChange={(e) => { setServerError(undefined); onChange(e.target.value); }} onBlur={save} spellCheck={false} />
    </Field>
  );
}

/** One-liner for install.sh; options are passed as environment variables. */
export function installCommand(i: Install, o: InstallOptions) {
  const env = [`HUB_URL='${i.hub_url}'`, `TOKEN='${i.token}'`, `KEY='${i.key}'`];
  if (i.hub_url.startsWith("http://")) env.push("ALLOW_INSECURE=true");
  if (!o.smart) env.push("SMART=false");
  if (!o.autoUpdate) env.push("AUTO_UPDATE=false");
  if (o.lxcToken) env.push("LXC=all", `LXC_TOKEN='${o.lxcToken}'`);
  return `curl -fsSL https://raw.githubusercontent.com/${REPO}/stable/rust-agent/install.sh | sudo ${env.join(" ")} sh`;
}

function ansibleVars(name: string, i: Install, o: InstallOptions) {
  return [
    `# host_vars/${name || "mon-hote"}.yml — chiffrez-le : ansible-vault encrypt host_vars/${name || "mon-hote"}.yml`,
    `hlm_hub_url: ${i.hub_url}`,
    `hlm_agent_token: ${i.token}`,
    `hlm_key: "${i.key}"`,
    `hlm_smart: ${o.smart}`,
    `hlm_auto_update: ${o.autoUpdate}`,
  ].join("\n");
}

function envFile(i: Install, o: InstallOptions) {
  return [`HUB_URL=${i.hub_url}`, `TOKEN=${i.token}`, `KEY=${i.key}`,
    ...(i.hub_url.startsWith("http://") ? ["ALLOW_INSECURE=true"] : []), ...(o.autoUpdate ? [] : ["AUTO_UPDATE=false"])].join("\n");
}

/** Install instructions with one tab per method; also used after a token rotation. */
export function InstallInstructions({ install: initial, name, options = { smart: true, autoUpdate: true } }: { install: Install; name: string; options?: InstallOptions }) {
  const [method, setMethod] = useState<"curl" | "ansible" | "manual">("curl");
  const [hub, setHub] = useState(initial.hub_url);
  const install = { ...initial, hub_url: hub.trim().replace(/\/$/, "") };
  return (
    <div className="grid gap-5">
      <HubUrlField value={hub} onChange={setHub} />
      <Alert kind="warning" title="Le jeton ne sera plus affiché">Copie-le maintenant. Il peut être régénéré depuis la fiche de l'hôte.</Alert>
      {install.hub_url.startsWith("http://") && (
        <Alert kind="info" title="Liaison non chiffrée">Le hub est joint en HTTP : la commande ajoute ALLOW_INSECURE=true. Un reverse proxy HTTPS chiffrerait les échanges.</Alert>
      )}
      <Segmented className="w-fit" label="Méthode d'installation" value={method} onChange={setMethod} options={[["curl", "Commande"], ["ansible", "Ansible"], ["manual", "Manuel"]]} />
      {method === "curl" && (
        <>
          <p className="text-sm text-body">Collez cette ligne dans un terminal de la machine (Debian, avec sudo). Le script télécharge le binaire, vérifie son empreinte SHA-256, crée l'utilisateur hlm-agent et démarre le service.</p>
          {options.lxcToken && (
            <Alert kind="info" title="Conteneurs LXC inclus">Après le Proxmox, le script installe l'agent dans chaque conteneur Debian démarré (copie par pct push, sans accès Internet nécessaire dans les conteneurs). Chacun apparaît sous son nom. Relancez la même ligne pour équiper les conteneurs créés plus tard ; le jeton commun est valable 7 jours.</Alert>
          )}
          <CodeBlock text={installCommand(install, options)} />
        </>
      )}
      {method === "ansible" && (
        <>
          <p className="text-sm text-body">Avec le rôle <code className="font-mono text-xs text-h2">deploy/ansible/roles/hlm_agent</code>, ajoutez ces variables pour cet hôte puis lancez le playbook. Pour tout un parc, utilisez plutôt un jeton commun : bouton « Déploiement en masse » de la page Hôtes.</p>
          <CodeBlock text={ansibleVars(name, install, options)} />
          <CodeBlock text="ansible-playbook -i inventory.ini deploy/ansible/site.yml --ask-vault-pass --limit NOM_DE_L_HOTE" />
        </>
      )}
      {method === "manual" && (
        <>
          <p className="text-sm text-body">Installez le binaire <code className="font-mono text-xs text-h2">hlm-agent-linux-x86_64</code> ou <code className="font-mono text-xs text-h2">-aarch64</code> depuis les releases GitHub dans <code className="font-mono text-xs text-h2">/opt/hlm-agent/</code>, puis créez <code className="font-mono text-xs text-h2">/etc/hlm-agent/agent.env</code> (root:hlm-agent, 0640) :</p>
          <CodeBlock text={envFile(install, options)} />
          <p className="text-sm text-body">et installez l'unité <code className="font-mono text-xs text-h2">rust-agent/hlm-agent.service</code> du dépôt dans <code className="font-mono text-xs text-h2">/etc/systemd/system/</code> : <code className="font-mono text-xs text-h2">systemctl enable --now hlm-agent</code>.</p>
        </>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-meta hover:text-h1">Désinstaller l'agent plus tard</summary>
        <div className="mt-2"><CodeBlock text={UNINSTALL_COMMAND} /></div>
      </details>
    </div>
  );
}

const STEPS = ["Machine", "Installation", "Connexion"];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-5 flex gap-2" aria-label="Étapes">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === step ? "step" : undefined}
          className={cn("flex flex-1 items-center gap-2 border-b-2 pb-2 text-sm font-medium", i === step ? "border-accent text-h1" : i < step ? "border-accent-muted text-body" : "border-line text-meta")}>
          <span aria-hidden className={cn("grid size-[22px] shrink-0 place-items-center rounded-full text-xs tabular-nums", i <= step ? "bg-accent text-on-accent" : "bg-muted")}>
            {i < step ? <Check size={14} /> : i + 1}
          </span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

export function AddHostWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("vm");
  const [opts, setOpts] = useState<InstallOptions>({ smart: false, autoUpdate: true });
  const [lxc, setLxc] = useState(true);
  const [created, setCreated] = useState<{ id: number; install: Install }>();
  const [host, setHost] = useState<Host>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setStep(0); setName(""); setKind("vm"); setOpts({ smart: false, autoUpdate: true }); setLxc(true);
    setCreated(undefined); setHost(undefined); setError(undefined);
    onClose();
  };

  // Step 3: wait for the agent's first connection.
  useEffect(() => {
    if (step !== 2 || !created) return;
    let stop = false;
    const tick = () => api.get<Host>(`/api/hosts/${created.id}`).then((h) => { if (!stop) setHost(h); }, () => {});
    tick();
    const t = setInterval(() => { if (!host?.last_seen) tick(); }, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [step, created, host?.last_seen]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (created) { setStep(1); return; }
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ id: number; install: Install }>("/api/hosts", { name });
      if (kind === "proxmox" && lxc) {
        // LXC containers enroll themselves with a shared token, one host each.
        const e = await api.post<{ install: Install }>("/api/enroll-tokens", { name: `LXC de ${name}`, expires_at: Math.floor(Date.now() / 1000) + 7 * 86400 });
        setOpts((o) => ({ ...o, lxcToken: e.install.token }));
      } else {
        setOpts((o) => ({ ...o, lxcToken: undefined }));
      }
      setCreated(r);
      setStep(1);
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  const online = !!host?.last_seen;

  const footer = [
    <>
      <Button variant="secondary" onClick={close}>Annuler</Button>
      <Button type="submit" form="wiz-host" loading={busy}>{created ? "Continuer" : "Créer l'hôte"}</Button>
    </>,
    <>
      <Button variant="secondary" onClick={() => setStep(0)}>Retour</Button>
      <Button onClick={() => setStep(2)}>J'ai lancé l'installation</Button>
    </>,
    <>
      <Button variant="secondary" onClick={() => setStep(1)}>Retour aux instructions</Button>
      {online ? <Button onClick={() => { const id = created!.id; close(); navigate(`/hosts/${id}`); }}>Voir l'hôte</Button>
        : <Button variant="secondary" onClick={close}>Fermer, je reviendrai plus tard</Button>}
    </>,
  ][step];

  return (
    <Dialog open={open} onClose={close} size="lg" title="Ajouter un hôte" description="Trois étapes : décrire la machine, installer l'agent, vérifier la connexion." footer={footer}>
      <Stepper step={step} />
      {step === 0 && (
        <form id="wiz-host" className="grid gap-5" onSubmit={create} noValidate>
          <Field label="Nom" htmlFor="wiz-name" error={error} hint="Tel qu'il apparaîtra dans le tableau de bord, par exemple pve-01">
            <input id="wiz-name" className={inputClass} value={name} disabled={!!created} onChange={(e) => setName(e.target.value)} autoFocus aria-invalid={!!error} />
          </Field>
          <fieldset className="mm-field">
            <legend className="mm-field__label mb-1.5">Type de machine</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
              {KINDS.map((k) => (
                <button key={k.id} type="button" role="radio" aria-checked={kind === k.id}
                  className="flex flex-col items-start gap-1 rounded-xl border border-line-subtle bg-box p-3 text-left transition-colors hover:border-line-strong aria-checked:border-accent aria-checked:bg-accent-soft"
                  onClick={() => { setKind(k.id); setOpts((o) => ({ ...o, smart: k.smart })); }}>
                  <span className="mb-1 flex size-8 items-center justify-center rounded-full bg-accent-soft text-accent-text"><k.icon size={16} aria-hidden /></span>
                  <span className="text-sm font-medium text-h1">{k.label}</span>
                  <span className="text-xs text-meta">{k.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <Switch label="Surveiller les disques (SMART, installe smartmontools)" checked={opts.smart} onChange={(v) => setOpts({ ...opts, smart: v })} />
          <Switch label="Mise à jour automatique quotidienne de l'agent" checked={opts.autoUpdate} onChange={(v) => setOpts({ ...opts, autoUpdate: v })} />
          {kind === "proxmox" && (
            <Switch label="Installer aussi dans les conteneurs LXC Debian démarrés" checked={lxc} onChange={setLxc} />
          )}
        </form>
      )}
      {step === 1 && created && <InstallInstructions install={created.install} name={name} options={opts} />}
      {step === 2 && (
        <div className="grid gap-5" aria-live="polite">
          {online ? (
            <>
              <Alert kind="success" title={`${name} est connecté`}>Les premières mesures sont arrivées.</Alert>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:text-h2 [&_dt]:text-meta">
                <dt>Système</dt><dd>{host!.info.os || "—"}</dd>
                <dt>Processeur</dt><dd>{host!.info.cpu_model || "—"}</dd>
                <dt>CPU</dt><dd className="tabular-nums">{fmtPct(host!.latest.cpu)}</dd>
                <dt>Mémoire</dt><dd className="tabular-nums">{fmtBytes(host!.latest.mem_used)} / {fmtBytes(host!.latest.mem_total)}</dd>
                <dt>Agent</dt><dd className="font-mono">{host!.info.agent_version || "—"}</dd>
              </dl>
            </>
          ) : (
            <>
              <Alert kind="info" title="En attente de l'agent…" action={<LoaderCircle size={16} className="animate-spin text-meta" aria-hidden />}>La connexion apparaît ici quelques secondes après la fin de l'installation.</Alert>
              <p className="text-sm text-body">Rien après une minute ? Sur la machine : <code className="font-mono text-xs text-h2">systemctl status hlm-agent</code> et <code className="font-mono text-xs text-h2">journalctl -u hlm-agent -n 30</code>. Messages fréquents :</p>
              <ul className="m-0 grid list-disc gap-1 pl-5 text-sm text-body">
                <li><code className="font-mono text-xs text-h2">hub rejected TOKEN (401)</code> : jeton mal copié ou régénéré depuis.</li>
                <li><code className="font-mono text-xs text-h2">hub signature invalid</code> : la clé KEY ne correspond pas à ce hub.</li>
                <li><code className="font-mono text-xs text-h2">HUB_URL uses plain http</code> : ajoutez ALLOW_INSECURE=true.</li>
                <li>Délai dépassé : la machine ne joint pas {created?.install.hub_url} (pare-feu, DNS).</li>
              </ul>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
