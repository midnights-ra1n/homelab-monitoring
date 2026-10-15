import { useMemo, useState } from "react";
import { ChevronRight, LayoutGrid, List, Pencil, Plus, Radar, ShieldAlert, Timer, Trash2 } from "lucide-react";
import { api, certDays, fmtAgo, fmtDate, fmtMs, fmtNum, statusLabel, type Monitor, type MonitorInput, type MonitorType, type Series } from "../api";
import {
  Alert, Badge, Button, Card, Chart, Dialog, EmptyState, Field, Link, PageHeader, SECTIONS, STAT_GRID, SectionTitle, Segmented, Skeleton, Stat, StatusBadge,
  StatusIcon, Switch, Tag, UptimeBars, cn, fmtLatency, formatPct, inputClass, kindTone, navigate, statusKind, usePoll, useTitle, useToast,
} from "../ui";

const TYPES: Record<MonitorType, string> = { http: "HTTP(S)", tcp: "Port TCP", dns: "DNS", ssl: "Certificat SSL", snmp: "SNMP", meross: "Prise Meross" };
const TARGET_HINT: Record<MonitorType, [string, string]> = {
  http: ["URL", "https://nextcloud.example.fr/status.php"],
  tcp: ["Hôte et port", "192.168.1.10:22"],
  dns: ["Nom de domaine", "example.fr"],
  ssl: ["Domaine (port facultatif)", "example.fr ou example.fr:8443"],
  snmp: ["Équipement (port facultatif)", "192.168.1.2 ou switch.lan:161"],
  meross: ["Adresse IP locale de la prise", "192.168.1.40"],
};

/** Unit of the value read by snmp / meross probes. */
const unitOf = (m: { type: MonitorType; config: { unit?: string } }) => (m.type === "meross" ? "W" : m.config.unit ?? "");
const fmtValue = (unit: string) => (v: number) => `${fmtNum(v, v < 10 ? 2 : 1)}${unit ? ` ${unit}` : ""}`;

/** Certificate expiry badge: always paired with a text label, never colour alone. */
export function CertBadge({ m }: { m: Monitor }) {
  const d = certDays(m);
  if (d == null) return <span className="text-meta">—</span>;
  const warn = m.config.warn_days ?? 14;
  return (
    <Badge tone={d <= 0 ? "red" : d < warn ? "yellow" : "green"} title={m.cert_expires_at ? `Expire le ${fmtDate(m.cert_expires_at)}` : undefined}>
      {d <= 0 ? "Expiré" : `${d} j`}
    </Badge>
  );
}

const uptime = (m: Monitor, last = 90) => {
  const known = (m.days ?? []).slice(-last).filter((d) => d.uptime != null);
  return known.length ? (known.reduce((a, d) => a + d.uptime!, 0) / known.length) * 100 : null;
};

