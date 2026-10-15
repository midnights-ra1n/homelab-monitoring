import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { api } from "./api";
import { Alert, Toaster, navigate, usePath, useTitle } from "./ui";
import { AppShell } from "./layout";
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
import { IncidentsPage } from "./pages/Incidents";

interface AuthState { setup_required: boolean; authenticated: boolean; username: string; version: string; dev_mode: boolean }

function App() {
  const path = usePath();
  const [auth, setAuth] = useState<AuthState>();

  const seg = path.split("/").filter(Boolean);
  // Detail pages (/hosts/3, /monitors/7) set their own title from the item's name; the public page uses its own title.
  const PAGE_TITLES: Record<string, string> = {
    "": "Vue d'ensemble", hosts: "Hôtes", monitors: "Sondes", incidents: "Incidents", updates: "Mises à jour", disks: "Disques",
    containers: "Conteneurs", reports: "Rapports", "status-page": "Page de statut", settings: "Paramètres",
  };
  useTitle(path === "/status" || seg[1] ? undefined : auth && !auth.authenticated ? (auth.setup_required ? "Premier démarrage" : "Connexion") : PAGE_TITLES[seg[0] ?? ""] ?? "");

  const loadAuth = () => api.get<AuthState>("/api/auth/state").then(setAuth, () => setAuth(undefined));
  useEffect(() => { loadAuth(); }, []);
  useEffect(() => {
    const on = () => setAuth((a) => (a ? { ...a, authenticated: false } : a));
    window.addEventListener("hlm:unauthorized", on);
    return () => window.removeEventListener("hlm:unauthorized", on);
  }, []);

  if (path === "/status") return <PublicStatusPage />;
  if (!auth) return null;
  const devBanner = auth.dev_mode && (
    <Alert kind="warning" className="rounded-none border-x-0 border-t-0" title="Mode test : données simulées et compte admin / devmode-password. Ne jamais exposer cette instance." />
  );
  if (!auth.authenticated) return <>{devBanner}<AuthPage setup={auth.setup_required} onDone={loadAuth} /></>;

  let page;
  if (seg[0] === "hosts" && seg[1]) page = <HostDetailPage id={Number(seg[1])} />;
  else if (seg[0] === "hosts") page = <HostsPage />;
  else if (seg[0] === "monitors" && seg[1]) page = <MonitorDetailPage id={Number(seg[1])} />;
  else if (seg[0] === "monitors") page = <MonitorsPage />;
  else if (seg[0] === "incidents") page = <IncidentsPage />;
  else if (seg[0] === "updates") page = <UpdatesPage />;
  else if (seg[0] === "disks") page = <DisksPage />;
  else if (seg[0] === "containers") page = <ContainersPage />;
  else if (seg[0] === "reports") page = <ReportsPage />;
  else if (seg[0] === "status-page") page = <StatusEditorPage />;
  else if (seg[0] === "settings") page = <SettingsPage version={auth.version} />;
  else page = <OverviewPage />;

  const logout = () => api.post("/api/auth/logout").then(() => { navigate("/"); loadAuth(); });
  return (
    <>
      {devBanner}
      <AppShell username={auth.username} version={auth.dev_mode ? "dev" : auth.version} onLogout={logout}>{page}</AppShell>
    </>
  );
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Toaster><App /></Toaster></StrictMode>,
);
