import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { api } from '../api';
import { ResponseText } from '../components';
import { coreCaseMarkdown, coreCaseSchema } from '../../shared/cases';
import { CORRECTABLE_FIELDS, type AdminOptions, type ResponseDetail } from '../../shared/admin';
import { StructureEditor } from './StructureEditor';
import { adminLink, ActiveBadge, DeleteButton, fmt, isLegacyTask, Section, Stat, useAction, useAdminData, useOptions } from './ui';

type Tab = 'display' | 'correct' | 'structure' | 'sources' | 'raw' | 'history';
export default function ResponseDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useAdminData<ResponseDetail>(`/admin/responses/${encodeURIComponent(id)}/detail`), options = useOptions();
  const [tab, setTab] = useState<Tab>('display'), action = useAction();
  const d = detail.data, r = d?.response;
  const back = <button className="text-button back-link" onClick={onBack}><ArrowLeftIcon size={15} /> All responses</button>;
  if (!d || !r) return <section>{back}<Section loading={detail.loading} error={detail.error} retry={detail.reload}>{null}</Section></section>;
  const caseTask = ['government', 'opposition'].includes(r.task);
  const tabs: [Tab, string][] = [['display', 'Display text'], ['correct', 'Correct record'], ...(caseTask ? [['structure', 'Structured case']] as [Tab, string][] : []),
    ...(r.rebuttal_input_snapshot ? [['sources', 'Source inputs']] as [Tab, string][] : []), ['raw', 'Raw output & prompt'], ['history', `History (${d.revisions.length + d.display_revisions.length})`]];
  const facts: [string, ReactNode][] = [
    ['System', <Link to={adminLink('systems', { system: r.system_id })}>{d.system_name || r.system_id}</Link>], ['Topic', d.category],
    ['Generated', fmt.date(r.generated_at)], ['Interface', r.interface], ['Reasoning', r.reasoning || 'Not specified'], ['Duration', fmt.duration(r.duration_ms)],
    ['Context / thread', <code>{r.context_id}</code>], ['Prompt revision', r.prompt_revision_id ? <code>{r.prompt_revision_id}</code> : 'Not recorded'],
    ['Run', d.claim ? <Link to={adminLink('runs')}>{d.claim.status === 'filled' ? 'Recorded' : d.claim.status} · {fmt.day(d.claim.claimed_at)}</Link> : 'Imported directly'],
  ];
  return <section>
    {back}
    <div className="detail-head">
      <div>
        <div className="run-meta"><span className="badge">{fmt.task(r.task)}</span><span className="badge">Sample {r.sample}</span><ActiveBadge active={r.active} />
          {d.frozen_at && <span className="badge ink">Frozen Rebuttal source</span>}{isLegacyTask(r.task) && <span className="badge">Legacy task</span>}
          {r.provenance_revision > 1 && <span className="badge">Corrected ×{r.provenance_revision - 1}</span>}
          {caseTask && <span className={`badge ${d.structure?.status === 'ready' ? '' : 'alert'}`}>{d.structure ? `Extraction ${d.structure.status}` : 'Not extracted'}</span>}</div>
        <h2>{d.system_name || r.system_id} · {fmt.task(r.task)}</h2>
        <p className="detail-motion">{d.motion}</p>
        <code className="cell-note">{r.id}</code>
      </div>
      <div className="row-actions">
        <button className="button" disabled={action.busy} onClick={() => void action.run(async () => { await api(`/admin/responses/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: JSON.stringify({ active: r.active ? 0 : 1 }) }); detail.reload(); },
          r.active ? 'Deactivated. It keeps its votes but leaves new runs and matchups.' : 'Activated. It is eligible for new matchups again.')}>{r.active ? 'Deactivate' : 'Activate'}</button>
        <DeleteButton kind="response" id={r.id} label="Delete…" onDeleted={onBack} />
      </div>
    </div>
    {action.feedback}
    <dl className="run-facts detail-facts">{facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>
    {r.configuration && <p className="caption run-configuration">{r.configuration}</p>}
    <div className="stat-grid compact">
      <Stat label="Matchups" value={fmt.n(d.counts.matchups)} /><Stat label="Arena assignments" value={fmt.n(d.counts.assignments)} />
      <Stat label="Human votes" value={fmt.n(d.counts.human_votes)} /><Stat label="AI votes" value={fmt.n(d.counts.ai_votes)} />
      <Stat label="Dependent responses" value={fmt.n(d.counts.dependents)} note={d.counts.dependents ? 'Rebuttals built on this case' : undefined} />
    </div>
    <div className="source-tabs subtabs" role="tablist" aria-label="Response tools">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'display' && <DisplayEditor key={`${r.display_version}`} detail={d} onSaved={detail.reload} />}
    {tab === 'correct' && <CorrectionForm key={`${r.provenance_revision}:${r.display_version}`} detail={d} options={options.data} onSaved={detail.reload} />}
    {tab === 'structure' && <StructureEditor key={r.id} responseId={r.id} />}
    {tab === 'sources' && <SourceInputs detail={d} />}
    {tab === 'raw' && <div className="raw-panels">
      <details className="run-detail" open><summary>Raw output · {fmt.chars(r.raw_output.length)}</summary><pre>{r.raw_output}</pre></details>
      <details className="run-detail" open><summary>Exact prompt</summary><pre>{r.prompt}</pre></details>
    </div>}
    {tab === 'history' && <History detail={d} />}
  </section>;
}

function DisplayEditor({ detail, onSaved }: { detail: ResponseDetail; onSaved: () => void }) {
  const r = detail.response, [text, setText] = useState(r.display_output), action = useAction();
  return <div className="tool-panel">
    <p className="caption">Arena judges see this text, or the structured case when one exists and display text is unrevised. Saving creates display version {r.display_version + 1}. Raw output and assignments already issued keep their snapshots. Identifying names are rejected.</p>
    <label>Blind Arena display text<textarea rows={18} value={text} onChange={e => setText(e.target.value)} /></label>
    {action.feedback}
    <div className="row-actions">
      <button className="button dark" disabled={action.busy || !text.trim() || text === r.display_output} onClick={() => void action.run(async () => { await api(`/admin/responses/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: JSON.stringify({ display_output: text }) }); onSaved(); }, 'Display revision saved.')}>Save display revision</button>
      <button className="button" disabled={text === r.raw_output} onClick={() => setText(r.raw_output)}>Start from raw output</button>
      <button className="text-button" disabled={text === r.display_output} onClick={() => setText(r.display_output)}>Discard changes</button>
    </div>
  </div>;
}

