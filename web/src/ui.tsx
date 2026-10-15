/* UI kit ported from homelab-management (src/components/ui, src/components/layout, src/lib/theme.ts) so both
   apps look the same. Next.js pieces (next/link, server actions, i18n) are replaced by their React equivalents. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import uPlot from "uplot";
import { CircleAlert, CircleCheck, CirclePause, Clock, Copy, TriangleAlert, Wrench, X } from "lucide-react";
import { statusLabel, type Day, type Status } from "./api";

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

/* ---------- Routing (history API; the server serves the app shell on every path) ---------- */

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
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

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={to} {...rest} onClick={(e) => {
      rest.onClick?.(e);
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
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

/* ---------- Theme and sidebar (lib/theme.ts): "auto" = no data-theme attribute ---------- */

export type ThemeChoice = "auto" | "dark" | "light";
const THEME_KEY = "hlm-theme";
const SIDEBAR_KEY = "hlm-sidebar";

function syncThemeColor() {
  const forced = document.documentElement.dataset.theme;
  const light = forced ? forced === "light" : matchMedia("(prefers-color-scheme: light)").matches;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => (m.content = light ? "#d8dde5" : "#0f131a"));
}

function getChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "dark" || t === "light" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function setTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  root.classList.add("theme-transition");
  window.setTimeout(() => root.classList.remove("theme-transition"), 200);
  try {
    if (choice === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch { /* private mode */ }
  if (choice === "auto") delete root.dataset.theme;
  else root.dataset.theme = choice;
  syncThemeColor();
  window.dispatchEvent(new Event("hlm:theme"));
}

export function toggleRail() {
  const root = document.documentElement;
  const rail = root.dataset.sidebar !== "rail";
  if (rail) root.dataset.sidebar = "rail";
  else delete root.dataset.sidebar;
  try { localStorage.setItem(SIDEBAR_KEY, rail ? "rail" : "full"); } catch { /* private mode */ }
  window.dispatchEvent(new Event("hlm:theme"));
}

function subscribeTheme(callback: () => void) {
  const media = matchMedia("(prefers-color-scheme: light)");
  window.addEventListener("hlm:theme", callback);
  media.addEventListener("change", callback);
  return () => {
    window.removeEventListener("hlm:theme", callback);
    media.removeEventListener("change", callback);
  };
}

export const useThemeChoice = () => useSyncExternalStore(subscribeTheme, getChoice);
export const useRail = () => useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.sidebar === "rail");

/** Theme Dark / Light / Auto as the system's segmented control. */
export function ThemeSwitch({ className }: { className?: string }) {
  const theme = useThemeChoice();
  const options: [ThemeChoice, string][] = [["dark", "Sombre"], ["light", "Clair"], ["auto", "Auto"]];
  return (
    <div role="radiogroup" aria-label="Thème" className={cn("mm-segmented", className)}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={theme === v} onClick={() => setTheme(v)} className="mm-segmented__item">{l}</button>
      ))}
    </div>
  );
}

/* ---------- Tones ---------- */

export type Tone = "accent" | "green" | "yellow" | "red" | "blue" | "purple" | "cyan" | "orange" | "pink" | "muted";

export const TONE_VAR: Record<Tone, string> = {
  accent: "var(--mm-accent)", green: "var(--mm-green)", yellow: "var(--mm-yellow)", red: "var(--mm-red)", blue: "var(--mm-blue)",
  purple: "var(--mm-purple)", cyan: "var(--mm-cyan)", orange: "var(--mm-orange)", pink: "var(--mm-pink)", muted: "var(--mm-muted)",
};
/** Text variant (≥ 4.5:1): vivid fill for dots, -text for words. */
export const TONE_TEXT_VAR = Object.fromEntries(
  Object.entries(TONE_VAR).map(([k, v]) => [k, k === "muted" ? v : v.replace(")", "-text)")]),
) as Record<Tone, string>;

