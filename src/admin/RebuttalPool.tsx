import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { EmptyState } from '../components';
import { StructureEditor } from './StructureEditor';
import { adminLink, ConfirmDialog, FilterSelect, fmt, Section, SectionHead, useAction, useAdminData, useQueryState } from './ui';

interface Source { response_id: string; topic_id: string; motion: string; government_system: string; frozen_at: string | null; availability: string; extraction_status: string | null; }
export default function RebuttalPool() {
  const query = useQueryState(), sources = useAdminData<Source[]>('/admin/rebuttal-pool'), action = useAction();
  const [edit, setEdit] = useState(''), [selection, setSelection] = useState<Set<string>>(new Set()), [removing, setRemoving] = useState<Source | null>(null);
  const view = query.get('view');
  const rows = (sources.data || []).filter(s => view === 'frozen' ? s.frozen_at : view === 'available' ? !s.frozen_at && s.availability === 'Available' : view === 'unavailable' ? s.availability !== 'Available' : true);
  const freezable = (s: Source) => !s.frozen_at && s.availability === 'Available';
  const freeze = (ids: string[]) => action.run(async () => { await api('/admin/rebuttal-pool', { method: 'POST', body: JSON.stringify({ response_ids: ids }) }); setSelection(new Set()); sources.reload(); },
    `Froze ${ids.length} Government case${ids.length === 1 ? '' : 's'}. Every system can now rebut ${ids.length === 1 ? 'it' : 'them'}.`);
  const motions = [...new Map(rows.map(s => [s.topic_id, s.motion])).entries()];
  const frozenCount = (sources.data || []).filter(s => s.frozen_at).length;
  return <section>
    <SectionHead title="Rebuttal Pool" description={`Freeze exact Government cases for every tested system to answer. A frozen case keeps its compact snapshot as rankings, extraction, and display text change. ${frozenCount} frozen.`} />
    <div className="filter-row admin-filters">
      <FilterSelect label="Show" value={view} all="All Government responses" onChange={v => query.set({ view: v })} options={[['frozen', 'Frozen sources'], ['available', 'Ready to freeze'], ['unavailable', 'Unavailable']]} />
      {selection.size > 0 && <button className="button dark" disabled={action.busy} onClick={() => void freeze([...selection])}>Freeze {selection.size} selected</button>}
    </div>
    {action.feedback}
    <Section loading={sources.loading && !sources.data} error={sources.data ? '' : sources.error} retry={sources.reload}>
      {!rows.length ? <EmptyState title="No Government responses here">Record Government cases in Next Run, or change the filter.</EmptyState> : motions.map(([topic, motion]) => <div className="pool-group" key={topic}>
        <h3>{motion}</h3>
        {rows.filter(s => s.topic_id === topic).map(s => <div className="pool-source" key={s.response_id}>
          <div className="pool-row">
            <label className="check-setting"><input type="checkbox" disabled={!freezable(s)} checked={selection.has(s.response_id)} aria-label={`Select ${s.response_id}`}
              onChange={() => setSelection(current => { const next = new Set(current); if (next.has(s.response_id)) next.delete(s.response_id); else next.add(s.response_id); return next; })} /></label>
            <div className="pool-meta"><strong>{s.government_system}</strong><Link to={adminLink('responses', { response: s.response_id })}><code>{s.response_id}</code></Link>
              <span className="badge-row">{s.frozen_at ? <span className="badge ink">Frozen {fmt.day(s.frozen_at)}</span> : <span className="badge">Not frozen</span>}{s.availability !== 'Available' && <span className="badge alert">{s.availability}</span>}</span></div>
            <div className="row-actions">
              {s.frozen_at ? <button className="button small danger" onClick={() => setRemoving(s)}>Remove from pool…</button> : <button className="button small" disabled={action.busy || !freezable(s)} onClick={() => void freeze([s.response_id])}>Freeze</button>}
              <button className="text-button" aria-expanded={edit === s.response_id} onClick={() => setEdit(edit === s.response_id ? '' : s.response_id)}>{edit === s.response_id ? 'Hide structure' : 'View / correct structure'}</button>
            </div>
          </div>
          {edit === s.response_id && <StructureEditor key={edit} responseId={edit} />}
        </div>)}
      </div>)}
    </Section>
    {removing && <ConfirmDialog title="Remove this frozen source?" confirmLabel="Remove from pool" danger reason onClose={() => setRemoving(null)}
      onConfirm={async reason => { await api(`/admin/rebuttal-pool/${encodeURIComponent(removing.response_id)}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }); sources.reload(); }}>
      <p>{removing.government_system} · {removing.motion}</p>
      <p className="caption">Systems will no longer be asked to rebut this case. Removal is refused while any Rebuttal response or in-progress run uses it, so every system keeps answering the same sources. The removal and its snapshot are recorded.</p>
    </ConfirmDialog>}
  </section>;
}
