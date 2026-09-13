import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorState, ResponseText } from '../components';
import { caseMarkdown, structuredCaseSchema } from '../../shared/cases';

interface Structure { status:string; case_json:string|null; method:string; error:string|null; revision:number; }
export function StructureEditor({responseId}:{responseId:string}) {
  const [structure,setStructure]=useState<Structure|null>(null),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [task,setTask]=useState('government');
  async function load() {
    const [result,run]=await Promise.all([api<{structure:Structure|null}>(`/admin/responses/${responseId}/structure`),api<{task:string}>(`/admin/responses/${responseId}`)]);
    setTask(run.task);setStructure(result.structure);setText(result.structure?.case_json ? JSON.stringify(JSON.parse(result.structure.case_json),null,2) : JSON.stringify({schema_version:1,motion_interpretation:'',contentions:[{number:1,title:'',claim:'',warrants:[''],impact:'',comparative:'',likely_response:'',defense:''}],round_priorities:''},null,2));
  }
  useEffect(()=>{void load().catch(e=>setError(e.message));},[responseId]);
  async function perform(retry:boolean) {
    setBusy(true);setError('');
    try { await api(`/admin/responses/${responseId}/structure${retry ? '/retry' : ''}`,{method:retry ? 'POST' : 'PUT',...(retry ? {} : {body:JSON.stringify(structuredCaseSchema.parse(JSON.parse(text)))})});await load(); }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  if(!['government','opposition'].includes(task)) return <p className="caption">Structured extraction applies to case-generation responses.</p>;
  const parsed=structuredCaseSchema.safeParse(structure?.case_json ? JSON.parse(structure.case_json) : null);
  return <section className="structure-editor"><p>Extraction: <strong>{structure?.status || 'Not extracted'}</strong>{structure && ` · ${structure.method} · revision ${structure.revision}`}</p>
    {structure?.error && <p className="caption">{structure.error}</p>}{error && <ErrorState message={error} />}
    <button className="button" disabled={busy} onClick={()=>void perform(true)}>{busy ? 'Working…' : 'Retry extraction'}</button>
    {parsed.success && <details className="run-detail"><summary>Structured case preview</summary><ResponseText text={caseMarkdown(parsed.data,task)} /></details>}
    <details className="run-detail"><summary>Correct structured JSON</summary><p className="caption">Preserve the original wording. This changes derived data only; raw output, prompts, frozen sources, and issued Arena snapshots remain historical records.</p>
      <label>Case JSON<textarea className="json-editor" rows={18} value={text} onChange={e=>setText(e.target.value)} /></label><button className="button dark" disabled={busy} onClick={()=>void perform(false)}>Save structured revision</button></details>
  </section>;
}
