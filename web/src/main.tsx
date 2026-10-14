import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Container, FileBarChart, HardDrive, LayoutDashboard, Menu, PackageCheck, PanelsTopLeft, Radar, Server, Settings as SettingsIcon, Globe } from "lucide-react";
import "./styles.css";
import { api } from "./api";
import { IconButton, Link, Logo, ToastProvider, UserMenu, navigate, usePath, useTheme } from "./ui";
import { AuthPage } from "./pages/Auth";
import { OverviewPage } from "./pages/Overview";
import { HostsPage, HostDetailPage } from "./pages/Hosts";
import { MonitorsPage, MonitorDetailPage } from "./pages/Monitors";
import { SettingsPage } from "./pages/Settings";
import { UpdatesPage } from "./pages/Updates";
import { PublicStatusPage, StatusEditorPage } from "./pages/PublicStatus";
import { DisksPage } from "./pages/Disks";
import { ContainersPage } from "./pages/Containers";
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
  else if (seg[0] === "containers") page = <ContainersPage />;
  else if (seg[0] === "reports") page = <ReportsPage />;
  else if (seg[0] === "status-page") page = <StatusEditorPage />;
  else if (seg[0] === "settings") page = <SettingsPage theme={theme} />;
  else page = <OverviewPage />;

  const sections: [string | null, [string, string, typeof Server][]][] = [
    [null, [["/", "Vue d'ensemble", LayoutDashboard]]],
    ["Infrastructure", [["/hosts", "Hôtes", Server], ["/containers", "Conteneurs", Container], ["/disks", "Disques", HardDrive]]],
    ["Surveillance", [["/monitors", "Sondes", Radar], ["/updates", "Mises à jour", PackageCheck], ["/reports", "Rapports", FileBarChart]]],
    ["Public", [["/status-page", "Page de statut", PanelsTopLeft]]],
  ];
  const isActive = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));
  const logout = () => api.post("/api/auth/logout").then(() => { navigate("/"); loadAuth(); });

  return (
    <div className={`shell${navOpen ? " nav-open" : ""}`}>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden />}
      <nav className="sidebar" aria-label="Navigation principale">
        <Link to="/" className="brand" aria-label="Homelab Monitoring, vue d'ensemble">
          <Logo />
          <span className="brand-sub"><span>Monitoring</span><span className="brand-version">{auth.dev_mode ? "dev" : auth.version}</span></span>
        </Link>
        {sections.map(([title, items]) => (
          <div key={title ?? "main"} className="nav-section">
            {title && <div className="nav-title">{title}</div>}
            {items.map(([to, label, Icon]) => (
              <Link key={to} to={to} className="nav-item" aria-current={isActive(to) ? "page" : undefined}>
                <Icon size={18} aria-hidden />{label}
              </Link>
            ))}
            {title === "Public" && <a className="nav-item" href="/status" target="_blank" rel="noopener"><Globe size={18} aria-hidden />Voir la page publique</a>}
          </div>
        ))}
        <div className="nav-footer">
          <Link to="/settings" className="nav-item" aria-current={isActive("/settings") ? "page" : undefined}>
            <SettingsIcon size={18} aria-hidden />Paramètres
          </Link>
          <UserMenu username={auth.username} theme={theme} onLogout={logout} />
        </div>
      </nav>
      <div className="main">
        <header className="mobile-bar">
          <IconButton label="Ouvrir le menu" icon={<Menu size={20} />} onClick={() => setNavOpen(true)} />
          <Logo />
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
