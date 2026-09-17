import { ResponseText } from '../components';
import { METRIC_LABELS, type Metric } from '../../shared/domain';

// Stored votes are canonical: positive favours the lower response ID ("A"), negative the higher ("B").
export function Preference({ value, a, b }: { value: number; a: string; b: string }) {
  if (!value) return <span>Tie</span>;
  return <span><strong>{value > 0 ? a : b}</strong> {Math.abs(value) === 2 ? 'much better' : 'better'}</span>;
}
export function MetricVotes({ json, a, b }: { json: string; a: string; b: string }) {
  const metrics = Object.entries(JSON.parse(json || '{}') as Record<string, number>);
  if (!metrics.length) return <p className="caption">No metric votes; every metric was skipped.</p>;
  return <dl className="impact-list">{metrics.map(([metric, value]) => <div key={metric}><dt>{METRIC_LABELS[metric as Metric] || metric}</dt><dd><Preference value={value} a={a} b={b} /></dd></div>)}</dl>;
}
export function SnapshotPair({ a, b, labelA, labelB, context }: { a: string; b: string; labelA: string; labelB: string; context?: string | null }) {
  return <>
    {context && <details className="run-detail"><summary>Shared Government case shown to the judge</summary><ResponseText text={context} /></details>}
    <div className="snapshot-pair">{[[labelA, a], [labelB, b]].map(([label, text]) => <div className="snapshot" key={label}><h4>{label}</h4><div className="snapshot-scroll"><ResponseText text={text} /></div></div>)}</div>
  </>;
}
