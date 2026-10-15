import { useEffect, useMemo, useState } from "react";
import { Activity, ExternalLink } from "lucide-react";
import { api, fmtDate, type Day, type Host, type Monitor, type Status } from "../api";
import { BlockEditor, type BlockType } from "../blocks";
import {
  Alert, Badge, Button, ButtonAnchor, Card, CardBody, CardHeader, Chart, FIELD_ROW, Field, Logo, PageHeader, SectionTitle, Skeleton, Stat, StatusBadge,
  StatusIcon, Switch, UptimeBars, fmtLatency, formatPct, inputClass, kindTone, statusKind, textareaClass, usePoll, useToast,
} from "../ui";

type ItemRef = { kind: "host" | "monitor"; id: number };
export interface StatusBlock {
  id: string; type: "header" | "overall" | "components" | "uptime" | "latency" | "text";
  title?: string; text?: string; items?: ItemRef[]; show_uptime?: boolean; days?: number; monitor_id?: number; range?: string;
  data?: unknown;
}
interface PublicItem { name: string; kind: "host" | "monitor"; status: Status; days?: Day[] }
export interface StatusPageData { title: string; status: Status; updated_at: number; blocks: StatusBlock[] }

const headline: Record<Status, string> = {
  operational: "Tous les services sont opérationnels",
  degraded: "Certains services sont ralentis",
  maintenance: "Maintenance en cours",
  minor_outage: "Panne partielle en cours",
  major_outage: "Panne majeure en cours",
  unknown: "État en cours de vérification",
};

function LatencyBlock({ b }: { b: StatusBlock }) {
  const d = b.data as { t: number[]; latency: (number | null)[]; name: string } | undefined;
  const series = useMemo(() => [{ label: d?.name ?? "Latence", values: d?.latency ?? [] }], [d]);
  if (!d) return null;
  return (
    <Card>
      <CardHeader overline="Latence" title={b.title || d.name} />
      <CardBody><Chart t={d.t} series={series} format={fmtLatency} height={200} /></CardBody>
    </Card>
  );
}

const avgUptime = (days?: Day[]) => {
  const known = (days ?? []).filter((d) => d.uptime != null);
  return known.length ? (known.reduce((a, d) => a + d.uptime!, 0) / known.length) * 100 : null;
};

/** Renders a resolved status page; shared by the public page and the editor preview. */
export function StatusView({ page }: { page: StatusPageData }) {
  return (
    <div className="grid gap-8">
      {page.blocks.map((b) => {
        switch (b.type) {
          case "header":
            return (
              <header key={b.id}>
                <h1 className="text-4xl font-bold tracking-tight text-h1 sm:text-5xl">{b.title || page.title}</h1>
                {b.text && <p className="mt-3 whitespace-pre-line text-pretty text-body">{b.text}</p>}
              </header>
            );
          case "overall": {
            const kind = statusKind(page.status);
            const tone = kindTone(kind);
            return (
              <div key={b.id} className="flex items-start gap-4 rounded-xl border px-5 py-5 sm:px-6"
                style={{ background: `color-mix(in srgb, ${tone} 8%, var(--mm-surface))`, borderColor: `color-mix(in srgb, ${tone} 35%, var(--mm-border))` }}>
                <StatusIcon kind={kind} size={30} className="mt-0.5" />
                <div className="min-w-0">
                  <p className="text-lg font-semibold text-h1 sm:text-xl">{headline[page.status]}</p>
                  <p className="text-sm text-body">Mis à jour le {fmtDate(page.updated_at)}</p>
                </div>
              </div>
            );
          }
          case "components": {
            const items = (b.data as PublicItem[] | undefined) ?? [];
            return (
              <section key={b.id} aria-label={b.title || "Services"}>
                {b.title && <SectionTitle>{b.title}</SectionTitle>}
                <ul className="divide-y divide-line-subtle overflow-hidden rounded-xl border border-line-subtle bg-box">
                  {items.length === 0 && <li className="px-5 py-8 text-center text-sm text-meta">Aucun service dans ce bloc.</li>}
                  {items.map((it, i) => (
                    <li key={i} className="grid gap-3 px-4 py-3.5 sm:px-5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <StatusIcon status={it.status} size={18} />
                        <p className="min-w-0 flex-1 truncate font-medium text-h1">{it.name}</p>
                        {it.days && <span className="shrink-0 font-mono text-sm font-semibold text-h1">{formatPct(avgUptime(it.days))}</span>}
                        <StatusBadge status={it.status} />
                      </div>
                      {it.days && <UptimeBars days={it.days} height={24} />}
                    </li>
                  ))}
                </ul>
              </section>
            );
          }
          case "uptime": {
            const d = b.data as { uptime: number | null; count: number } | undefined;
            return (
              <Stat key={b.id} label={b.title || `Disponibilité sur ${b.days ?? 90} jours`} value={formatPct(d?.uptime == null ? null : d.uptime * 100)}
                detail={`${d?.count ?? 0} service(s)`} icon={<Activity size={16} />} />
            );
          }
          case "latency":
            return <LatencyBlock key={b.id} b={b} />;
          case "text":
            return (
              <Card key={b.id}>
                {b.title && <CardHeader title={b.title} />}
                <CardBody><p className="max-w-[72ch] whitespace-pre-line leading-relaxed text-body">{b.text}</p></CardBody>
              </Card>
            );
        }
      })}
    </div>
  );
}

