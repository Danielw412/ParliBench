import Prompts from '../admin/Prompts';
import RebuttalPool from '../admin/RebuttalPool';
import { StructureEditor } from '../admin/StructureEditor';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LockSimpleIcon } from '@phosphor-icons/react/dist/csr/LockSimple';
import { UploadSimpleIcon } from '@phosphor-icons/react/dist/csr/UploadSimple';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, PageHeader, ErrorState, Select } from '../components';
import NextRun from '../NextRun';
import { METRICS, METRIC_LABELS, TASK_LABELS, applicableMetrics, type AccountRow, type SystemInfo, type User } from '../../shared/domain';

interface Catalog { systems: SystemInfo[]; topics: {id:string;motion:string;category:string;active:number;metadata_json:string}[]; responses: {id:string;task:string;display_version:number}[]; standards: {id:string;title:string}[]; judges: {id:string;display_name:string}[]; weights: {task:string;metric:string;weight:number}[]; source: {human:number;ai:number}; users: AccountRow[]; }
type Field = { name:string; label:string; multiline?:boolean; optional?:boolean; options?:[string,string][]; value?:string; type?:string };
const entityOptions: [string,string][] = [['systems','System / configuration'],['topics','Topic / motion'],['responses','Response / run'],['ai_judges','AI judge'],['ai_votes','AI judgment']];

