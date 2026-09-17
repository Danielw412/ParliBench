import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { createDemoData } from '../scripts/demo-data';
import { importSchema } from '../worker/validation';
import type { ArenaMatch, RunClaim, User } from '../shared/domain';
import type { AdminAccount, AdminAiVote, AdminAiVoteDetail, AdminHumanVote, AdminJudge, AdminOverview, AdminResponseRow, AuditEntry, ImpactReport, Page,
  PromptUsage, ResponseDetail, RunHistoryRow, SystemDetail, SystemStats, TopicStats } from '../shared/admin';

let mf:Miniflare, db:D1Database;
let founder:{token:string;user:User}, member:{token:string;user:User}, other:{token:string;user:User};
const data = createDemoData();
async function request(path:string,method='GET',value?:unknown,token?:string) {
  return mf.dispatchFetch(`http://localhost/api${path}`,{method,headers:{'Content-Type':'application/json',Origin:'http://localhost:5173',...(token ? {Authorization:`Bearer ${token}`} : {})},body:value === undefined ? undefined : JSON.stringify(value)});
}
async function parsed<T>(path:string,method='GET',value?:unknown,token?:string):Promise<T> {
  const response=await request(path,method,value,token); const body=await response.json();
  if(!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`); return body as T;
}
const admin = <T>(path:string,method='GET',value?:unknown) => parsed<T>(path,method,value,founder.token);
const status = async (path:string,method='GET',value?:unknown,token=founder.token) => (await request(path,method,value,token)).status;
const count = async (sql:string,...params:string[]) => (await db.prepare(sql).bind(...params).first<{n:number}>())!.n;
const blind = '## A recorded response\n\nThe argument is written here for the round, with no identifying detail at all.';
const response = (id:string,system_id:string,topic_id:string,sample=1) => ({id,system_id,topic_id,task:'government',raw_output:blind,display_output:blind,prompt:`Prepare ${topic_id}`,generated_at:'2026-09-02T10:00:00.000Z',interface:'Example Chat',context_id:`ctx-${id}`,sample});

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
  member=await parsed('/auth/register','POST',{username:'member',pin:'2468',user_type:'Non-Parliamentary Debater'});
  other=await parsed('/auth/register','POST',{username:'other',pin:'1357',user_type:'Non-Parliamentary Debater'});
  await admin('/admin/import','POST',{...data,ai_votes:[]});
  await admin('/admin/import','POST',{ai_votes:data.ai_votes});
  for (let n=0;n<4;n++) {
    const {matchup}=await parsed<{matchup:ArenaMatch}>('/arena/next?task=government','POST',undefined,member.token);
    await parsed(`/judgments/${matchup.id}`,'POST',{overall:n%2 ? 1 : -2,metrics:{argument:1}},member.token);
  }
});
afterAll(async()=>{await mf?.dispose();});
beforeEach(async()=>{await db.prepare("DELETE FROM rate_limits WHERE key LIKE 'admin:%' OR key LIKE 'account:%'").run();});

describe('Administrator console',()=> {
  it('refuses every console route to anyone without the administrator role',async()=> {
    const routes:[string,string][]=[['/admin/overview','GET'],['/admin/responses','GET'],['/admin/system-stats','GET'],['/admin/export','GET'],['/admin/audit','GET'],
      ['/admin/impact/system/demo-atlas','GET'],['/admin/responses/demo-atlas-spoilers-government','DELETE'],['/admin/systems/demo-atlas','DELETE'],['/admin/users/x','DELETE'],['/admin/human-votes','GET']];
    for (const [path,method] of routes) {
      expect(await status(path,method,undefined,'')).toBe(401);
      expect(await status(path,method,undefined,member.token)).toBe(403);
    }
    expect(await count('SELECT count(*) n FROM systems')).toBe(4);
  });
  it('summarizes corpus, coverage, and configuration on the overview',async()=> {
    const overview=await admin<AdminOverview>('/admin/overview');
    expect(overview.totals).toMatchObject({systems:4,active_systems:4,topics:4,responses:32,ai_votes:data.ai_votes.length,human_votes:4,users:3,admins:1,open_claims:0,extraction_failed:0});
    expect(overview.coverage.cells).toHaveLength(32);
    expect(overview.coverage.cells.every(c=>c.responses===1 && c.active===1)).toBe(true);
    expect(overview.recent_votes[0].username).toBe('member');
    expect(overview.configuration).toEqual({gemini:false,rebuttal_prompt:false,environment:'test'});
  });
  it('reports per-model statistics, rankings, and topic coverage',async()=> {
    const stats=await admin<SystemStats[]>('/admin/system-stats');
    expect(stats).toHaveLength(4);
    for (const system of stats) {
      expect(system).toMatchObject({responses:8,active_responses:8,government:4,opposition:4,rebuttal:0,topics_covered:4,extraction_ready:8,matchups:24});
      expect(system.ai_votes).toBe(data.ai_votes.filter(v=>[v.response_a,v.response_b].some(r=>String(r).startsWith(`${system.id}-`) && !String(r).startsWith(`${system.id}-tools`))).length);
      expect(system.combined?.comparisons).toBeGreaterThan(0);
    }
    expect(stats.find(s=>s.id==='demo-atlas')!.judges).toBe(1);
    expect(stats.reduce((n,s)=>n+s.human_votes,0)).toBe(8);
    const detail=await admin<SystemDetail>('/admin/system-stats/demo-cedar');
    expect(detail.topics.map(t=>[t.government,t.opposition])).toEqual([[1,1],[1,1],[1,1],[1,1]]);
    expect(detail.rankings).toHaveLength(7);
    expect(detail.recent).toHaveLength(8);
    expect(await status('/admin/system-stats/missing')).toBe(404);
    const topics=await admin<TopicStats[]>('/admin/topic-stats');
    expect(topics.every(t=>t.responses===8 && t.systems_covered===4 && t.matchups===12)).toBe(true);
  });
  it('lists responses with filters, search, and paging',async()=> {
    expect((await admin<Page<AdminResponseRow>>('/admin/responses?system=demo-atlas')).total).toBe(8);
    const page=await admin<Page<AdminResponseRow>>('/admin/responses?task=government&limit=5&offset=5&sort=system');
    expect([page.total,page.rows.length]).toEqual([16,5]);
    expect(page.rows.every(r=>r.task==='government')).toBe(true);
    expect((await admin<Page<AdminResponseRow>>('/admin/responses?q=Four-Day')).total).toBe(8);
    expect((await admin<Page<AdminResponseRow>>('/admin/responses?extraction=ready')).total).toBe(32);
    expect((await admin<Page<AdminResponseRow>>('/admin/responses?task=legacy')).total).toBe(0);
    expect(await status('/admin/responses?task=prediction')).toBe(400);
  });
  it('corrects provenance with a recorded revision while unrecorded tampering stays blocked',async()=> {
    const id='demo-orbit-spoilers-government';
    const before=await admin<ResponseDetail>(`/admin/responses/${id}/detail`);
    expect(before.response.provenance_revision).toBe(1);
    expect(before.counts.matchups).toBe(3);
    const corrected=before.response.raw_output+'\n\nA sentence that was missing from the pasted output.';
    expect(await status(`/admin/responses/${id}`,'PUT',{raw_output:before.response.raw_output})).toBe(400);
    await admin(`/admin/responses/${id}`,'PUT',{raw_output:corrected,interface:'Corrected interface',reason:'Pasted output was truncated',reextract:true});
    const after=await admin<ResponseDetail>(`/admin/responses/${id}/detail`);
    expect(after.response).toMatchObject({raw_output:corrected,interface:'Corrected interface',provenance_revision:2,prompt:before.response.prompt});
    expect(after.revisions).toHaveLength(1);
    expect(JSON.parse(after.revisions[0].snapshot_json)).toMatchObject({raw_output:before.response.raw_output,interface:before.response.interface});
    expect(after.revisions[0].reason).toBe('Pasted output was truncated');
    expect(after.structure).toMatchObject({status:'ready',method:'headings'});
    await expect(db.prepare("UPDATE responses SET raw_output='tampered' WHERE id=?").bind(id).run()).rejects.toThrow('immutable');
    await expect(db.prepare("UPDATE responses SET raw_output='tampered',provenance_revision=provenance_revision+1 WHERE id=?").bind(id).run()).rejects.toThrow('immutable');
    await db.prepare("INSERT INTO response_revisions(response_id,revision,snapshot_json) VALUES(?,2,'{}')").bind(id).run();
    await expect(db.prepare("UPDATE responses SET topic_id='public-transit',provenance_revision=3 WHERE id=?").bind(id).run()).rejects.toThrow('immutable');
    await db.prepare('DELETE FROM response_revisions WHERE response_id=? AND revision=2').bind(id).run();
  });
  it('reassigns a response to another system only when pairs and samples stay valid',async()=> {
    await admin('/admin/import','POST',{topics:[{id:'reassign-topic',motion:'This House would test reassignment.',category:'Informal'}],
      responses:[response('reassign-a','demo-orbit','reassign-topic'),response('reassign-b','demo-cedar','reassign-topic'),response('reassign-c','demo-atlas','reassign-topic',2)]});
    expect(await status('/admin/responses/reassign-a','PUT',{system_id:'demo-cedar'})).toBe(409);
    expect(await status('/admin/responses/reassign-a','PUT',{system_id:'missing-system'})).toBe(400);
    await admin('/admin/responses/reassign-a','PUT',{system_id:'demo-atlas-tools',reason:'Recorded under the wrong configuration'});
    const detail=await admin<ResponseDetail>('/admin/responses/reassign-a/detail');
    expect([detail.response.system_id,detail.response.provenance_revision,detail.counts.matchups]).toEqual(['demo-atlas-tools',2,2]);
    expect(await status('/admin/responses/reassign-c','PUT',{system_id:'demo-atlas-tools'})).toBe(409);
    expect(await status('/admin/responses/reassign-c','PUT',{sample:1})).toBe(200);
    expect(await status('/admin/responses/reassign-a','PUT',{system_id:'demo-atlas',sample:1})).toBe(409);
  });
  it('toggles response status and revises display text with an audit trail',async()=> {
    await admin('/admin/responses/reassign-b','PATCH',{active:0});
    expect((await admin<Page<AdminResponseRow>>('/admin/responses?active=0')).rows.map(r=>r.id)).toEqual(['reassign-b']);
    expect(await status('/admin/responses/reassign-b','PATCH',{display_output:'Written by demo-cedar.'})).toBe(400);
    await admin('/admin/responses/reassign-b','PATCH',{display_output:'## A revised display\n\nThe blind text was tidied.',active:1});
    const detail=await admin<ResponseDetail>('/admin/responses/reassign-b/detail');
    expect([detail.response.active,detail.response.display_version,detail.display_revisions.length]).toEqual([1,2,2]);
    expect(await status('/admin/responses/missing','PATCH',{active:0})).toBe(404);
  });
  it('previews and performs a cascading response delete, keeping foreign keys intact',async()=> {
    // Public transit stays intact for the Rebuttal Pool case below.
    const voted=await db.prepare("SELECT m.response_low id FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low WHERE r.topic_id<>'public-transit' LIMIT 1").first<{id:string}>();
    const preview=await admin<ImpactReport>(`/admin/impact/response/${voted!.id}`);
    expect(preview).toMatchObject({responses:1,dependent_responses:0,matchups:3,blockers:[]});
    expect(preview.human_votes).toBeGreaterThan(0);
    expect(preview.ai_votes).toBeGreaterThan(0);
    const votesBefore=await count('SELECT count(*) n FROM human_votes');
    await admin(`/admin/responses/${voted!.id}?reason=Duplicate%20sample`,'DELETE');
    expect(await count('SELECT count(*) n FROM responses WHERE id=?',voted!.id)).toBe(0);
    expect(await count('SELECT count(*) n FROM matchups WHERE response_low=?1 OR response_high=?1',voted!.id)).toBe(0);
    expect(await count('SELECT count(*) n FROM human_votes')).toBe(votesBefore-preview.human_votes);
    const entry=(await admin<Page<AuditEntry>>('/admin/audit?entity=response')).rows.find(e=>e.action==='delete' && e.entity_id===voted!.id)!;
    expect(JSON.parse(entry.detail_json)).toMatchObject({reason:'Duplicate sample',record:{id:voted!.id}});
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await status(`/admin/responses/${voted!.id}`,'DELETE')).toBe(404);
  });
  it('removes a frozen source only explicitly, only when unused, and cascades Rebuttals built on it',async()=> {
    const gov='demo-atlas-public-transit-government';
    await admin('/admin/rebuttal-pool','POST',{response_ids:[gov]});
    await expect(db.prepare('DELETE FROM rebuttal_pool WHERE government_response_id=?').bind(gov).run()).rejects.toThrow('historical');
    await admin('/admin/prompts','POST',{task:'rebuttal',template:'TEST ONLY {MOTION} {GOVERNMENT_CASE} {OPPOSITION_CASE}'});
    const slot={system_id:'demo-cedar',topic_id:'public-transit',task:'rebuttal',government_source_response_id:gov,opposition_source_response_id:'demo-cedar-public-transit-opposition'};
    const claim=await admin<RunClaim>('/admin/runs','POST',slot);
    expect(await status(`/admin/rebuttal-pool/${gov}`,'DELETE')).toBe(409);
    await admin(`/admin/runs/${claim.claim_id}/release`,'POST');
    await admin(`/admin/rebuttal-pool/${gov}?reason=Froze%20the%20wrong%20case`,'DELETE');
    expect(await count('SELECT count(*) n FROM rebuttal_pool_removals WHERE government_response_id=?',gov)).toBe(1);
    expect(await status(`/admin/rebuttal-pool/${gov}`,'DELETE')).toBe(404);
    await admin('/admin/rebuttal-pool','POST',{response_ids:[gov]});
    const second=await admin<RunClaim>('/admin/runs','POST',slot);
    const saved=await admin<{response_id:string}>(`/admin/runs/${second.claim_id}/response`,'POST',{raw_output:blind,display_output:blind,generated_at:new Date().toISOString(),interface:'Example Chat',reasoning:null,configuration:'',context_id:'fresh-rebuttal',duration_ms:null});
    expect((await admin<ImpactReport>(`/admin/impact/response/${gov}`)).dependent_responses).toBe(1);
    expect(await status(`/admin/responses/${saved.response_id}`,'PUT',{system_id:'demo-orbit'})).toBe(409);
    expect(await status('/admin/responses/demo-cedar-public-transit-opposition','PUT',{system_id:'demo-orbit'})).toBe(409);
    const prompts=await admin<PromptUsage[]>('/admin/prompts');
    expect(prompts.find(p=>p.task==='rebuttal')).toMatchObject({claims:2,responses:1});
    await admin(`/admin/responses/${gov}`,'DELETE');
    expect(await count('SELECT count(*) n FROM responses WHERE id IN (?,?)',gov,saved.response_id)).toBe(0);
    expect(await count('SELECT count(*) n FROM rebuttal_pool')).toBe(0);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('lists and prunes run records, but never an in-progress run',async()=> {
    const slot={system_id:'demo-orbit',topic_id:'spoilers',task:'opposition',government_source_response_id:null,opposition_source_response_id:null};
    const released=await admin<RunClaim>('/admin/runs','POST',slot);
    await admin(`/admin/runs/${released.claim_id}/release`,'POST');
    const runs=await admin<Page<RunHistoryRow>>('/admin/runs?status=released');
    expect(runs.rows.map(r=>[r.id,r.system_name,r.prompt_version])).toEqual([[released.claim_id,'Orbit / Workspace [DEMO]',1]]);
    const open=await admin<RunClaim>('/admin/runs','POST',slot);
    expect(await status(`/admin/runs/${open.claim_id}`,'DELETE')).toBe(409);
    await admin(`/admin/runs/${released.claim_id}`,'DELETE');
    expect((await admin<Page<RunHistoryRow>>('/admin/runs?status=released')).total).toBe(0);
    expect((await admin<Page<RunHistoryRow>>('/admin/runs?status=open&system=demo-orbit')).rows[0].id).toBe(open.claim_id);
    await admin(`/admin/runs/${open.claim_id}/release`,'POST');
  });
  it('browses and deletes individual AI judgments, whole judges, and human votes',async()=> {
    const judges=await admin<AdminJudge[]>('/admin/judges');
    const two=judges.find(j=>j.id==='demo-judge-two')!;
    const list=await admin<Page<AdminAiVote>>('/admin/ai-votes?judge=demo-judge-two&limit=10');
    expect(list.total).toBe(two.votes);
    const detail=await admin<AdminAiVoteDetail>(`/admin/ai-votes/${list.rows[0].id}`);
    expect(detail.snapshot_low.length).toBeGreaterThan(50);
    await admin(`/admin/ai-votes/${list.rows[0].id}`,'DELETE');
    expect((await admin<Page<AdminAiVote>>('/admin/ai-votes?judge=demo-judge-two')).total).toBe(two.votes-1);
    expect(await status('/admin/judges/demo-judge-two','PUT',{display_name:'Renamed judge',version:'v2',system_id:'missing'})).toBe(400);
    await admin('/admin/judges/demo-judge-two','PUT',{display_name:'Renamed judge',version:'v2',system_id:'demo-orbit'});
    expect((await admin<AdminJudge[]>('/admin/judges')).find(j=>j.id==='demo-judge-two')).toMatchObject({display_name:'Renamed judge',system_id:'demo-orbit'});
    expect((await admin<ImpactReport>('/admin/impact/judge/demo-judge-one')).ai_votes).toBe(judges.find(j=>j.id==='demo-judge-one')!.votes);
    await admin('/admin/judges/demo-judge-one','DELETE');
    expect(await count("SELECT count(*) n FROM ai_votes WHERE judge_id='demo-judge-one'")).toBe(0);
    expect(await count("SELECT count(*) n FROM ai_judges WHERE id='demo-judge-one'")).toBe(0);
    const human=await admin<Page<AdminHumanVote>>(`/admin/human-votes?user=${member.user.id}`);
    expect(human.rows.every(v=>v.username==='member')).toBe(true);
    await admin(`/admin/human-votes/${human.rows[0].id}`,'DELETE');
    expect((await admin<Page<AdminHumanVote>>(`/admin/human-votes?user=${member.user.id}`)).total).toBe(human.total-1);
    expect(await status(`/judgments/${human.rows[0].id}`,'GET',undefined,member.token)).toBe(404);
  });
  it('clears only stale unvoted assignments',async()=> {
    const {matchup}=await parsed<{matchup:ArenaMatch}>('/arena/next?task=opposition','POST',undefined,member.token);
    expect((await admin<{cleared:number}>('/admin/assignments/cleanup','POST',{older_than_hours:1})).cleared).toBe(0);
    await db.prepare("UPDATE arena_assignments SET issued_at='2020-01-01T00:00:00.000Z' WHERE id=?").bind(matchup.id).run();
    const votes=await count('SELECT count(*) n FROM human_votes');
    expect((await admin<{cleared:number}>('/admin/assignments/cleanup','POST',{older_than_hours:1,user_id:member.user.id})).cleared).toBe(1);
    expect(await count('SELECT count(*) n FROM human_votes')).toBe(votes);
  });
  it('manages accounts: rename, type, PIN reset, sessions, and deletion',async()=> {
    const votes=await count('SELECT count(*) n FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id WHERE aa.user_id=?',member.user.id);
    expect((await admin<Page<AdminAccount>>('/admin/accounts?q=memb')).rows.map(a=>[a.username,a.votes])).toEqual([['member',votes]]);
    expect(await status(`/admin/users/${other.user.id}`,'PATCH',{username:'MEMBER'})).toBe(409);
    await admin(`/admin/users/${other.user.id}`,'PATCH',{username:'renamed_other',user_type:'Parliamentary Debater'});
    expect((await parsed<User>('/auth/me','GET',undefined,other.token))).toMatchObject({username:'renamed_other',user_type:'Parliamentary Debater'});
    expect(await status(`/admin/users/${other.user.id}/pin`,'POST',{pin:'12'})).toBe(400);
    await admin(`/admin/users/${other.user.id}/pin`,'POST',{pin:'975310'});
    expect(await status('/auth/me','GET',undefined,other.token)).toBe(401);
    expect(await status('/auth/login','POST',{username:'renamed_other',pin:'1357'},'')).toBe(401);
    const login=await parsed<{token:string}>('/auth/login','POST',{username:'renamed_other',pin:'975310'});
    expect((await admin<{revoked:number}>(`/admin/users/${other.user.id}/sessions`,'DELETE')).revoked).toBe(1);
    expect(await status('/auth/me','GET',undefined,login.token)).toBe(401);
    await admin(`/admin/users/${founder.user.id}/sessions`,'DELETE');
    expect(await status('/auth/me','GET',undefined,founder.token)).toBe(200);
    const self=await admin<ImpactReport>(`/admin/impact/user/${founder.user.id}`);
    expect(self.blockers.length).toBeGreaterThan(0);
    expect(await status(`/admin/users/${founder.user.id}`,'DELETE')).toBe(409);
    const impact=await admin<ImpactReport>(`/admin/impact/user/${member.user.id}`);
    expect([impact.human_votes,impact.blockers]).toEqual([votes,[]]);
    await admin(`/admin/users/${member.user.id}`,'DELETE');
    expect(await status('/auth/login','POST',{username:'member',pin:'2468'},'')).toBe(401);
    expect(await count('SELECT count(*) n FROM arena_assignments WHERE user_id=?',member.user.id)).toBe(0);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('bulk deactivates, activates, retries extraction, and deletes responses',async()=> {
    const ids=['reassign-a','reassign-b','reassign-c'];
    expect((await admin<{affected:number}>('/admin/responses/bulk','POST',{ids,action:'deactivate'})).affected).toBe(3);
    expect((await admin<Page<AdminResponseRow>>('/admin/responses?topic=reassign-topic&active=0')).total).toBe(3);
    await admin('/admin/responses/bulk','POST',{ids,action:'activate'});
    expect((await admin<{affected:number}>('/admin/responses/bulk','POST',{ids,action:'retry_extraction'})).affected).toBe(3);
    expect(await status('/admin/responses/bulk','POST',{ids,action:'explode'})).toBe(400);
    expect((await admin<{affected:number}>('/admin/responses/bulk','POST',{ids:[...ids,'missing'],action:'delete'})).affected).toBe(3);
    expect(await count("SELECT count(*) n FROM responses WHERE topic_id='reassign-topic'")).toBe(0);
  });
  it('deletes whole systems and topics with everything that depends on them',async()=> {
    const system=await admin<ImpactReport>('/admin/impact/system/demo-orbit');
    expect(system).toMatchObject({responses:8,judges:1,blockers:[]});
    await admin('/admin/systems/demo-orbit','DELETE');
    expect(await count("SELECT count(*) n FROM responses WHERE system_id='demo-orbit'")).toBe(0);
    expect(await count("SELECT count(*) n FROM ai_judges WHERE system_id='demo-orbit'")).toBe(0);
    expect(await count("SELECT count(*) n FROM run_claims WHERE system_id='demo-orbit'")).toBe(0);
    const topic=await admin<ImpactReport>('/admin/impact/topic/four-day-week');
    expect(topic.responses).toBe(await count("SELECT count(*) n FROM responses WHERE topic_id='four-day-week'"));
    await admin('/admin/topics/four-day-week','DELETE');
    expect(await count("SELECT count(*) n FROM topics WHERE id='four-day-week'")).toBe(0);
    expect((await admin<AdminOverview>('/admin/overview')).totals).toMatchObject({systems:3,topics:4});
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await status('/admin/systems/demo-orbit','DELETE')).toBe(404);
  });
  it('exports a re-importable corpus and a credential-free backup',async()=> {
    const corpus=await admin<Record<string,unknown[]>>('/admin/export');
    expect(importSchema.safeParse(corpus).success).toBe(true);
    expect(corpus.systems).toHaveLength(3);
    const backup=await admin<{tables:Record<string,unknown[]>}>('/admin/export?scope=backup');
    expect(backup.tables.users.length).toBe(2);
    expect(JSON.stringify(backup)).not.toMatch(/pin_hash|pin_salt|token_hash/);
    expect(backup.tables.admin_audit.length).toBeGreaterThan(10);
  });
  it('records every administrator change in a searchable audit log',async()=> {
    const log=await admin<Page<AuditEntry>>('/admin/audit?limit=200');
    const actions=new Set(log.rows.map(e=>`${e.action}:${e.entity}`));
    for (const expected of ['import:benchmark','correct:response','display:response','delete:response','delete:system','delete:topic','delete:judge','delete:user','delete:human_vote','delete:ai_vote','unfreeze:rebuttal_pool','freeze:rebuttal_pool','revise:prompt','account:user','cleanup:assignment','export:benchmark','start:run','release:run'])
      expect(actions).toContain(expected);
    expect(log.rows.every(e=>e.actor_username==='dannywang')).toBe(true);
    expect((await admin<Page<AuditEntry>>('/admin/audit?q=renamed_other')).total).toBeGreaterThan(0);
  });
});
