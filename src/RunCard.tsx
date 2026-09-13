import { useState, type ReactNode, type FormEvent } from 'react';

import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';

import { ResponseText, TaskBadge } from './components';

import { taskSide, type RunPlan, type RunClaim } from '../shared/domain';

function CopyPrompt({text}:{text:string}) {

  const [message,setMessage]=useState('Copy prompt');

  return <button className="button" onClick={()=>void navigator.clipboard.writeText(text).then(()=>setMessage('Copied'),()=>setMessage('Copy failed — select prompt text'))}>{message}</button>;

}

export function RunCard({ plan, actions, children }: { plan: RunPlan; actions: ReactNode; children?: ReactNode }) {

  const facts: [string, string][] = [['System', plan.system.display_name], ['Provider', plan.system.provider], ['Model', plan.system.model], ['Interface', plan.system.interface], ['Reasoning', plan.system.reasoning || 'Not specified']];

  return <article className="run-card">

    <div className="run-meta"><span className="badge">{taskSide(plan.task)}</span><TaskBadge task={plan.task} /><span className="badge">{plan.topic.category}</span><span className="badge">Sample {plan.sample}</span></div>

    <h3 className="run-motion">{plan.topic.motion}</h3>

    <dl className="run-facts">{facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>

    {plan.system.configuration && <p className="caption run-configuration">{plan.system.configuration}</p>}

    <details className="run-detail" open><summary>Rendered prompt - version {plan.prompt_version}</summary><pre>{plan.rendered_prompt}</pre></details>
    {plan.upstream.map(stage => <details className="run-detail" key={stage.response_id}><summary>{stage.label} <code>{stage.response_id}</code></summary><ResponseText text={stage.text} /></details>)}

    <div className="run-actions"><CopyPrompt key={plan.rendered_prompt} text={plan.rendered_prompt} />{actions}</div>

    {children}

  </article>;

}



// The response produced offline. Provenance fields default to the recorded system configuration and

// describe the actual execution. The started prompt is immutable.

export function ResponseForm({ claim, busy, onSave }: { claim: RunClaim; busy: boolean; onSave: (payload: Record<string, unknown>) => void }) {

  const [raw, setRaw] = useState(''), [display, setDisplay] = useState(''), [mirrored, setMirrored] = useState(true);

  function submit(event: FormEvent<HTMLFormElement>) {

    event.preventDefault();

    const form = new FormData(event.currentTarget), value = (key: string) => String(form.get(key) ?? '').trim();

    onSave({ raw_output: raw, display_output: display, prompt: claim.rendered_prompt, generated_at: value('generated_at'),

      interface: value('interface'), reasoning: value('reasoning') || null, configuration: value('configuration'),

      context_id: value('context_id'), duration_ms: value('duration_ms') ? Number(value('duration_ms')) : null });

  }

  return <form className="admin-form run-form" onSubmit={submit}>

    <label className="wide">Exact prompt the model received<textarea name="prompt" rows={5} value={claim.rendered_prompt} readOnly /></label>

    <label className="wide">Raw output, stored exactly as returned<textarea name="raw_output" rows={9} value={raw} onChange={e => { setRaw(e.target.value); if (mirrored) setDisplay(e.target.value); }} required /></label>

    <label className="wide">Blind Arena display text<span className="muted"> · remove identifying clues</span>

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