export function PublicStatusPage() {
  const { data, error } = usePoll(() => api.get<StatusPageData>("/api/public/status"), 60000);
  useEffect(() => { if (data) document.title = data.title; }, [data]);
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-12 sm:py-16">
      {error && <Alert kind="info" title="Page de statut indisponible">{error}</Alert>}
      {!data && !error && <Skeleton className="h-72" />}
      {data && <StatusView page={data} />}
      <footer className="mt-12 flex items-center justify-center gap-2 font-mono text-xs text-meta">
        <span className="[&_svg]:h-4"><Logo compact /></span>Homelab Monitoring
      </footer>
    </div>
  );
}

/* ---------- Editor ---------- */

const TYPES: Record<StatusBlock["type"], BlockType<StatusBlock>> = {
  header: { label: "En-tête", description: "Titre et description", create: () => ({ type: "header", title: "Homelab", text: "" }) },
  overall: { label: "État global", description: "Bandeau de l'état général", create: () => ({ type: "overall" }) },
  components: { label: "Services", description: "Liste de services avec historique", create: () => ({ type: "components", title: "Services", items: [], show_uptime: true, days: 90 }) },
  uptime: { label: "Disponibilité", description: "Pourcentage moyen sur la période", create: () => ({ type: "uptime", title: "", items: [], days: 30 }) },
  latency: { label: "Graphique de latence", description: "Latence d'une sonde", create: () => ({ type: "latency", title: "", range: "24h" }) },
  text: { label: "Texte", description: "Annonce, informations, contact", create: () => ({ type: "text", title: "", text: "" }) },
};

function ItemPicker({ value, onChange, hosts, monitors }: { value: ItemRef[]; onChange: (v: ItemRef[]) => void; hosts: Host[]; monitors: Monitor[] }) {
  const has = (r: ItemRef) => value.some((v) => v.kind === r.kind && v.id === r.id);
  const toggle = (r: ItemRef) => onChange(has(r) ? value.filter((v) => !(v.kind === r.kind && v.id === r.id)) : [...value, r]);
  return (
    <div className="grid max-h-56 gap-2.5 overflow-y-auto rounded-[18px] border border-line-strong bg-field px-4 py-3" role="group" aria-label="Éléments affichés">
      {monitors.length > 0 && <span className="mm-label-caps">Sondes</span>}
      {monitors.map((m) => (
        <label key={`m${m.id}`} className="flex cursor-pointer items-start gap-3 text-sm text-h2"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--mm-accent)]" checked={has({ kind: "monitor", id: m.id })} onChange={() => toggle({ kind: "monitor", id: m.id })} />{m.name}</label>
      ))}
      {hosts.length > 0 && <span className="mm-label-caps mt-1.5">Hôtes (état seulement)</span>}
      {hosts.map((h) => (
        <label key={`h${h.id}`} className="flex cursor-pointer items-start gap-3 text-sm text-h2"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--mm-accent)]" checked={has({ kind: "host", id: h.id })} onChange={() => toggle({ kind: "host", id: h.id })} />{h.name}</label>
      ))}
    </div>
  );
}

