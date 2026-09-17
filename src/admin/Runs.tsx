import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { EmptyState } from '../components';
import { TASK_LABELS, type SystemInfo } from '../../shared/domain';
import type { Page, RunHistoryRow } from '../../shared/admin';
import { adminLink, ConfirmDialog, FilterSelect, fmt, Pager, queryString, Section, SectionHead, useAdminData, useQueryState } from './ui';

export default function Runs() {
  const query = useQueryState(), filters = { status: query.get('status'), system: query.get('system'), task: query.get('task'), offset: query.get('offset') };
  const runs = useAdminData<Page<RunHistoryRow>>(`/admin/runs?${queryString(filters)}`), systems = useAdminData<SystemInfo[]>('/systems');
  const [confirm, setConfirm] = useState<{ run: RunHistoryRow; release: boolean } | null>(null);
  const page = runs.data;
  return <section>
    <SectionHead title="Run history" description="Every run started from Next Run: in progress, recorded, or released. Deleting a finished record frees nothing else; the recorded response stays." />
    <div className="filter-row admin-filters">
      <FilterSelect label="Status" value={filters.status} all="All statuses" onChange={v => query.set({ status: v, offset: null })} options={[['open', 'In progress'], ['filled', 'Recorded'], ['released', 'Released']]} />
      <FilterSelect label="System" value={filters.system} all="All systems" onChange={v => query.set({ system: v, offset: null })} options={(systems.data || []).map(s => [s.id, s.display_name])} />
      <FilterSelect label="Task" value={filters.task} all="All tasks" onChange={v => query.set({ task: v, offset: null })} options={Object.entries(TASK_LABELS)} />
    </div>
    <Section loading={runs.loading && !page} error={page ? '' : runs.error} retry={runs.reload}>{page && (page.rows.length ? <>
      <div className="table-scroll"><table className="admin-table">
        <thead><tr><th scope="col">Started</th><th scope="col">System</th><th scope="col">Motion</th><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Prompt</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{page.rows.map(run => <tr key={run.id}>
          <td className="nowrap">{fmt.date(run.claimed_at)}</td>
          <td><Link to={adminLink('systems', { system: run.system_id })}>{run.system_name}</Link></td>
          <td className="clamp">{run.motion}</td>
          <td className="nowrap">{fmt.task(run.task)} · {run.sample}</td>
          <td className="nowrap">{run.status === 'open' ? <span className="badge ink">In progress</span> : run.status === 'filled' ? <span className="badge">Recorded</span> : <span className="badge alert">Released</span>}{run.resolved_at && <small className="cell-note">{fmt.ago(run.resolved_at)}</small>}</td>
          <td className="mono">{run.prompt_version ? `v${run.prompt_version}` : '—'}</td>
          <td className="row-actions">
            {run.response_id && <Link className="button small" to={adminLink('responses', { response: run.response_id })}>Response</Link>}
            {run.status === 'open' ? <button className="button small" onClick={() => setConfirm({ run, release: true })}>Release</button> : <button className="button small danger" onClick={() => setConfirm({ run, release: false })}>Delete record</button>}
          </td>
        </tr>)}</tbody>
      </table></div>
      <Pager page={page} onChange={offset => query.set({ offset })} />
    </> : <EmptyState title="No runs match">Start a run from Next Run, or change the filters.</EmptyState>)}</Section>
    {confirm && <ConfirmDialog title={confirm.release ? 'Release this run?' : 'Delete this run record?'} confirmLabel={confirm.release ? 'Release run' : 'Delete record'} danger={!confirm.release} onClose={() => setConfirm(null)}
      onConfirm={async () => { await api(confirm.release ? `/admin/runs/${confirm.run.id}/release` : `/admin/runs/${confirm.run.id}`, { method: confirm.release ? 'POST' : 'DELETE' }); runs.reload(); }}>
      <p>{confirm.run.system_name} · {fmt.task(confirm.run.task)} · sample {confirm.run.sample}</p>
      <p className="caption">{confirm.release ? 'The slot returns to the queue and can be recommended again.' : 'Only the run record is removed. Any recorded response remains, with its prompt snapshot.'}</p>
    </ConfirmDialog>}
  </section>;
}
