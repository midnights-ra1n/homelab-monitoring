/* App shell ported from homelab-management (components/layout/*, components/alert-banner.tsx):
   .mm-app [sidebar | content], bottom bar under 640 px, ⌘K search and the alert strip. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, ArrowUpRight, ChevronsUpDown, Container, CornerDownLeft, Ellipsis, FileBarChart, Globe, HardDrive, LayoutDashboard,
  PackageCheck, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Radar, Search, Server, Settings, Siren, X, type LucideIcon,
} from "lucide-react";
import { api, type Overview } from "./api";
import { incidents } from "./pages/Incidents";
import { Link, Logo, StatusDot, StatusIcon, STATUS_TONE, ThemeSwitch, TONE_VAR, cn, isActive, navigate, toggleRail, usePath, useRail } from "./ui";

type NavItem = { href: string; label: string; short: string; icon: LucideIcon };

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Vue d'ensemble", short: "Accueil", icon: LayoutDashboard },
  { href: "/incidents", label: "Incidents", short: "Incidents", icon: Siren },
  { href: "/hosts", label: "Hôtes", short: "Hôtes", icon: Server },
  { href: "/containers", label: "Conteneurs", short: "Conteneurs", icon: Container },
  { href: "/disks", label: "Disques", short: "Disques", icon: HardDrive },
  { href: "/monitors", label: "Sondes", short: "Sondes", icon: Radar },
  { href: "/updates", label: "Mises à jour", short: "MàJ", icon: PackageCheck },
  { href: "/reports", label: "Rapports", short: "Rapports", icon: FileBarChart },
  { href: "/status-page", label: "Page de statut", short: "Statut", icon: PanelsTopLeft },
];
const byHref = (href: string) => NAV_ITEMS.find((i) => i.href === href)!;

const NAV_SECTIONS: { label?: string; items: NavItem[] }[] = [
  { items: ["/", "/incidents"].map(byHref) },
  { label: "Infrastructure", items: ["/hosts", "/containers", "/disks"].map(byHref) },
  { label: "Surveillance", items: ["/monitors", "/updates", "/reports"].map(byHref) },
  { label: "Public", items: ["/status-page"].map(byHref) },
];
/** Main tabs of the mobile bar (the rest is under "Plus"). */
const MOBILE_TABS = ["/", "/hosts", "/monitors", "/incidents"];
const SETTINGS: NavItem = { href: "/settings", label: "Paramètres", short: "Paramètres", icon: Settings };

const SEARCH_EVENT = "hlm:search";
const openSearch = () => window.dispatchEvent(new Event(SEARCH_EVENT));

export function AppShell({ username, version, onLogout, children }: { username: string; version: string; onLogout: () => void; children: ReactNode }) {
  return (
    <>
      <a href="#contenu" className="mm-btn mm-btn--primary sr-only z-[70] focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Aller au contenu</a>
      <div className="mm-app" data-mobile-nav="bottom">
        <AppSidebar version={version} account={<AccountButton username={username} onLogout={onLogout} />} />
        <div className="mm-app__main">
          <main id="contenu" className="mm-page flex-1 overflow-x-clip">
            <AlertStrip />
            {children}
          </main>
        </div>
        <MobileNav account={<AccountSheet username={username} onLogout={onLogout} />} />
      </div>
      <CommandPalette />
    </>
  );
}

/* ---------- Sidebar ---------- */

function AppSidebar({ version, account }: { version: string; account: ReactNode }) {
  const pathname = usePath();
  return (
    <aside className="mm-sidebar" aria-label="Navigation principale">
      <SideHead version={version} />
      <nav className="mm-sidebar__nav">
        <button type="button" onClick={openSearch} title="Rechercher (⌘K)" className="mm-nav-item">
          <Search size={16} aria-hidden="true" className="shrink-0" />
          <span className="mm-nav-item__label">Rechercher</span>
          <kbd className="mm-nav-item__count font-mono">⌘K</kbd>
        </button>
        {NAV_SECTIONS.map((section, i) => (
          <div key={i} className="mm-sidebar__section">
            {section.label && <div className="mm-label-caps">{section.label}</div>}
            {section.items.map((item) => <SideLink key={item.href} item={item} active={isActive(pathname, item.href)} />)}
            {section.label === "Public" && (
              <a href="/status" target="_blank" rel="noopener" title="Voir la page publique" className="mm-nav-item">
                <Globe size={16} aria-hidden="true" className="shrink-0" />
                <span className="mm-nav-item__label">Voir la page publique</span>
              </a>
            )}
          </div>
        ))}
      </nav>
      <div className="mm-sidebar__foot">
        <SideLink item={SETTINGS} active={isActive(pathname, SETTINGS.href)} />
        {account}
      </div>
    </aside>
  );
}

function SideLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link to={item.href} title={item.label} aria-current={active ? "page" : undefined} className="mm-nav-item">
      <item.icon size={16} aria-hidden="true" className="shrink-0" />
      <span className="mm-nav-item__label">{item.label}</span>
    </Link>
  );
}

function SideHead({ version }: { version: string }) {
  const rail = useRail();
  const v = /^v?\d/.test(version) ? (version.startsWith("v") ? version : `v${version}`) : version;
  const label = rail ? "Déplier la barre latérale" : "Replier la barre latérale";
  return (
    <div className="mm-sidebar__head">
      <Link to="/" aria-label="Vue d'ensemble" className="mm-sidebar__brand no-underline">
        <span className="flex size-6 shrink-0 items-center justify-center [&_svg]:h-6"><Logo compact /></span>
        <span className="grid min-w-0 leading-none">
          <span>Homelab</span>
          <span className="mt-1 flex items-baseline gap-1.5 text-[11px] font-medium text-meta">
            Monitoring
            <span className="font-mono font-normal text-accent-text tabular-nums">{v}</span>
          </span>
        </span>
      </Link>
      <button type="button" onClick={toggleRail} aria-label={label} title={label} className="mm-btn mm-btn--ghost mm-btn--sm mm-btn--icon mm-sidebar__collapse">
        {rail ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}

/* ---------- Account ---------- */

function Avatar({ username, large = false }: { username: string; large?: boolean }) {
  return <span className={large ? "mm-avatar mm-avatar--lg uppercase" : "mm-avatar uppercase"}>{username.slice(0, 2)}</span>;
}

function AccountMenu({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="mm-menu w-full" role="menu">
      <div className="mm-menu__label mm-label-caps">Thème</div>
      <div className="mm-menu__block"><ThemeSwitch className="mm-segmented--block" /></div>
      <div className="mm-menu__sep" role="separator" />
      <button type="button" role="menuitem" className="mm-menu__item mm-menu__item--danger" onClick={onLogout}>Se déconnecter</button>
    </div>
  );
}

/** Sidebar footer: avatar, name, role; the menu opens upwards. */
function AccountButton({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="mm-account-anchor">
      <button type="button" className="mm-account" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={username} aria-label={`Compte ${username}`}>
        <Avatar username={username} />
        <span className="mm-account__text">
          <span className="mm-account__name">{username}</span>
          <span className="mm-account__sub">Administrateur</span>
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" className="mm-account__chev" />
      </button>
      {open && <div className="mm-account-menu"><AccountMenu onLogout={() => { setOpen(false); onLogout(); }} /></div>}
    </div>
  );
}

/** Account block of the mobile "Plus" sheet. */
function AccountSheet({ username, onLogout }: { username: string; onLogout: () => void }) {
  return (
    <>
      <div className="flex items-center gap-3 px-3 py-2">
        <Avatar username={username} large />
        <span className="mm-account__text">
          <span className="mm-account__name">{username}</span>
          <span className="mm-account__sub">Administrateur</span>
        </span>
      </div>
      <AccountMenu onLogout={onLogout} />
    </>
  );
}

/* ---------- Mobile bottom bar ---------- */

function MobileNav({ account }: { account: ReactNode }) {
  const pathname = usePath();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const tabs = MOBILE_TABS.map(byHref);
  const more = [...NAV_ITEMS.filter((i) => !MOBILE_TABS.includes(i.href)), SETTINGS];
  const moreActive = more.some((i) => isActive(pathname, i.href));

  return (
    <>
      {open && <div className="mm-sheet-scrim sm:hidden" onClick={() => setOpen(false)} aria-hidden />}
      {open && (
        <div className="mm-sheet sm:hidden" role="dialog" aria-modal="true" aria-label="Plus">
          <div className="mm-sheet__grip" aria-hidden="true" />
          <button type="button" className="mm-nav-item" onClick={() => { setOpen(false); openSearch(); }}>
            <Search size={20} aria-hidden="true" className="shrink-0" />
            <span className="mm-nav-item__label">Rechercher</span>
          </button>
          {more.map((item) => (
            <Link key={item.href} to={item.href} className="mm-nav-item" aria-current={isActive(pathname, item.href) ? "page" : undefined}>
              <item.icon size={20} aria-hidden="true" className="shrink-0" />
              <span className="mm-nav-item__label">{item.label}</span>
            </Link>
          ))}
          <a href="/status" target="_blank" rel="noopener" className="mm-nav-item">
            <Globe size={20} aria-hidden="true" className="shrink-0" />
            <span className="mm-nav-item__label">Voir la page publique</span>
          </a>
          <div className="mm-sheet__sep" />
          {account}
        </div>
      )}
      <nav className="mm-bottomnav" aria-label="Navigation principale">
        {tabs.map((item) => (
          <Link key={item.href} to={item.href} className="mm-bottomnav__item no-underline" aria-current={isActive(pathname, item.href) && !open ? "page" : undefined}>
            <span className="mm-bottomnav__pill"><item.icon size={22} aria-hidden="true" /></span>
            <span className="mm-bottomnav__label">{item.short}</span>
          </Link>
        ))}
        <button type="button" className="mm-bottomnav__item" aria-haspopup="dialog" aria-expanded={open}
          aria-current={moreActive && !open ? "page" : undefined} onClick={() => setOpen((o) => !o)}>
          <span className="mm-bottomnav__pill">{open ? <X size={22} aria-hidden="true" /> : <Ellipsis size={22} aria-hidden="true" />}</span>
          <span className="mm-bottomnav__label">Plus</span>
        </button>
      </nav>
    </>
  );
}

/* ---------- Global search (⌘K / Ctrl+K): pages, hosts and monitors ---------- */

type Item = { key: string; href: string; label: string; detail?: string; icon: ReactNode; tone?: ReturnType<typeof toneOf> };
const toneOf = (s: Overview["hosts"][number]["status"]) => STATUS_TONE[s];

function CommandPalette() {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<Overview>();
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SEARCH_EVENT, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(SEARCH_EVENT, onOpen); };
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); api.get<Overview>("/api/overview").then(setData, () => {}); }
    if (!open && d.open) d.close();
  }, [open]);

  const query = q.trim().toLowerCase();
  const match = (...s: (string | undefined)[]) => !query || s.some((x) => x?.toLowerCase().includes(query));
  const pages = [...NAV_ITEMS, SETTINGS].filter((p) => match(p.label))
    .map<Item>((p) => ({ key: `p${p.href}`, href: p.href, label: p.label, detail: "Page", icon: <p.icon size={16} /> }));
  const things = !query || !data ? [] : [
    ...data.hosts.filter((h) => match(h.name, h.info.hostname, h.info.os))
      .map<Item>((h) => ({ key: `h${h.id}`, href: `/hosts/${h.id}`, label: h.name, detail: ["Hôte", h.info.os].filter(Boolean).join(" · "), icon: <Server size={16} />, tone: toneOf(h.status) })),
    ...data.monitors.filter((m) => match(m.name, m.target))
      .map<Item>((m) => ({ key: `m${m.id}`, href: `/monitors/${m.id}`, label: m.name, detail: `Sonde · ${m.target}`, icon: <Radar size={16} />, tone: toneOf(m.status) })),
  ];
  const items = [...things, ...pages];
  const current = Math.min(active, Math.max(0, items.length - 1));
  const go = (item: Item | undefined) => { if (!item) return; setOpen(false); navigate(item.href); };

  return (
    <dialog ref={ref} aria-label="Recherche globale" onClick={(e) => e.target === ref.current && setOpen(false)}
      onClose={() => { setOpen(false); setQ(""); setActive(0); }}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-[560px] rounded-[14px] border border-line bg-elevated p-0 text-h2 shadow-[var(--mm-shadow-lg)]">
      {open && (
        <div onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((current + 1) % Math.max(1, items.length));
          else if (e.key === "ArrowUp") setActive((current - 1 + items.length) % Math.max(1, items.length));
          else if (e.key === "Enter") go(items[current]);
          else return;
          e.preventDefault();
        }}>
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search size={16} className="shrink-0 text-accent-text" aria-hidden="true" />
            <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Hôte, sonde, page…"
              aria-label="Rechercher" role="combobox" aria-expanded="true" aria-controls="palette-results"
              aria-activedescendant={items[current] ? `palette-${items[current].key}` : undefined}
              className="h-12 min-w-0 flex-1 bg-transparent text-base text-h1 outline-none placeholder:text-meta" />
            <kbd className="rounded-full border border-line px-2 font-mono text-[0.7rem] text-meta">Esc</kbd>
          </div>
          <ul id="palette-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-meta">Aucun résultat</li>}
            {items.map((item, i) => (
              <li key={item.key} id={`palette-${item.key}`} role="option" aria-selected={i === current}
                onMouseMove={() => setActive(i)} onClick={() => go(item)}
                className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-[6px] px-3 text-sm", i === current ? "bg-hover text-h1" : "text-h2")}>
                <span className={cn("shrink-0", i === current ? "text-accent-text" : "text-meta")}>{item.icon}</span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate">{item.label}</span>
                  {item.tone && <StatusDot tone={item.tone} className="scale-75" />}
                </span>
                {item.detail && <span className="max-w-[45%] truncate font-mono text-xs text-meta">{item.detail}</span>}
                {i === current && <CornerDownLeft size={14} className="shrink-0 text-meta" aria-hidden="true" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </dialog>
  );
}

/* ---------- Alerts ---------- */

/** Polls /api/overview every 30 s while the tab is visible and returns the open incidents. */
export function useIncidents() {
  const [list, setList] = useState<ReturnType<typeof incidents>>([]);
  useEffect(() => {
    let stopped = false;
    const load = () => { if (!document.hidden) api.get<Overview>("/api/overview").then((d) => !stopped && setList(incidents(d)), () => {}); };
    load();
    const timer = setInterval(load, 30_000);
    document.addEventListener("visibilitychange", load);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, []);
  return list;
}

type Incident = ReturnType<typeof incidents>[number];
const isCritical = (i: Incident) => i.status === "major_outage" || i.status === "minor_outage";

function summary(list: Incident[]) {
  const critical = list.filter(isCritical).length;
  return {
    critical,
    color: TONE_VAR[critical ? "red" : "yellow"],
    title: critical ? `${critical} incident(s) en cours` : `${list.length} point(s) d'attention`,
  };
}

/** Overview banner: large, lists the alerts. */
export function AlertBanner({ list }: { list: Incident[] }) {
  const shown = list.filter((i) => i.status !== "maintenance");
  if (!shown.length) return null;
  const { critical, color, title } = summary(shown);
  return (
    <section role={critical ? "alert" : "status"} className="rounded-2xl border p-5 sm:p-6"
      style={{ background: `color-mix(in srgb, ${color} 12%, var(--mm-surface))`, borderColor: `color-mix(in srgb, ${color} 50%, var(--mm-border))` }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: color, color: "var(--mm-surface)" }}>
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold sm:text-xl" style={{ color }}>{title}</p>
          {critical > 0 && shown.length > critical && <p className="text-sm text-meta">+ {shown.length - critical} avertissement(s)</p>}
        </div>
        <Link to="/incidents" className="mm-btn mm-btn--secondary mm-btn--sm no-underline"><ArrowUpRight size={14} />Voir les incidents</Link>
      </div>
      <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {shown.slice(0, 6).map((a) => (
          <li key={a.key}>
            <Link to={a.to} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm no-underline hover:bg-page">
              <StatusIcon status={a.status} size={15} />
              <span className="truncate text-h1">{a.name}{a.detail ? <span className="text-meta"> · {a.detail}</span> : null}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Discreet one-line version for the other pages (the overview and incidents pages have their own). */
function AlertStrip() {
  const pathname = usePath();
  const list = useIncidents().filter((i) => i.status !== "maintenance");
  if (!list.length || pathname === "/" || pathname === "/incidents") return null;
  const { critical, color, title } = summary(list);
  return (
    <Link to="/incidents" role={critical ? "alert" : "status"}
      className="mb-6 flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm no-underline transition-colors hover:brightness-110"
      style={{ background: `color-mix(in srgb, ${color} 8%, var(--mm-surface))`, borderColor: `color-mix(in srgb, ${color} 35%, var(--mm-border))` }}>
      <AlertTriangle size={14} className="shrink-0" style={{ color }} aria-hidden="true" />
      <span className="shrink-0 font-medium" style={{ color }}>{title}</span>
      <span className="min-w-0 flex-1 truncate text-meta">{list[0].name}{list[0].detail ? ` · ${list[0].detail}` : ""}</span>
      <ArrowUpRight size={14} className="shrink-0 text-meta" aria-hidden="true" />
    </Link>
  );
}
