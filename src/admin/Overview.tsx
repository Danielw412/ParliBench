import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { api } from '../api';
import { TASK_LABELS } from '../../shared/domain';
import type { AdminOverview } from '../../shared/admin';
import { adminLink, ConfirmDialog, fmt, Section, SectionHead, Stat, useAdminData } from './ui';

export default function Overview() {
  const overview = useAdminData<AdminOverview>('/admin/overview'), o = overview.data;
  return <section>
    <SectionHead title="Overview" description="Corpus size, judging activity, coverage, and anything that needs attention." actions={<button className="text-button" disabled={overview.loading} onClick={overview.reload}><ArrowClockwiseIcon size={15} /> Refresh</button>} />
    <Section loading={overview.loading && !o} error={o ? '' : overview.error} retry={overview.reload}>{o && <>
      <div className="stat-grid">
        <Stat label="Responses" value={fmt.n(o.totals.responses)} note={`${fmt.n(o.totals.active_responses)} active · ${fmt.n(o.totals.matchups)} matchups`} />
        <Stat label="Human votes" value={fmt.n(o.totals.human_votes)} note={`${fmt.n(o.totals.human_votes_7d)} in the last 7 days`} />
        <Stat label="AI votes" value={fmt.n(o.totals.ai_votes)} note={`${o.totals.ai_judges} AI judges`} />
        <Stat label="Active systems" value={o.totals.active_systems} note={`${o.totals.systems} total`} />
        <Stat label="Active topics" value={o.totals.active_topics} note={`${o.totals.topics} total`} />
        <Stat label="Accounts" value={fmt.n(o.totals.users)} note={`${o.totals.users_7d} new this week · ${o.totals.admins} admin${o.totals.admins === 1 ? '' : 's'}`} />
      </div>
      <div className="overview-columns">
        <Attention overview={o} reload={overview.reload} />
        <div><h3>Responses by task</h3><TaskBars rows={o.responses_by_task} /></div>
      </div>
      <Coverage coverage={o.coverage} />
      <div className="overview-columns three">
        <div><h3>Latest responses</h3><ul className="activity-list">{o.recent_responses.map(r => <li key={r.id}><Link to={adminLink('responses', { response: r.id })}><strong>{r.system_name}</strong> · {fmt.task(r.task)} · sample {r.sample}</Link><span>{r.motion}</span></li>)}</ul>{!o.recent_responses.length && <p className="caption">No responses yet.</p>}</div>
        <div><h3>Latest human votes</h3><ul className="activity-list">{o.recent_votes.map(v => <li key={v.id}><Link to={adminLink('human-votes', { vote: v.id })}><strong>{v.username}</strong> · {fmt.task(v.task)}</Link><span>{fmt.ago(v.updated_at)} · {v.motion}</span></li>)}</ul>{!o.recent_votes.length && <p className="caption">No human votes yet.</p>}</div>
        <div><h3>Recent admin changes</h3><ul className="activity-list">{o.audit.map(a => <li key={a.id}><Link to={adminLink('audit')}>{a.summary}</Link><span>{a.actor_username} · {fmt.ago(a.created_at)}</span></li>)}</ul>{!o.audit.length && <p className="caption">No recorded changes yet.</p>}</div>
      </div>
      <p className="caption">Environment: {o.configuration.environment}</p>
    </>}</Section>
  </section>;
}

function Attention({ overview: { totals: t, configuration: c }, reload }: { overview: AdminOverview; reload: () => void }) {
  const [clearing, setClearing] = useState(false);
  const items: { tone: 'warn' | 'info'; text: string; action: ReactNode }[] = [];
  const go = (section: string, label: string, extra: Record<string, string> = {}) => <Link className="inline-link" to={adminLink(section, extra)}>{label} <ArrowRightIcon size={13} /></Link>;
  if (t.extraction_failed) items.push({ tone: 'warn', text: `${t.extraction_failed} structured case extraction${t.extraction_failed === 1 ? '' : 's'} failed`, action: go('responses', 'Review', { extraction: 'failed' }) });
  if (t.extraction_missing) items.push({ tone: 'warn', text: `${t.extraction_missing} case${t.extraction_missing === 1 ? ' has' : 's have'} never been extracted`, action: go('responses', 'Review', { extraction: 'missing' }) });
  if (t.open_claims) items.push({ tone: 'info', text: `${t.open_claims} run${t.open_claims === 1 ? '' : 's'} in progress, waiting for a response`, action: go('next', 'Open Next Run') });
  if (t.stale_assignments) items.push({ tone: 'info', text: `${t.stale_assignments} Arena assignment${t.stale_assignments === 1 ? '' : 's'} abandoned for over 24 hours hold matchups back`, action: <button className="text-button" onClick={() => setClearing(true)}>Clear</button> });
  if (!c.rebuttal_prompt) items.push({ tone: 'info', text: 'No Rebuttal prompt is saved, so Rebuttal runs cannot be recommended', action: go('prompts', 'Prompts', { task: 'rebuttal' }) });
  if (!t.pool_sources) items.push({ tone: 'info', text: 'The Rebuttal Pool has no frozen Government sources', action: go('pool', 'Rebuttal Pool') });
  if (t.systems > t.active_systems) items.push({ tone: 'info', text: `${t.systems - t.active_systems} system${t.systems - t.active_systems === 1 ? ' is' : 's are'} inactive and excluded from new runs and matchups`, action: go('systems', 'Systems') });
  if (!c.gemini) items.push({ tone: 'info', text: 'Gemini extraction is not configured; only the heading parser runs', action: null });
  return <div><h3>Needs attention</h3>
    {items.length ? <ul className="attention-list">{items.map(item => <li key={item.text}>{item.tone === 'warn' ? <WarningIcon size={17} aria-label="Warning" /> : <InfoIcon size={17} aria-label="Note" />}<span>{item.text}</span>{item.action}</li>)}</ul>
      : <p className="notice"><CheckIcon /> Nothing needs attention.</p>}
    {clearing && <ConfirmDialog title="Clear abandoned assignments?" confirmLabel="Clear assignments" onClose={() => setClearing(false)}
      onConfirm={async () => { await api('/admin/assignments/cleanup', { method: 'POST', body: JSON.stringify({ older_than_hours: 24 }) }); reload(); }}>
      <p>Removes {t.stale_assignments} Arena assignments that were issued more than 24 hours ago and never voted on. Their matchups return to matchmaking. Votes are not affected.</p>
    </ConfirmDialog>}
  </div>;
}