type Values = Record<typeof CORRECTABLE_FIELDS[number], string>;
function CorrectionForm({ detail, options, onSaved }: { detail: ResponseDetail; options: AdminOptions | null; onSaved: () => void }) {
  const r = detail.response;
  const initial: Values = { raw_output: r.raw_output, prompt: r.prompt, generated_at: r.generated_at, interface: r.interface, reasoning: r.reasoning || '', configuration: r.configuration,
    duration_ms: r.duration_ms == null ? '' : String(r.duration_ms), context_id: r.context_id, sample: String(r.sample), system_id: r.system_id };
  const [values, setValues] = useState(initial), [reason, setReason] = useState(''), [reextract, setReextract] = useState(true), [syncDisplay, setSyncDisplay] = useState(false);
  const action = useAction();
  const changed = CORRECTABLE_FIELDS.filter(f => values[f] !== initial[f]);
  const set = (field: keyof Values) => (e: { target: { value: string } }) => setValues(v => ({ ...v, [field]: e.target.value }));
  const caseTask = ['government', 'opposition'].includes(r.task), rawChanged = changed.includes('raw_output');
  function submit(e: FormEvent) {
    e.preventDefault();
    const convert = (field: typeof CORRECTABLE_FIELDS[number]) => field === 'sample' ? Number(values.sample) : field === 'duration_ms' ? (values.duration_ms.trim() ? Number(values.duration_ms) : null) : field === 'reasoning' ? (values.reasoning.trim() || null) : values[field];
    const payload = { ...Object.fromEntries(changed.map(f => [f, convert(f)])), reason, reextract: caseTask && rawChanged && reextract, ...(syncDisplay ? { display_output: values.raw_output } : {}) };
    void action.run(async () => { await api(`/admin/responses/${encodeURIComponent(r.id)}`, { method: 'PUT', body: JSON.stringify(payload) }); onSaved(); }, 'Correction saved. The previous record is kept in History.');
  }
  return <form className="tool-panel" onSubmit={submit}>
    <div className="notice"><WarningIcon size={18} /><span>Corrections change the canonical record, so use them for recording mistakes: a truncated paste, the wrong system, a wrong timestamp. Every save keeps the prior state in History. Topic, task, source cases, and prompt revision cannot change; delete and re-import to move a response.{detail.counts.human_votes + detail.counts.ai_votes > 0 && ` Its ${detail.counts.human_votes + detail.counts.ai_votes} existing votes will count toward the corrected record.`}</span></div>
    <div className="admin-form">
      <label>System<select value={values.system_id} onChange={set('system_id')}>{(options?.systems || [{ id: r.system_id, display_name: detail.system_name || r.system_id, active: 1 }]).map(s => <option key={s.id} value={s.id}>{s.display_name}{s.active ? '' : ' (inactive)'}</option>)}</select></label>
      <label>Sample number<input type="number" min={1} value={values.sample} onChange={set('sample')} required /></label>
      <label className="wide">Raw output<textarea rows={14} value={values.raw_output} onChange={set('raw_output')} required /></label>
      <label className="wide">Exact prompt<textarea rows={6} value={values.prompt} onChange={set('prompt')} required /></label>
      <label>Generation timestamp (ISO UTC)<input value={values.generated_at} onChange={set('generated_at')} required /></label>
      <label>Interface<input value={values.interface} onChange={set('interface')} required /></label>
      <label>Reasoning setting<span className="muted"> · optional</span><input value={values.reasoning} onChange={set('reasoning')} /></label>
      <label>Duration (milliseconds)<span className="muted"> · optional</span><input type="number" min={0} value={values.duration_ms} onChange={set('duration_ms')} /></label>
      <label>Context / thread ID<input value={values.context_id} onChange={set('context_id')} required /></label>
      <label className="wide">Tools / configuration<span className="muted"> · optional</span><textarea rows={2} value={values.configuration} onChange={set('configuration')} /></label>
      <label className="wide">Reason for the correction<span className="muted"> · saved with the revision</span><input value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} placeholder="For example: pasted output was truncated" /></label>
      {rawChanged && <div className="wide check-group">
        {caseTask && <label className="check-setting"><input type="checkbox" checked={reextract} onChange={e => setReextract(e.target.checked)} />Re-run structured extraction from the corrected output</label>}
        <label className="check-setting"><input type="checkbox" checked={syncDisplay} onChange={e => setSyncDisplay(e.target.checked)} />Also replace the Arena display text with the corrected output (sanitized)</label>
      </div>}
    </div>
    {action.feedback}
    <div className="row-actions"><button className="button dark" disabled={action.busy || !changed.length}>{action.busy ? 'Saving…' : changed.length ? `Save correction (${changed.length} field${changed.length === 1 ? '' : 's'})` : 'No changes'}</button>
      {changed.length > 0 && <button type="button" className="text-button" onClick={() => setValues(initial)}>Discard changes</button>}</div>
  </form>;
}

