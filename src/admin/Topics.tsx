import { Fragment, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { api } from '../api';
import { EmptyState } from '../components';
import type { TopicStats } from '../../shared/admin';
import { ActiveBadge, adminLink, DeleteButton, FilterSelect, fmt, Section, SectionHead, useAction, useAdminData, useQueryState } from './ui';

interface TopicRecord { id: string; motion: string; category: 'Serious' | 'Informal'; active: number; metadata_json: string }

export default function Topics() {
  const query = useQueryState(), stats = useAdminData<TopicStats[]>('/admin/topic-stats'), action = useAction();
  const [creating, setCreating] = useState(false);
  const editing = query.get('topic'), category = query.get('category'), status = query.get('status');
  const rows = (stats.data || []).filter(t => (!category || t.category === category) && (!status || String(t.active) === status));
  const save = (topic: TopicRecord, message: string) => action.run(async () => { await api(`/admin/topics/${encodeURIComponent(topic.id)}`, { method: 'PUT', body: JSON.stringify(topic) }); stats.reload(); }, message);
  const record = (t: TopicStats): TopicRecord => ({ id: t.id, motion: t.motion, category: t.category, active: t.active, metadata_json: t.metadata_json });
  return <section>
    <SectionHead title="Topics" description="Motions under test. Inactive topics keep their results but leave new runs and Arena matchups. Editing a motion never rewrites what judges already saw." actions={<button className="button dark" onClick={() => setCreating(!creating)}><PlusIcon size={15} />{creating ? 'Close form' : 'New topic'}</button>} />
    {creating && <div className="tool-panel"><h3>New topic</h3><TopicForm creating busy={action.busy} initial={{ id: '', motion: '', category: 'Serious', active: 1, metadata_json: '{}' }}
      onSubmit={topic => void action.run(async () => { await api('/admin/import', { method: 'POST', body: JSON.stringify({ topics: [topic] }) }); setCreating(false); stats.reload(); }, 'Topic created. Next Run will recommend it right away.')} /></div>}
    {action.feedback}
    <div className="filter-row admin-filters">
      <FilterSelect label="Category" value={category} all="All categories" onChange={v => query.set({ category: v })} options={[['Serious', 'Serious'], ['Informal', 'Informal']]} />
      <FilterSelect label="Status" value={status} all="Active and inactive" onChange={v => query.set({ status: v })} options={[['1', 'Active only'], ['0', 'Inactive only']]} />
    </div>
    <Section loading={stats.loading && !stats.data} error={stats.data ? '' : stats.error} retry={stats.reload}>{rows.length ? <div className="table-scroll"><table className="admin-table">
      <thead><tr><th scope="col">Motion</th><th scope="col">Status</th><th scope="col" className="num">Responses</th><th scope="col">By task</th><th scope="col" className="num">Systems</th><th scope="col" className="num">Human / AI votes</th><th scope="col" className="num">Frozen sources</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{rows.map(t => <Fragment key={t.id}>
        <tr className={editing === t.id ? 'selected' : ''}>
          <td className="motion-cell"><span className="row-title">{t.motion}</span><small className="cell-note">{t.category} · <code>{t.id}</code></small></td>
          <td><ActiveBadge active={t.active} /></td>
          <td className="num mono">{fmt.n(t.responses)}{t.open_claims > 0 && <small className="cell-note">+{t.open_claims} in progress</small>}</td>
          <td className="mono nowrap">G {t.government} · O {t.opposition} · R {t.rebuttal}</td>
          <td className="num mono">{t.systems_covered}</td>
          <td className="num mono">{fmt.n(t.human_votes)} / {fmt.n(t.ai_votes)}</td>
          <td className="num mono">{t.pool_sources || '—'}</td>
          <td className="row-actions">
            <button className="button small" aria-expanded={editing === t.id} onClick={() => query.set({ topic: editing === t.id ? null : t.id })}>{editing === t.id ? 'Close' : 'Manage'}</button>
          </td>
        </tr>
        {editing === t.id && <tr className="row-detail"><td colSpan={8}>
          <TopicForm key={JSON.stringify(record(t))} initial={record(t)} creating={false} busy={action.busy} onSubmit={topic => void save(topic, 'Topic saved. Issued Arena assignments keep the motion as it was shown.')} />
          <div className="row-actions">
            <button className="button" disabled={action.busy} onClick={() => void save({ ...record(t), active: t.active ? 0 : 1 }, t.active ? 'Topic deactivated.' : 'Topic activated.')}>{t.active ? 'Deactivate' : 'Activate'}</button>
            <Link className="button" to={adminLink('responses', { topic: t.id })}>Responses</Link>
            <Link className="button" to={adminLink('pool')}>Rebuttal Pool</Link>
            <DeleteButton kind="topic" id={t.id} label="Delete topic…" onDeleted={() => { query.set({ topic: null }); stats.reload(); }} />
          </div>
        </td></tr>}
      </Fragment>)}</tbody>
    </table></div> : <EmptyState title="No topics match">Create a topic, or change the filters.</EmptyState>}</Section>
  </section>;
}

function TopicForm({ initial, creating, busy, onSubmit }: { initial: TopicRecord; creating: boolean; busy: boolean; onSubmit: (topic: TopicRecord) => void }) {
  const [value, setValue] = useState(initial), [touchedId, setTouchedId] = useState(!creating), [error, setError] = useState('');
  const slug = (text: string) => text.toLowerCase().replace(/^this house (would|believes that|believes|regrets|supports|opposes)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  function submit(e: FormEvent) {
    e.preventDefault();
    try { const parsed = JSON.parse(value.metadata_json || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); }
    catch { setError('Metadata must be a JSON object, such as {}'); return; }
    setError(''); onSubmit({ ...value, metadata_json: value.metadata_json.trim() || '{}' });
  }
  return <form className="admin-form" onSubmit={submit}>
    {creating && <label>Unique topic ID<span className="muted"> · cannot change later</span><input value={value.id} pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,79}" onChange={e => { setTouchedId(true); setValue(v => ({ ...v, id: e.target.value })); }} required /></label>}
    <label>Category<select value={value.category} onChange={e => setValue(v => ({ ...v, category: e.target.value as TopicRecord['category'] }))}><option>Serious</option><option>Informal</option></select></label>
    <label className="wide">Motion<textarea rows={2} value={value.motion} onChange={e => { const motion = e.target.value; setValue(v => ({ ...v, motion, ...(creating && !touchedId ? { id: slug(motion) } : {}) })); }} required /></label>
    <label className="wide">Metadata (JSON object)<span className="muted"> · optional tags such as difficulty or domain</span><textarea className="json-editor" rows={3} value={value.metadata_json} onChange={e => setValue(v => ({ ...v, metadata_json: e.target.value }))} /></label>
    <label className="check-setting"><input type="checkbox" checked={!!value.active} onChange={e => setValue(v => ({ ...v, active: e.target.checked ? 1 : 0 }))} />Active: eligible for new runs and Arena matchups</label>
    {error && <p className="caption wide" role="alert">{error}</p>}
    <div className="wide"><button className="button dark" disabled={busy || (!creating && JSON.stringify(value) === JSON.stringify(initial))}>{busy ? 'Saving…' : creating ? 'Create topic' : 'Save topic'}</button></div>
  </form>;
}
