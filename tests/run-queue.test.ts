import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { createDemoData } from '../scripts/demo-data';
import { RUN_TASKS, type RunBoard, type RunClaim, type RunPlan, type RunSlot, type User } from '../shared/domain';

let mf:Miniflare, db:D1Database;
let founder:{token:string;user:User}, visitor:{token:string;user:User};
const data = createDemoData();
const newTopic = {id:'scheduler-topic',motion:'This House would plan its own benchmark coverage.',category:'Serious'};
const blindText = '## A scheduled response\n\nThe argument is recorded here exactly as it was prepared for the round, with no identifying detail.';
const slotOf = (plan:RunPlan):RunSlot => ({system_id:plan.system_id,topic_id:plan.topic_id,task:plan.task,standardized_task_id:plan.standardized_task_id,prediction_response_id:plan.prediction_response_id,rebuttal_response_id:plan.rebuttal_response_id});
const where = (plan:RunPlan) => [plan.system_id,plan.topic_id,plan.task,plan.standardized_task_id || ''].join('/');
const result = (extra:Record<string,unknown> = {}) => ({prompt:'Prepare the assigned side of this motion.',raw_output:`${blindText}\n\nSources: none.`,display_output:blindText,
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
  const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{PIN_PEPPER:'test-pin-pepper-longer-than-thirty-two-characters',ALLOWED_ORIGINS:'http://localhost:5173',ENVIRONMENT:'test'},log:new Log(LogLevel.ERROR),outboundService:()=>{throw new Error('Outbound requests are forbidden: benchmark must never call AI APIs');}}));
  db=await mf.getD1Database('DB') as unknown as D1Database;
  async function migrate(files:string[]) {
    for (const migration of files) {
      const sql=(await readFile(`migrations/${migration}`,'utf8')).replace(/^--.*$/gm,'');
      await db.batch(sql.split(/;\s*(?=(?:CREATE|INSERT|PRAGMA|ALTER|UPDATE)\b|$)/i).filter(s=>s.trim()).map(s=>db.prepare(s)));
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
    expect(Object.keys(plan).sort()).toEqual(['prediction_response_id','prompt_reference','rebuttal_response_id','sample','standardized_case','standardized_task_id','system','system_id','task','topic','topic_id','upstream'].sort());
    expect(RUN_TASKS).toContain(plan.task);
    expect(plan.system.active).toBe(1);
    expect(plan.topic.motion.length).toBeGreaterThan(10);
    expect(plan.sample).toBeGreaterThan(0);
    // Everything needed to execute the run, and nothing about the corpus it came from.
    expect(plan.prompt_reference).toBeTruthy();
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
      expect(['government','prediction']).toContain(plan.task);
      expect([plan.prediction_response_id,plan.rebuttal_response_id,plan.standardized_case]).toEqual([null,null,null]);
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
    const first=await claimSlot({system_id:'demo-cedar',topic_id:newTopic.id,task:'government',standardized_task_id:null,prediction_response_id:null,rebuttal_response_id:null});
    const second=await claimSlot(slotOf(first));
    expect([first.sample,second.sample]).toEqual([1,2]);
    for(const claim of [first,second]) await parsed(`/admin/runs/${claim.claim_id}/release`,'POST',undefined,undefined,true);
  });
  it('refuses a run that is not currently valid',async()=> {
    const invalid=(slot:Partial<RunSlot>)=>request('/admin/runs','POST',{system_id:'demo-atlas',topic_id:newTopic.id,task:'government',standardized_task_id:null,prediction_response_id:null,rebuttal_response_id:null,...slot},undefined,true);
    expect((await invalid({system_id:'no-such-system'})).status).toBe(409);
    expect((await invalid({topic_id:'no-such-topic'})).status).toBe(409);
    expect((await invalid({task:'full_opposition',prediction_response_id:'demo-atlas-public-transit-prediction',rebuttal_response_id:'demo-atlas-public-transit-rebuttal'})).status).toBe(409);
    expect((await invalid({task:'nonsense' as RunSlot['task']})).status).toBe(400);
  });
  it('imports the response through the same validation as every other record',async()=> {
    const claim=await claimSlot({system_id:'demo-atlas',topic_id:newTopic.id,task:'government',standardized_task_id:null,prediction_response_id:null,rebuttal_response_id:null});
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
  it('carries the Opposition pipeline forward one stage at a time',async()=> {
    const context='ctx-scheduler-prediction';
    const prediction=await claimSlot({system_id:'demo-atlas',topic_id:newTopic.id,task:'prediction',standardized_task_id:null,prediction_response_id:null,rebuttal_response_id:null});
    const first=await parsed<{response_id:string}>(`/admin/runs/${prediction.claim_id}/response`,'POST',result({context_id:context}),undefined,true);
    expect(await db.prepare('SELECT response_id FROM opposition_predictions WHERE response_id=?').bind(first.response_id).first()).toBeTruthy();
    const rebuttal=await claimSlot({system_id:'demo-atlas',topic_id:newTopic.id,task:'rebuttal',standardized_task_id:null,prediction_response_id:first.response_id,rebuttal_response_id:null});
    expect(rebuttal.upstream.map(stage=>stage.response_id)).toEqual([first.response_id]);
    expect(rebuttal.upstream[0].text).toContain('A scheduled response');
    // Reusing the prediction's context is still rejected: the stage must run in a fresh thread.
    expect((await request(`/admin/runs/${rebuttal.claim_id}/response`,'POST',result({context_id:context}),undefined,true)).status).toBe(400);
    const second=await parsed<{response_id:string}>(`/admin/runs/${rebuttal.claim_id}/response`,'POST',result(),undefined,true);
    const prep=await claimSlot({system_id:'demo-atlas',topic_id:newTopic.id,task:'full_opposition',standardized_task_id:null,prediction_response_id:first.response_id,rebuttal_response_id:second.response_id});
    expect(prep.upstream).toHaveLength(2);
    const complete=await parsed<{response_id:string}>(`/admin/runs/${prep.claim_id}/response`,'POST',result(),undefined,true);
    expect(await db.prepare('SELECT response_id FROM opposition_preps WHERE response_id=?').bind(complete.response_id).first()).toBeTruthy();
    expect((await request('/admin/runs','POST',{system_id:'demo-atlas',topic_id:newTopic.id,task:'rebuttal',standardized_task_id:null,prediction_response_id:first.response_id,rebuttal_response_id:null},undefined,true)).status).toBe(409);
  });
  it('recommends the shared case as soon as one exists for a topic',async()=> {
    await parsed('/admin/import','POST',{standardized_rebuttal_tasks:[{id:'scheduler-case',topic_id:newTopic.id,title:'Shared case',case_text:'## The shared case\n\nA common Government case every Opposition run answers.'}]},undefined,true);
    const standardized=await claimSlot({system_id:'demo-orbit',topic_id:newTopic.id,task:'standardized_rebuttal',standardized_task_id:'scheduler-case',prediction_response_id:null,rebuttal_response_id:null});
    expect(standardized.standardized_case!.case_text).toContain('common Government case');
    await parsed(`/admin/runs/${standardized.claim_id}/release`,'POST',undefined,undefined,true);
  });
  it('keeps recommending the least-tested run once every combination is covered',async()=> {
    const inactive=await db.prepare("SELECT count(*) n FROM topics WHERE active=0").first<{n:number}>();
    expect(inactive?.n).toBe(0);
    const plan=(await board()).recommendation!;
    expect(plan).toBeTruthy();
    expect(plan.sample).toBeGreaterThan(0);
  });
});
