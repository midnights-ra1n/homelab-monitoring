import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import uPlot from "uplot";
import { AlertTriangle, CheckCircle2, CircleAlert, Copy, Info, Wrench, X } from "lucide-react";
import { statusLabel, type Day, type Status } from "./api";

/* ---------- Routing (history API; the server serves the app shell on every path) ---------- */

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={to} {...rest} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    }}>{children}</a>
  );
}

/* ---------- Data loading ---------- */

/** Loads data on mount and every `intervalMs` while the tab is visible. */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(() => {
    loadRef.current().then((d) => { setData(d); setError(undefined); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, refresh, setData };
}

/* ---------- Theme ---------- */

export type ThemeMode = "system" | "light" | "dark";
export type Palette = "classic" | "mint";

function readPref<T extends string>(k: string, def: T): T {
  try { return (localStorage.getItem(k) as T) || def; } catch { return def; }
}

export function applyTheme(mode: ThemeMode, palette: Palette) {
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.palette = palette;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-app").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  window.dispatchEvent(new Event("hlm:theme"));
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readPref("hlm-theme", "system"));
  const [palette, setPalette] = useState<Palette>(() => readPref("hlm-palette", "classic"));
  useEffect(() => {
    try { localStorage.setItem("hlm-theme", mode); localStorage.setItem("hlm-palette", palette); } catch { /* private mode */ }
    applyTheme(mode, palette);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme(mode, palette);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mode, palette]);
  return { mode, setMode, palette, setPalette };
}

/* ---------- Toasts ---------- */

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className="toast">{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Primitives ---------- */

export function Button({ variant, size, loading, icon, children, ...rest }: {
  variant?: "primary" | "ghost" | "danger"; size?: "sm" | "lg"; loading?: boolean; icon?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ["btn", variant, size, !children && "icon", rest.className].filter(Boolean).join(" ");
  return (
    <button type="button" {...rest} className={cls} disabled={rest.disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, icon, ...rest }: { label: string; icon: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button variant="ghost" aria-label={label} title={label} icon={icon} {...rest} />;
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge s-${status}`}><span className="dot" aria-hidden />{statusLabel[status]}</span>;
}

export function StatusIcon({ status }: { status: Status }) {
  const props = { "aria-hidden": true, style: { color: `var(--${statusTone(status)}-solid)` } } as const;
  if (status === "operational") return <CheckCircle2 {...props} />;
  if (status === "maintenance") return <Wrench {...props} />;
  if (status === "degraded") return <AlertTriangle {...props} />;
  if (status === "unknown") return <Info {...props} style={{ color: "var(--text-tertiary)" }} />;
  return <CircleAlert {...props} />;
}

export function statusTone(s: Status) {
  return ({ operational: "success", degraded: "warning", maintenance: "info", minor_outage: "danger", major_outage: "danger", unknown: "info" } as const)[s];
}

export function Card({ title, sub, actions, children, flush }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      {title && (
        <div className="card-header">
          <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
          {actions}
        </div>
      )}
      {flush ? <div className="flush">{children}</div> : <div className="card-body" style={title ? { paddingTop: 0 } : undefined}>{children}</div>}
    </section>
  );
}

export function Kpi({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="card kpi">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {detail && <span className="small muted">{detail}</span>}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="error" role="alert"><CircleAlert size={14} aria-hidden />{error}</span> : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="check">
      <button type="button" role="switch" className="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} aria-label={label} />
      <span aria-hidden>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={v === value} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

/** `higherIsBetter` flips the colour scale (health scores) compared to usage gauges. */
export function Progress({ label, value, text, higherIsBetter }: { label: string; value: number | null; text?: string; higherIsBetter?: boolean }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const bad = higherIsBetter ? 100 - v : v;
  return (
    <div className="progress">
      <div className="top"><span className="muted">{label}</span><span className="num">{text ?? (value == null ? "—" : `${v.toFixed(0)} %`)}</span></div>
      <div className="track" role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`bar ${bad >= 90 ? "crit" : bad >= 75 ? "warn" : ""}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

export function Alert({ tone, title, children }: { tone: "danger" | "success" | "info" | "warning"; title: string; children?: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "info" ? Info : tone === "warning" ? AlertTriangle : CircleAlert;
  return (
    <div className={`alert ${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <Icon aria-hidden />
      <div><strong>{title}</strong>{children}</div>
    </div>
  );
}

export function Dialog({ open, onClose, title, description, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`dialog${wide ? " wide" : ""}`} aria-labelledby="dlg-title" onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <>
          <div className="dialog-head">
            <div><h2 id="dlg-title">{title}</h2>{description && <p>{description}</p>}</div>
            <IconButton label="Fermer" icon={<X />} onClick={onClose} />
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function CodeBlock({ text }: { text: string }) {
  const toast = useToast();
  return (
    <div className="codeblock">
      {text}
      <IconButton label="Copier" icon={<Copy />} className="sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copié dans le presse-papiers"))} />
    </div>
  );
}

export function UptimeBars({ days }: { days: Day[] }) {
  const measured = days.filter((d) => d.uptime != null);
  const avg = measured.length ? measured.reduce((a, d) => a + (d.uptime ?? 0), 0) / measured.length : null;
  return (
    <div>
      <div className="uptime" role="img" aria-label={`Disponibilité sur ${days.length} jours : ${avg == null ? "aucune donnée" : (avg * 100).toFixed(2) + " %"}`}>
        {days.map((d) => (
          <span key={d.day} className={`d-${d.worst}`}
            title={`${new Date(d.day * 1000).toLocaleDateString("fr-FR")} · ${d.uptime == null ? "aucune donnée" : (d.uptime * 100).toFixed(2) + " %"} · ${statusLabel[d.worst]}`} />
        ))}
      </div>
      <div className="uptime-legend"><span>Il y a {days.length} jours</span><span className="num">{avg == null ? "—" : `${(avg * 100).toFixed(2).replace(".", ",")} %`}</span><span>Aujourd'hui</span></div>
    </div>
  );
}

/* ---------- Charts (uPlot: ~50 kB, canvas, handles thousands of points cheaply) ---------- */

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export interface ChartSeries { label: string; values: (number | null)[] }

/** Hover tooltip listing every series at the cursor's x; replaces uPlot's crosshair. */
function tooltipPlugin(format: (v: number) => string): uPlot.Plugin {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "chart-tip";
        tip.setAttribute("aria-hidden", "true"); // values are also reachable via the tables/KPIs
        u.over.appendChild(tip);
        u.over.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      },
      setCursor: (u) => {
        const i = u.cursor.idx;
        if (i == null || u.cursor.left == null || u.cursor.left < 0) { tip.style.display = "none"; return; }
        tip.replaceChildren();
        const head = document.createElement("div");
        head.className = "chart-tip-time";
        head.textContent = new Date((u.data[0][i] as number) * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
        tip.appendChild(head);
        u.series.slice(1).forEach((sr, k) => {
          const v = u.data[k + 1][i];
          const row = document.createElement("div");
          row.className = "chart-tip-row";
          const sw = document.createElement("span");
          sw.className = "chart-tip-swatch";
          sw.style.background = String(sr.stroke);
          const label = document.createElement("span");
          label.textContent = String(sr.label ?? "");
          const val = document.createElement("strong");
          val.textContent = v == null ? "—" : format(v as number);
          row.append(sw, label, val);
          tip.appendChild(row);
        });
        tip.style.display = "block";
        const x = u.cursor.left, w = tip.offsetWidth, ow = u.over.clientWidth;
        tip.style.left = `${x + 12 + w > ow ? x - w - 12 : x + 12}px`;
        tip.style.top = `${Math.max(0, (u.cursor.top ?? 0) - tip.offsetHeight / 2)}px`;
      },
    },
  };
}

export function Chart({ t, series, format, height = 220, max }: {
  t: number[]; series: ChartSeries[]; format: (v: number) => string; height?: number; max?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  // Callers pass inline formatters; a ref keeps the plot from being rebuilt on every render.
  const fmtRef = useRef(format);
  fmtRef.current = format;
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const on = () => setThemeTick((x) => x + 1);
    window.addEventListener("hlm:theme", on);
    return () => window.removeEventListener("hlm:theme", on);
  }, []);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const format = (v: number) => fmtRef.current(v);
    const grid = cssVar("--chart-grid"), text = cssVar("--text-tertiary");
    const axis = { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: `12px ${cssVar("--font-sans")}` };
    const fmtTime = (span: number) => (_u: uPlot, vals: number[]) => vals.map((v) => new Date(v * 1000).toLocaleString("fr-FR",
      span > 2 * 86400 ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit" }));
    const span = t.length > 1 ? t[t.length - 1] - t[0] : 0;
    const opts: uPlot.Options = {
      width: node.clientWidth, height,
      cursor: { x: false, y: false, points: { size: 7 } },
      legend: { show: series.length > 1, live: false },
      plugins: [tooltipPlugin(format)],
      // Widen a near-empty time range so the axis stays readable with one or two samples.
      scales: { x: { time: true, range: span < 600 && t.length ? [t[0] - 300, t[t.length - 1] + 300] : undefined }, y: { range: (_u, _min, mx) => [0, max ?? Math.max(mx * 1.1, 1)] } },
      axes: [
        { ...axis, grid: { show: false }, values: fmtTime(span) },
        { ...axis, size: 64, values: (_u, vals) => vals.map((v) => format(v)) },
      ],
      series: [
        { value: (_u, v) => (v == null ? "—" : new Date(v * 1000).toLocaleString("fr-FR")) },
        ...series.map((s, i) => ({
          label: s.label, stroke: cssVar(`--chart-${(i % 6) + 1}`), width: 2, spanGaps: false,
          points: { show: t.length < 3 }, value: (_u: uPlot, v: number | null) => (v == null ? "—" : format(v)),
        })),
      ],
    };
    const plot = new uPlot(opts, [t, ...series.map((s) => s.values)] as uPlot.AlignedData, node);
    const ro = new ResizeObserver(() => plot.setSize({ width: node.clientWidth, height }));
    ro.observe(node);
    return () => { ro.disconnect(); plot.destroy(); };
  }, [t, series, height, max, themeTick]);
  if (!t.length) return <div className="empty small">Aucune donnée sur cette période</div>;
  return <div ref={el} className="chart" />;
}
