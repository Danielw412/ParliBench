import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorState } from '../components';
import { StructureEditor } from './StructureEditor';
interface Source {response_id:string;motion:string;government_system:string;frozen_at:string|null;availability:string;extraction_status:string|null;}
export default function RebuttalPool(){
  const [sources,setSources]=useState<Source[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[edit,setEdit]=useState('');
  const load=async()=>setSources(await api<Source[]>('/admin/rebuttal-pool'));
  useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
  async function freeze(id:string){setBusy(true);setError('');try{await api('/admin/rebuttal-pool',{method:'POST',body:JSON.stringify({response_ids:[id]})});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section><h2>Rebuttal Pool</h2><p>Freeze exact Government cases for every tested system to answer. A frozen response and its compact case remain fixed as rankings change.</p>{error && <ErrorState message={error} />}
    <button className="text-button" onClick={()=>void load().catch(e=>setError(e.message))}>Refresh sources</button>
    {!sources.length && <p>No Government responses yet. Record a Government case in Next Run.</p>}
    {sources.map(s=><div className="pool-source" key={s.response_id}><h3>{s.motion}</h3><p>{s.government_system} · <code>{s.response_id}</code></p><p className="caption">{s.frozen_at ? `Frozen ${s.frozen_at}` : 'Not frozen'} · {s.availability}</p><div className="run-actions">
      <button className="button" disabled={busy || !!s.frozen_at || s.availability!=='Available'} onClick={()=>void freeze(s.response_id)}>{s.frozen_at ? 'Frozen' : 'Freeze this case'}</button>
      <button className="text-button" onClick={()=>setEdit(edit===s.response_id ? '' : s.response_id)}>View / correct structure</button></div>{edit===s.response_id && <StructureEditor key={edit} responseId={edit} />}</div>)}
  </section>;
}