export default function Admin() {
  const { user, loading, setUser } = useAuth();
  const [catalog,setCatalog] = useState<Catalog | null>(null), [error,setError] = useState(''), [success,setSuccess] = useState(''), [busy,setBusy] = useState(false);
  const [tab,setTab] = useState('next'), [entity,setEntity] = useState('systems'), [task,setTask] = useState('government');
  const [json,setJson] = useState('{\n  "systems": [],\n  "topics": [],\n  "responses": []\n}');
  const [editId,setEditId] = useState(''), [display,setDisplay] = useState(''), [raw,setRaw] = useState('');
  const admin = !!user?.is_admin;
  async function load() { const next = await api<Catalog>('/admin/catalog'); setCatalog(next); }
  async function perform(action:()=>Promise<unknown>, message:string) { setBusy(true); setError(''); setSuccess(''); try { await action(); setSuccess(message); await load(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  useEffect(() => { if (!admin) { setCatalog(null); return; } load().catch(e => setError((e as Error).message)); }, [admin]);
  // Revoking your own access re-reads the account so the page falls back to the no-access state instead of failing to reload.
  async function changeRole(target:AccountRow, next:boolean) {
    setBusy(true); setError(''); setSuccess('');
    try {
      await api(`/admin/users/${target.id}`,{method:'PATCH',body:JSON.stringify({is_admin:next})});
      setSuccess(`${target.username} ${next ? 'is now an administrator' : 'no longer has administrator access'}.`);
      if (target.id === user!.id && !next) setUser(await api<User>('/auth/me')); else await load();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const references = (key:'systems'|'topics'|'responses'|'standards'|'judges'): [string,string][] => (catalog?.[key] || []).map(r => [r.id,`${r.id}${'display_name' in r ? ` · ${r.display_name}` : ''}`]);
  const basic = (name:string,label:string,extra:Partial<Field> = {}):Field => ({name,label,...extra});
  let fields:Field[] = [];
  if (entity === 'systems') fields = [basic('id','Unique system ID'),basic('display_name','Display name'),basic('provider','Provider'),basic('model','Underlying model'),basic('interface','Product / interface'),basic('reasoning','Reasoning setting',{optional:true}),basic('configuration','Tools / configuration notes',{multiline:true,optional:true})];
  if (entity === 'topics') fields = [basic('id','Unique topic ID'),basic('motion','Motion',{multiline:true}),basic('category','Category',{options:[['Serious','Serious'],['Informal','Informal']]}),basic('metadata_json','Future metadata (JSON object)',{value:'{}',optional:true})];
  if (entity === 'responses') fields = [basic('id','Unique response ID'),basic('system_id','System / configuration',{options:references('systems')}),basic('topic_id','Topic',{options:references('topics')}),basic('prompt','Exact prompt',{multiline:true}),basic('raw_output','Raw output (immutable)',{multiline:true}),basic('display_output','Sanitized display output',{multiline:true}),basic('generated_at','Generation timestamp (ISO UTC)',{value:new Date().toISOString()}),basic('interface','Generation interface'),basic('reasoning','Reasoning setting',{optional:true}),basic('configuration','Tools / configuration',{multiline:true,optional:true}),basic('context_id','Context / thread ID'),basic('sample','Run / sample number',{type:'number',value:'1'}),basic('duration_ms','Duration (milliseconds)',{type:'number',optional:true})];
  if (entity === 'ai_judges') fields = [basic('id','Unique judge ID'),basic('system_id','Judge system',{options:references('systems')}),basic('display_name','Judge display name'),basic('version','Judge version')];
  if (entity === 'ai_votes') fields = [basic('id','Unique judgment ID'),basic('judge_id','AI judge',{options:references('judges')}),basic('response_a','Response A ID',{options:references('responses')}),basic('response_b','Response B ID',{options:references('responses')}),basic('overall','Overall preference',{options:[['2','A much better'],['1','A better'],['0','Tie'],['-1','B better'],['-2','B much better']]}),basic('snapshot_a','Exact response A text seen by offline judge',{multiline:true}),basic('snapshot_b','Exact response B text seen by offline judge',{multiline:true}),basic('version','Judgment version'),basic('judged_at','Judged timestamp (ISO UTC)',{value:new Date().toISOString()}),basic('explanation','Optional explanation',{multiline:true,optional:true}),...METRICS.map(m => basic(`metric_${m}`,METRIC_LABELS[m],{optional:true,options:[['','Skip'],['2','A much better'],['1','A better'],['0','Tie'],['-1','B better'],['-2','B much better']]}))];
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget;
    const data: Record<string,unknown> = Object.fromEntries(new FormData(form));
    for (const [k,v] of Object.entries(data)) if (v === '') { if (['reasoning','duration_ms','government_response_id','explanation'].includes(k)) data[k] = null; else delete data[k]; }
    const payload: Record<string,unknown> = {};
    if (entity === 'responses') {
      data.task = task; data.sample = Number(data.sample); if (data.duration_ms != null) data.duration_ms = Number(data.duration_ms);

    }
    if (entity === 'ai_votes') {
      data.overall = Number(data.overall); const metrics: Record<string,number> = {};
      for (const m of METRICS) { if (data[`metric_${m}`] != null) metrics[m] = Number(data[`metric_${m}`]); delete data[`metric_${m}`]; } data.metrics = metrics;
    }
    payload[entity] = [data];
    await perform(() => api('/admin/import',{method:'POST',body:JSON.stringify(payload)}),'Record imported and relationships validated.');
  }
  async function loadDisplay(id:string) {
    setEditId(id); setDisplay(''); setRaw(''); if (!id) return;
    await perform(async () => { const run = await api<{display_output:string;raw_output:string}>(`/admin/responses/${id}`,{}); setDisplay(run.display_output); setRaw(run.raw_output); },'Response loaded.');
  }
  async function saveWeights(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); if (!catalog) return;
    await perform(() => api('/admin/weights',{method:'PUT',body:JSON.stringify({source:{human:Number(form.get('human'))/100,ai:Number(form.get('ai'))/100},benchmark:catalog.weights.map(w => ({...w,weight:Number(form.get(`${w.task}:${w.metric}`))/100}))})}),'Ranking weights saved.');
  }
  const header = <PageHeader title="Admin" description="Import offline results, edit display text, configure ranking weights, and manage administrator accounts." />;
  if (loading) return <div className="page admin-page">{header}<Loading /></div>;
  if (!admin) return <div className="page admin-page">{header}<div className="admin-lock"><LockSimpleIcon size={30} /><h2>Administrator access</h2>{user ? <p className="muted">You are signed in as {user.username}. This account is not an administrator; an existing administrator can grant access from this page.</p> : <><p className="muted">Sign in with an administrator account. Access is granted per account, and there is no separate admin password.</p><Link className="button dark" to="/login">Sign in</Link></>}{error && <ErrorState message={error} />}</div></div>;
  return <div className="page admin-page">{header}{!catalog ? (error ? <ErrorState message={error} /> : <Loading />) : <><div className="admin-tabs" role="group" aria-label="Admin tools">{[['next','Next Run'],['prompts','Prompts'],['pool','Rebuttal Pool'],['manual','Manual entry'],['import','JSON import'],['display','Display editor'],['catalog','Catalog'],['weights','Ranking weights'],['admins','Administrators']].map(([v,label]) => <button className={tab === v ? 'active' : ''} key={v} onClick={() => {setTab(v);setError('');setSuccess('');}}>{label}</button>)}</div>{error && <ErrorState message={error} />}{success && <div className="notice" role="status"><CheckIcon />{success}</div>}
    {tab === 'next' && <NextRun onSaved={() => { void load().catch(() => {}); }} />}
    {tab === 'prompts' && <Prompts />}
    {tab === 'pool' && <RebuttalPool />}
    {tab === 'manual' && <section><div className="filter-row admin-entity"><Select label="Record type" value={entity} onChange={setEntity} options={entityOptions} />{entity === 'responses' && <Select label="Task / stage" value={task} onChange={setTask} options={Object.entries(TASK_LABELS).filter(([key])=>key!=='rebuttal')} />}</div>{entity === 'responses' && <p className="notice">Government and Opposition receive only the motion. Next Run automatically renders and snapshots your prompt; manual entry records an existing external run.</p>}<form className="admin-form" key={`${entity}:${task}`} onSubmit={create}>{fields.map(field => <label className={field.multiline ? 'wide' : ''} key={field.name}>{field.label}{field.optional && <span className="muted"> · optional</span>}{field.options ? <select name={field.name} required={!field.optional}>{field.options.map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select> : field.multiline ? <textarea name={field.name} rows={6} required={!field.optional} /> : <input name={field.name} type={field.type || 'text'} defaultValue={field.value} required={!field.optional} min={field.name === 'sample' ? 1 : 0} />}</label>)}<div className="wide"><button className="button dark" disabled={busy}><PlusIcon />{busy ? 'Importing…' : 'Validate & create'}</button></div></form></section>}
    {tab === 'import' && <section className="import-panel"><h2>JSON import</h2><p>Import systems, topics, runs, AI judges, and judgments in one atomic batch. Maximum 500 records / 2 MB. Duplicate IDs reject the entire batch.</p><label className="file-picker"><UploadSimpleIcon />Load JSON file<input type="file" accept=".json,application/json" onChange={async e => {const file=e.target.files?.[0]; if(file) {if(file.size>2_000_000) setError('File exceeds 2 MB'); else setJson(await file.text());}}} /></label><label>Import payload<textarea className="json-editor" spellCheck={false} value={json} onChange={e => setJson(e.target.value)} rows={20} /></label><button className="button dark" disabled={busy} onClick={() => void perform(() => api('/admin/import',{method:'POST',body:JSON.stringify(JSON.parse(json))}),'Bulk import completed atomically.')}><UploadSimpleIcon />Validate & import</button></section>}
    {tab === 'display' && <section><Select label="Response to edit" value={editId} onChange={v => void loadDisplay(v)} options={[["","Choose a response"],...references('responses')]} />{editId && <><div className="notice">Only display text changes. Raw output and historical Arena snapshots are preserved.</div><label>Blind Arena display<textarea rows={18} value={display} onChange={e => setDisplay(e.target.value)} /></label><button className="button dark" disabled={busy || !display} onClick={() => void perform(() => api(`/admin/responses/${editId}`,{method:'PATCH',body:JSON.stringify({display_output:display})}),'Display revision saved. Previous judgments retain their original snapshots.')}>Save display revision</button><StructureEditor key={editId} responseId={editId} /><details className="raw-output"><summary>Original raw output (read only)</summary><pre>{raw}</pre></details></>}</section>}
    {tab === 'catalog' && <section><h2>Systems and topics</h2><p className="muted">Inactive records remain in historical rankings, but are excluded from new Arena matchups.</p>{(['systems','topics'] as const).map(kind => <div className="catalog-section" key={kind}><h3>{kind === 'systems' ? 'Systems / configurations' : 'Topics'}</h3>{catalog[kind].map(record => <div className="catalog-row" key={record.id}><span><strong>{'display_name' in record ? record.display_name : record.motion}</strong><code>{record.id}</code></span><button className="button small" disabled={busy} onClick={() => void perform(() => api(`/admin/${kind}/${record.id}`,{method:'PUT',body:JSON.stringify({...record,active:record.active ? 0 : 1})}),'Active status updated.')}>{record.active ? 'Deactivate' : 'Activate'}</button></div>)}</div>)}</section>}
    {tab === 'weights' && <form className="weights-form" onSubmit={saveWeights}><h2>Source influence</h2><p className="muted">Fixed shares prevent a large AI vote import from overwhelming human judgment. Each group must total 100%.</p><div className="filter-row"><label>Human judges (%)<input name="human" type="number" min="0" max="100" step="0.1" defaultValue={catalog.source.human*100} required /></label><label>AI judges (%)<input name="ai" type="number" min="0" max="100" step="0.1" defaultValue={catalog.source.ai*100} required /></label></div>{Object.entries(TASK_LABELS).map(([task,label]) => <fieldset key={task}><legend>{label} metric weights (%)</legend><div className="weights-grid">{applicableMetrics(task).map(m => <label key={m}>{METRIC_LABELS[m]}<input type="number" name={`${task}:${m}`} min="0" max="100" step="0.1" defaultValue={(catalog.weights.find(w => w.task === task && w.metric === m)?.weight || 0)*100} required /></label>)}</div></fieldset>)}<button className="button dark" disabled={busy}>Save benchmark weights</button></form>}
    {tab === 'admins' && <section><h2>Accounts and administrators</h2><p className="muted">Administrator access follows the account, so revoking it applies to that person&rsquo;s existing sessions immediately. At least one administrator must always remain.</p><div className="catalog-section">{catalog.users.map(record => <div className="catalog-row" key={record.id}><span><strong>{record.username}{record.id === user!.id && <span className="muted"> · you</span>}</strong><code>{record.user_type} · joined {record.created_at.slice(0,10)}</code></span><span className="role-actions">{record.is_admin ? <span className="badge">Administrator</span> : null}<button className="button small" disabled={busy} onClick={() => void changeRole(record,!record.is_admin)}>{record.is_admin ? (record.id === user!.id ? 'Revoke my access' : 'Revoke admin') : 'Make admin'}</button></span></div>)}</div></section>}</>}</div>;
}
