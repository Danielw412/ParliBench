import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { api } from '../api';
import { EmptyState } from '../components';
import type { SystemInfo } from '../../shared/domain';
import type { ScoreSummary, SystemDetail, SystemStats } from '../../shared/admin';
import { ActiveBadge, adminLink, DeleteButton, fmt, Section, SectionHead, Stat, useAction, useAdminData, useQueryState } from './ui';

export default function Systems() {
  const query = useQueryState(), selected = query.get('system'), creating = query.get('new') === '1';
  if (creating) return <CreateSystem cloneFrom={query.get('clone')} onDone={id => query.set({ new: null, clone: null, system: id || null }, true)} />;
  if (selected) return <SystemDetailView key={selected} id={selected} onBack={() => query.set({ system: null }, true)} onClone={() => query.set({ system: null, new: '1', clone: selected }, true)} />;
  return <SystemList onCreate={() => query.set({ new: '1' }, true)} />;
}

export function ScoreLine({ summary }: { summary: ScoreSummary | null }) {
  if (!summary?.comparisons) return <span className="muted">Unranked</span>;
  return <span className="score-inline"><strong className="mono">{summary.score.toFixed(1)}</strong><small className="cell-note">#{summary.rank} · {summary.comparisons} ballots{summary.low_confidence ? ' · low confidence' : ''}</small></span>;
}

function SystemList({ onCreate }: { onCreate: () => void }) {
  const stats = useAdminData<SystemStats[]>('/admin/system-stats'), list = stats.data;
  return <section>
    <SectionHead title="Systems" description="Each model configuration under test, with its coverage, judging volume, and current rankings. Open one to edit its configuration, clone it, or delete it." actions={<button className="button dark" onClick={onCreate}><PlusIcon size={15} />New system</button>} />
    <Section loading={stats.loading && !list} error={list ? '' : stats.error} retry={stats.reload}>{list && (list.length ? <div className="table-scroll"><table className="admin-table">
      <thead><tr><th scope="col">System</th><th scope="col">Status</th><th scope="col" className="num">Responses</th><th scope="col">By task</th><th scope="col" className="num">Topics</th>
        <th scope="col" className="num">Human / AI votes</th><th scope="col">Human score</th><th scope="col">Combined score</th><th scope="col" className="num">Avg duration</th><th scope="col">Last response</th></tr></thead>
      <tbody>{list.map(s => <tr key={s.id}>
        <td><Link className="row-title" to={adminLink('systems', { system: s.id })}>{s.display_name}</Link><small className="cell-note">{s.provider} · {s.model}</small></td>
        <td><ActiveBadge active={s.active} /></td>
        <td className="num mono">{fmt.n(s.responses)}{s.active_responses !== s.responses && <small className="cell-note">{s.active_responses} active</small>}</td>
        <td className="mono nowrap">G {s.government} · O {s.opposition} · R {s.rebuttal}{s.legacy > 0 && <small className="cell-note">{s.legacy} legacy</small>}</td>
        <td className="num mono">{s.topics_covered}</td>
        <td className="num mono">{fmt.n(s.human_votes)} / {fmt.n(s.ai_votes)}</td>
        <td><ScoreLine summary={s.human} /></td>
        <td><ScoreLine summary={s.combined} /></td>
        <td className="num mono">{fmt.duration(s.avg_duration_ms)}</td>
        <td className="nowrap">{fmt.ago(s.last_generated_at)}</td>
      </tr>)}</tbody>
    </table></div> : <EmptyState title="No systems yet">Create a system configuration to start recording runs.</EmptyState>)}</Section>
    <p className="caption table-caption">Scores use Overall Preference, recalculated live. Votes count every judgment that involved the system. Topics counts motions with a Government or Opposition case.</p>
  </section>;
}

