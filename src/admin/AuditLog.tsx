import { Fragment } from 'react';
import { EmptyState } from '../components';
import type { AuditEntry, Page } from '../../shared/admin';
import { FilterSelect, fmt, Pager, queryString, SearchField, Section, SectionHead, useAdminData, useQueryState } from './ui';

const ENTITIES: [string, string][] = [['response', 'Responses'], ['system', 'Systems'], ['topic', 'Topics'], ['prompt', 'Prompts'], ['rebuttal_pool', 'Rebuttal Pool'], ['run', 'Runs'],
  ['judge', 'AI judges'], ['ai_vote', 'AI votes'], ['human_vote', 'Human votes'], ['assignment', 'Assignments'], ['user', 'Accounts'], ['weights', 'Weights'], ['benchmark', 'Imports & exports']];

export default function AuditLog() {
  const query = useQueryState(), filters = { q: query.get('q'), entity: query.get('entity'), offset: query.get('offset') };
  const log = useAdminData<Page<AuditEntry>>(`/admin/audit?${queryString(filters)}`), page = log.data, open = query.get('entry');
  return <section>
    <SectionHead title="Audit log" description="Every administrator change, with who made it and when. Deletions keep the removed identifiers, and a deleted response keeps its full record." />
    <div className="filter-row admin-filters">
      <SearchField value={filters.q} onSearch={v => query.set({ q: v, offset: null })} placeholder="Summary, administrator, or ID" />
      <FilterSelect label="Area" value={filters.entity} all="Everything" onChange={v => query.set({ entity: v, offset: null })} options={ENTITIES} />
    </div>
    <Section loading={log.loading && !page} error={page ? '' : log.error} retry={log.reload}>{page && (page.rows.length ? <>
      <div className="table-scroll"><table className="admin-table">
        <thead><tr><th scope="col">When</th><th scope="col">Administrator</th><th scope="col">Action</th><th scope="col">Change</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
        <tbody>{page.rows.map(entry => <Fragment key={entry.id}>
          <tr className={open === String(entry.id) ? 'selected' : ''}>
            <td className="nowrap">{fmt.date(entry.created_at)}</td>
            <td>{entry.actor_username}</td>
            <td className="nowrap"><span className={`badge ${entry.action === 'delete' ? 'alert' : ''}`}>{entry.action}</span><small className="cell-note">{ENTITIES.find(([k]) => k === entry.entity)?.[1] || entry.entity}</small></td>
            <td>{entry.summary}{entry.entity_id && <code className="cell-note">{entry.entity_id}</code>}</td>
            <td className="row-actions">{entry.detail_json !== '{}' && <button className="button small" aria-expanded={open === String(entry.id)} onClick={() => query.set({ entry: open === String(entry.id) ? null : entry.id })}>{open === String(entry.id) ? 'Close' : 'Details'}</button>}</td>
          </tr>
          {open === String(entry.id) && <tr className="row-detail"><td colSpan={5}><pre className="audit-detail">{JSON.stringify(JSON.parse(entry.detail_json), null, 2)}</pre></td></tr>}
        </Fragment>)}</tbody>
      </table></div>
      <Pager page={page} onChange={offset => query.set({ offset, entry: null })} />
    </> : <EmptyState title="No recorded changes">Administrator actions appear here as they happen.</EmptyState>)}</Section>
  </section>;
}