export function MonitorsPage() {
  const { data, error, refresh } = usePoll(() => api.get<Monitor[]>("/api/monitors"), 15000);
  const [editing, setEditing] = useState<Monitor | "new">();
  const [view, setView] = useState<"cards" | "table">(() => (localStorage.getItem("hlm-view-monitors") as "table") || "cards");
  const changeView = (v: "cards" | "table") => { setView(v); try { localStorage.setItem("hlm-view-monitors", v); } catch { /* private mode */ } };
  const active = data?.filter((m) => m.enabled) ?? [];
  const ok = active.filter((m) => m.status === "operational").length;
  const certs = data?.filter((m) => certDays(m) != null) ?? [];
  const expiring = certs.filter((m) => certDays(m)! < (m.config.warn_days ?? 14)).length;
  const ups = active.map((m) => uptime(m)).filter((u): u is number => u != null);
  const lat = active.filter((m) => m.latency_ms != null && m.type !== "ssl");

  return (
    <>
      <PageHeader title="Sondes" description="Points de terminaison HTTP et TCP, serveurs DNS et expiration des certificats."
        actions={<Button icon={<Plus size={16} />} onClick={() => setEditing("new")}>Ajouter une sonde</Button>} />
      {error && <Alert kind="error" title="Impossible de charger les sondes" className="mb-6">{error}</Alert>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && data.length === 0 && (
        <EmptyState icon={<Radar size={20} />} title="Aucune sonde" action={<Button icon={<Plus size={16} />} onClick={() => setEditing("new")}>Ajouter une sonde</Button>}>
          Ajoute un service à surveiller : site web, port, serveur DNS ou certificat.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <div className={SECTIONS}>
          <div className={STAT_GRID}>
            <Stat label="Sondes" value={`${ok}/${active.length}`} detail="opérationnelle(s)" icon={<Radar size={16} />} tone={ok < active.length ? "red" : undefined} />
            <Stat label="Disponibilité 90 j" value={formatPct(ups.length ? ups.reduce((a, u) => a + u, 0) / ups.length : null)} detail="moyenne des sondes" />
            <Stat label="Latence moyenne" value={fmtMs(lat.length ? lat.reduce((a, m) => a + m.latency_ms!, 0) / lat.length : null)} icon={<Timer size={16} />} detail={`Sur ${lat.length} sonde(s)`} />
            <Stat label="Certificats" value={certs.length ? `${certs.length - expiring}/${certs.length}` : "—"} detail={expiring ? `${expiring} à renouveler` : "valides"} icon={<ShieldAlert size={16} />} tone={expiring ? "yellow" : undefined} />
          </div>
          <section aria-labelledby="probes-title">
            <SectionTitle id="probes-title" actions={
              <Segmented size="sm" label="Affichage" value={view} onChange={changeView}
                options={[["cards", <><LayoutGrid size={14} aria-hidden />Tuiles</>], ["table", <><List size={14} aria-hidden />Tableau</>]]} />
            }>{data.length} sonde(s)</SectionTitle>
            {view === "cards" ? (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.map((m) => {
                  const kind = statusKind(m.status, m);
                  const d = certDays(m);
                  const note = kind === "down" || kind === "warn" ? m.message
                    : d != null && d < (m.config.warn_days ?? 14) ? `Certificat : ${d} j restants`
                    : m.latency_ms != null && m.type !== "snmp" && m.type !== "meross" ? fmtLatency(m.latency_ms) : m.message;
                  return (
                    <li key={m.id} className={cn("relative grid gap-3 rounded-xl border border-line-subtle bg-box p-4 transition-colors hover:border-line-strong", !m.enabled && "opacity-60")}
                      style={kind === "down" ? { borderColor: `color-mix(in srgb, ${kindTone("down")} 40%, var(--mm-border))` } : undefined}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <StatusIcon kind={kind} size={18} />
                        <Link to={`/monitors/${m.id}`} title={m.target}
                          className="min-w-0 flex-1 truncate font-medium text-h1 no-underline after:absolute after:inset-0 after:rounded-xl">{m.name}</Link>
                        <span className="shrink-0 rounded-full border border-line-subtle px-1.5 font-mono text-[0.65rem] uppercase text-meta">{m.type}</span>
                        <span className="shrink-0 font-mono text-sm font-semibold text-h1">{formatPct(uptime(m, 30), 1)}</span>
                      </div>
                      <UptimeBars days={(m.days ?? []).slice(-30)} height={16} className="z-[1]" />
                      <p className={cn("truncate font-mono text-xs", kind === "down" ? "text-red" : "text-meta")} title={note}>{note || "—"}</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Card flush title="Toutes les sondes" sub={`${data.length} sonde(s)`}>
                <div className="mm-table-wrap">
                  <table className="mm-table min-w-[56rem]">
                    <thead><tr><th scope="col">Nom</th><th scope="col">Type</th><th scope="col">État</th><th scope="col" className="mm-col-num">Latence</th><th scope="col">Certificat</th><th scope="col" className="min-w-60">30 derniers jours</th><th scope="col">Vérifiée</th></tr></thead>
                    <tbody>
                      {data.map((m) => (
                        <tr key={m.id} className="cursor-pointer" onClick={() => navigate(`/monitors/${m.id}`)}>
                          <td className="mm-col-strong max-w-[22rem]">
                            <Link to={`/monitors/${m.id}`} className="flex min-w-0 items-center gap-2.5 py-1.5 text-inherit no-underline hover:text-accent-text">
                              <StatusIcon kind={statusKind(m.status, m)} />
                              <span className="min-w-0"><span className="block truncate">{m.name}</span><span className="block truncate font-mono text-xs font-normal text-meta">{m.target}</span></span>
                            </Link>
                          </td>
                          <td className="mm-col-muted">{TYPES[m.type]}</td>
                          <td><StatusBadge status={m.enabled ? m.status : "unknown"} /></td>
                          <td className="mm-col-num font-mono text-xs">{fmtMs(m.latency_ms)}</td>
                          <td><CertBadge m={m} /></td>
                          <td><UptimeBars days={(m.days ?? []).slice(-30)} height={20} /></td>
                          <td className="mm-col-muted">{m.enabled ? fmtAgo(m.last_check / 1000) : "Désactivée"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </section>
        </div>
      )}
      {editing && <MonitorDialog monitor={editing === "new" ? undefined : editing} onClose={(changed) => { setEditing(undefined); if (changed) refresh(); }} />}
    </>
  );
}

type CfgSetter = <K extends keyof MonitorInput["config"]>(k: K, v: MonitorInput["config"][K]) => void;

function SnmpFields({ m, cfg, editing }: { m: MonitorInput; cfg: CfgSetter; editing: boolean }) {
  const c = m.config;
  const row = "flex flex-wrap items-end gap-3 [&>.mm-field]:min-w-40 [&>.mm-field]:flex-1";
  const secret = (k: "community" | "auth_pass" | "priv_pass", label: string) => (
    <Field label={label} htmlFor={`m-${k}`}>
      <input id={`m-${k}`} className={inputClass} type="password" autoComplete="new-password" placeholder={editing ? "Inchangé" : k === "community" ? "public" : ""}
        value={c[k] ?? ""} onChange={(e) => cfg(k, e.target.value)} />
    </Field>
  );
  return (
    <>
      <div className={row}>
        <Field label="Version" htmlFor="m-snmpv">
          <select id="m-snmpv" className={inputClass} value={c.snmp_version ?? "2c"} onChange={(e) => cfg("snmp_version", e.target.value as "2c")}>
            <option value="1">v1</option><option value="2c">v2c</option><option value="3">v3 (recommandé)</option>
          </select>
        </Field>
        <Field label="OID" htmlFor="m-oid" hint="Ex. 1.3.6.1.2.1.1.3.0 (uptime)"><input id="m-oid" className={`${inputClass} font-mono`} value={c.oid ?? ""} onChange={(e) => cfg("oid", e.target.value)} /></Field>
        <Field label="Unité (facultatif)" htmlFor="m-unit"><input id="m-unit" className={inputClass} placeholder="°C, %, W…" value={c.unit ?? ""} onChange={(e) => cfg("unit", e.target.value)} /></Field>
      </div>
      {(c.snmp_version ?? "2c") !== "3" ? (
        <div className={row}>
          {secret("community", "Communauté")}
          <Field label="Texte attendu (facultatif)" htmlFor="m-exp"><input id="m-exp" className={inputClass} value={c.expected ?? ""} onChange={(e) => cfg("expected", e.target.value)} /></Field>
        </div>
      ) : (
        <>
          <div className={row}>
            <Field label="Utilisateur" htmlFor="m-user"><input id="m-user" className={inputClass} autoComplete="off" value={c.snmp_user ?? ""} onChange={(e) => cfg("snmp_user", e.target.value)} /></Field>
            <Field label="Authentification" htmlFor="m-auth">
              <select id="m-auth" className={inputClass} value={c.auth_proto ?? ""} onChange={(e) => cfg("auth_proto", e.target.value)}>
                <option value="">Aucune</option>{["SHA", "SHA256", "SHA512", "MD5"].map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
            {secret("auth_pass", "Mot de passe d'authentification")}
          </div>
          <div className={row}>
            <Field label="Chiffrement" htmlFor="m-priv">
              <select id="m-priv" className={inputClass} value={c.priv_proto ?? ""} onChange={(e) => cfg("priv_proto", e.target.value)}>
                <option value="">Aucun</option>{["AES", "AES256", "DES"].map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
            {secret("priv_pass", "Mot de passe de chiffrement")}
          </div>
        </>
      )}
      {(c.snmp_version ?? "2c") !== "3" && <p className="mm-help -mt-3">v1/v2c transmettent la communauté en clair : préfère SNMPv3 avec authentification et chiffrement.</p>}
    </>
  );
}

const blank: MonitorInput = { name: "", type: "http", target: "", interval_s: 60, timeout_s: 10, config: {}, enabled: true, maintenance: false, public: false };

function MonitorDialog({ monitor, onClose }: { monitor?: Monitor; onClose: (changed: boolean, m?: Monitor) => void }) {
  // Only send editable fields: the API rejects unknown ones.
  const [m, setM] = useState<MonitorInput>(() => monitor ? {
    name: monitor.name, type: monitor.type, target: monitor.target, interval_s: monitor.interval_s, timeout_s: monitor.timeout_s,
    config: { ...monitor.config }, enabled: monitor.enabled, maintenance: monitor.maintenance, public: monitor.public,
  } : blank);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = <K extends keyof MonitorInput>(k: K, v: MonitorInput[K]) => setM((x) => ({ ...x, [k]: v }));
  const cfg = <K extends keyof MonitorInput["config"]>(k: K, v: MonitorInput["config"][K]) => setM((x) => ({ ...x, config: { ...x.config, [k]: v } }));
  const num = (v: string) => (v === "" ? undefined : Number(v));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const saved = monitor ? await api.put<Monitor>(`/api/monitors/${monitor.id}`, m) : await api.post<Monitor>("/api/monitors", m);
      toast(monitor ? "Sonde mise à jour" : "Sonde créée, première vérification en cours");
      onClose(true, saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [targetLabel, targetPh] = TARGET_HINT[m.type];

  return (
    <Dialog open onClose={() => onClose(false)} size="lg" title={monitor ? `Modifier ${monitor.name}` : "Ajouter une sonde"}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Annuler</Button><Button type="submit" form="monitor-form" loading={busy}>{monitor ? "Enregistrer la sonde" : "Créer la sonde"}</Button></>}>
      <form id="monitor-form" className="grid gap-5" onSubmit={submit} noValidate>
        {error && <Alert kind="error" title={error} />}
        <Field label="Type">
          <Segmented label="Type de sonde" value={m.type} onChange={(t) => setM((x) => ({ ...x, type: t, config: {} }))} options={Object.entries(TYPES) as [MonitorType, string][]} />
        </Field>
        <div className="flex flex-wrap items-end gap-3 [&>.mm-field]:min-w-40 [&>.mm-field]:flex-1">
          <Field label="Nom" htmlFor="m-name"><input id="m-name" className={inputClass} value={m.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label={targetLabel} htmlFor="m-target"><input id="m-target" className={`${inputClass} font-mono`} placeholder={targetPh} value={m.target} onChange={(e) => set("target", e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap items-end gap-3 [&>.mm-field]:min-w-40 [&>.mm-field]:flex-1">
          <Field label="Intervalle (secondes)" htmlFor="m-int"><input id="m-int" className={`${inputClass} tabular-nums`} type="number" min={10} value={m.interval_s} onChange={(e) => set("interval_s", Number(e.target.value))} /></Field>
          <Field label="Délai d'attente (secondes)" htmlFor="m-to"><input id="m-to" className={`${inputClass} tabular-nums`} type="number" min={1} max={60} value={m.timeout_s} onChange={(e) => set("timeout_s", Number(e.target.value))} /></Field>
          <Field label="Échecs avant alerte" htmlFor="m-th" hint="Évite les fausses alertes"><input id="m-th" className={`${inputClass} tabular-nums`} type="number" min={1} max={10} placeholder="2" value={m.config.failure_threshold ?? ""} onChange={(e) => cfg("failure_threshold", num(e.target.value))} /></Field>
        </div>
        {m.type === "http" && (
          <>
            <div className="flex flex-wrap items-end gap-3 [&>.mm-field]:min-w-40 [&>.mm-field]:flex-1">
              <Field label="Méthode" htmlFor="m-meth">
                <select id="m-meth" className={inputClass} value={m.config.method ?? "GET"} onChange={(e) => cfg("method", e.target.value)}><option>GET</option><option>HEAD</option></select>
              </Field>
              <Field label="Codes HTTP attendus" htmlFor="m-codes" hint="Plages ou liste, ex. 200-299,301"><input id="m-codes" className={`${inputClass} font-mono`} placeholder="200-399" value={m.config.expected_status ?? ""} onChange={(e) => cfg("expected_status", e.target.value)} /></Field>
            </div>
            <Field label="Mot-clé attendu (facultatif)" htmlFor="m-kw"><input id="m-kw" className={inputClass} value={m.config.keyword ?? ""} onChange={(e) => cfg("keyword", e.target.value)} /></Field>
            <label className="flex cursor-pointer items-start gap-3 text-sm text-h2"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--mm-accent)]" checked={!!m.config.ignore_tls} onChange={(e) => cfg("ignore_tls", e.target.checked)} />Accepter les certificats auto-signés</label>
            <label className="flex cursor-pointer items-start gap-3 text-sm text-h2">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--mm-accent)]" checked={!!m.config.check_ssl} disabled={!m.target.startsWith("https://")} onChange={(e) => cfg("check_ssl", e.target.checked)} />
              Vérifier le certificat SSL (jours avant expiration)
            </label>
            {!m.target.startsWith("https://") && <p className="mm-help -mt-3">Disponible pour une URL https://</p>}
          </>
        )}
        {m.type === "dns" && (
          <div className="flex flex-wrap items-end gap-3 [&>.mm-field]:min-w-40 [&>.mm-field]:flex-1">
            <Field label="Enregistrement" htmlFor="m-rr">
              <select id="m-rr" className={inputClass} value={m.config.record_type ?? "A"} onChange={(e) => cfg("record_type", e.target.value)}>
                {["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Serveur DNS (facultatif)" htmlFor="m-dns" hint="Vide : résolveur du système"><input id="m-dns" className={`${inputClass} font-mono`} placeholder="192.168.1.53" value={m.config.dns_server ?? ""} onChange={(e) => cfg("dns_server", e.target.value)} /></Field>
            <Field label="Réponse attendue (facultatif)" htmlFor="m-exp"><input id="m-exp" className={`${inputClass} font-mono`} value={m.config.expected ?? ""} onChange={(e) => cfg("expected", e.target.value)} /></Field>
          </div>
        )}
        {m.type === "snmp" && <SnmpFields m={m} cfg={cfg} editing={!!monitor} />}
        {m.type === "meross" && (
          <Field label="Canal (multiprise)" htmlFor="m-ch" hint="0 pour une prise simple">
            <input id="m-ch" className={`${inputClass} tabular-nums`} type="number" min={0} max={8} placeholder="0" value={m.config.channel ?? ""} onChange={(e) => cfg("channel", num(e.target.value))} />
          </Field>
        )}
        {(m.type === "snmp" || m.type === "meross") && (
          <div className="flex flex-wrap items-end gap-3 [&>.mm-field]:min-w-40 [&>.mm-field]:flex-1">
            <Field label={`Seuil haut${m.type === "meross" ? " (W)" : ""} (facultatif)`} htmlFor="m-max" hint={m.type === "meross" ? "Alerte si la consommation le dépasse" : "Alerte au-dessus"}>
              <input id="m-max" className={`${inputClass} tabular-nums`} type="number" step="any" value={m.config.max_value ?? ""} onChange={(e) => cfg("max_value", num(e.target.value))} />
            </Field>
            <Field label={`Seuil bas${m.type === "meross" ? " (W)" : ""} (facultatif)`} htmlFor="m-min" hint={m.type === "meross" ? "Ex. appareil éteint par erreur" : "Alerte en dessous"}>
              <input id="m-min" className={`${inputClass} tabular-nums`} type="number" step="any" value={m.config.min_value ?? ""} onChange={(e) => cfg("min_value", num(e.target.value))} />
            </Field>
          </div>
        )}
        {m.type === "meross" && <p className="mm-help -mt-3">Lecture directe sur le réseau local, sans passer par le cloud. Connecte d'abord le compte Meross dans Configuration.</p>}
        {(m.type === "ssl" || (m.type === "http" && m.config.check_ssl)) && (
          <Field label="Avertir par e-mail avant expiration (jours)" htmlFor="m-warn" hint="Un seul e-mail par certificat, par exemple 3 jours avant">
            <input id="m-warn" className={`${inputClass} tabular-nums`} type="number" min={1} max={365} placeholder="14" value={m.config.warn_days ?? ""} onChange={(e) => cfg("warn_days", num(e.target.value))} />
          </Field>
        )}
        {m.type !== "ssl" && m.type !== "meross" && (
          <Field label="Seuil de lenteur en ms (facultatif)" htmlFor="m-slow" hint="Au-delà, la sonde passe en « performances dégradées »">
            <input id="m-slow" className={`${inputClass} tabular-nums`} type="number" min={0} value={m.config.degraded_ms ?? ""} onChange={(e) => cfg("degraded_ms", num(e.target.value))} />
          </Field>
        )}
        <div className="flex flex-wrap gap-6">
          <Switch label="Activée" checked={m.enabled} onChange={(v) => set("enabled", v)} />
          <Switch label="Maintenance" checked={m.maintenance} onChange={(v) => set("maintenance", v)} />
        </div>
      </form>
    </Dialog>
  );
}

type Range = "1h" | "24h" | "7d" | "30d" | "90d";

export function MonitorDetailPage({ id }: { id: number }) {
  const mon = usePoll(() => api.get<Monitor>(`/api/monitors/${id}`), 15000, [id]);
  const [range, setRange] = useState<Range>("24h");
  const res = usePoll(() => api.get<Series>(`/api/monitors/${id}/results?range=${range}`), 30000, [id, range]);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const series = useMemo(() => [{ label: "Latence", values: res.data?.latency ?? [] }], [res.data]);
  const valueSeries = useMemo(() => [{ label: "Valeur", values: res.data?.value ?? [] }], [res.data]);
  const m = mon.data;
  useTitle(m?.name ?? "Sondes");

  if (mon.error) return <Alert kind="error" title="Sonde introuvable">{mon.error}</Alert>;
  if (!m) return <Skeleton className="h-72" />;
  const lat = (res.data?.latency ?? []).filter((v): v is number => v != null);
  const d = certDays(m);

  return (
    <>
      <PageHeader
        crumbs={<><Link to="/monitors" className="text-meta no-underline hover:text-accent-text">Sondes</Link><ChevronRight size={14} aria-hidden /><span className="text-h2">{m.name}</span></>}
        title={<span className="flex items-center gap-3"><StatusIcon kind={statusKind(m.status, m)} size={26} />{m.name}</span>}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={m.status} /><Tag>{TYPES[m.type]}</Tag><span className="font-mono text-xs">{m.target}</span></span>}
        actions={<>
          <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => setEditing(true)}>Modifier</Button>
          <Button variant="danger-ghost" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>Supprimer</Button>
        </>} />
      <div className={SECTIONS}>
        {m.message && m.status !== "operational" && (
          <Alert kind={m.status === "degraded" ? "warning" : m.status === "maintenance" ? "info" : "error"} title={statusLabel[m.status]}>{m.message}</Alert>
        )}
        <div className={STAT_GRID}>
          <Stat label="Dernière latence" value={fmtMs(m.latency_ms)} icon={<Timer size={16} />}
            detail={m.last_check ? `Vérifiée ${fmtAgo(m.last_check / 1000)}` : "Jamais vérifiée"} />
          <Stat label="Latence moyenne" value={fmtMs(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null)} detail="sur la période" />
          <Stat label="Latence max." value={fmtMs(lat.length ? Math.max(...lat) : null)} detail="sur la période" />
          {d != null ? (
            <Stat label="Certificat SSL" value={d <= 0 ? "Expiré" : `${d} j`} icon={<ShieldAlert size={16} />} tone={d < (m.config.warn_days ?? 14) ? "yellow" : "green"}
              detail={`Expire le ${fmtDate(m.cert_expires_at!)}`} />
          ) : (
            <Stat label="Disponibilité 90 j" value={formatPct(uptime(m))} detail="jours mesurés" />
          )}
        </div>
        <section aria-labelledby="lat-title">
          <SectionTitle id="lat-title" actions={<Segmented size="sm" label="Période" value={range} onChange={setRange} options={[["1h", "1 h"], ["24h", "24 h"], ["7d", "7 j"], ["30d", "30 j"], ["90d", "90 j"]]} />}>Latence</SectionTitle>
          <Card className="p-5"><Chart t={res.data?.t ?? []} series={series} format={fmtLatency} height={260} /></Card>
        </section>
        {(m.type === "snmp" || m.type === "meross") && (
          <section aria-labelledby="val-title">
            <SectionTitle id="val-title">{m.type === "meross" ? "Consommation instantanée" : "Valeur relevée"}</SectionTitle>
            <Card className="p-5"><Chart t={res.data?.t ?? []} series={valueSeries} format={fmtValue(unitOf(m))} height={260} /></Card>
          </section>
        )}
        <section aria-labelledby="up-title">
          <SectionTitle id="up-title" actions={<span className="font-mono text-sm font-semibold text-h1">{formatPct(uptime(m))}</span>}>Disponibilité sur 90 jours</SectionTitle>
          <Card className="p-5">
            <UptimeBars days={m.days ?? []} />
            <div className="mt-2 flex justify-between font-mono text-xs text-meta"><span>il y a 90 j</span><span>aujourd'hui</span></div>
          </Card>
        </section>
      </div>
      {editing && <MonitorDialog monitor={m} onClose={(changed, saved) => { setEditing(false); if (changed && saved) mon.setData(saved); }} />}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} size="sm" title="Confirmer la suppression"
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(false)}>Annuler</Button>
          <Button variant="danger" onClick={() => api.del(`/api/monitors/${id}`).then(() => { toast("Sonde supprimée"); navigate("/monitors"); })}>Supprimer</Button></>}>
        <p className="text-sm leading-relaxed text-body">Supprimer la sonde « {m.name} » et tout son historique ? Cette action est irréversible.</p>
      </Dialog>
    </>
  );
}