export const STATUS_TONE: Record<Status, Tone> = {
  operational: "green", degraded: "yellow", maintenance: "blue", minor_outage: "orange", major_outage: "red", unknown: "muted",
};

/* ---------- Toasts ---------- */

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; message: string };
const ToastCtx = createContext<(message: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
const GLYPH = { success: ["✓", "--mm-success-solid"], error: ["✕", "--mm-danger-solid"], info: ["i", "--mm-info-solid"] } as const;

/** Bottom-right notifications, announced to screen readers (above the bottom bar on mobile). */
export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback((message: string, kind: ToastKind = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="mm-toast-region pointer-events-none">
        {toasts.map((t) => {
          const [glyph, color] = GLYPH[t.kind];
          return (
            <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className="mm-toast pointer-events-auto">
              <span className="mm-alert__glyph" style={{ background: `var(${color})` }} aria-hidden="true">{glyph}</span>
              <p className="mm-toast__body break-words">{t.message}</p>
              <button type="button" onClick={() => dismiss(t.id)} className="mm-btn mm-btn--ghost mm-btn--icon mm-btn--sm -my-1.5" aria-label="Fermer">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Buttons ---------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md" | "icon" | "icon-sm";
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "mm-btn--primary", secondary: "mm-btn--secondary", ghost: "mm-btn--ghost", danger: "mm-btn--danger", "danger-ghost": "mm-btn--danger-ghost",
};
const SIZES: Record<ButtonSize, string> = { sm: "mm-btn--sm", md: "", icon: "mm-btn--icon", "icon-sm": "mm-btn--icon mm-btn--sm" };

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cn("mm-btn touch-manipulation", VARIANTS[variant], SIZES[size], className);
}

type ButtonCommon = { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode; loading?: boolean };

export function Button({ variant, size, icon, loading, className, children, type = "button", ...props }: ButtonCommon & ComponentProps<"button">) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...props} disabled={props.disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/** Internal link styled as a button. */
export function ButtonLink({ variant, size, icon, className, children, to, ...props }: Omit<ButtonCommon, "loading"> & { to: string } & ComponentProps<"a">) {
  return (
    <Link to={to} className={buttonClass(variant, size, cn("no-underline", className))} {...props}>
      {icon}
      {children}
    </Link>
  );
}

/** External link styled as a button (new tab, downloads…). */
export function ButtonAnchor({ variant, size, icon, className, children, ...props }: Omit<ButtonCommon, "loading"> & ComponentProps<"a">) {
  return (
    <a className={buttonClass(variant, size, cn("no-underline", className))} {...props}>
      {icon}
      {children}
    </a>
  );
}

export function IconButton({ label, icon, size = "icon-sm", variant = "ghost", ...rest }: { label: string; icon: ReactNode } & ButtonCommon & ComponentProps<"button">) {
  return <Button variant={variant} size={size} aria-label={label} title={label} icon={icon} {...rest} />;
}

/* ---------- Cards ---------- */

/** System card (.mm-card): surface, 1 px border, radius 10, no shadow. With `title` it gets a head and a body
    (`flush` puts tables and lists straight under the head). */
export function Card({ className, title, overline, sub, actions, flush, children, ...props }: {
  title?: ReactNode; overline?: ReactNode; sub?: ReactNode; actions?: ReactNode; flush?: boolean;
} & Omit<ComponentProps<"div">, "title">) {
  if (title === undefined) return <div className={cn("mm-card", className)} {...props}>{children}</div>;
  return (
    <div className={cn("mm-card", flush && "overflow-hidden", className)} {...props}>
      <div className="mm-card__head flex-wrap">
        <div className="min-w-0">
          {overline && <p className="mm-label-caps">{overline}</p>}
          <h3 className="mm-card__title truncate">{title}</h3>
          {sub && <p className="mm-help">{sub}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {flush ? <div className="border-t border-line">{children}</div> : <div className="mm-card__body">{children}</div>}
    </div>
  );
}

export function CardHeader({ title, overline, actions, className }: { title: ReactNode; overline?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("mm-card__head flex-wrap", className)}>
      <div className="min-w-0">
        {overline && <p className="mm-label-caps">{overline}</p>}
        <h3 className="mm-card__title truncate">{title}</h3>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mm-card__body", className)} {...props} />;
}


/** KPI tile (.mm-stat): label, 28/600 tabular value, detail. */
export function Stat({ label, value, detail, icon, href, tone, className }: {
  label: string; value: ReactNode; detail?: ReactNode; icon?: ReactNode; href?: string; tone?: "accent" | "red" | "yellow" | "green"; className?: string;
}) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="mm-stat__label min-w-0 truncate">{label}</p>
        {icon && (
          <span className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            tone === "red" ? "bg-red/12 text-red" : tone === "yellow" ? "bg-yellow/12 text-yellow" : tone === "green" ? "bg-green/12 text-green" : "bg-accent-soft text-accent-text",
          )}>{icon}</span>
        )}
      </div>
      <p className="mm-stat__value">{value}</p>
      {detail && <p className="mm-stat__meta truncate">{detail}</p>}
    </>
  );
  const cls = cn("mm-card mm-stat transition-colors duration-[120ms]", href && "hover:border-line-strong", className);
  return href ? <Link to={href} className={cn(cls, "text-inherit no-underline")}>{content}</Link> : <div className={cls}>{content}</div>;
}

export const STAT_GRID = "grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 xl:gap-6";

/** Page header: h1 30/38 · 600 (26/34 under 640 px), straight at the top of the page. */
export function PageHeader({ title, description, actions, crumbs }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) {
  return (
    <header className="mm-page__head mb-6">
      <div className="min-w-0 flex-1">
        {crumbs && <nav aria-label="Fil d'Ariane" className="mb-1 flex items-center gap-1.5 text-sm text-meta">{crumbs}</nav>}
        <h1 className="mm-h1">{title}</h1>
        {description && <div className="mt-1 text-pretty text-meta">{description}</div>}
      </div>
      {actions && <div className="mm-btn-group shrink-0 items-center">{actions}</div>}
    </header>
  );
}

/** Sub-section title inside a page. */
export function SectionTitle({ children, actions, id }: { children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
      <h2 id={id} className="mm-h2">{children}</h2>
      {actions}
    </div>
  );
}

/** Vertical rhythm between page sections. */
export const SECTIONS = "grid grid-cols-1 gap-12 xl:gap-16";

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mm-card mm-empty justify-center", className)}>
      {icon && <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-body">{icon}</div>}
      <p className="mm-empty__title">{title}</p>
      {children && <p className="mm-empty__msg">{children}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-xl bg-elevated", className)} />;
}

/* ---------- Badges and states ---------- */

/** Status badge (.mm-badge, pill): colour is never alone, always with a word. */
export function Badge({ tone = "muted", children, className, icon, dot, title }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={cn("mm-badge", className)} title={title}
      style={tone === "muted" ? undefined : { color: TONE_TEXT_VAR[tone], background: `color-mix(in srgb, ${TONE_VAR[tone]} 16%, transparent)` }}>
      {dot && <span className="mm-badge__dot" style={{ background: TONE_VAR[tone] }} />}
      {icon}
      {children}
    </span>
  );
}

/** Free label (tags): mono, neutral pill. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-full bg-muted px-2 font-mono text-[0.7rem] text-body", className)}>{children}</span>;
}

/** Status dot, with an optional "ping" wave. */
export function StatusDot({ tone, ping, className }: { tone: Tone; ping?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex h-2.5 w-2.5 shrink-0", className)} aria-hidden="true">
      {ping && <span className="ping absolute inset-0 rounded-full" style={{ background: TONE_VAR[tone] }} />}
      <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: TONE_VAR[tone] }} />
    </span>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  return <Badge tone={STATUS_TONE[status]} dot>{statusLabel[status]}</Badge>;
}

export type StatusKind = "ok" | "warn" | "down" | "pending" | "paused" | "maintenance";
const KIND_META = {
  ok: { Icon: CircleCheck, tone: TONE_VAR.green },
  warn: { Icon: TriangleAlert, tone: TONE_VAR.yellow },
  down: { Icon: CircleAlert, tone: TONE_VAR.red },
  pending: { Icon: Clock, tone: TONE_VAR.blue },
  paused: { Icon: CirclePause, tone: TONE_VAR.muted },
  maintenance: { Icon: Wrench, tone: TONE_VAR.blue },
} as const;

export function statusKind(s: Status, opts: { enabled?: boolean } = {}): StatusKind {
  if (opts.enabled === false) return "paused";
  if (s === "operational") return "ok";
  if (s === "degraded") return "warn";
  if (s === "maintenance") return "maintenance";
  if (s === "unknown") return "pending";
  return "down";
}
export const kindTone = (kind: StatusKind) => KIND_META[kind].tone;

/** State icon (✓ operational, ⚠ degraded, ! down…) in its tone. */
export function StatusIcon({ kind, status, size = 16, className }: { kind?: StatusKind; status?: Status; size?: number; className?: string }) {
  const { Icon, tone } = KIND_META[kind ?? statusKind(status ?? "unknown")];
  return <Icon size={size} strokeWidth={2.25} className={cn("shrink-0", className)} style={{ color: tone }} aria-hidden />;
}

/* ---------- Alerts ---------- */

const ALERT_KINDS = {
  success: { cls: "mm-alert--success", glyph: "✓" },
  warning: { cls: "mm-alert--warning", glyph: "!" },
  error: { cls: "mm-alert--danger", glyph: "✕" },
  info: { cls: "", glyph: "i" },
};

/** Glyph in a disc (✓ ! ✕ i) + title + message, never colour alone. */
export function Alert({ kind = "info", title, children, className, action }: { kind?: keyof typeof ALERT_KINDS; title?: ReactNode; children?: ReactNode; className?: string; action?: ReactNode }) {
  const k = ALERT_KINDS[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={cn("mm-alert items-start", k.cls, className)}>
      <span className="mm-alert__glyph" aria-hidden="true">{k.glyph}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="mm-alert__title">{title}</p>}
        {children && <div className="mm-alert__msg">{children}</div>}
      </div>
      {action}
    </div>
  );
}

