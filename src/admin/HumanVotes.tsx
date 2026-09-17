import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { EmptyState, ErrorState, Loading } from '../components';
import { TASK_LABELS } from '../../shared/domain';
import type { AdminHumanVote, AdminHumanVoteDetail, Page } from '../../shared/admin';
import { adminLink, ConfirmDialog, FilterSelect, fmt, Pager, queryString, Section, SectionHead, useAction, useAdminData, useOptions, useQueryState } from './ui';
import { MetricVotes, Preference, SnapshotPair } from './votes';

const FILTERS = ['system', 'topic', 'task', 'subgroup', 'user', 'offset'] as const;
export default function HumanVotes() {
  const query = useQueryState(), options = useOptions(), action = useAction();
  const filters = Object.fromEntries(FILTERS.map(k => [k, query.get(k)])) as Record<typeof FILTERS[number], string>;
  const votes = useAdminData<Page<AdminHumanVote>>(`/admin/human-votes?${queryString(filters)}`), page = votes.data;
  const open = query.get('vote'), [deleting, setDeleting] = useState<AdminHumanVote | null>(null), [hours, setHours] = useState('24');
  const filter = (key: string, value: string) => query.set({ [key]: value, offset: null, vote: null });
  const judgeName = query.get('username') || page?.rows.find(v => v.user_id === filters.user)?.username;
  return <section>
    <SectionHead title="Human votes" description="Every Arena judgment, with the exact texts each judge saw. Delete spam or invalid ballots; rankings update immediately." />
    <div className="filter-row admin-filters">
      <FilterSelect label="System" value={filters.system} all="All systems" onChange={v => filter('system', v)} options={(options.data?.systems || []).map(s => [s.id, s.display_name])} />
      <FilterSelect label="Topic" value={filters.topic} all="All topics" onChange={v => filter('topic', v)} options={(options.data?.topics || []).map(t => [t.id, t.motion.length > 70 ? `${t.motion.slice(0, 70)}…` : t.motion])} />
      <FilterSelect label="Task" value={filters.task} all="All tasks" onChange={v => filter('task', v)} options={[...Object.entries(TASK_LABELS), ['legacy', 'Legacy tasks']]} />
      <FilterSelect label="Judge type" value={filters.subgroup} all="All judges" onChange={v => filter('subgroup', v)} options={[['Parliamentary Debater', 'Parliamentary Debaters'], ['Non-Parliamentary Debater', 'Non-Parliamentary Debaters']]} />
      {filters.user && <span className="filter-chip">Judge: {judgeName || filters.user}<button className="text-button" onClick={() => query.set({ user: null, username: null, offset: null, vote: null })}>Clear</button></span>}
    </div>
    {action.feedback}
    <Section loading={votes.loading && !page} error={page ? '' : votes.error} retry={votes.reload}>{page && (page.rows.length ? <>
      <div className="table-scroll"><table className="admin-table">
        <thead><tr><th scope="col">Updated</th><th scope="col">Judge</th><th scope="col">Motion</th><th scope="col">Pair (A vs B)</th><th scope="col">Overall</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{page.rows.map(v => <Fragment key={v.id}>
          <tr className={open === v.id ? 'selected' : ''}>
            <td className="nowrap">{fmt.date(v.updated_at)}{v.revision > 1 && <small className="cell-note">Edited {v.revision - 1}×</small>}</td>
            <td><button className="link-button" onClick={() => query.set({ user: v.user_id, username: v.username, offset: null, vote: null })}>{v.username}</button><small className="cell-note">{v.user_type}</small></td>
            <td className="clamp" title={v.motion}>{v.motion}<small className="cell-note">{fmt.task(v.task)}</small></td>
            <td>{v.system_low}<small className="cell-note">vs {v.system_high}</small></td>
            <td><Preference value={v.overall} a="A" b="B" /><small className="cell-note">{Object.keys(JSON.parse(v.metrics)).length} metric votes</small></td>
            <td className="row-actions"><button className="button small" aria-expanded={open === v.id} onClick={() => query.set({ vote: open === v.id ? null : v.id })}>{open === v.id ? 'Close' : 'Inspect'}</button>
              <button className="button small danger" onClick={() => setDeleting(v)}>Delete</button></td>
          </tr>
          {open === v.id && <tr className="row-detail"><td colSpan={6}><HumanVoteDetail id={v.id} /></td></tr>}
        </Fragment>)}</tbody>
      </table></div>
      <Pager page={page} onChange={offset => query.set({ offset, vote: null })} />
    </> : <EmptyState title="No human votes match">Votes appear here as judges use the Arena.</EmptyState>)}</Section>
    <div className="tool-panel maintenance">
      <h3>Abandoned assignments</h3>
      <p className="caption">Each Arena request reserves a matchup for that judge. Clearing old, unvoted reservations returns those pairs to matchmaking{filters.user ? ` for ${judgeName || 'this judge'} only` : ''}. Votes are never affected.</p>
      <div className="filter-row"><label className="select-field"><span>Older than (hours)</span><input type="number" min={1} max={8760} value={hours} onChange={e => setHours(e.target.value)} /></label>
        <button className="button" disabled={action.busy || !(Number(hours) >= 1)} onClick={() => void action.run(() => api<{ cleared: number }>('/admin/assignments/cleanup', { method: 'POST', body: JSON.stringify({ older_than_hours: Math.round(Number(hours)), user_id: filters.user || null }) }), r => `Cleared ${r.cleared} unvoted assignment${r.cleared === 1 ? '' : 's'}.`)}>Clear unvoted assignments</button></div>
    </div>
    {deleting && <ConfirmDialog title="Delete this judgment?" confirmLabel="Delete judgment" danger onClose={() => setDeleting(null)}
      onConfirm={async () => { await api(`/admin/human-votes/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' }); if (open === deleting.id) query.set({ vote: null }); votes.reload(); }}>
      <p>{deleting.username} · {deleting.motion}</p>
      <p className="caption">Removes the vote, its metric votes and edit history, and the assignment, so the judge may be offered this pair again. Recorded in the audit log.</p>
    </ConfirmDialog>}
  </section>;
}

function HumanVoteDetail({ id }: { id: string }) {
  const detail = useAdminData<AdminHumanVoteDetail>(`/admin/human-votes/${encodeURIComponent(id)}`), v = detail.data;
  if (!v) return detail.error ? <ErrorState message={detail.error} /> : <Loading />;
  return <div className="vote-detail">
    <dl className="run-facts">
      <div><dt>Judge</dt><dd><Link to={adminLink('accounts', { q: v.username })}>{v.username}</Link></dd></div>
      <div><dt>Issued</dt><dd>{fmt.date(v.issued_at)}</dd></div>
      <div><dt>Shown as</dt><dd>{v.swapped ? `${v.system_high} left, ${v.system_low} right` : `${v.system_low} left, ${v.system_high} right`}</dd></div>
      <div><dt>Overall</dt><dd><Preference value={v.overall} a={v.system_low} b={v.system_high} /></dd></div>
    </dl>
    <MetricVotes json={v.metrics} a={v.system_low} b={v.system_high} />
    <div className="row-actions"><Link className="button small" to={adminLink('responses', { response: v.response_low })}>Response A</Link><Link className="button small" to={adminLink('responses', { response: v.response_high })}>Response B</Link></div>
    <SnapshotPair a={v.snapshot_low} b={v.snapshot_high} labelA={`A · ${v.system_low}`} labelB={`B · ${v.system_high}`} context={v.context_snapshot} />
  </div>;
}
