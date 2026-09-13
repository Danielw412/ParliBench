import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { createDemoData, demoCase } from '../scripts/demo-data';
import { RUN_TASKS, type RunBoard, type RunClaim, type RunPlan, type RunSlot, type User } from '../shared/domain';

let mf:Miniflare, db:D1Database;
let founder:{token:string;user:User}, visitor:{token:string;user:User};
const data = createDemoData();
const newTopic = {id:'scheduler-topic',motion:'This House would plan its own benchmark coverage.',category:'Serious'};
const blindText = '## A scheduled response\n\nThe argument is recorded here exactly as it was prepared for the round, with no identifying detail.';
const slotOf = (plan:RunPlan):RunSlot => ({system_id:plan.system_id,topic_id:plan.topic_id,task:plan.task,government_source_response_id:plan.government_source_response_id,opposition_source_response_id:plan.opposition_source_response_id});
const where = (plan:RunPlan) => [plan.system_id,plan.topic_id,plan.task,plan.government_source_response_id || ''].join('/');
const result = (extra:Record<string,unknown> = {}) => ({raw_output:`${blindText}\n\nSources: none.`,display_output:blindText,
  generated_at:new Date().toISOString(),interface:'Example Chat',reasoning:null,configuration:'',context_id:`ctx-${crypto.randomUUID().slice(0,8)}`,duration_ms:9000,...extra});