const FIELDS: { key: keyof SystemInfo; label: string; optional?: boolean; wide?: boolean; multiline?: boolean }[] = [
  { key: 'display_name', label: 'Display name' }, { key: 'provider', label: 'Provider' }, { key: 'model', label: 'Underlying model' }, { key: 'interface', label: 'Product / interface' },
  { key: 'reasoning', label: 'Reasoning setting', optional: true }, { key: 'configuration', label: 'Tools / configuration notes', optional: true, wide: true, multiline: true },
];
function SystemForm({ initial, creating, busy, onSubmit }: { initial: SystemInfo; creating: boolean; busy: boolean; onSubmit: (value: SystemInfo) => void }) {
  const [value, setValue] = useState(initial), [touchedId, setTouchedId] = useState(!creating);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const update = (key: keyof SystemInfo, text: string) => setValue(v => ({ ...v, [key]: text, ...(creating && !touchedId && key === 'display_name' ? { id: slug(text) } : {}) }));
  function submit(e: FormEvent) { e.preventDefault(); onSubmit({ ...value, reasoning: value.reasoning?.trim() ? value.reasoning.trim() : null }); }
  const changed = JSON.stringify(value) !== JSON.stringify(initial);
  return <form className="admin-form" onSubmit={submit}>
    {creating && <label>Unique system ID<span className="muted"> · letters, digits, - and _; cannot change later</span><input value={value.id} pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,79}" onChange={e => { setTouchedId(true); setValue(v => ({ ...v, id: e.target.value })); }} required /></label>}
    {FIELDS.map(f => <label key={f.key} className={f.wide ? 'wide' : ''}>{f.label}{f.optional && <span className="muted"> · optional</span>}
      {f.multiline ? <textarea rows={3} value={String(value[f.key] ?? '')} onChange={e => update(f.key, e.target.value)} /> : <input value={String(value[f.key] ?? '')} onChange={e => update(f.key, e.target.value)} required={!f.optional} />}</label>)}
    <label className="check-setting"><input type="checkbox" checked={!!value.active} onChange={e => setValue(v => ({ ...v, active: e.target.checked ? 1 : 0 }))} />Active: eligible for new runs and Arena matchups</label>
    <div className="wide"><button className="button dark" disabled={busy || (!creating && !changed)}>{busy ? 'Saving…' : creating ? 'Create system' : 'Save configuration'}</button></div>
  </form>;
}

function CreateSystem({ cloneFrom, onDone }: { cloneFrom: string; onDone: (id?: string) => void }) {
  const source = useAdminData<SystemInfo[]>(cloneFrom ? '/systems' : null), action = useAction();
  const base = source.data?.find(s => s.id === cloneFrom);
  const empty: SystemInfo = { id: '', display_name: '', provider: '', model: '', interface: '', reasoning: null, configuration: '', active: 1 };
  const initial = base ? { ...base, id: `${base.id}-copy`, display_name: `${base.display_name} (copy)` } : empty;
  return <section>
    <button className="text-button back-link" onClick={() => onDone()}><ArrowLeftIcon size={15} /> All systems</button>
    <SectionHead title={base ? `Clone ${base.display_name}` : 'New system'} description="A system is one exact configuration: provider, model, interface, reasoning, and tools. Record a variant as its own system so rankings never mix configurations." />
    {cloneFrom && !base ? <Section loading={source.loading} error={source.error}>{null}</Section>
      : <SystemForm key={initial.id} initial={initial} creating busy={action.busy} onSubmit={value => void action.run(async () => { await api('/admin/import', { method: 'POST', body: JSON.stringify({ systems: [value] }) }); onDone(value.id); })} />}
    {action.feedback}
  </section>;
}

