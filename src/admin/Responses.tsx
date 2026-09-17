import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { EmptyState } from '../components';
import { TASK_LABELS } from '../../shared/domain';
import type { AdminResponseRow, Page } from '../../shared/admin';
import ResponseDetailView from './ResponseDetail';
import { ConfirmDialog, FilterSelect, fmt, Pager, queryString, SearchField, Section, SectionHead, useAction, useAdminData, useOptions, useQueryState } from './ui';

const FILTERS = ['system', 'topic', 'task', 'active', 'extraction', 'frozen', 'q', 'sort', 'offset'] as const;
type Bulk = 'activate' | 'deactivate' | 'retry_extraction' | 'delete';

export default function Responses() {
  const query = useQueryState(), selected = query.get('response');
  if (selected) return <ResponseDetailView key={selected} id={selected} onBack={() => query.set({ response: null }, true)} />;
  return <ResponseList />;
}

function ResponseList() {
  const query = useQueryState(), options = useOptions();
  const filters = Object.fromEntries(FILTERS.map(k => [k, query.get(k)])) as Record<typeof FILTERS[number], string>;
  const list = useAdminData<Page<AdminResponseRow>>(`/admin/responses?${queryString(filters)}`);
  const [selection, setSelection] = useState<Set<string>>(new Set()), [bulk, setBulk] = useState<Bulk | null>(null);
  const action = useAction(), page = list.data;
  const filter = (key: string, value: string) => { query.set({ [key]: value, offset: null }); setSelection(new Set()); };
  useEffect(() => setSelection(new Set()), [filters.offset]);
  const detailHref = (id: string) => `/admin?${new URLSearchParams([...query.params.entries(), ['response', id]])}`;
  const allOnPage = !!page?.rows.length && page.rows.every(r => selection.has(r.id));
  const toggle = (id: string) => setSelection(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const runBulk = async (kind: Bulk, reason = '') => {
    const result = await api<{ affected: number; queued?: boolean }>('/admin/responses/bulk', { method: 'POST', body: JSON.stringify({ ids: [...selection], action: kind, reason }) });
    setSelection(new Set()); list.reload();
    return `${result.affected} response${result.affected === 1 ? '' : 's'} ${{ activate: 'activated', deactivate: 'deactivated', retry_extraction: result.queued ? 'queued for extraction' : 'reprocessed', delete: 'deleted' }[kind]}.`;
  };
  const bulkButton = (kind: Exclude<Bulk, 'delete'>, label: string) => <button className="button small" disabled={action.busy} onClick={() => void action.run(() => runBulk(kind), message => message)}>{label}</button>;
  return <section>
    <SectionHead title="Responses" description="Every recorded model output. Open one to edit its display text, correct its record, fix its structured case, review its history, or delete it." />
    <div className="filter-row admin-filters">
      <SearchField label="Search" value={filters.q} onSearch={v => filter('q', v)} placeholder="ID, motion, or output text" />
      <FilterSelect label="System" value={filters.system} all="All systems" onChange={v => filter('system', v)} options={(options.data?.systems || []).map(s => [s.id, `${s.display_name}${s.active ? '' : ' (inactive)'}`])} />
      <FilterSelect label="Topic" value={filters.topic} all="All topics" onChange={v => filter('topic', v)} options={(options.data?.topics || []).map(t => [t.id, t.motion.length > 70 ? `${t.motion.slice(0, 70)}…` : t.motion])} />
      <FilterSelect label="Task" value={filters.task} all="All tasks" onChange={v => filter('task', v)} options={[...Object.entries(TASK_LABELS), ['legacy', 'Legacy tasks']]} />
      <FilterSelect label="Status" value={filters.active} all="Active and inactive" onChange={v => filter('active', v)} options={[['1', 'Active only'], ['0', 'Inactive only']]} />
      <FilterSelect label="Extraction" value={filters.extraction} all="Any extraction" onChange={v => filter('extraction', v)} options={[['ready', 'Structured'], ['failed', 'Failed'], ['missing', 'Never extracted']]} />
      <FilterSelect label="Rebuttal Pool" value={filters.frozen} all="Any" onChange={v => filter('frozen', v)} options={[['1', 'Frozen sources']]} />
      <FilterSelect label="Sort" value={filters.sort} all="Newest first" onChange={v => filter('sort', v)} options={[['oldest', 'Oldest first'], ['system', 'System'], ['topic', 'Motion'], ['votes', 'Most human votes'], ['longest', 'Longest output']]} />
    </div>
    {action.feedback}
    <Section loading={list.loading && !page} error={page ? '' : list.error} retry={list.reload}>{page && (page.rows.length ? <>
      <div className={`table-toolbar ${selection.size ? 'selecting' : ''}`}>
        {selection.size ? <><strong>{selection.size} selected</strong><span className="row-actions">
          {bulkButton('activate', 'Activate')}{bulkButton('deactivate', 'Deactivate')}{bulkButton('retry_extraction', 'Retry extraction')}
          <button className="button small danger" onClick={() => setBulk('delete')} disabled={action.busy}>Delete…</button>
          <button className="text-button" onClick={() => setSelection(new Set())}>Clear</button>
        </span></> : <span className="muted">Select rows for bulk actions.</span>}
        {list.loading && <span className="caption">Refreshing…</span>}
      </div>
      <div className="table-scroll attached"><table className="admin-table">
        <thead><tr>
          <th scope="col" className="check-cell"><input type="checkbox" aria-label="Select every response on this page" checked={allOnPage} onChange={() => setSelection(allOnPage ? new Set() : new Set(page.rows.map(r => r.id)))} /></th>
          <th scope="col">Response</th><th scope="col">Motion</th><th scope="col">Task</th><th scope="col">State</th><th scope="col" className="num">Human / AI votes</th><th scope="col">Generated</th>
        </tr></thead>
        <tbody>{page.rows.map(r => <tr key={r.id} className={selection.has(r.id) ? 'selected' : ''}>
          <td className="check-cell"><input type="checkbox" aria-label={`Select ${r.id}`} checked={selection.has(r.id)} onChange={() => toggle(r.id)} /></td>
          <td><Link className="row-title" to={detailHref(r.id)}>{r.system_name}</Link><code className="cell-note">{r.id}</code></td>
          <td className="clamp" title={r.motion}>{r.motion}</td>
          <td className="nowrap">{fmt.task(r.task)}<small className="cell-note">Sample {r.sample} · {fmt.chars(r.raw_length)}</small></td>
          <td><span className="badge-row">
            {!r.active && <span className="badge alert">Inactive</span>}
            {!!r.frozen && <span className="badge ink">Frozen source</span>}
            {!!r.legacy && <span className="badge">Legacy</span>}
            {['government', 'opposition'].includes(r.task) && (r.extraction_status === 'failed' ? <span className="badge alert">Extraction failed</span> : !r.extraction_status ? <span className="badge alert">Not extracted</span> : null)}
            {r.provenance_revision > 1 && <span className="badge">Corrected ×{r.provenance_revision - 1}</span>}
            {r.display_version > 1 && <span className="badge">Display v{r.display_version}</span>}
          </span></td>
          <td className="num mono">{r.human_votes} / {r.ai_votes}</td>
          <td className="nowrap">{fmt.day(r.generated_at)}</td>
        </tr>)}</tbody>
      </table></div>
      <Pager page={page} onChange={offset => query.set({ offset })} />
    </> : <EmptyState title="No responses match">Change the filters, or record runs from Next Run.</EmptyState>)}</Section>
    {bulk === 'delete' && <ConfirmDialog title={`Delete ${selection.size} response${selection.size === 1 ? '' : 's'}?`} confirmLabel="Delete permanently" danger reason typeToConfirm onClose={() => setBulk(null)} onConfirm={async reason => action.setNotice(await runBulk('delete', reason))}>
      <p>Each response is removed with its matchups, the human and AI votes cast on them, structured cases, revision history, and run records. Rebuttals built on a deleted source case are deleted too.</p>
      <p className="caption">Rankings recalculate immediately. The audit log records every deleted ID. To hide a response without losing votes, deactivate it instead.</p>
    </ConfirmDialog>}
  </section>;
}