function SourceInputs({ detail }: { detail: ResponseDetail }) {
  const r = detail.response;
  let parts: string[] = [];
  try { parts = (JSON.parse(r.rebuttal_input_snapshot || '[]') as unknown[]).map(part => coreCaseMarkdown(coreCaseSchema.parse(part))); } catch { parts = []; }
  return <div className="raw-panels">
    <p className="caption">The exact compact cases this Rebuttal received. They were snapshotted when the run started and never change.</p>
    {[['Frozen Government case', r.government_source_response_id], ['Own Opposition case', r.opposition_source_response_id]].map(([label, source], i) =>
      <details className="run-detail" key={label} open={i === 0}><summary>{label} {source && <Link to={adminLink('responses', { response: source })}><code>{source}</code></Link>}</summary>{parts[i] ? <ResponseText text={parts[i]} /> : <pre>{r.rebuttal_input_snapshot}</pre>}</details>)}
  </div>;
}

const FIELD_LABELS: Record<string, string> = { raw_output: 'Raw output', prompt: 'Prompt', generated_at: 'Generated', interface: 'Interface', reasoning: 'Reasoning', configuration: 'Configuration', duration_ms: 'Duration', context_id: 'Context', sample: 'Sample', system_id: 'System' };
function History({ detail }: { detail: ResponseDetail }) {
  const r = detail.response;
  // Each stored snapshot is the state a correction replaced; compare it with the state that followed.
  const states = [...detail.revisions].sort((a, b) => a.revision - b.revision).map(rev => ({ ...rev, values: JSON.parse(rev.snapshot_json) as Record<string, unknown> }));
  const next = (i: number): Record<string, unknown> => states[i + 1]?.values ?? r as unknown as Record<string, unknown>;
  return <div className="history-panels">
    <h3>Record corrections</h3>
    {!states.length ? <p className="caption">This record has never been corrected.</p> : <ol className="revision-list">{states.map((state, i) => {
      const fields = Object.keys(FIELD_LABELS).filter(f => state.values[f] !== next(i)[f]);
      return <li key={state.revision}><div><strong>Revision {state.revision} → {state.revision + 1}</strong><span className="muted"> · {fmt.date(state.created_at)}</span></div>
        <p>{fields.length ? `Changed ${fields.map(f => FIELD_LABELS[f].toLowerCase()).join(', ')}` : 'No field differences recorded'}{state.reason && <> · “{state.reason}”</>}</p>
        {fields.length > 0 && <details className="run-detail"><summary>Values before this correction</summary>{fields.map(f => <div key={f} className="revision-field"><span className="mono">{FIELD_LABELS[f]}</span><pre>{String(state.values[f] ?? '—')}</pre></div>)}</details>}
      </li>;
    }).reverse()}</ol>}
    <h3>Display text versions</h3>
    <ol className="revision-list">{detail.display_revisions.map(rev => <li key={rev.version}><div><strong>Version {rev.version}</strong>{rev.version === r.display_version && <span className="badge">Current</span>}<span className="muted"> · {fmt.date(rev.changed_at)}</span></div>
      <details className="run-detail"><summary>Show text</summary><pre>{rev.display_output}</pre></details></li>)}</ol>
    <p className="caption">Arena assignments snapshot the text each judge saw, so earlier votes remain reconstructable after any edit.</p>
  </div>;
}