/* ---------- Dialog ---------- */

/** Native <dialog>: trapped focus, Escape closes; bottom sheet under 640 px. */
export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cn(
        "mx-0 mb-0 mt-auto w-full max-w-none rounded-t-[14px] border border-b-0 border-line bg-elevated p-0 text-h2 shadow-[var(--mm-shadow-lg)]",
        "sm:m-auto sm:w-[calc(100%-2rem)] sm:rounded-[14px] sm:border-b",
        { sm: "sm:max-w-[400px]", md: "sm:max-w-[560px]", lg: "sm:max-w-[800px]", xl: "sm:max-w-5xl" }[size],
      )}>
      {open && (
        <div className="max-h-[90dvh] overflow-y-auto overscroll-contain px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-3 sm:max-h-[85vh] sm:px-6 sm:pb-6 sm:pt-5">
          <div className="mm-sheet__grip mx-auto sm:hidden" aria-hidden />
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h2 className="mm-dialog__title">{title}</h2>
              {description && <p className="mm-help mt-0.5">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="mm-btn mm-btn--ghost mm-btn--icon mm-btn--sm -mr-2 -mt-1" aria-label="Fermer">
              <X size={18} />
            </button>
          </div>
          {children}
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/* ---------- Forms ---------- */

// Pill fields of 36 px (44 px on touch), textarea radius 18; 16 px on mobile (no iOS zoom).
const fieldBase = "field w-full px-4 text-base sm:text-sm";
export const inputClass = `${fieldBase} h-9 pointer-coarse:h-11 rounded-full`;
export const textareaClass = `${fieldBase} min-h-22 py-2.5 rounded-[18px] resize-y leading-relaxed`;

/** Labelled field: label, control, help (muted) or error (red + ✕). */
export function Field({ label, hint, error, children, htmlFor, className, required }: {
  label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; className?: string; required?: boolean;
}) {
  return (
    <div className={cn("mm-field", className)}>
      <label htmlFor={htmlFor} className="mm-field__label">
        {label}
        {required && <span className="mm-field__req" aria-hidden="true">*</span>}
      </label>
      {children}
      {error ? <p className="mm-field__error" role="alert"><span aria-hidden="true">✕</span> {error}</p> : hint ? <p className="mm-help">{hint}</p> : null}
    </div>
  );
}

/** Group of fields with a title, in a card (long forms). */
export function Fieldset({ legend, description, children, className }: { legend: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn("mm-card min-w-0 p-5", className)}>
      <legend className="sr-only">{legend}</legend>
      <div className="mb-5">
        <p className="mm-h3">{legend}</p>
        {description && <p className="mm-help mt-0.5">{description}</p>}
      </div>
      {children}
    </fieldset>
  );
}

/** Switch of the system. */
export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 text-sm text-h2", disabled && "cursor-not-allowed opacity-60")}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden="true"
        className="mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border border-line-strong bg-field px-0.5 transition-colors duration-[120ms] peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--mm-focus)] peer-checked:[&>span]:translate-x-4 peer-checked:[&>span]:bg-on-accent">
        <span className="h-3.5 w-3.5 rounded-full bg-body transition-transform duration-[180ms]" />
      </span>
      <span>
        {label}
        {hint && <span className="mt-0.5 block text-xs text-meta">{hint}</span>}
      </span>
    </label>
  );
}

