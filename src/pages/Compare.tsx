import { useParams } from 'react-router-dom';
import { useResource } from '../api';
import { PageHeader, Loading, ErrorState } from '../components';
import { METRIC_LABELS, type SystemInfo } from '../../shared/domain';
interface H2H { a: SystemInfo; b: SystemInfo; breakdowns: { label: string; comparisons: number; win_rate: number; ci: [number,number]; sufficient: boolean }[]; }
const labels: Record<string,string> = { ...METRIC_LABELS, government:'Government', opposition:'Opposition', human:'Human judges', ai:'AI judges' };
export default function Compare() {
  const { a,b } = useParams();
  const state = useResource<H2H>(`/compare/${encodeURIComponent(a || '')}/${encodeURIComponent(b || '')}`);
  if (state.loading) return <Loading />;
  if (state.error || !state.data) return <ErrorState message={state.error || 'Comparison not found'} />;
  const data = state.data;
  return <div className="page">
    <PageHeader title="Head to head" description="Direct comparisons only. Each breakdown shows preference for the system on the left." />
    <div className="versus"><div><span className="letter-square">A</span><h2>{data.a.display_name}</h2><p>{data.a.model} · {data.a.interface}</p></div><span className="versus-label">VS</span><div><span className="letter-square outline">B</span><h2>{data.b.display_name}</h2><p>{data.b.model} · {data.b.interface}</p></div></div>
    <div className="h2h-table"><div className="h2h-row h2h-head"><span>Breakdown</span><span>A preference share</span><span>95% interval</span><span>Comparisons</span></div>{data.breakdowns.map(row => <div className="h2h-row" key={row.label}><strong>{labels[row.label] || row.label}</strong>{row.sufficient ? <><div className="h2h-bar"><span style={{width:`${row.win_rate*100}%`}} /><b>{(row.win_rate*100).toFixed(1)}%</b></div><span className="mono">{(row.ci[0]*100).toFixed(1)}–{(row.ci[1]*100).toFixed(1)}%</span></> : <><span className="muted">Insufficient data</span><span>—</span></>}<span className="mono">{row.comparisons}</span></div>)}</div>
    <p className="caption">At least 5 direct comparisons and 3 effective comparisons are required per breakdown. Ties and preference strength contribute fractional wins. Intervals use a conservative weighted Wilson approximation. Combined views respect configured human/AI source shares.</p>
  </div>;
}
