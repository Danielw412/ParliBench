import { Link } from 'react-router-dom';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import type { ReactNode } from 'react';
import { METRIC_LABELS, TASK_LABELS, VOTE_OPTIONS, type RankingRow, type VoteValue } from '../shared/domain';

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{action}</div>;
}
export function Loading() { return <div className="empty-state" role="status"><CircleNotchIcon className="spin" size={22} /><p>Loading…</p></div>; }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className="notice error" role="alert"><InfoIcon size={20} /><span>{message}</span>{retry && <button className="button small" onClick={retry}><ArrowClockwiseIcon /> Retry</button>}</div>; }
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty-state"><h3>{title}</h3><p>{children}</p></div>; }
export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}>{options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select></label>;
}
export const categoryOptions: [string, string][] = [['all', 'All topics'], ['Serious', 'Serious'], ['Informal', 'Informal']];
export const taskOptions: [string, string][] = [['all', 'All tasks'], ['government', 'Government'], ['opposition', 'Opposition (all)'], ['prediction', 'Opposition Prediction'], ['standardized_rebuttal', 'Standardized Rebuttal'], ['full_opposition', 'Full Opposition Prep']];
export const metricOptions: [string, string][] = [['overall', 'Overall Preference'], ['weighted', 'Weighted Benchmark'], ...Object.entries(METRIC_LABELS)];
// Sparse or disconnected data is flagged; established estimates need no label.
export function Confidence({ row }: { row: RankingRow }) { return row.low_confidence ? <span className="confidence">Low confidence</span> : null; }
export function ScoreInterval({ row }: { row: RankingRow }) {
  return <div className="score-cell"><strong>{row.score.toFixed(1)}</strong><div className="interval-track" title={`95% interval: ${row.ci[0].toFixed(1)}–${row.ci[1].toFixed(1)}`}><span className="interval-range" style={{ left: `${row.ci[0]}%`, width: `${row.ci[1] - row.ci[0]}%` }} /><span className="interval-point" style={{ left: `${row.score}%` }} /></div></div>;
}
export function RankingTable({ rows, compact = false }: { rows: RankingRow[]; compact?: boolean }) {
  if (!rows.length) return <EmptyState title="No systems yet">Import a benchmark dataset to begin.</EmptyState>;
  return <div className="table-scroll"><table className={`ranking-table ${compact ? 'compact' : ''}`}><thead><tr><th scope="col">Rank</th><th scope="col">System / configuration</th><th scope="col">Score <span className="muted">/ 100</span></th>{!compact && <><th scope="col">Rating</th><th scope="col">Win share</th></>}<th scope="col">Comparisons</th>{!compact && <th scope="col">95% interval</th>}</tr></thead><tbody>{rows.map((row, i) => <tr key={row.id}><td className="rank">{row.comparisons ? String(i + 1).padStart(2, '0') : '—'}</td><td><Link className="system-link" to={`/systems/${row.id}`}>{row.display_name || row.id}<ArrowRightIcon size={14} /></Link><span className="system-provider">{row.provider}</span></td><td><ScoreInterval row={row} /></td>{!compact && <><td className="mono">{Math.round(row.rating)}</td><td className="mono">{row.comparisons ? `${(row.win_rate * 100).toFixed(1)}%` : '—'}</td></>}<td className="mono">{row.comparisons.toLocaleString()}</td>{!compact && <td><span className="mono ci-text">{row.ci[0].toFixed(1)}–{row.ci[1].toFixed(1)}</span><Confidence row={row} /></td>}</tr>)}</tbody></table></div>;
}
export function VoteScale({ name, value, onChange, skip = false, disabled = false }: { name: string; value: VoteValue | null; onChange: (v: VoteValue | null) => void; skip?: boolean; disabled?: boolean }) {
  return <div className={`vote-scale ${skip ? 'with-skip' : ''}`} role="radiogroup" aria-label={name}>
    {VOTE_OPTIONS.map(option => <label key={option.value} className={`vote-choice ${value === option.value ? 'selected' : ''}`} title={option.label}><input type="radio" name={name} aria-label={option.label} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} disabled={disabled} /><span className="full-label">{option.label}</span><span className="short-label">{option.short}</span></label>)}
    {skip && <label className={`vote-choice skip ${value === null ? 'selected' : ''}`}><input type="radio" name={name} checked={value === null} onChange={() => onChange(null)} disabled={disabled} /><span>Skip</span></label>}
  </div>;
}
// Render only text and a small, safe Markdown subset. No HTML, clickable citations, or images.
export function ResponseText({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
  return <div className="response-text">{text.split(/\n\s*\n/).map((block, i) => {
    if (/^#{1,4}\s/.test(block)) return <h3 key={i}>{block.replace(/^#{1,4}\s/, '')}</h3>;
    if (/^[-*]\s/m.test(block)) return <ul key={i}>{block.split('\n').map((line, j) => <li key={j}>{inline(line.replace(/^[-*]\s/, ''))}</li>)}</ul>;
    return <p key={i}>{inline(block)}</p>;
  })}</div>;
}
export function TaskBadge({ task }: { task: string }) { return <span className="badge">{TASK_LABELS[task as keyof typeof TASK_LABELS] || task}</span>; }
