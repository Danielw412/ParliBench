import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { EmptyState, ErrorState, Loading } from '../components';
import { TASK_LABELS } from '../../shared/domain';
import type { AdminAiVote, AdminAiVoteDetail, AdminJudge, Page } from '../../shared/admin';
import { adminLink, ConfirmDialog, DeleteButton, FilterSelect, fmt, Pager, queryString, Section, SectionHead, useAction, useAdminData, useOptions, useQueryState } from './ui';
import { MetricVotes, Preference, SnapshotPair } from './votes';

const FILTERS = ['judge', 'system', 'topic', 'task', 'offset'] as const;
export default function AiJudges() {
  const query = useQueryState(), options = useOptions(), judges = useAdminData<AdminJudge[]>('/admin/judges'), action = useAction();
  const filters = Object.fromEntries(FILTERS.map(k => [k, query.get(k)])) as Record<typeof FILTERS[number], string>;
  const votes = useAdminData<Page<AdminAiVote>>(`/admin/ai-votes?${queryString(filters)}`), page = votes.data;
  const [editing, setEditing] = useState(''), [deleting, setDeleting] = useState<AdminAiVote | null>(null), open = query.get('vote');
  const filter = (key: string, value: string) => query.set({ [key]: value, offset: null, vote: null });
  const refresh = () => { judges.reload(); votes.reload(); };
  return <section>
    <SectionHead title="AI judges & votes" description={<>Offline AI adjudicators and their imported judgments. Rankings use each judge’s latest version per pair. Add judges and votes through <Link className="inline-link" to={adminLink('manual')}>Manual entry</Link> or <Link className="inline-link" to={adminLink('import')}>JSON import</Link>.</>} />
    {action.feedback}
    <Section loading={judges.loading && !judges.data} error={judges.data ? '' : judges.error} retry={judges.reload}>{judges.data && (judges.data.length ? <div className="table-scroll"><table className="admin-table">
      <thead><tr><th scope="col">Judge</th><th scope="col">Backing system</th><th scope="col">Version</th><th scope="col" className="num">Votes</th><th scope="col">Latest judgment</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{judges.data.map(j => <Fragment key={j.id}>
        <tr className={editing === j.id ? 'selected' : ''}>
          <td><span className="row-title">{j.display_name}</span><code className="cell-note">{j.id}</code></td>
          <td><Link to={adminLink('systems', { system: j.system_id })}>{j.system_name}</Link></td>
          <td className="mono">{j.version}</td><td className="num mono">{fmt.n(j.votes)}</td><td className="nowrap">{fmt.day(j.latest_judged_at)}</td>
          <td className="row-actions"><button className="button small" onClick={() => filter('judge', j.id)}>Votes</button><button className="button small" aria-expanded={editing === j.id} onClick={() => setEditing(editing === j.id ? '' : j.id)}>{editing === j.id ? 'Close' : 'Edit'}</button></td>
        </tr>
        {editing === j.id && <tr className="row-detail"><td colSpan={6}><JudgeForm judge={j} systems={options.data?.systems || []} busy={action.busy}
          onSave={value => void action.run(async () => { await api(`/admin/judges/${encodeURIComponent(j.id)}`, { method: 'PUT', body: JSON.stringify(value) }); setEditing(''); refresh(); }, 'AI judge saved.')}
          remove={<DeleteButton kind="judge" id={j.id} label="Delete judge and votes…" onDeleted={() => { setEditing(''); if (filters.judge === j.id) filter('judge', ''); refresh(); }} />} /></td></tr>}
      </Fragment>)}</tbody>
    </table></div> : <EmptyState title="No AI judges yet">Import AI judges and their judgments to add a second ranking source.</EmptyState>)}</Section>
    <h3 className="subsection-title">AI judgments</h3>
    <div className="filter-row admin-filters">
      <FilterSelect label="Judge" value={filters.judge} all="All judges" onChange={v => filter('judge', v)} options={(judges.data || []).map(j => [j.id, j.display_name])} />
      <FilterSelect label="System" value={filters.system} all="All systems" onChange={v => filter('system', v)} options={(options.data?.systems || []).map(s => [s.id, s.display_name])} />
      <FilterSelect label="Topic" value={filters.topic} all="All topics" onChange={v => filter('topic', v)} options={(options.data?.topics || []).map(t => [t.id, t.motion.length > 70 ? `${t.motion.slice(0, 70)}…` : t.motion])} />
      <FilterSelect label="Task" value={filters.task} all="All tasks" onChange={v => filter('task', v)} options={[...Object.entries(TASK_LABELS), ['legacy', 'Legacy tasks']]} />
    </div>
    <Section loading={votes.loading && !page} error={page ? '' : votes.error} retry={votes.reload}>{page && (page.rows.length ? <>
      <div className="table-scroll"><table className="admin-table">
        <thead><tr><th scope="col">Judged</th><th scope="col">Judge</th><th scope="col">Motion</th><th scope="col">Pair (A vs B)</th><th scope="col">Overall</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{page.rows.map(v => <Fragment key={v.id}>
          <tr className={open === v.id ? 'selected' : ''}>
            <td className="nowrap">{fmt.date(v.judged_at)}<small className="cell-note mono">{v.version}</small></td>
            <td>{v.judge_name}</td>
            <td className="clamp" title={v.motion}>{v.motion}<small className="cell-note">{fmt.task(v.task)}</small></td>
            <td>{v.system_low}<small className="cell-note">vs {v.system_high}</small></td>
            <td><Preference value={v.overall} a="A" b="B" />{!!v.has_explanation && <small className="cell-note">Has explanation</small>}</td>
            <td className="row-actions"><button className="button small" aria-expanded={open === v.id} onClick={() => query.set({ vote: open === v.id ? null : v.id })}>{open === v.id ? 'Close' : 'Inspect'}</button>
              <button className="button small danger" onClick={() => setDeleting(v)}>Delete</button></td>
          </tr>
          {open === v.id && <tr className="row-detail"><td colSpan={6}><AiVoteDetail id={v.id} /></td></tr>}
        </Fragment>)}</tbody>
      </table></div>
      <Pager page={page} onChange={offset => query.set({ offset, vote: null })} />
    </> : <EmptyState title="No AI judgments match">Change the filters, or import AI judgments.</EmptyState>)}</Section>
    {deleting && <ConfirmDialog title="Delete this AI judgment?" confirmLabel="Delete judgment" danger onClose={() => setDeleting(null)}
      onConfirm={async () => { await api(`/admin/ai-votes/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' }); refresh(); }}>
      <p>{deleting.judge_name} · {deleting.version} · {deleting.motion}</p>
      <p className="caption">If this judge has an older version for the same pair, rankings fall back to that version.</p>
    </ConfirmDialog>}
  </section>;
}

function JudgeForm({ judge, systems, busy, onSave, remove }: { judge: AdminJudge; systems: { id: string; display_name: string }[]; busy: boolean; onSave: (value: { display_name: string; version: string; system_id: string }) => void; remove: ReactNode }) {
  const [value, setValue] = useState({ display_name: judge.display_name, version: judge.version, system_id: judge.system_id });
  return <form className="admin-form" onSubmit={e => { e.preventDefault(); onSave(value); }}>
    <label>Display name<input value={value.display_name} onChange={e => setValue(v => ({ ...v, display_name: e.target.value }))} required /></label>
    <label>Version<input value={value.version} onChange={e => setValue(v => ({ ...v, version: e.target.value }))} required /></label>
    <label>Backing system<select value={value.system_id} onChange={e => setValue(v => ({ ...v, system_id: e.target.value }))}>{systems.map(s => <option key={s.id} value={s.id}>{s.display_name}</option>)}</select></label>
    <div className="wide row-actions"><button className="button dark" disabled={busy}>Save judge</button>{remove}</div>
  </form>;
}

function AiVoteDetail({ id }: { id: string }) {
  const detail = useAdminData<AdminAiVoteDetail>(`/admin/ai-votes/${encodeURIComponent(id)}`), v = detail.data;
  if (!v) return detail.error ? <ErrorState message={detail.error} /> : <Loading />;
  return <div className="vote-detail">
    <dl className="run-facts"><div><dt>Judge</dt><dd>{v.judge_name}</dd></div><div><dt>Version</dt><dd>{v.version}</dd></div><div><dt>Overall</dt><dd><Preference value={v.overall} a={v.system_low} b={v.system_high} /></dd></div><div><dt>Vote ID</dt><dd><code>{v.id}</code></dd></div></dl>
    <MetricVotes json={v.metrics} a={v.system_low} b={v.system_high} />
    {v.explanation && <details className="run-detail" open><summary>Explanation</summary><pre>{v.explanation}</pre></details>}
    <div className="row-actions"><Link className="button small" to={adminLink('responses', { response: v.response_low })}>Response A</Link><Link className="button small" to={adminLink('responses', { response: v.response_high })}>Response B</Link></div>
    <SnapshotPair a={v.snapshot_low} b={v.snapshot_high} labelA={`A · ${v.system_low}`} labelB={`B · ${v.system_high}`} />
  </div>;
}
