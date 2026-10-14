import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api, fmtDate, type Day, type Host, type Monitor, type Status } from "../api";
import { BlockEditor, type BlockType } from "../blocks";
import { Alert, Button, Card, Chart, Field, StatusBadge, StatusIcon, Switch, UptimeBars, statusTone, usePoll, useTheme, useToast } from "../ui";

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
  return <Card title={b.title || `Latence · ${d.name}`}><Chart t={d.t} series={series} format={(v) => `${Math.round(v)} ms`} height={200} /></Card>;
}

/** Renders a resolved status page; shared by the public page and the editor preview. */
export function StatusView({ page }: { page: StatusPageData }) {
  return (
    <>
      {page.blocks.map((b) => {
        switch (b.type) {
          case "header":
            return (
              <div key={b.id}>
                <h1>{b.title || page.title}</h1>
                {b.text && <p className="muted" style={{ marginTop: 4, whiteSpace: "pre-line" }}>{b.text}</p>}
              </div>
            );
          case "overall":
            return (
              <div key={b.id} className={`alert ${statusTone(page.status)}`} style={{ padding: 16 }}>
                <StatusIcon status={page.status} />
                <div><strong style={{ fontSize: "var(--text-lg)" }}>{headline[page.status]}</strong><span className="small">Mis à jour le {fmtDate(page.updated_at)}</span></div>
              </div>
            );
          case "components": {
            const items = (b.data as PublicItem[] | undefined) ?? [];
            return (
              <Card key={b.id} title={b.title || undefined} flush>
                <div className="list">
                  {items.length === 0 && <div className="empty small">Aucun service dans ce bloc.</div>}
                  {items.map((it, i) => (
                    <div key={i} className="list-item" style={{ flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 160px" }}><strong style={{ fontWeight: 500 }}>{it.name}</strong></div>
                      <StatusBadge status={it.status} />
                      {it.days && <div style={{ flex: "1 1 100%" }}><UptimeBars days={it.days} /></div>}
                    </div>
                  ))}
                </div>
              </Card>
            );
          }
          case "uptime": {
            const d = b.data as { uptime: number | null; count: number } | undefined;
            return (
              <div key={b.id} className="card kpi">
                <span className="label">{b.title || `Disponibilité sur ${b.days ?? 90} jours`}</span>
                <span className="value">{d?.uptime == null ? "—" : `${(d.uptime * 100).toFixed(2).replace(".", ",")} %`}</span>
                <span className="small muted">{d?.count ?? 0} service(s)</span>
              </div>
            );
          }
          case "latency":
            return <LatencyBlock key={b.id} b={b} />;
          case "text":
            return (
              <Card key={b.id} title={b.title || undefined}>
                <p style={{ whiteSpace: "pre-line", lineHeight: 1.55, maxWidth: "72ch" }}>{b.text}</p>
              </Card>
            );
        }
      })}
    </>
  );
}

export function PublicStatusPage() {
  useTheme();
  const { data, error } = usePoll(() => api.get<StatusPageData>("/api/public/status"), 60000);
  useEffect(() => { if (data) document.title = data.title; }, [data]);
  if (error) return <div className="auth"><Alert tone="info" title="Page de statut indisponible">{error}</Alert></div>;
  if (!data) return null;
  return (
    <div className="content" style={{ height: "100%" }}>
      <div className="page" style={{ maxWidth: 840, paddingTop: 48 }}>
        <StatusView page={data} />
      </div>
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
    <div className="picker" role="group" aria-label="Éléments affichés">
      {monitors.length > 0 && <span className="xs tertiary">Sondes</span>}
      {monitors.map((m) => (
        <label key={`m${m.id}`} className="check"><input type="checkbox" checked={has({ kind: "monitor", id: m.id })} onChange={() => toggle({ kind: "monitor", id: m.id })} />{m.name}</label>
      ))}
      {hosts.length > 0 && <span className="xs tertiary" style={{ marginTop: 6 }}>Hôtes (état seulement)</span>}
      {hosts.map((h) => (
        <label key={`h${h.id}`} className="check"><input type="checkbox" checked={has({ kind: "host", id: h.id })} onChange={() => toggle({ kind: "host", id: h.id })} />{h.name}</label>
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
  if (!blocks) return <div className="page">{error && <Alert tone="danger" title={error} />}</div>;
  const h = hosts.data ?? [], m = monitors.data ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Page de statut</h1><p className="muted">Composez la page publique : seuls les éléments ajoutés ici sont visibles sans connexion.</p></div>
        <div className="actions" style={{ alignItems: "center" }}>
          <Switch label="Publiée" checked={enabled} onChange={setEnabled} />
          <a className="btn" href="/status" target="_blank" rel="noopener"><ExternalLink size={16} aria-hidden />Ouvrir</a>
          <Button variant="primary" loading={busy} onClick={save}>Enregistrer la page</Button>
        </div>
      </div>
      {error && <Alert tone="danger" title="Disposition invalide">{error}</Alert>}
      <div className="editor-layout">
        <BlockEditor blocks={blocks} onChange={setBlocks} types={TYPES}
          title={(b) => b.title || (b.type === "latency" ? m.find((x) => x.id === b.monitor_id)?.name ?? "Choisir une sonde" : b.type === "overall" ? "État général" : b.text?.slice(0, 40) || "Sans titre")}
          renderFields={(b, up) => (
            <>
              {b.type === "overall" && <p className="small muted">Affiche l'état le plus grave parmi les éléments de la page.</p>}
              {b.type !== "overall" && (
                <Field label={b.type === "header" ? "Titre" : "Titre (facultatif)"}><input className="input" value={b.title ?? ""} onChange={(e) => up({ title: e.target.value })} /></Field>
              )}
              {(b.type === "header" || b.type === "text") && (
                <Field label={b.type === "header" ? "Description (facultatif)" : "Texte"}>
                  <textarea className="textarea" style={{ minHeight: 100, fontFamily: "var(--font-sans)" }} value={b.text ?? ""} onChange={(e) => up({ text: e.target.value })} />
                </Field>
              )}
              {(b.type === "components" || b.type === "uptime") && (
                <>
                  <Field label="Éléments"><ItemPicker value={b.items ?? []} onChange={(items) => up({ items })} hosts={h} monitors={m} /></Field>
                  <Field label="Historique">
                    <select className="select" value={b.days ?? 90} onChange={(e) => up({ days: Number(e.target.value) })}>
                      <option value={30}>30 jours</option><option value={60}>60 jours</option><option value={90}>90 jours</option>
                    </select>
                  </Field>
                  {b.type === "components" && <Switch label="Afficher les barres de disponibilité" checked={!!b.show_uptime} onChange={(v) => up({ show_uptime: v })} />}
                </>
              )}
              {b.type === "latency" && (
                <div className="row">
                  <Field label="Sonde">
                    <select className="select" value={b.monitor_id ?? ""} onChange={(e) => up({ monitor_id: Number(e.target.value) })}>
                      <option value="" disabled>Choisir…</option>
                      {m.filter((x) => x.type !== "ssl").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Période">
                    <select className="select" value={b.range ?? "24h"} onChange={(e) => up({ range: e.target.value })}>
                      <option value="24h">24 heures</option><option value="7d">7 jours</option><option value="30d">30 jours</option>
                    </select>
                  </Field>
                </div>
              )}
            </>
          )} />
        <div className="preview">
          <div className="small muted" style={{ marginBottom: 8 }}>Aperçu {enabled ? "" : "(page non publiée)"}</div>
          <div className="status-surface">{preview ? <StatusView page={preview} /> : <span className="small muted">Chargement…</span>}</div>
        </div>
      </div>
    </div>
  );
}