export function StatusEditorPage() {
  const [blocks, setBlocks] = useState<StatusBlock[]>();
  const [enabled, setEnabled] = useState(false);
  const [preview, setPreview] = useState<StatusPageData>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const hosts = usePoll(() => api.get<Host[]>("/api/hosts"), 60000);
  const monitors = usePoll(() => api.get<Monitor[]>("/api/monitors"), 60000);
  const toast = useToast();

  useEffect(() => {
    api.get<{ blocks: StatusBlock[]; enabled: boolean }>("/api/status/layout").then((r) => { setBlocks(r.blocks); setEnabled(r.enabled); }, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!blocks) return;
    const t = setTimeout(() => api.post<StatusPageData>("/api/status/preview", { blocks }).then((p) => { setPreview(p); setError(undefined); }, (e) => setError(e.message)), 300);
    return () => clearTimeout(t);
  }, [blocks]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put("/api/status/layout", { blocks, enabled });
      toast("Page de statut enregistrée");
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  if (!blocks) return error ? <Alert kind="error" title={error} /> : <Skeleton className="h-72" />;
  const h = hosts.data ?? [], m = monitors.data ?? [];

  return (
    <>
      <PageHeader title="Page de statut" description="Compose la page publique : seuls les éléments ajoutés ici sont visibles sans connexion."
        actions={<>
          <Switch label="Publiée" checked={enabled} onChange={setEnabled} />
          <ButtonAnchor variant="secondary" href="/status" target="_blank" rel="noopener" icon={<ExternalLink size={16} />}>Ouvrir</ButtonAnchor>
          <Button loading={busy} onClick={save}>Enregistrer la page</Button>
        </>} />
      {error && <Alert kind="error" title="Disposition invalide" className="mb-6">{error}</Alert>}
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)] xl:gap-10">
        <section aria-labelledby="blocks-title">
          <SectionTitle id="blocks-title">Blocs</SectionTitle>
          <BlockEditor blocks={blocks} onChange={setBlocks} types={TYPES}
            title={(b) => b.title || (b.type === "latency" ? m.find((x) => x.id === b.monitor_id)?.name ?? "Choisir une sonde" : b.type === "overall" ? "État général" : b.text?.slice(0, 40) || "Sans titre")}
            renderFields={(b, up) => (
              <>
                {b.type === "overall" && <p className="text-sm text-meta">Affiche l'état le plus grave parmi les éléments de la page.</p>}
                {b.type !== "overall" && (
                  <Field label={b.type === "header" ? "Titre" : "Titre (facultatif)"}><input className={inputClass} value={b.title ?? ""} onChange={(e) => up({ title: e.target.value })} /></Field>
                )}
                {(b.type === "header" || b.type === "text") && (
                  <Field label={b.type === "header" ? "Description (facultatif)" : "Texte"}>
                    <textarea className={textareaClass} value={b.text ?? ""} onChange={(e) => up({ text: e.target.value })} />
                  </Field>
                )}
                {(b.type === "components" || b.type === "uptime") && (
                  <>
                    <Field label="Éléments"><ItemPicker value={b.items ?? []} onChange={(items) => up({ items })} hosts={h} monitors={m} /></Field>
                    <Field label="Historique">
                      <select className={inputClass} value={b.days ?? 90} onChange={(e) => up({ days: Number(e.target.value) })}>
                        <option value={30}>30 jours</option><option value={60}>60 jours</option><option value={90}>90 jours</option>
                      </select>
                    </Field>
                    {b.type === "components" && <Switch label="Afficher les barres de disponibilité" checked={!!b.show_uptime} onChange={(v) => up({ show_uptime: v })} />}
                  </>
                )}
                {b.type === "latency" && (
                  <div className={FIELD_ROW}>
                    <Field label="Sonde">
                      <select className={inputClass} value={b.monitor_id ?? ""} onChange={(e) => up({ monitor_id: Number(e.target.value) })}>
                        <option value="" disabled>Choisir…</option>
                        {m.filter((x) => x.type !== "ssl").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Période">
                      <select className={inputClass} value={b.range ?? "24h"} onChange={(e) => up({ range: e.target.value })}>
                        <option value="24h">24 heures</option><option value="7d">7 jours</option><option value="30d">30 jours</option>
                      </select>
                    </Field>
                  </div>
                )}
              </>
            )} />
        </section>
        <section aria-labelledby="preview-title" className="min-w-0 xl:sticky xl:top-6">
          <SectionTitle id="preview-title" actions={!enabled && <Badge tone="yellow" dot>Non publiée</Badge>}>Aperçu</SectionTitle>
          <div className="rounded-2xl border border-dashed border-line bg-page p-5 sm:p-8">
            {preview ? <StatusView page={preview} /> : <Skeleton className="h-64" />}
          </div>
        </section>
      </div>
    </>
  );
}
