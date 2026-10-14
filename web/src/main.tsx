import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, FileBarChart, HardDrive, LayoutDashboard, LogOut, Menu, Moon, PackageCheck, PanelsTopLeft, Radar, Server, Settings as SettingsIcon, Sun, Globe } from "lucide-react";
import "./styles.css";
import { api } from "./api";
import { IconButton, Link, ToastProvider, navigate, usePath, useTheme } from "./ui";
import { AuthPage } from "./pages/Auth";
import { OverviewPage } from "./pages/Overview";
import { HostsPage, HostDetailPage } from "./pages/Hosts";
import { MonitorsPage, MonitorDetailPage } from "./pages/Monitors";
import { SettingsPage } from "./pages/Settings";
import { UpdatesPage } from "./pages/Updates";
import { PublicStatusPage, StatusEditorPage } from "./pages/PublicStatus";
import { DisksPage } from "./pages/Disks";
import { ReportsPage } from "./pages/Reports";

interface AuthState { setup_required: boolean; authenticated: boolean; username: string; version: string; dev_mode: boolean }

function App() {
  const path = usePath();
  const theme = useTheme();
  const [auth, setAuth] = useState<AuthState>();
  const [navOpen, setNavOpen] = useState(false);

  const loadAuth = () => api.get<AuthState>("/api/auth/state").then(setAuth, () => setAuth(undefined));
  useEffect(() => { loadAuth(); }, []);
  useEffect(() => {
    const on = () => setAuth((a) => (a ? { ...a, authenticated: false } : a));
    window.addEventListener("hlm:unauthorized", on);
    return () => window.removeEventListener("hlm:unauthorized", on);
  }, []);
  useEffect(() => setNavOpen(false), [path]);

  if (path === "/status") return <PublicStatusPage />;
  if (!auth) return null;
  const devBanner = auth.dev_mode && (
    <div className="alert warning" role="status" style={{ borderRadius: 0, borderWidth: "0 0 1px" }}>
      <strong>Mode test : données simulées et compte admin / devmode-password. Ne jamais exposer cette instance.</strong>
    </div>
  );
  if (!auth.authenticated) return <>{devBanner}<AuthPage setup={auth.setup_required} onDone={loadAuth} /></>;

  const seg = path.split("/").filter(Boolean);
  let page;
  if (seg[0] === "hosts" && seg[1]) page = <HostDetailPage id={Number(seg[1])} />;
  else if (seg[0] === "hosts") page = <HostsPage />;
  else if (seg[0] === "monitors" && seg[1]) page = <MonitorDetailPage id={Number(seg[1])} />;
  else if (seg[0] === "monitors") page = <MonitorsPage />;
  else if (seg[0] === "updates") page = <UpdatesPage />;
  else if (seg[0] === "disks") page = <DisksPage />;
  else if (seg[0] === "reports") page = <ReportsPage />;
  else if (seg[0] === "status-page") page = <StatusEditorPage />;
  else if (seg[0] === "settings") page = <SettingsPage theme={theme} />;
  else page = <OverviewPage />;

  const nav: [string, string, typeof Server][] = [
    ["/", "Vue d'ensemble", LayoutDashboard],
    ["/hosts", "Hôtes", Server],
    ["/monitors", "Sondes", Radar],
    ["/updates", "Mises à jour", PackageCheck],
    ["/disks", "Disques", HardDrive],
    ["/reports", "Rapports", FileBarChart],
    ["/status-page", "Page de statut", PanelsTopLeft],
    ["/settings", "Réglages", SettingsIcon],
  ];
  const isDark = document.documentElement.dataset.theme === "dark";

  return (
    <div className={`shell${navOpen ? " nav-open" : ""}`}>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden />}
      <nav className="sidebar" aria-label="Navigation principale">
        <div className="brand"><span className="brand-mark"><Activity size={16} aria-hidden /></span>Homelab</div>
        {nav.map(([to, label, Icon]) => {
          const active = to === "/" ? path === "/" : path.startsWith(to);
          return (
            <Link key={to} to={to} className="nav-item" aria-current={active ? "page" : undefined}>
              <Icon size={18} aria-hidden />{label}
            </Link>
          );
        })}
        <div className="nav-title">Public</div>
        <a className="nav-item" href="/status" target="_blank" rel="noopener"><Globe size={18} aria-hidden />Voir la page publique</a>
        <div style={{ flex: 1 }} />
        <span className="xs tertiary" style={{ padding: "0 8px" }}>Version {auth.version}</span>
      </nav>
      <div className="main">
        <header className="topbar">
          <IconButton className="menu-btn" label="Ouvrir le menu" icon={<Menu size={20} />} onClick={() => setNavOpen(true)} />
          <div className="spacer" />
          <IconButton label={isDark ? "Passer au thème clair" : "Passer au thème sombre"} icon={isDark ? <Sun size={20} /> : <Moon size={20} />}
            onClick={() => theme.setMode(isDark ? "light" : "dark")} />
          <span className="small muted">{auth.username}</span>
          <IconButton label="Se déconnecter" icon={<LogOut size={20} />} onClick={() => api.post("/api/auth/logout").then(() => { navigate("/"); loadAuth(); })} />
        </header>
        {devBanner}
        <main className="content" id="content">{page}</main>
      </div>
    </div>
  );
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ToastProvider><App /></ToastProvider></StrictMode>,
);
