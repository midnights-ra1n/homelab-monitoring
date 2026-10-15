import { useState } from "react";
import { CircleAlert, CircleCheck, TriangleAlert, Wrench } from "lucide-react";
import { api, fmtAgo, statusLabel, type Overview, type Status } from "../api";
import { Alert, EmptyState, Link, PageHeader, SECTIONS, STAT_GRID, Segmented, Card, Stat, StatusBadge, StatusIcon, navigate, usePoll } from "../ui";

export interface Incident { key: string; kind: "Hôte" | "Sonde"; name: string; status: Status; detail: string; at: number; to: string }

const SEVERITY: Record<Status, number> = { major_outage: 0, minor_outage: 1, degraded: 2, maintenance: 3, operational: 4, unknown: 5 };

/** Hosts and monitors that are neither operational nor unknown, worst first. */
export function incidents(data: Overview): Incident[] {
  const open = (s: Status) => s !== "operational" && s !== "unknown";
  return [
    ...data.hosts.filter((h) => open(h.status)).map((h): Incident => ({
      key: `h${h.id}`, kind: "Hôte", name: h.name, status: h.status, at: h.last_seen, to: `/hosts/${h.id}`,
      detail: h.status === "maintenance" ? "Maintenance en cours" : h.connected ? "Agent connecté" : "Agent injoignable",
    })),
    ...data.monitors.filter((m) => open(m.status)).map((m): Incident => ({
      key: `m${m.id}`, kind: "Sonde", name: m.name, status: m.status, at: m.last_check, to: `/monitors/${m.id}`,
      detail: m.message || (m.status === "maintenance" ? "Maintenance en cours" : ""),
    })),
  ].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.name.localeCompare(b.name, "fr"));
}

type Filter = "all" | "Hôte" | "Sonde";

export function IncidentsPage() {
  const { data, error } = usePoll(() => api.get<Overview>("/api/overview"), 15000);
  const [filter, setFilter] = useState<Filter>("all");
  const all = data ? incidents(data) : [];
  const list = filter === "all" ? all : all.filter((i) => i.kind === filter);
  const count = (s: Status) => all.filter((i) => i.status === s).length;

  return (
    <>
      <PageHeader title="Incidents en cours" description="Hôtes et sondes qui ne sont pas opérationnels, du plus grave au moins grave. Actualisé toutes les 15 secondes." />
      {error && <Alert kind="error" title="Impossible de charger les incidents" className="mb-6">{error}</Alert>}
      <div className={SECTIONS}>
        <div className={STAT_GRID}>
          <Stat label="Pannes majeures" value={count("major_outage")} icon={<CircleAlert size={16} />} tone={count("major_outage") ? "red" : undefined} />
          <Stat label="Pannes partielles" value={count("minor_outage")} icon={<CircleAlert size={16} />} tone={count("minor_outage") ? "red" : undefined} />
          <Stat label="Performances dégradées" value={count("degraded")} icon={<TriangleAlert size={16} />} tone={count("degraded") ? "yellow" : undefined} />
          <Stat label="En maintenance" value={count("maintenance")} icon={<Wrench size={16} />} />
        </div>
        {data && all.length === 0 ? (
          <EmptyState icon={<CircleCheck size={20} />} title="Aucun incident en cours">Tous les hôtes et toutes les sondes sont opérationnels.</EmptyState>
        ) : (
          <Card flush title="Éléments concernés" sub={data ? `${list.length} incident(s)` : "Chargement…"}
            actions={<Segmented size="sm" label="Type" value={filter} onChange={setFilter} options={[["all", "Tous"], ["Hôte", "Hôtes"], ["Sonde", "Sondes"]]} />}>
            {list.length === 0 ? <p className="px-5 py-8 text-center text-sm text-meta">Aucun incident pour ce type d'élément.</p> : (
              <>
                <ul className="mm-list sm:hidden">
                  {list.map((i) => (
                    <li key={i.key}>
                      <Link to={i.to} className="mm-list__item items-center no-underline">
                        <span className="flex min-w-0 items-center gap-3">
                          <StatusIcon status={i.status} size={18} />
                          <span className="min-w-0">
                            <span className="mm-list__title block">{i.name}</span>
                            <span className="mm-list__meta block truncate">{i.kind} · {i.detail || statusLabel[i.status]}</span>
                          </span>
                        </span>
                        <StatusBadge status={i.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="mm-table-wrap hidden sm:block">
                  <table className="mm-table">
                    <thead><tr><th scope="col">Élément</th><th scope="col">Type</th><th scope="col">État</th><th scope="col">Détail</th><th scope="col">Dernier relevé</th></tr></thead>
                    <tbody>
                      {list.map((i) => (
                        <tr key={i.key} className="cursor-pointer" onClick={() => navigate(i.to)}>
                          <td className="mm-col-strong">
                            <Link to={i.to} className="flex items-center gap-2.5 text-inherit no-underline hover:text-accent-text"><StatusIcon status={i.status} />{i.name}</Link>
                          </td>
                          <td className="mm-col-muted">{i.kind}</td>
                          <td><StatusBadge status={i.status} /></td>
                          <td className="whitespace-normal">{i.detail || "—"}</td>
                          <td className="mm-col-muted">{i.at ? fmtAgo(i.at) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
