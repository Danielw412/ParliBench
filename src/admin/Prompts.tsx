import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorState, Select } from '../components';
import { TASK_LABELS, type PromptRevision, type Task } from '../../shared/domain';
export default function Prompts() {
  const [rows,setRows]=useState<PromptRevision[]>([]),[task,setTask]=useState<Task>('government'),[text,setText]=useState(''),[error,setError]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;void api<PromptRevision[]>('/admin/prompts').then(data=>{if(active){setRows(data);setText(data.find(r=>r.task==='government')?.template || '');}}).catch(e=>setError(e.message));return()=>{active=false;};},[]);
  async function save(){setBusy(true);setError('');try{await api('/admin/prompts',{method:'POST',body:JSON.stringify({task,template:text})});setRows(await api('/admin/prompts'));setNote('New revision saved. Started runs keep their original prompts.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section><h2>Prompt templates</h2><p>Each save creates a new version. The motion is inserted automatically when recommending a run.</p><Select label="Task" value={task} onChange={v=>{setTask(v as Task);setText(rows.find(r=>r.task===v)?.template || '');setNote('');}} options={Object.entries(TASK_LABELS)} />
    {task==='rebuttal' && <p className="notice">Rebuttal is awaiting its prompt. No wording has been supplied. Provisional placeholders: {'{MOTION}'}, {'{GOVERNMENT_CASE}'}, {'{OPPOSITION_CASE}'}. Saving a valid template enables eligible runs.</p>}
    {task!=='rebuttal' && <p className="caption">Required placeholder: {'{MOTION}'}</p>}{error && <ErrorState message={error} />}{note && <p role="status">{note}</p>}
    <label>Template<textarea rows={20} value={text} onChange={e=>setText(e.target.value)} /></label><button className="button dark" disabled={busy || !text.trim()} onClick={()=>void save()}>Save new revision</button>
    <h3>Version history</h3>{rows.filter(r=>r.task===task).map(r=><details className="run-detail" key={r.id}><summary>Version {r.version} · {r.created_at}</summary><pre>{r.template}</pre></details>)}
  </section>;
}
