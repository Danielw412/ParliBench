import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { api } from './api';
import { EmptyState, ErrorState, Loading, ResponseText, TaskBadge } from './components';
import { taskSide, type RunBoard, type RunClaim, type RunPlan, type RunSlot } from '../shared/domain';

const slotOf = (plan: RunPlan): RunSlot => ({ system_id: plan.system_id, topic_id: plan.topic_id, task: plan.task, standardized_task_id: plan.standardized_task_id, prediction_response_id: plan.prediction_response_id, rebuttal_response_id: plan.rebuttal_response_id });

function RunCard({ plan, actions, children }: { plan: RunPlan; actions: ReactNode; children?: ReactNode }) {
  const facts: [string, string][] = [['System', plan.system.display_name], ['Provider', plan.system.provider], ['Model', plan.system.model], ['Interface', plan.system.interface], ['Reasoning', plan.system.reasoning || 'Not specified']];
  return <article className="run-card">
    <div className="run-meta"><span className="badge">{taskSide(plan.task)}</span><TaskBadge task={plan.task} /><span className="badge">{plan.topic.category}</span><span className="badge">Sample {plan.sample}</span></div>
    <h3 className="run-motion">{plan.topic.motion}</h3>
    <dl className="run-facts">{facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>
    {plan.system.configuration && <p className="caption run-configuration">{plan.system.configuration}</p>}
    {plan.prompt_reference && <details className="run-detail"><summary>Prompt used for this motion and task</summary><pre>{plan.prompt_reference}</pre></details>}
    {plan.standardized_case && <details className="run-detail"><summary>Shared Government case · {plan.standardized_case.title}</summary><ResponseText text={plan.standardized_case.case_text} /></details>}
    {plan.upstream.map(stage => <details className="run-detail" key={stage.response_id}><summary>{stage.label} <code>{stage.response_id}</code></summary><ResponseText text={stage.text} /></details>)}
    <div className="run-actions">{actions}</div>
    {children}
  </article>;
}

// The response produced offline. Provenance fields default to the recorded system configuration and
// stay editable, because the run records what the model actually received, not what was planned.
function ResponseForm({ claim, busy, onSave }: { claim: RunClaim; busy: boolean; onSave: (payload: Record<string, unknown>) => void }) {
  const [raw, setRaw] = useState(''), [display, setDisplay] = useState(''), [mirrored, setMirrored] = useState(true);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget), value = (key: string) => String(form.get(key) ?? '').trim();
    onSave({ raw_output: raw, display_output: display, prompt: value('prompt'), generated_at: value('generated_at'),
      interface: value('interface'), reasoning: value('reasoning') || null, configuration: value('configuration'),
      context_id: value('context_id'), duration_ms: value('duration_ms') ? Number(value('duration_ms')) : null });
  }
  return <form className="admin-form run-form" onSubmit={submit}>
    <label className="wide">Exact prompt the model received<textarea name="prompt" rows={5} defaultValue={claim.prompt_reference || ''} required /></label>
    <label className="wide">Raw output, stored exactly as returned<textarea name="raw_output" rows={9} value={raw} onChange={e => { setRaw(e.target.value); if (mirrored) setDisplay(e.target.value); }} required /></label>
    <label className="wide">{claim.task === 'full_opposition' ? 'Constructive material shown in the Arena (prediction and rebuttal are assembled automatically)' : 'Blind Arena display text'}<span className="muted"> · remove identifying clues</span>
      <textarea name="display_output" rows={9} value={display} onChange={e => { setMirrored(false); setDisplay(e.target.value); }} required /></label>
    <label>Generation interface<input name="interface" defaultValue={claim.system.interface} required /></label>
    <label>Reasoning setting<span className="muted"> · optional</span><input name="reasoning" defaultValue={claim.system.reasoning || ''} /></label>
    <label>Context / thread ID{claim.task === 'rebuttal' && <span className="muted"> · must be a fresh context</span>}<input name="context_id" defaultValue={`ctx-${Date.now().toString(36)}`} required /></label>
    <label>Generation timestamp (ISO UTC)<input name="generated_at" defaultValue={new Date().toISOString()} required /></label>
    <label>Duration (milliseconds)<span className="muted"> · optional</span><input name="duration_ms" type="number" min={0} /></label>
    <label className="wide">Tools / configuration<span className="muted"> · optional</span><textarea name="configuration" rows={2} defaultValue={claim.system.configuration} /></label>
    <div className="wide"><button className="button dark" disabled={busy || !raw || !display}>{busy ? 'Saving…' : 'Save response'}<ArrowRightIcon size={18} /></button></div>
  </form>;
}

export default function NextRun({ onSaved }: { onSaved?: () => void }) {
  const [board, setBoard] = useState<RunBoard | null>(null);
  const [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [openId, setOpenId] = useState('');
  const load = useCallback(async () => {
    try { setBoard(await api<RunBoard>('/admin/next-run')); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNote('');
    try { await action(); setNote(message); await load(); onSaved?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const start = (plan: RunPlan) => perform(async () => {
    const claim = await api<RunClaim>('/admin/runs', { method: 'POST', body: JSON.stringify(slotOf(plan)) });
    setOpenId(claim.claim_id);
  }, 'Run started. Record its response here when the model is finished.');
  const save = (claim: RunClaim, payload: Record<string, unknown>) => perform(async () => {
    await api(`/admin/runs/${claim.claim_id}/response`, { method: 'POST', body: JSON.stringify(payload) });
    setOpenId('');
  }, 'Response imported. The next recommendation already accounts for it.');
  if (!board) return error ? <ErrorState message={error} retry={() => void load()} /> : <Loading />;
  return <section className="run-planner">
    {error && <ErrorState message={error} />}
    {note && <div className="notice" role="status"><CheckIcon />{note}</div>}
    <div className="section-heading"><h2>Next run</h2><button className="text-button" disabled={busy} onClick={() => void load()}><ArrowClockwiseIcon size={15} /> Another option</button></div>
    {board.recommendation
      ? <RunCard plan={board.recommendation} actions={<button className="button dark" disabled={busy} onClick={() => void start(board.recommendation!)}><PlayIcon size={16} />Start this run</button>} />
      : <EmptyState title="Nothing to run">Activate at least one system and one topic to schedule benchmark runs.</EmptyState>}
    <div className="section-heading run-queue-heading"><h2>In progress</h2><span className="caption">{board.queue.length} started, waiting for a response</span></div>
    {!board.queue.length ? <p className="caption">Start a run to record its response here.</p> : board.queue.map(claim => <RunCard key={claim.claim_id} plan={claim}
      actions={<>
        <button className="button dark" disabled={busy} onClick={() => setOpenId(openId === claim.claim_id ? '' : claim.claim_id)}>{openId === claim.claim_id ? 'Hide response form' : 'Record the response'}</button>
        <button className="button" disabled={busy} onClick={() => void perform(() => api(`/admin/runs/${claim.claim_id}/release`, { method: 'POST' }), 'Run released. It can be recommended again.')}>Release</button>
      </>}>
      {openId === claim.claim_id && <ResponseForm claim={claim} busy={busy} onSave={payload => void save(claim, payload)} />}
    </RunCard>)}
  </section>;
}
