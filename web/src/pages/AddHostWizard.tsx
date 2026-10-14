import { useEffect, useState } from "react";
import { Check, CircleCheck, Cpu, HardDrive, Laptop, LoaderCircle, Server } from "lucide-react";
import { api, fmtBytes, fmtPct, type Host, type Install } from "../api";
import { Alert, Button, CodeBlock, Dialog, Field, Segmented, Switch, navigate, useToast } from "../ui";

type Kind = "vm" | "proxmox" | "physical" | "client";
const KINDS: { id: Kind; label: string; hint: string; icon: typeof Server; smart: boolean }[] = [
  { id: "vm", label: "Machine virtuelle", hint: "VM ou conteneur LXC, sans SMART", icon: Cpu, smart: false },
  { id: "proxmox", label: "Serveur Proxmox", hint: "Hyperviseur avec ses disques", icon: Server, smart: true },
  { id: "physical", label: "Serveur physique", hint: "NAS, serveur dédié", icon: HardDrive, smart: true },
  { id: "client", label: "Poste client", hint: "Ordinateur sous Debian", icon: Laptop, smart: true },
];

export interface InstallOptions { smart: boolean; autoUpdate: boolean }

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
      <input id="hub-url" className="input mono" value={value} onChange={(e) => { setServerError(undefined); onChange(e.target.value); }} onBlur={save} spellCheck={false} />
    </Field>
  );
}

/** One-liner for install.sh; options are passed as environment variables. */
export function installCommand(i: Install, o: InstallOptions) {
  const env = [`HUB_URL='${i.hub_url}'`, `TOKEN='${i.token}'`, `KEY='${i.key}'`];
  if (i.hub_url.startsWith("http://")) env.push("ALLOW_INSECURE=true");
  if (!o.smart) env.push("SMART=false");
  if (!o.autoUpdate) env.push("AUTO_UPDATE=false");
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
    <div className="form">
      <HubUrlField value={hub} onChange={setHub} />
      <Alert tone="warning" title="Le jeton ne sera plus affiché">Copiez-le maintenant. Il peut être régénéré depuis la fiche de l'hôte.</Alert>
      {install.hub_url.startsWith("http://") && (
        <Alert tone="info" title="Liaison non chiffrée">Le hub est joint en HTTP : la commande ajoute ALLOW_INSECURE=true. Un reverse proxy HTTPS chiffrerait les échanges.</Alert>
      )}
      <Segmented label="Méthode d'installation" value={method} onChange={setMethod} options={[["curl", "Commande"], ["ansible", "Ansible"], ["manual", "Manuel"]]} />
      {method === "curl" && (
        <>
          <p className="small muted">Collez cette ligne dans un terminal de la machine (Debian, avec sudo). Le script télécharge le binaire, vérifie son empreinte SHA-256, crée l'utilisateur hlm-agent et démarre le service.</p>
          <CodeBlock text={installCommand(install, options)} />
        </>
      )}
      {method === "ansible" && (
        <>
          <p className="small muted">Avec le rôle <span className="mono">deploy/ansible/roles/hlm_agent</span>, ajoutez ces variables pour cet hôte puis lancez le playbook. Pour tout un parc, utilisez plutôt un jeton commun : bouton « Déploiement en masse » de la page Hôtes.</p>
          <CodeBlock text={ansibleVars(name, install, options)} />
          <CodeBlock text="ansible-playbook -i inventory.ini deploy/ansible/site.yml --ask-vault-pass --limit NOM_DE_L_HOTE" />
        </>
      )}
      {method === "manual" && (
        <>
          <p className="small muted">Installez le binaire <span className="mono">hlm-agent-linux-x86_64</span> ou <span className="mono">-aarch64</span> depuis les releases GitHub dans <span className="mono">/opt/hlm-agent/</span>, puis créez <span className="mono">/etc/hlm-agent/agent.env</span> (root:hlm-agent, 0640) :</p>
          <CodeBlock text={envFile(install, options)} />
          <p className="small muted">et installez l'unité <span className="mono">rust-agent/hlm-agent.service</span> du dépôt dans <span className="mono">/etc/systemd/system/</span> : <span className="mono">systemctl enable --now hlm-agent</span>.</p>
        </>
      )}
      <details className="small">
        <summary className="muted" style={{ cursor: "pointer" }}>Désinstaller l'agent plus tard</summary>
        <div style={{ marginTop: 8 }}><CodeBlock text={UNINSTALL_COMMAND} /></div>
      </details>
    </div>
  );
}