function SystemDetailView({ id, onBack, onClone }: { id: string; onBack: () => void; onClone: () => void }) {
  const detail = useAdminData<SystemDetail>(`/admin/system-stats/${encodeURIComponent(id)}`), action = useAction();
  const d = detail.data, s = d?.system;
  const back = <button className="text-button back-link" onClick={onBack}><ArrowLeftIcon size={15} /> All systems</button>;
  if (!d || !s) return <section>{back}<Section loading={detail.loading} error={detail.error} retry={detail.reload}>{null}</Section></section>;
  const save = (value: SystemInfo, message: string) => action.run(async () => { await api(`/admin/systems/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) }); detail.reload(); }, message);
  const record: SystemInfo = { id: s.id, display_name: s.display_name, provider: s.provider, model: s.model, interface: s.interface, reasoning: s.reasoning, configuration: s.configuration, active: s.active };
  const activeTopics = d.topics.filter(t => t.active).length;
  return <section>
    {back}
    <div className="detail-head">
      <div><div className="run-meta"><ActiveBadge active={s.active} /><span className="badge">{s.provider}</span><span className="badge">{s.model}</span><span className="badge">{s.interface}</span></div>
        <h2>{s.display_name}</h2><code className="cell-note">{s.id}</code></div>
      <div className="row-actions">
        <button className="button" disabled={action.busy} onClick={() => void save({ ...record, active: s.active ? 0 : 1 }, s.active ? 'System deactivated. Its results stay in rankings; it leaves new runs and matchups.' : 'System activated.')}>{s.active ? 'Deactivate' : 'Activate'}</button>
        <button className="button" onClick={onClone}><CopyIcon size={15} />Clone</button>
        <Link className="button" to={adminLink('responses', { system: s.id })}>Responses</Link>
        <Link className="button" to={`/systems/${s.id}`}>Public page <ArrowUpRightIcon size={14} /></Link>
        <DeleteButton kind="system" id={s.id} label="Delete…" onDeleted={onBack} />
      </div>
    </div>
    {action.feedback}
    <div className="stat-grid">
      <Stat label="Responses" value={fmt.n(s.responses)} note={`G ${s.government} · O ${s.opposition} · R ${s.rebuttal}${s.legacy ? ` · ${s.legacy} legacy` : ''}`} />
      <Stat label="Topics covered" value={`${s.topics_covered} / ${activeTopics}`} note="active motions with a case" />
      <Stat label="Human votes" value={fmt.n(s.human_votes)} note={`${fmt.n(s.matchups)} matchups`} />
      <Stat label="AI votes" value={fmt.n(s.ai_votes)} note={s.judges ? `Also powers ${s.judges} AI judge${s.judges === 1 ? '' : 's'}` : undefined} />
      <Stat label="Avg duration" value={fmt.duration(s.avg_duration_ms)} note={`Last response ${fmt.ago(s.last_generated_at)}`} />
      <Stat label="Extraction" value={`${s.extraction_ready} ready`} note={`${s.extraction_failed} failed · ${s.open_claims} runs in progress`} />
    </div>
    <div className="overview-columns">
      <div><h3>Rankings</h3><div className="ranking-list">{d.rankings.map(r => <div key={r.label}>
        <span>{r.label}</span>
        {r.summary?.comparisons ? <><span className="score-cell"><strong>{r.summary.score.toFixed(1)}</strong><span className="interval-track" title={`95% interval: ${r.summary.ci[0].toFixed(1)}–${r.summary.ci[1].toFixed(1)}`}><span className="interval-range" style={{ left: `${r.summary.ci[0]}%`, width: `${r.summary.ci[1] - r.summary.ci[0]}%` }} /><span className="interval-point" style={{ left: `${r.summary.score}%` }} /></span></span>
          <small className="cell-note">Rank {r.summary.rank} · {r.summary.comparisons} ballots · rating {Math.round(r.summary.rating)} · win share {fmt.pct(r.summary.win_rate)}{r.summary.low_confidence ? ' · low confidence' : ''}</small></> : <span className="muted">No comparisons</span>}
      </div>)}</div></div>
      <div><h3>Configuration</h3><SystemForm key={JSON.stringify(record)} initial={record} creating={false} busy={action.busy} onSubmit={value => void save(value, 'Configuration saved. Recorded responses keep the configuration they ran with.')} /></div>
    </div>
    <h3>Coverage by motion</h3>
    <div className="table-scroll"><table className="admin-table">
      <thead><tr><th scope="col">Motion</th><th scope="col">Category</th><th scope="col" className="num">Government</th><th scope="col" className="num">Opposition</th><th scope="col" className="num">Rebuttal</th><th scope="col" className="num">In progress</th></tr></thead>
      <tbody>{d.topics.map(t => <tr key={t.topic_id} className={t.active ? '' : 'inactive'}>
        <td><Link to={adminLink('responses', { system: s.id, topic: t.topic_id })}>{t.motion}</Link>{!t.active && <small className="cell-note">Inactive topic</small>}</td>
        <td>{t.category}</td>
        {[t.government, t.opposition, t.rebuttal].map((n, i) => <td key={i} className={`num mono ${n ? '' : 'gap'}`}>{n || '—'}</td>)}
        <td className="num mono">{t.open_claims || ''}</td>
      </tr>)}</tbody>
    </table></div>
    <h3>Latest responses</h3>
    {d.recent.length ? <ul className="activity-list">{d.recent.map(r => <li key={r.id}><Link to={adminLink('responses', { response: r.id })}><strong>{fmt.task(r.task)}</strong> · sample {r.sample}{!r.active && ' · inactive'}</Link><span>{fmt.day(r.generated_at)} · {r.motion}</span></li>)}</ul> : <p className="caption">No responses recorded yet.</p>}
  </section>;
}
