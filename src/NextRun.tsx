import { RunCard, ResponseForm } from './RunCard';
import { StructureEditor } from './admin/StructureEditor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { api } from './api';
import { EmptyState, ErrorState, Loading, Select } from './components';
import { type RunBoard, type RunClaim, type RunPlan, type RunSlot } from '../shared/domain';

const slotOf = (plan: RunPlan): RunSlot => ({ system_id: plan.system_id, topic_id: plan.topic_id, task: plan.task, government_source_response_id: plan.government_source_response_id, opposition_source_response_id: plan.opposition_source_response_id });

export default function NextRun({ onSaved }: { onSaved?: () => void }) {
  const [systemId,setSystemId]=useState(()=>sessionStorage.getItem('parlibench.next-system') || '');
  const [savedId,setSavedId]=useState('');
  const sequence=useRef(0);
  const [board, setBoard] = useState<RunBoard | null>(null);
  const [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [openId, setOpenId] = useState('');
  const load = useCallback(async (exclude?: string) => {
    const request=++sequence.current;
    try {
      const params=new URLSearchParams(); if(systemId) params.set('system',systemId); if(exclude) params.set('exclude',exclude);
      const next=await api<RunBoard>(`/admin/next-run?${params}`);
      if(request===sequence.current) setBoard(next);
    } catch(e) { if(request===sequence.current) setError((e as Error).message); }
  }, [systemId]);
  useEffect(()=>{setBoard(null);void load();return()=>{sequence.current++;};},[load]);
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
    const saved=await api<{response_id:string}>(`/admin/runs/${claim.claim_id}/response`, { method: 'POST', body: JSON.stringify(payload) });
    if(claim.task!=='rebuttal') setSavedId(saved.response_id);
    setOpenId('');
  }, 'Response imported. The next recommendation already accounts for it.');
  if (!board) return error ? <ErrorState message={error} retry={() => void load()} /> : <Loading />;
  return <section className="run-planner">
    <Select label="System" value={systemId} onChange={value=>{sessionStorage.setItem('parlibench.next-system',value);setSystemId(value);}} options={[["","All systems"],...board.systems.map(s=>[s.id,s.display_name] as [string,string]),...(systemId && !board.systems.some(s=>s.id===systemId) ? [[systemId,'Selected system (inactive)'] as [string,string]] : [])]} />
    {savedId && <details className="run-detail" open><summary>Saved case · extraction and correction</summary><StructureEditor key={savedId} responseId={savedId} /></details>}
    {error && <ErrorState message={error} />}
    {note && <div className="notice" role="status"><CheckIcon />{note}</div>}
    <div className="section-heading"><h2>Next run</h2><button className="text-button" disabled={busy} onClick={() => {const p=board.recommendation;void load(p ? [p.system_id,p.topic_id,p.task,p.government_source_response_id || ''].join('|') : undefined);}}><ArrowClockwiseIcon size={15} /> Another option</button></div>
    {board.recommendation
      ? <RunCard plan={board.recommendation} actions={<button className="button dark" disabled={busy} onClick={() => void start(board.recommendation!)}><PlayIcon size={16} />Start this run</button>} />
      : <EmptyState title="Nothing to run">{systemId ? 'This system has no executable run. Check its active status, topics, and prompt availability.' : 'Activate a system and topic to begin. Rebuttal also requires its prompt and structured source cases.'}</EmptyState>}
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
