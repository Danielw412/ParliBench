import { Link, useParams } from 'react-router-dom';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { useResource } from '../api';
import { PageHeader, Loading, ErrorState, Confidence, ScoreInterval } from '../components';
import type { SystemInfo, RankingRow } from '../../shared/domain';
const breakdownLabels: Record<string, string> = { all: 'All tasks', government: 'Government', opposition: 'Opposition' };
export default function System() {
  const { id } = useParams();
  const state = useResource<{ system: SystemInfo; breakdowns: { label: string; row?: RankingRow }[] }>(`/systems/${encodeURIComponent(id || '')}`);
  if (state.loading) return <Loading />;
  if (state.error || !state.data) return <ErrorState message={state.error || 'System not found'} />;
  const { system: s, breakdowns } = state.data;
  return <div className="page">
    <PageHeader title={s.display_name} description={s.active ? s.provider : `${s.provider}. Inactive: excluded from new Arena matchups.`} action={<Link className="button" to="/leaderboard">Full leaderboard <ArrowUpRightIcon /></Link>} />
    <div className="system-layout">
      <section><h2>Configuration</h2><dl className="metadata"><dt>System ID</dt><dd className="mono">{s.id}</dd><dt>Provider</dt><dd>{s.provider}</dd><dt>Underlying model</dt><dd>{s.model}</dd><dt>Product / interface</dt><dd>{s.interface}</dd><dt>Reasoning setting</dt><dd>{s.reasoning || 'Not specified'}</dd><dt>Tools / configuration</dt><dd>{s.configuration || 'Not specified'}</dd></dl></section>
      <section><h2>Performance</h2><p className="page-description">Overall Preference, combined human and AI judges.</p><div className="system-breakdowns">{breakdowns.map(b => <div key={b.label}><h3>{breakdownLabels[b.label] || b.label}</h3>{b.row ? <><ScoreInterval row={b.row} /><p>{b.row.comparisons} comparisons, rating {Math.round(b.row.rating)}</p><Confidence row={b.row} /></> : <p>No comparisons yet</p>}</div>)}</div></section>
    </div>
    <p className="notice">Responses are shown only inside blind Arena comparisons. Raw outputs and run provenance are private to administrators.</p>
  </div>;
}