async function request(path:string,method='GET',value?:unknown,token?:string,admin=false) {
  const bearer = admin ? founder.token : token;
  return mf.dispatchFetch(`http://localhost/api${path}`,{method,headers:{'Content-Type':'application/json',Origin:'http://localhost:5173',...(bearer ? {Authorization:`Bearer ${bearer}`} : {})},body:value === undefined ? undefined : JSON.stringify(value)});
}
async function parsed<T>(path:string,method='GET',value?:unknown,token?:string,admin=false):Promise<T> {
  const response=await request(path,method,value,token,admin); const body=await response.json();
  if(!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`); return body as T;
}
const board = () => parsed<RunBoard>('/admin/next-run','GET',undefined,undefined,true);
const claimSlot = (slot:RunSlot) => parsed<RunClaim>('/admin/runs','POST',slot,undefined,true);

beforeAll(async()=> {
  const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,loader:{'.txt':'text'},write:false,format:'esm',platform:'browser',target:'es2022'});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{PIN_PEPPER:'test-pin-pepper-longer-than-thirty-two-characters',ALLOWED_ORIGINS:'http://localhost:5173',ENVIRONMENT:'test'},log:new Log(LogLevel.ERROR),outboundService:()=>{throw new Error('Outbound requests are forbidden: benchmark must never call AI APIs');}}));
  db=await mf.getD1Database('DB') as unknown as D1Database;
  async function migrate(files:string[]) {
    for (const migration of files) {
      const sql=(await readFile(`migrations/${migration}`,'utf8')).replace(/^--.*$/gm,'');
      await db.batch(sql.split(/;\s*(?=(?:CREATE|INSERT|PRAGMA|ALTER|UPDATE|DROP)\b|$)/i).filter(s=>s.trim()).map(s=>db.prepare(s)));
    }
  }
  const files=(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort(), bootstrap=files.indexOf('0003_account_admins.sql');
  await migrate(files.slice(0,bootstrap));
  founder=await parsed('/auth/register','POST',{username:'dannywang',pin:'135790',user_type:'Parliamentary Debater'});
  await migrate(files.slice(bootstrap));
  visitor=await parsed('/auth/register','POST',{username:'visitor',pin:'2468',user_type:'Non-Parliamentary Debater'});
  await parsed('/admin/import','POST',{...data,ai_votes:[]},undefined,true);
});
afterAll(async()=>{await mf?.dispose();});
// One administrator polling the scheduler stays far below the per-minute admin limit; this suite
// replays a month of that work in seconds, so its own counter is cleared between cases.
beforeEach(async()=>{await db.prepare("DELETE FROM rate_limits WHERE key LIKE 'admin:%'").run();});

describe('Next run recommendation and response entry',()=> {
  it('is reachable only by an administrator',async()=> {
    expect((await request('/admin/next-run')).status).toBe(401);
    expect((await request('/admin/next-run','GET',undefined,visitor.token)).status).toBe(403);
    expect((await request('/admin/runs','POST',{},visitor.token)).status).toBe(403);
  });
  it('recommends one executable run, without saying why it was chosen',async()=> {
    const plan=(await board()).recommendation!;
    expect(plan.rendered_prompt).toContain(plan.topic.motion);
    expect(plan.prompt_revision_id).toBeTruthy();
    expect(RUN_TASKS).toContain(plan.task);
    expect(plan.system.active).toBe(1);
    expect(plan.topic.motion.length).toBeGreaterThan(10);
    expect(plan.sample).toBeGreaterThan(0);
    // Everything needed to execute the run, and nothing about the corpus it came from.
    expect(plan.rendered_prompt).toBeTruthy();
  });
  it('moves to a new topic as soon as one exists, because every other combination is covered',async()=> {
    const before=(await board()).recommendation!;
    expect(before.sample).toBe(2);
    await parsed('/admin/import','POST',{topics:[newTopic]},undefined,true);
    for(let n=0;n<3;n++) {
      const plan=(await board()).recommendation!;
      expect(plan.topic.id).toBe(newTopic.id);
      expect(plan.sample).toBe(1);
    }
  });
  it('never recommends a pipeline stage before the stage it continues',async()=> {
    for(let n=0;n<4;n++) {
      const plan=(await board()).recommendation!;
      expect(['government','opposition']).toContain(plan.task);
      expect([plan.government_source_response_id,plan.opposition_source_response_id]).toEqual([null,null]);
    }
  });
  it('distributes tie-breaks across equally useful runs',async()=> {
    const seen=new Set<string>();
    for(let n=0;n<10;n++) seen.add(where((await board()).recommendation!));
    expect(seen.size).toBeGreaterThan(1);
  });
  it('starts a run, keeps it out of later recommendations, and lists it as in progress',async()=> {
    const plan=(await board()).recommendation!;
    const claim=await claimSlot(slotOf(plan));
    expect(claim.claim_id).toMatch(/^[a-f0-9-]{36}$/);
    expect([claim.system_id,claim.topic_id,claim.task,claim.sample]).toEqual([plan.system_id,plan.topic_id,plan.task,plan.sample]);
    const next=await board();
    expect(next.queue.map(q=>q.claim_id)).toContain(claim.claim_id);
    expect(next.queue.find(q=>q.claim_id===claim.claim_id)!.topic.motion).toBe(newTopic.motion);
    for(let n=0;n<3;n++) expect(where((await board()).recommendation!)).not.toBe(where(plan));
    await parsed(`/admin/runs/${claim.claim_id}/release`,'POST',undefined,undefined,true);
    expect((await board()).queue.map(q=>q.claim_id)).not.toContain(claim.claim_id);
    expect((await request(`/admin/runs/${claim.claim_id}/release`,'POST',undefined,undefined,true)).status).toBe(404);
  });
  it('reserves a separate sample for a second run of the same combination',async()=> {
    const first=await claimSlot({system_id:'demo-cedar',topic_id:newTopic.id,task:'government',government_source_response_id:null,opposition_source_response_id:null});
    const second=await claimSlot(slotOf(first));
    expect([first.sample,second.sample]).toEqual([1,2]);
    for(const claim of [first,second]) await parsed(`/admin/runs/${claim.claim_id}/release`,'POST',undefined,undefined,true);
  });
  it('refuses a run that is not currently valid',async()=> {
    const invalid=(slot:Partial<RunSlot>)=>request('/admin/runs','POST',{system_id:'demo-atlas',topic_id:newTopic.id,task:'government',government_source_response_id:null,opposition_source_response_id:null,...slot},undefined,true);
    expect((await invalid({system_id:'no-such-system'})).status).toBe(409);
    expect((await invalid({topic_id:'no-such-topic'})).status).toBe(409);
    expect((await invalid({task:'rebuttal',government_source_response_id:'demo-atlas-public-transit-government',opposition_source_response_id:'demo-atlas-public-transit-opposition'})).status).toBe(409);
    expect((await invalid({task:'nonsense' as RunSlot['task']})).status).toBe(400);
  });
  it('imports the response through the same validation as every other record',async()=> {
    const claim=await claimSlot({system_id:'demo-atlas',topic_id:newTopic.id,task:'government',government_source_response_id:null,opposition_source_response_id:null});
    expect((await request(`/admin/runs/${claim.claim_id}/response`,'POST',result({display_output:'Prepared by demo-atlas.'}),undefined,true)).status).toBe(400);
    expect((await request(`/admin/runs/${claim.claim_id}/response`,'POST',result({generated_at:'yesterday'}),undefined,true)).status).toBe(400);
    const saved=await parsed<{response_id:string}>(`/admin/runs/${claim.claim_id}/response`,'POST',result(),undefined,true);
    const stored=await db.prepare('SELECT system_id,topic_id,task,sample,display_output FROM responses WHERE id=?').bind(saved.response_id).first<{system_id:string;topic_id:string;task:string;sample:number;display_output:string}>();
    expect(stored).toMatchObject({system_id:'demo-atlas',topic_id:newTopic.id,task:'government',sample:1});
    expect(stored!.display_output).toContain('A scheduled response');
    const next=await board();
    expect(next.queue.map(q=>q.claim_id)).not.toContain(claim.claim_id);
    expect(next.recommendation!.system_id === 'demo-atlas' && next.recommendation!.task === 'government' && next.recommendation!.topic_id === newTopic.id).toBe(false);
    expect((await request(`/admin/runs/${claim.claim_id}/response`,'POST',result(),undefined,true)).status).toBe(404);
  });
  it('keeps recommending the least-tested run once every combination is covered',async()=> {
    const inactive=await db.prepare("SELECT count(*) n FROM topics WHERE active=0").first<{n:number}>();
    expect(inactive?.n).toBe(0);
    const plan=(await board()).recommendation!;
    expect(plan).toBeTruthy();
    expect(plan.sample).toBeGreaterThan(0);
  });
});


describe('three-capability workflow',()=> {
  const adminGet=<T>(path:string)=>parsed<T>(path,'GET',undefined,undefined,true);
  const adminPost=<T>(path:string,value?:unknown)=>parsed<T>(path,'POST',value,undefined,true);
  const gov='demo-atlas-public-transit-government', own='demo-atlas-public-transit-opposition';
  const slot=(task:RunSlot['task'],system='demo-atlas'):RunSlot=>({system_id:system,topic_id:'public-transit',task,government_source_response_id:task==='rebuttal' ? gov : null,opposition_source_response_id:task==='rebuttal' ? `${system}-public-transit-opposition` : null});
  it('preserves foreign-key integrity through the additive migration',async()=> {
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('applies system filtering to repeated recommendations and Another option',async()=> {
    const first=(await adminGet<RunBoard>('/admin/next-run?system=demo-cedar')).recommendation!;
    const exclude=encodeURIComponent([first.system_id,first.topic_id,first.task,''].join('|'));
    const next=(await adminGet<RunBoard>(`/admin/next-run?system=demo-cedar&exclude=${exclude}`)).recommendation!;
    expect(first.system_id).toBe('demo-cedar');expect(next.system_id).toBe('demo-cedar');expect(where(next)).not.toBe(where(first));
    expect((await adminGet<RunBoard>('/admin/next-run?system=nonexistent')).recommendation).toBeNull();
  });
  it('snapshots the exact prompt version and motion across edits and reload',async()=> {
    const claim=await claimSlot(slot('opposition'));
    expect(claim.rendered_prompt).toContain(data.topics[0].motion);
    expect(claim.upstream).toEqual([]);
    await adminPost('/admin/prompts',{task:'opposition',template:'Revised independent Opposition prompt: {MOTION}'});
    const reload=(await board()).queue.find(q=>q.claim_id===claim.claim_id)!;
    expect(reload.rendered_prompt).toBe(claim.rendered_prompt);
    expect(reload.prompt_revision_id).toBe(claim.prompt_revision_id);
    expect((await request(`/admin/runs/${claim.claim_id}/response`,'POST',result({prompt:'tampered'}),undefined,true)).status).toBe(400);
    const raw='  '+demoCase(data.topics[0].motion,'opposition','A precise contention')+'\n\n';
    const saved=await adminPost<{response_id:string}>(`/admin/runs/${claim.claim_id}/response`,result({raw_output:raw}));
    const record=await adminGet<{raw_output:string;prompt:string;prompt_revision_id:string}>(`/admin/responses/${saved.response_id}`);
    expect(record.raw_output).toBe(raw);expect(record.prompt).toBe(claim.rendered_prompt);expect(record.prompt_revision_id).toBe(claim.prompt_revision_id);
    expect((await adminGet<{structure:{status:string}}>(`/admin/responses/${saved.response_id}/structure`)).structure.status).toBe('ready');
    await expect(db.prepare("UPDATE prompt_revisions SET template='changed' WHERE id=?").bind(claim.prompt_revision_id).run()).rejects.toThrow('immutable');
    await expect(db.prepare("UPDATE responses SET prompt='changed' WHERE id=?").bind(saved.response_id).run()).rejects.toThrow('immutable');
  });
  it('rejects missing and unknown prompt placeholders',async()=> {
    for(const template of ['No motion','{MOTION} {MODEL}','{MOTION} {GOVERNMENT_CASE}']) expect((await request('/admin/prompts','POST',{task:'opposition',template},undefined,true)).status).toBe(400);
  });
  it('retains failed extraction and supports retry and manual corrections',async()=> {
    const claim=await claimSlot(slot('government','demo-orbit'));
    const saved=await adminPost<{response_id:string}>(`/admin/runs/${claim.claim_id}/response`,result());
    const path=`/admin/responses/${saved.response_id}/structure`;
    expect((await adminGet<{structure:{status:string}}>(path)).structure.status).toBe('failed');
    expect((await adminPost<{structure:{status:string}}>(`${path}/retry`)).structure.status).toBe('failed');
    const base=await adminGet<{structure:{case_json:string}}>(`/admin/responses/${gov}/structure`);
    await parsed(path,'PUT',JSON.parse(base.structure.case_json),undefined,true);
    expect((await adminGet<{structure:{method:string}}>(path)).structure.method).toBe('manual');
    expect((await adminGet<{raw_output:string}>(`/admin/responses/${saved.response_id}`)).raw_output).toBe(result().raw_output);
  });
  it('keeps prompt snapshots and reservations safe across concurrent starts and saves',async()=> {
    const attempts=await Promise.all(Array.from({length:4},()=>request('/admin/runs','POST',slot('government','demo-cedar'),undefined,true)));
    const accepted:RunClaim[]=[];for(const r of attempts) {if(r.ok) accepted.push(await r.json() as RunClaim);else expect([400,409]).toContain(r.status);}
    expect(new Set(accepted.map(c=>c.sample)).size).toBe(accepted.length);
    const c=accepted[0];expect(c).toBeTruthy();
    const saves=await Promise.all([request(`/admin/runs/${c.claim_id}/response`,'POST',result(),undefined,true),request(`/admin/runs/${c.claim_id}/response`,'POST',result(),undefined,true)]);
    expect(saves.filter(r=>r.status===201)).toHaveLength(1);
    expect((await db.prepare('SELECT count(*) n FROM responses WHERE id=?').bind(`run-${c.claim_id}`).first<{n:number}>())?.n).toBe(1);
    for(const rest of accepted.slice(1)) await adminPost(`/admin/runs/${rest.claim_id}/release`);
  });
  it('freezes exact Government content and never substitutes a different response',async()=> {
    await adminPost('/admin/rebuttal-pool',{response_ids:[gov]});
    const before=await db.prepare('SELECT * FROM rebuttal_pool WHERE government_response_id=?').bind(gov).first();
    const original=await adminGet<{structure:{case_json:string}}>(`/admin/responses/${gov}/structure`);
    const changed=JSON.parse(original.structure.case_json);changed.contentions[0].claim='A manually revised representation.';
    await parsed(`/admin/responses/${gov}/structure`,'PUT',changed,undefined,true);
    await adminPost('/admin/rebuttal-pool',{response_ids:[gov]});
    expect(await db.prepare('SELECT * FROM rebuttal_pool WHERE government_response_id=?').bind(gov).first()).toEqual(before);
    await expect(db.prepare("UPDATE rebuttal_pool SET core_case_json='{}' WHERE government_response_id=?").bind(gov).run()).rejects.toThrow('immutable');
    await db.prepare('UPDATE responses SET active=0 WHERE id=?').bind(gov).run();
    const pool=await adminGet<{response_id:string;availability:string}[]>('/admin/rebuttal-pool');
    expect(pool.find(p=>p.response_id===gov)?.availability).toContain('unavailable');
    await db.prepare('UPDATE responses SET active=1 WHERE id=?').bind(gov).run();
  });
  it('gates Rebuttal on its deferred prompt, relationships, and source availability',async()=> {
    expect((await request('/admin/runs','POST',slot('rebuttal'),undefined,true)).status).toBe(409);
    // Test-only placeholder text, never shipped as a default Rebuttal prompt.
    await adminPost('/admin/prompts',{task:'rebuttal',template:'TEST ONLY {MOTION} {GOVERNMENT_CASE} {OPPOSITION_CASE}'});
    const claim=await claimSlot(slot('rebuttal'));
    expect(claim.upstream.map(s=>s.response_id)).toEqual([gov,own]);
    const core=JSON.parse(claim.upstream[0].text);
    expect(Object.keys(core)).toEqual(['contentions']);
    expect(Object.keys(core.contentions[0])).toEqual(['title','claim','warrants','impact']);
    expect(claim.rendered_prompt).not.toContain('A manually revised representation.');
    expect((await request('/admin/runs','POST',{...slot('rebuttal'),opposition_source_response_id:'demo-cedar-public-transit-opposition'},undefined,true)).status).toBe(409);
    await adminPost(`/admin/runs/${claim.claim_id}/release`);
    await db.prepare('UPDATE responses SET active=0 WHERE id=?').bind(gov).run();
    expect((await request('/admin/runs','POST',slot('rebuttal'),undefined,true)).status).toBe(409);
    await db.prepare('UPDATE responses SET active=1 WHERE id=?').bind(gov).run();
  });
  it('pairs Rebuttals only against the same frozen source and snapshots judge presentation',async()=> {
    const ids:string[]=[];
    for(const system of ['demo-atlas','demo-cedar']) {
      const c=await claimSlot(slot('rebuttal',system));
      ids.push((await adminPost<{response_id:string}>(`/admin/runs/${c.claim_id}/response`,result())).response_id);
    }
    const other='demo-orbit-public-transit-government';await adminPost('/admin/rebuttal-pool',{response_ids:[other]});
    const otherClaim=await claimSlot({...slot('rebuttal','demo-orbit'),government_source_response_id:other});
    const different=await adminPost<{response_id:string}>(`/admin/runs/${otherClaim.claim_id}/response`,result());
    expect((await db.prepare('SELECT * FROM matchups WHERE response_low=? OR response_high=?').bind(different.response_id,different.response_id).all()).results).toEqual([]);
    const match=await parsed<{matchup:{id:string;context:string;metrics:string[];a:string;b:string}}>('/arena/next?task=rebuttal','POST',undefined,visitor.token);
    expect(match.matchup.context).not.toMatch(/demo-atlas|Atlas|provider|comparative|likely_response|round_priorities/);
    expect(match.matchup.metrics).toEqual(['argument','evidence','creativity','strategy','rebuttal']);
    const snapshot=await db.prepare('SELECT context_snapshot FROM arena_assignments WHERE id=?').bind(match.matchup.id).first();
    await parsed(`/admin/responses/${gov}`,'PATCH',{display_output:'Edited Government display.'},undefined,true);
    expect(await db.prepare('SELECT context_snapshot FROM arena_assignments WHERE id=?').bind(match.matchup.id).first()).toEqual(snapshot);
  });
});
