import { useMemo, useState } from "react";
import { CalendarDays, Download, Plug, Send, Zap } from "lucide-react";
import { api, fmtNum } from "../api";
import {
  Alert, Button, ButtonAnchor, Card, EmptyState, Link, PageHeader, SECTIONS, STAT_GRID, SectionTitle, Segmented, Skeleton, Stat, Chart, usePoll, useToast,
} from "../ui";

interface EnergyPlug { id: number; name: string; total_wh: number; avg_day_wh: number | null; avg_week_wh: number | null; avg_month_wh: number | null; daily: (number | null)[] }
interface EnergyReport { from: number; to: number; days: number[]; total_wh: number; avg_day_wh: number | null; avg_week_wh: number | null; avg_month_wh: number | null; plugs: EnergyPlug[] }

const kwh = (wh: number | null | undefined) => (wh == null ? "—" : `${fmtNum(wh / 1000, wh < 10000 ? 2 : 1)} kWh`);
type Range = "7" | "30" | "90" | "365";

export function EnergyPage() {
  const [days, setDays] = useState<Range>("30");
  const { data, error } = usePoll(() => api.get<EnergyReport>(`/api/reports/energy?days=${days}`), 300000, [days]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // Daily kWh per plug; uPlot wants seconds on x.
  const series = useMemo(() => (data?.plugs ?? []).map((p) => ({ label: p.name, values: p.daily.map((v) => (v == null ? null : v / 1000)) })), [data]);

  return (
    <>
      <PageHeader title="Consommation électrique" description="Relevés des prises Meross, lus en local. Moyennes calculées sur les jours mesurés."
        actions={<div className="mm-btn-group">
          <Segmented label="Période" value={days} onChange={setDays} options={[["7", "7 j"], ["30", "30 j"], ["90", "90 j"], ["365", "1 an"]]} />
          <ButtonAnchor variant="secondary" href={`/api/reports/energy.csv?days=${days}`} download icon={<Download size={16} />}>Exporter (CSV)</ButtonAnchor>
          <Button variant="secondary" icon={<Send size={16} />} loading={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/api/reports/energy/send?days=${days}`); toast("Rapport envoyé par e-mail"); } catch (e) { toast((e as Error).message, "error"); }
            setBusy(false);
          }}>Envoyer par e-mail</Button>
        </div>} />
      {error && <Alert kind="error" title="Impossible de charger la consommation" className="mb-6">{error}</Alert>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && data.plugs.length === 0 && (
        <EmptyState icon={<Plug size={20} />} title="Aucune prise connectée" action={<Link to="/monitors">Ajouter une sonde « Prise Meross »</Link>}>
          Connecte ton compte Meross dans Configuration, puis ajoute chaque prise comme sonde avec son adresse IP locale.
        </EmptyState>
      )}
      {data && data.plugs.length > 0 && (
        <div className={SECTIONS}>
          <div className={STAT_GRID}>
            <Stat label="Total sur la période" value={kwh(data.total_wh)} icon={<Zap size={16} />} detail={`${data.plugs.length} prise(s)`} />
            <Stat label="Moyenne par jour" value={kwh(data.avg_day_wh)} icon={<CalendarDays size={16} />} detail="toutes prises" />
            <Stat label="Moyenne par semaine" value={kwh(data.avg_week_wh)} detail="moyenne journalière × 7" />
            <Stat label="Moyenne par mois" value={kwh(data.avg_month_wh)} detail="moyenne journalière × 30,44" />
          </div>
          <section aria-labelledby="energy-chart">
            <SectionTitle id="energy-chart">Consommation par jour</SectionTitle>
            <Card className="p-5"><Chart t={data.days} series={series} format={(v) => `${fmtNum(v, 2)} kWh`} height={260} /></Card>
          </section>
          <Card flush title="Par prise" sub="Les jours sans relevé ne comptent pas dans les moyennes">
            <div className="mm-table-wrap">
              <table className="mm-table">
                <thead><tr><th scope="col">Prise</th><th scope="col" className="mm-col-num">Total</th><th scope="col" className="mm-col-num">/ jour</th><th scope="col" className="mm-col-num">/ semaine</th><th scope="col" className="mm-col-num">/ mois</th></tr></thead>
                <tbody>{data.plugs.map((p) => (
                  <tr key={p.id}>
                    <td className="mm-col-strong"><Link to={`/monitors/${p.id}`} className="text-inherit no-underline hover:text-accent-text">{p.name}</Link></td>
                    {[p.total_wh, p.avg_day_wh, p.avg_week_wh, p.avg_month_wh].map((v, i) => <td key={i} className="mm-col-num font-mono text-xs">{kwh(v)}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
