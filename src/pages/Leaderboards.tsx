import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { useResource, query } from '../api';
import { categoryOptions, taskOptions, metricOptions, Select, PageHeader, Loading, ErrorState, RankingTable } from '../components';
import type { Leaderboard } from '../../shared/domain';

export function Methodology() {
  return <details className="methodology"><summary><InfoIcon size={18} /> How to read these rankings</summary><div className="methodology-columns"><div><h3>Pairwise, from the ground up.</h3><p>Bradley-Terry estimates each system’s strength from direct comparisons. “Much better”, “better”, and “tie” contribute fractional outcomes of 1, 0.75, and 0.5. Scores show predicted win share against a benchmark-average system; Elo-style ratings are centered around 1500.</p></div><div><h3>Preference and performance.</h3><p>Overall Preference uses the mandatory overall vote. Weighted Benchmark uses only the judged metrics, with configured task weights renormalized over non-skipped metrics. The two rankings answer different questions.</p></div><div><h3>Uncertainty is part of the result.</h3><p>Intervals are approximate 95% regularized model intervals. Sparse or disconnected comparisons show low confidence. Correlated judges and repeated topics can make real uncertainty larger. Combined rankings use fixed source shares, initially 50% human and 50% AI.</p></div></div></details>;
}
export default function Leaderboards() {
  const [search, setSearch] = useSearchParams();
  const get = (key: string, fallback: string) => search.get(key) || fallback;
  const values = { source: get('source','human'), subgroup: get('subgroup','all'), category: get('category','all'), task: get('task','all'), metric: get('metric','overall'), ...(search.get('judge') ? { judge: search.get('judge')! } : {}) };
  const rank = useResource<Leaderboard>(`/leaderboard?${query(values)}`);
  const judges = useResource<{ id: string; display_name: string }[]>('/ai-judges');
  const [compareA, setCompareA] = useState(''), [compareB, setCompareB] = useState('');
  function change(key: string, value: string) { const next = new URLSearchParams(search); next.set(key, value); if (key === 'source') next.delete('judge'); if (key === 'judge' && value === 'all') next.delete('judge'); setSearch(next); }
  return <div className="page">
    <PageHeader title="Leaderboard" description="Pairwise rankings of AI systems from blind Arena judgments." action={<Link className="button" to="/arena">Enter the Arena <ArrowUpRightIcon /></Link>} />
    <div className="source-tabs" role="group" aria-label="Judge source">{[['human','Human judges'],['ai','AI judges'],['combined','Combined']].map(([v,label]) => <button key={v} className={values.source === v ? 'active' : ''} aria-pressed={values.source === v} onClick={() => change('source',v)}>{label}</button>)}</div>
    <div className="leaderboard-filters"><Select label="Human subgroup" value={values.subgroup} onChange={v => change('subgroup',v)} options={values.source === 'ai' ? [['all','Not applicable']] : [['all','All human judges'],['Parliamentary Debater','Parliamentary Debaters'],['Non-Parliamentary Debater','Non-Parliamentary Debaters']]} /><Select label="Topic" value={values.category} onChange={v => change('category',v)} options={categoryOptions} /><Select label="Task" value={values.task} onChange={v => change('task',v)} options={taskOptions} /><Select label="Ranking metric" value={values.metric} onChange={v => change('metric',v)} options={metricOptions} />{values.source !== 'human' && <Select label="AI judge" value={values.judge || 'all'} onChange={v => change('judge',v)} options={[['all','All AI judges'],...(judges.data || []).map(j => [j.id,j.display_name] as [string,string])]} />}</div>
    <div className="results-title"><h2>{metricOptions.find(([v]) => v === values.metric)?.[1]}</h2><span className="mono">{rank.data?.comparisons.toLocaleString() ?? '—'} comparisons</span></div>
    {values.metric === 'weighted' && <p className="notice">Uses backend-configured metric weights. Argument Strength has the greatest weight in Government (45% by default). Skipped metrics contribute no judgment.</p>}
    {values.source === 'combined' && rank.data && <p className="caption">Configured source influence: {(rank.data.source_weights.human * 100).toFixed(0)}% human / {(rank.data.source_weights.ai * 100).toFixed(0)}% AI.{rank.data.missing_source && ` No ${rank.data.missing_source} data in this selection; results use the available source.`}</p>}
    {rank.loading ? <Loading /> : rank.error ? <ErrorState message={rank.error} retry={rank.reload} /> : rank.data && <RankingTable rows={rank.data.rows} />}
    <p className="caption table-caption">Score ranges visualize 95% uncertainty. Win share includes ties and preference strength. Systems with no comparisons are unranked.</p>
    <Methodology />
    {rank.data && rank.data.rows.length > 1 && <section className="compare-picker"><h2>Head to head</h2><div className="filter-row"><Select label="System A" value={compareA} onChange={setCompareA} options={[["","Choose a system"],...rank.data.rows.map(r => [r.id,r.display_name || r.id] as [string,string])]} /><Select label="System B" value={compareB} onChange={setCompareB} options={[["","Choose a system"],...rank.data.rows.filter(r => r.id !== compareA).map(r => [r.id,r.display_name || r.id] as [string,string])]} />{compareA && compareB && compareA !== compareB && <Link className="button dark" to={`/compare/${compareA}/${compareB}`}>Compare <ArrowUpRightIcon /></Link>}</div></section>}
  </div>;
}