export function Checkbox({ label, hint, className, ...props }: { label: ReactNode; hint?: ReactNode } & ComponentProps<"input">) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 text-sm text-h2", className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--mm-accent)]" {...props} />
      <span>
        {label}
        {hint && <span className="mt-0.5 block text-xs text-meta">{hint}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, size, className }: {
  value: T; options: [T, ReactNode][]; onChange: (v: T) => void; label: string; size?: "sm"; className?: string;
}) {
  return (
    <div className={cn("mm-segmented max-w-full overflow-x-auto", size === "sm" && "mm-segmented--sm", className)} role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" className="mm-segmented__item shrink-0 gap-1.5" aria-checked={v === value} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

/* ---------- Meters ---------- */

export function meterTone(value: number): Tone {
  if (value >= 90) return "red";
  if (value >= 75) return "yellow";
  return "accent";
}

/** Horizontal gauge; the tone follows the thresholds (75 % / 90 %) unless forced. */
export function Meter({ value, label, detail, tone, className, size = "md" }: {
  value: number | null | undefined; label?: string; detail?: string; tone?: Tone; className?: string; size?: "sm" | "md";
}) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const t = tone ?? meterTone(v);
  return (
    <div className={cn("min-w-0", className)}>
      {(label || detail) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
          <span className="truncate text-body">{label}</span>
          <span className="shrink-0 text-meta tabular-nums">{detail ?? (value == null ? "—" : `${Math.round(v)} %`)}</span>
        </div>
      )}
      <div className={cn("overflow-hidden rounded-full bg-muted", size === "md" ? "h-2" : "h-1.5")} role="meter"
        aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full transition-[width] duration-[260ms] ease-[var(--ease-expo)]" style={{ width: `${v}%`, background: TONE_VAR[t] }} />
      </div>
    </div>
  );
}

