import { useEffect, useState } from 'react';
import { api } from '../api';
import { TASK_LABELS, type Task } from '../../shared/domain';
import type { PromptUsage } from '../../shared/admin';
import { fmt, Section, SectionHead, useAction, useAdminData, useQueryState } from './ui';

export default function Prompts() {
  const query = useQueryState(), prompts = useAdminData<PromptUsage[]>('/admin/prompts'), action = useAction();
  const task = (Object.keys(TASK_LABELS).includes(query.get('task')) ? query.get('task') : 'government') as Task;
  const history = (prompts.data || []).filter(r => r.task === task).sort((a, b) => b.version - a.version), current = history[0];
  const [text, setText] = useState(''), [loadedFor, setLoadedFor] = useState('');
  // Load the latest template once per task; later refreshes must not overwrite an unsaved edit.
  useEffect(() => { if (prompts.data && loadedFor !== task) { setText(current?.template || ''); setLoadedFor(task); } }, [prompts.data, task, loadedFor, current]);
  const dirty = text !== (current?.template || '');
  return <section>
    <SectionHead title="Prompts" description="Each save creates a new immutable version. Started runs and recorded responses keep the exact prompt they were given." />
    <div className="source-tabs subtabs" role="tablist" aria-label="Prompt task">{Object.entries(TASK_LABELS).map(([key, label]) => <button key={key} role="tab" aria-selected={task === key} className={task === key ? 'active' : ''} onClick={() => query.set({ task: key })}>{label}</button>)}</div>
    <Section loading={prompts.loading && !prompts.data} error={prompts.data ? '' : prompts.error} retry={prompts.reload}>
      {task === 'rebuttal' && <p className="notice">Rebuttal is awaiting its prompt wording. Provisional placeholders: {'{MOTION}'}, {'{GOVERNMENT_CASE}'}, {'{OPPOSITION_CASE}'}. Saving a valid template enables eligible Rebuttal runs.</p>}
      {task !== 'rebuttal' && <p className="caption">Required placeholder: {'{MOTION}'}. Unknown placeholders are rejected.</p>}
      <label>Template{current ? <span className="muted"> · editing from version {current.version}</span> : <span className="muted"> · no version saved yet</span>}<textarea className="json-editor" rows={20} value={text} onChange={e => setText(e.target.value)} /></label>
      {action.feedback}
      <div className="row-actions">
        <button className="button dark" disabled={action.busy || !text.trim() || !dirty} onClick={() => void action.run(async () => { await api('/admin/prompts', { method: 'POST', body: JSON.stringify({ task, template: text }) }); prompts.reload(); }, 'New version saved. Recommendations use it immediately; started runs keep their prompts.')}>Save as version {(current?.version || 0) + 1}</button>
        {dirty && <button className="text-button" onClick={() => setText(current?.template || '')}>Discard changes</button>}
      </div>
      <h3>Version history</h3>
      {!history.length ? <p className="caption">No versions yet.</p> : <ol className="revision-list">{history.map(r => <li key={r.id}>
        <div><strong>Version {r.version}</strong>{r === current && <span className="badge ink">Current</span>}<span className="muted"> · {fmt.date(r.created_at)} · {r.claims} runs started · {r.responses} responses recorded</span></div>
        <details className="run-detail"><summary>Show template</summary><pre>{r.template}</pre></details>
        {r !== current && <button className="button small" onClick={() => { setText(r.template); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Load into editor</button>}
      </li>)}</ol>}
      {history.length > 1 && <p className="caption">Restoring an old version saves it again as a new version, so the history stays complete.</p>}
    </Section>
  </section>;
}