function TaskBars({ rows }: { rows: AdminOverview['responses_by_task'] }) {
  const max = Math.max(1, ...rows.map(r => r.responses));
  if (!rows.length) return <p className="caption">No responses yet.</p>;
  return <dl className="bar-list">{rows.map(r => <div key={r.task}>
    <dt>{fmt.task(r.task)}</dt>
    <dd><span className="bar-track"><span className="bar-fill" style={{ width: `${(r.responses / max) * 100}%` }} /></span><span className="mono">{fmt.n(r.responses)}{r.active !== r.responses && <span className="muted"> · {fmt.n(r.active)} active</span>}</span></dd>
  </div>)}</dl>;
}

const TASK_KEYS = ['government', 'opposition', 'rebuttal'] as const;
function Coverage({ coverage }: { coverage: AdminOverview['coverage'] }) {
  const [task, setTask] = useState<'all' | typeof TASK_KEYS[number]>('all');
  const lookup = new Map(coverage.cells.map(c => [`${c.system_id}|${c.topic_id}|${c.task}`, c]));
  const tasks: readonly typeof TASK_KEYS[number][] = task === 'all' ? TASK_KEYS : [task];
  const total = (system: string, topic: string) => tasks.reduce((n, k) => n + (lookup.get(`${system}|${topic}|${k}`)?.active || 0), 0);
  const max = Math.max(1, ...coverage.systems.flatMap(s => coverage.topics.map(t => total(s.id, t.id))));
  if (!coverage.systems.length || !coverage.topics.length) return null;
  return <div className="coverage">
    <div className="section-heading"><h3>Coverage</h3><div className="profile-views" role="group" aria-label="Coverage task">{(['all', ...TASK_KEYS] as const).map(k => <button key={k} className={task === k ? 'active' : ''} aria-pressed={task === k} onClick={() => setTask(k)}>{k === 'all' ? 'All tasks' : TASK_LABELS[k]}</button>)}</div></div>
    <p className="caption">Active responses per system and motion. Darker cells hold more responses; a dash marks a gap. Open a cell to see its responses.</p>
    <div className="table-scroll"><table className="admin-table coverage-table">
      <thead><tr><th scope="col">System</th>{coverage.topics.map(t => <th scope="col" key={t.id} title={t.motion}><span className="coverage-motion">{t.motion}</span>{!t.active && <span className="muted"> · inactive</span>}</th>)}</tr></thead>
      <tbody>{coverage.systems.map(s => <tr key={s.id}>
        <th scope="row"><Link to={adminLink('systems', { system: s.id })}>{s.display_name}</Link>{!s.active && <span className="muted"> · inactive</span>}</th>
        {coverage.topics.map(t => {
          const n = total(s.id, t.id), running = tasks.reduce((sum, k) => sum + (lookup.get(`${s.id}|${t.id}|${k}`)?.open_claims || 0), 0);
          const parts = tasks.map(k => [k, lookup.get(`${s.id}|${t.id}|${k}`)?.active || 0] as const);
          const label = parts.map(([k, v]) => `${TASK_LABELS[k]}: ${v}`).join(', ') + (running ? `, ${running} in progress` : '');
          return <td key={t.id} style={n ? { background: `color-mix(in srgb, var(--accent) ${8 + Math.round((n / max) * 27)}%, var(--panel))` } : undefined}>
            <Link to={adminLink('responses', { system: s.id, topic: t.id, ...(task !== 'all' ? { task } : {}) })} title={`${s.display_name} · ${t.motion} — ${label}`} aria-label={label}>
              {n ? (task === 'all' ? parts.map(([k, v]) => <span key={k} className={v ? '' : 'muted'}><span className="coverage-key">{k[0].toUpperCase()}</span>{v}</span>) : <span>{n}</span>) : <span className="muted">—</span>}
              {running > 0 && <span className="coverage-running">+{running}</span>}
            </Link></td>;
        })}
      </tr>)}</tbody>
    </table></div>
    <p className="caption">G Government · O Opposition · R Rebuttal · +n runs in progress</p>
  </div>;
}