const STEPS = ["Machine", "Installation", "Connexion"];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="stepper" aria-label="Étapes">
      {STEPS.map((s, i) => (
        <li key={s} className={i < step ? "done" : i === step ? "current" : ""} aria-current={i === step ? "step" : undefined}>
          <span className="step-num" aria-hidden>{i < step ? <Check size={14} /> : i + 1}</span>
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
  const [created, setCreated] = useState<{ id: number; install: Install }>();
  const [host, setHost] = useState<Host>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setStep(0); setName(""); setKind("vm"); setOpts({ smart: false, autoUpdate: true });
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
      setCreated(r);
      setStep(1);
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  const online = !!host?.last_seen;

  const footer = [
    <>
      <Button onClick={close}>Annuler</Button>
      <Button variant="primary" type="submit" form="wiz-host" loading={busy}>{created ? "Continuer" : "Créer l'hôte"}</Button>
    </>,
    <>
      <Button onClick={() => setStep(0)}>Retour</Button>
      <Button variant="primary" onClick={() => setStep(2)}>J'ai lancé l'installation</Button>
    </>,
    <>
      <Button onClick={() => setStep(1)}>Retour aux instructions</Button>
      {online ? <Button variant="primary" onClick={() => { const id = created!.id; close(); navigate(`/hosts/${id}`); }}>Voir l'hôte</Button>
        : <Button onClick={close}>Fermer, je reviendrai plus tard</Button>}
    </>,
  ][step];

  return (
    <Dialog open={open} onClose={close} wide title="Ajouter un hôte" description="Trois étapes : décrire la machine, installer l'agent, vérifier la connexion." footer={footer}>
      <Stepper step={step} />
      {step === 0 && (
        <form id="wiz-host" className="form" onSubmit={create} noValidate>
          <Field label="Nom" htmlFor="wiz-name" error={error} hint="Tel qu'il apparaîtra dans le tableau de bord, par exemple pve-01">
            <input id="wiz-name" className="input" value={name} disabled={!!created} onChange={(e) => setName(e.target.value)} autoFocus aria-invalid={!!error} />
          </Field>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontSize: "var(--text-sm)", fontWeight: 500, marginBottom: 6 }}>Type de machine</legend>
            <div className="choice-grid" role="radiogroup">
              {KINDS.map((k) => (
                <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className="choice"
                  onClick={() => { setKind(k.id); setOpts((o) => ({ ...o, smart: k.smart })); }}>
                  <k.icon size={20} aria-hidden />
                  <strong>{k.label}</strong>
                  <span className="xs muted">{k.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <Switch label="Surveiller les disques (SMART, installe smartmontools)" checked={opts.smart} onChange={(v) => setOpts({ ...opts, smart: v })} />
          <Switch label="Mise à jour automatique quotidienne de l'agent" checked={opts.autoUpdate} onChange={(v) => setOpts({ ...opts, autoUpdate: v })} />
        </form>
      )}
      {step === 1 && created && <InstallInstructions install={created.install} name={name} options={opts} />}
      {step === 2 && (
        <div className="form" aria-live="polite">
          {online ? (
            <>
              <div className="alert success"><CircleCheck aria-hidden /><div><strong>{name} est connecté</strong>Les premières mesures sont arrivées.</div></div>
              <dl className="kv">
                <dt>Système</dt><dd>{host!.info.os || "—"}</dd>
                <dt>Processeur</dt><dd>{host!.info.cpu_model || "—"}</dd>
                <dt>CPU</dt><dd className="num">{fmtPct(host!.latest.cpu)}</dd>
                <dt>Mémoire</dt><dd className="num">{fmtBytes(host!.latest.mem_used)} / {fmtBytes(host!.latest.mem_total)}</dd>
                <dt>Agent</dt><dd className="mono">{host!.info.agent_version || "—"}</dd>
              </dl>
            </>
          ) : (
            <>
              <div className="alert info"><LoaderCircle aria-hidden className="spin" /><div><strong>En attente de l'agent…</strong>La connexion apparaît ici quelques secondes après la fin de l'installation.</div></div>
              <p className="small muted">Rien après une minute ? Sur la machine : <span className="mono">systemctl status hlm-agent</span> et <span className="mono">journalctl -u hlm-agent -n 30</span>. Messages fréquents :</p>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li><span className="mono">hub rejected TOKEN (401)</span> : jeton mal copié ou régénéré depuis.</li>
                <li><span className="mono">hub signature invalid</span> : la clé KEY ne correspond pas à ce hub.</li>
                <li><span className="mono">HUB_URL uses plain http</span> : ajoutez ALLOW_INSECURE=true.</li>
                <li>Délai dépassé : la machine ne joint pas {created?.install.hub_url} (pare-feu, DNS).</li>
              </ul>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