/* ---------- Code ---------- */

export function CodeBlock({ text }: { text: string }) {
  const toast = useToast();
  return (
    <div className="relative rounded-xl border border-line bg-field py-3 pl-4 pr-12 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-h2">
      {text}
      <IconButton label="Copier" icon={<Copy size={14} />} className="absolute right-1.5 top-1.5"
        onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copié dans le presse-papiers"))} />
    </div>
  );
}

/* ---------- Uptime bars (90 days, status-page style) ---------- */

export function uptimeTone(u: number | null): Tone | null {
  if (u === null) return null;
  if (u >= 99.9) return "green";
  if (u >= 99) return "yellow";
  return "red";
}

/** Percentage with a French decimal comma; 99.995–99.999 shows 99,99 rather than 100. */
export function formatPct(u: number | null | undefined, digits = 2) {
  if (u == null) return "—";
  const v = u >= 99.995 && u < 100 ? "99.99" : u.toFixed(u === 100 ? 0 : digits);
  return `${v.replace(".", ",")} %`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function UptimeBars({ days: allDays, height = 32, className }: { days: Day[]; height?: number; className?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  // Narrow screens keep the last days that fit (≥ 3 px per bar + 2 px gap).
  const fit = width > 0 ? Math.max(14, Math.floor((width + 2) / 5)) : allDays.length;
  const days = allDays.slice(-Math.min(fit, allDays.length));
  const pctOf = (d: Day) => (d.uptime == null ? null : d.uptime * 100);
  const known = days.filter((d) => d.uptime != null);
  const bad = known.filter((d) => pctOf(d)! < 99.9).length;
  const h = hover !== null ? days[hover] : null;
  return (
    <div ref={ref} className={cn("relative", className)}>
      <div className="flex items-end gap-[2px]" style={{ height }} role="img"
        aria-label={`Disponibilité sur ${days.length} jours : ${known.length} jour(s) mesuré(s), ${bad} jour(s) dégradé(s)`}
        onPointerLeave={() => setHover(null)}>
        {days.map((d, i) => {
          const tone = d.worst === "maintenance" ? "blue" : uptimeTone(pctOf(d));
          return (
            <span key={d.day} onPointerEnter={() => setHover(i)}
              className={cn("h-full min-w-[2px] flex-1 rounded-[2px] transition-opacity", hover !== null && hover !== i && "opacity-60")}
              style={{ background: tone ? TONE_VAR[tone] : "var(--mm-border)" }} />
          );
        })}
      </div>
      {h && (
        <div className="pointer-events-none absolute bottom-[calc(100%+8px)] z-10 min-w-40 -translate-x-1/2 rounded-xl border border-line bg-elevated px-3 py-2 shadow-[var(--mm-shadow-md)]"
          style={{ left: `clamp(5rem, ${((hover! + 0.5) / days.length) * 100}%, calc(100% - 5rem))` }}>
          <p className="text-xs text-meta">{new Date(h.day * 1000).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</p>
          {h.uptime == null ? <p className="text-sm text-body">Aucune mesure</p> : (
            <>
              <p className="text-base font-semibold text-h1">{formatPct(pctOf(h), 2)}</p>
              {h.worst !== "operational" && <p className="text-xs text-body">{statusLabel[h.worst]}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Charts (uPlot: ~50 kB, canvas, handles thousands of points cheaply) ---------- */

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** Latency axis/tooltip format: one decimal below 10 ms so small values stay distinct. */
export const fmtLatency = (v: number) => (v < 10 ? `${v.toFixed(1).replace(".", ",")} ms` : `${Math.round(v)} ms`);

export interface ChartSeries { label: string; values: (number | null)[] }

/** Hover tooltip listing every series at the cursor's x, drawn like the system's popovers. */
function tooltipPlugin(format: (v: number) => string): uPlot.Plugin {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "pointer-events-none absolute z-10 hidden min-w-40 rounded-xl border border-line bg-elevated px-3 py-2 text-xs shadow-[var(--mm-shadow-md)]";
        tip.setAttribute("aria-hidden", "true"); // values are also reachable via the tables/KPIs
        u.over.appendChild(tip);
        u.over.addEventListener("mouseleave", () => tip.classList.add("hidden"));
      },
      setCursor: (u) => {
        const i = u.cursor.idx;
        if (i == null || u.cursor.left == null || u.cursor.left < 0) { tip.classList.add("hidden"); return; }
        tip.replaceChildren();
        const head = document.createElement("p");
        head.className = "mb-1 text-meta tabular-nums";
        head.textContent = new Date((u.data[0][i] as number) * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
        tip.appendChild(head);
        u.series.slice(1).forEach((sr, k) => {
          const v = u.data[k + 1][i];
          const row = document.createElement("p");
          row.className = "flex items-center gap-2 text-body";
          const sw = document.createElement("span");
          sw.className = "size-2 shrink-0 rounded-full";
          sw.style.background = String(sr.stroke);
          const label = document.createElement("span");
          label.textContent = String(sr.label ?? "");
          const val = document.createElement("span");
          val.className = "ml-auto pl-3 font-mono font-semibold text-h1";
          val.textContent = v == null ? "—" : format(v as number);
          row.append(sw, label, val);
          tip.appendChild(row);
        });
        tip.classList.remove("hidden");
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
  useEffect(() => subscribeTheme(() => setThemeTick((x) => x + 1)), []);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const format = (v: number) => fmtRef.current(v);
    const grid = cssVar("--mm-chart-grid"), text = cssVar("--mm-chart-axis");
    const axis = { stroke: text, grid: { stroke: grid, width: 1, dash: [2, 4] }, ticks: { show: false }, font: `11px ${cssVar("--mm-font-sans")}` };
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
          label: s.label, stroke: cssVar(`--mm-chart-${(i % 8) + 1}`), width: 2, spanGaps: false,
          points: { show: t.length < 3 }, value: (_u: uPlot, v: number | null) => (v == null ? "—" : format(v)),
        })),
      ],
    };
    const plot = new uPlot(opts, [t, ...series.map((s) => s.values)] as uPlot.AlignedData, node);
    const ro = new ResizeObserver(() => plot.setSize({ width: node.clientWidth, height }));
    ro.observe(node);
    return () => { ro.disconnect(); plot.destroy(); };
  }, [t, series, height, max, themeTick]);
  if (!t.length) return <p className="py-10 text-center text-sm text-meta">Aucune donnée sur cette période</p>;
  return <div ref={el} className="w-full" style={{ minHeight: height }} />;
}

/* ---------- Brand ---------- */

/** Logo: two slashes (muted mint + accent) followed by the name. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="248 128 528 768" className="h-7 w-auto" aria-hidden="true">
        <path d="M504 128L312 896H248L440 128H504Z" style={{ fill: "var(--mm-mint-700)" }} />
        <path d="M776 128L584 896H360L552 128H776Z" style={{ fill: "var(--mm-accent)" }} />
      </svg>
      {!compact && (
        <span className="text-lg font-bold leading-none tracking-tight text-h1">
          homelab<span className="text-accent-text">.</span>
        </span>
      )}
    </span>
  );
}

/* ---------- Settings sections ---------- */

/** Settings block: section title, then a card with a short description and the controls. */
export function SettingsSection({ id, title, description, children, actions }: { id: string; title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-8">
      <SectionTitle id={`${id}-title`}>{title}</SectionTitle>
      <Card>
        <CardBody className="grid gap-5">
          {description && <p className="text-sm text-body">{description}</p>}
          {children}
          {actions && <div className={FORM_ACTIONS}>{actions}</div>}
        </CardBody>
      </Card>
    </section>
  );
}

/** Cancel / Save bar of a form: at the very bottom, after the last field. */
export const FORM_ACTIONS = "mt-2 flex flex-wrap justify-end gap-3";
/** Fields side by side from 640 px. */
export const FIELD_ROW = "grid gap-5 sm:grid-cols-2";

/** Browser tab title: "Page name · Homelab Monitoring". */
export function useTitle(name: string | undefined) {
  useEffect(() => {
    if (name !== undefined) document.title = name ? `${name} · Homelab Monitoring` : "Homelab Monitoring";
  }, [name]);
}
