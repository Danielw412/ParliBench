import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { createHistoricalDemoData as createDemoData } from '../scripts/demo-data';
import type { AccountRow, ArenaMatch, Judgment, Leaderboard, User } from '../shared/domain';
import { sanitizeDisplay } from '../worker/sanitize';
let mf:Miniflare, db:D1Database;
let founder:{token:string;user:User}, alice:{token:string;user:User}, bob:{token:string;user:User};
let first:ArenaMatch;
const data = createDemoData();
// `admin` sends the founding administrator's ordinary session: there is no separate admin credential.
async function request(path:string,method='GET',value?:unknown,token?:string,admin=false) {
  const bearer = admin ? founder.token : token;
  return mf.dispatchFetch(`http://localhost/api${path}`,{method,headers:{'Content-Type':'application/json',Origin:'http://localhost:5173',...(bearer ? {Authorization:`Bearer ${bearer}`} : {})},body:value === undefined ? undefined : JSON.stringify(value)});
}
async function parsed<T>(path:string,method='GET',value?:unknown,token?:string,admin=false):Promise<T> {
  const response=await request(path,method,value,token,admin); const result=await response.json();
  if(!response.ok) throw new Error(`${response.status} ${JSON.stringify(result)}`); return result as T;
}
beforeAll(async()=> {
  const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,loader:{'.txt':'text'},write:false,format:'esm',platform:'browser',target:'es2022'});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{PIN_PEPPER:'test-pin-pepper-longer-than-thirty-two-characters',ALLOWED_ORIGINS:'http://localhost:5173',ENVIRONMENT:'test'},log:new Log(LogLevel.ERROR),outboundService:()=>{throw new Error('Outbound requests are forbidden: benchmark must never call AI APIs');}}));
  db=await mf.getD1Database('DB') as unknown as D1Database;
  async function migrate(files:string[]) {
    for (const migration of files) {
      const sql=(await readFile(`migrations/${migration}`,'utf8')).replace(/^--.*$/gm,'');
      const statements=sql.split(/;\s*(?=(?:CREATE|INSERT|PRAGMA|ALTER|UPDATE|DROP)\b|$)/i).filter(s=>s.trim());
      await db.batch(statements.map(s=>db.prepare(s)));
    }
  }
  // Register the founding account before the bootstrap migration, exactly as production did.
  const files=(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort(), bootstrap=files.indexOf('0003_account_admins.sql');
  await migrate(files.slice(0,bootstrap));
  founder=await parsed('/auth/register','POST',{username:'dannywang',pin:'135790',user_type:'Parliamentary Debater'});
  await migrate(files.slice(bootstrap));
  await parsed('/admin/import','POST',{...data,ai_votes:[]},undefined,true);
  await parsed('/admin/import','POST',{ai_votes:data.ai_votes.slice(0,12)},undefined,true);
});
afterAll(async()=>{await mf?.dispose();});
describe('Worker + real local D1 integration',()=> {
  it('registers a user and issues a hashed persistent session',async()=> {
    alice=await parsed('/auth/register','POST',{username:'alice',pin:'123456',user_type:'Parliamentary Debater'});
    expect(alice.token).toMatch(/^[a-f0-9]{64}$/); expect(alice.user.username).toBe('alice');
    const stored=await db.prepare('SELECT pin_hash,pin_salt FROM users WHERE id=?').bind(alice.user.id).first<{pin_hash:string;pin_salt:string}>();
    expect(stored?.pin_hash).not.toContain('123456'); expect(stored?.pin_salt).toBeTruthy();
    expect(await db.prepare('SELECT token_hash FROM sessions WHERE token_hash=?').bind(alice.token).first()).toBeNull();
    expect((await parsed<User>('/auth/me','GET',undefined,alice.token)).username).toBe('alice');
  });
  it('enforces case-insensitive unique usernames',async()=> { expect((await request('/auth/register','POST',{username:'ALICE',pin:'1234',user_type:'Non-Parliamentary Debater'})).status).toBe(409); });
  it.each(['123','12345','1234567','12ab',' 1234'])('rejects invalid PIN %s',async(pin)=>{expect((await request('/auth/register','POST',{username:'invalid_pin',pin,user_type:'Parliamentary Debater'})).status).toBe(400);});
  it('accepts a 4-digit PIN and the other user type',async()=> { bob=await parsed('/auth/register','POST',{username:'bob',pin:'2468',user_type:'Non-Parliamentary Debater'}); expect(bob.user.user_type).toBe('Non-Parliamentary Debater'); });
  it('logs in case-insensitively, rejects incorrect PINs',async()=> { expect((await request('/auth/login','POST',{username:'Alice',pin:'654321'})).status).toBe(401); expect((await parsed<{token:string}>('/auth/login','POST',{username:'ALICE',pin:'123456'})).token).toHaveLength(64); });
  it('rejects unsafe usernames and missing registration fields',async()=> { expect((await request('/auth/register','POST',{username:"'; DROP TABLE users;",pin:'1234',user_type:'Parliamentary Debater'})).status).toBe(400); expect((await request('/auth/register','POST',{username:'missing_type',pin:'1234'})).status).toBe(400); });
  it('requires an account to obtain Arena responses',async()=>{expect((await request('/arena/next','POST')).status).toBe(401);});
  it('serves a complete blind matchup with filters and no provenance',async()=> {
    const r=await parsed<{matchup:ArenaMatch}>('/arena/next?category=Serious&task=government','POST',undefined,alice.token); first=r.matchup;
    expect(first.category).toBe('Serious'); expect(first.task).toBe('government'); expect(first.a.length).toBeGreaterThan(1500); expect(first.metrics).toHaveLength(4);
    expect(Object.keys(first).sort()).toEqual(['a','b','category','context','id','metrics','motion','task'].sort());
    expect(JSON.stringify(first)).not.toMatch(/demo-atlas|Atlas|Cedar|raw_output|configuration|system_id|Sources:/);
  });
  it('rejects invalid filters instead of silently broadening the selection',async()=>{expect((await request('/arena/next?task=nonsense','POST',undefined,alice.token)).status).toBe(400);});
  it.each(['prediction','standardized_rebuttal','full_opposition'])('retires %s from active Arena and rankings',async(task)=> {
    expect((await request(`/arena/next?task=${task}`,'POST',undefined,bob.token)).status).toBe(400);
    expect((await request(`/leaderboard?task=${task}`)).status).toBe(400);
  });
  it('keeps legacy pipeline rebuttals out of the active Rebuttal category',async()=> {
    expect((await parsed<{matchup:null}>('/arena/next?task=rebuttal','POST',undefined,bob.token)).matchup).toBeNull();
    expect((await parsed<Leaderboard>('/leaderboard?task=rebuttal&source=ai')).comparisons).toBe(0);
    expect((await parsed<Leaderboard>('/leaderboard?source=ai')).comparisons).toBe((await parsed<Leaderboard>('/leaderboard?task=government&source=ai')).comparisons);
  });
  it('prevents duplicate underlying matchups, even across simultaneous requests',async()=> {
    const results=await Promise.all(Array.from({length:12},()=>parsed<{matchup:ArenaMatch|null}>('/arena/next?category=Informal&task=government','POST',undefined,alice.token)));
    const issued=results.flatMap(r=>r.matchup?[r.matchup.id]:[]);
    const assignments=await db.prepare('SELECT matchup_id FROM arena_assignments WHERE user_id=?').bind(alice.user.id).all<{matchup_id:string}>();
    expect(issued.length).toBeLessThanOrEqual(6); expect(new Set(assignments.results.map(a=>a.matchup_id)).size).toBe(assignments.results.length);
    expect((await parsed<{matchup:null}>('/arena/next?category=Informal&task=government','POST',undefined,alice.token)).matchup).toBeNull();
  });
  it('uses both random A/B orientations',async()=> {
    for(let n=0;n<18;n++) await parsed('/arena/next?task=government','POST',undefined,bob.token);
    const assigned=await db.prepare('SELECT DISTINCT swapped FROM arena_assignments').all<{swapped:number}>(); expect(assigned.results.map(r=>r.swapped).sort()).toEqual([0,1]);
  });
  it('requires overall preference and accepts skipped metrics',async()=> {
    expect((await request(`/judgments/${first.id}`,'POST',{metrics:{}},alice.token)).status).toBe(400);
    const result=await parsed<{saved:boolean;names?:unknown}>(`/judgments/${first.id}`,'POST',{overall:2,metrics:{argument:1,evidence:null}},alice.token);
    expect(result.saved).toBe(true); expect(result.names).toBeUndefined();
    const m=await db.prepare('SELECT * FROM human_metric_votes WHERE vote_id=?').bind(first.id).all(); expect(m.results).toHaveLength(1);
  });
  it('stores canonical vote direction and rejects a second submission',async()=> {
    const row=await db.prepare('SELECT v.overall,aa.swapped FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id WHERE v.id=?').bind(first.id).first<{overall:number;swapped:number}>();
    expect(row?.overall).toBe(row?.swapped ? -2 : 2); expect((await request(`/judgments/${first.id}`,'POST',{overall:0,metrics:{}},alice.token)).status).toBe(409);
  });
  it('returns 400 for inapplicable metrics',async()=> { expect((await request(`/judgments/${first.id}`,'PUT',{overall:0,metrics:{threat:1}},alice.token)).status).toBe(400); });
  it('isolates ownership of judgment reads and edits',async()=> {
    expect((await request(`/judgments/${first.id}`,'GET',undefined,bob.token)).status).toBe(404); expect((await request(`/judgments/${first.id}`,'PUT',{overall:0,metrics:{}},bob.token)).status).toBe(404);
  });
  it('isolates personal votes from other humans and AI judges',async()=> {
    const a=await parsed<Leaderboard>('/profiles/alice/leaderboard?source=combined'); const b=await parsed<Leaderboard>('/profiles/bob/leaderboard?source=combined');
    expect(a.comparisons).toBe(1); expect(b.comparisons).toBe(0); expect(b.rows.every(r=>r.comparisons===0)).toBe(true);
    expect((await parsed<Leaderboard>('/leaderboard?source=human&subgroup=Non-Parliamentary%20Debater')).comparisons).toBe(0);
  });
  it('edits votes in place, replaces metric votes, and updates rankings immediately',async()=> {
    const before=await parsed<Leaderboard>('/profiles/alice/leaderboard');
    await parsed(`/judgments/${first.id}`,'PUT',{overall:-2,metrics:{creativity:-1}},alice.token);
    const after=await parsed<Leaderboard>('/profiles/alice/leaderboard'); expect(after.comparisons).toBe(1); expect(before.rows[0].id).not.toBe(after.rows[0].id);
    const detail=await parsed<Judgment>(`/judgments/${first.id}`,'GET',undefined,alice.token); expect(detail.overall).toBe(-2); expect(detail.metric_votes).toEqual({creativity:-1});
    const rev=await db.prepare('SELECT count(*) n FROM human_vote_revisions WHERE vote_id=?').bind(first.id).first<{n:number}>(); expect(rev?.n).toBe(2);
  });
  it('excludes skipped metrics and keeps overall and weighted rankings independent',async()=> {
    const overall=await parsed<Leaderboard>('/profiles/alice/leaderboard?metric=overall'), skipped=await parsed<Leaderboard>('/profiles/alice/leaderboard?metric=argument'), weighted=await parsed<Leaderboard>('/profiles/alice/leaderboard?metric=weighted');
    expect(overall.comparisons).toBe(1); expect(skipped.comparisons).toBe(0); expect(weighted.comparisons).toBe(1); expect(overall.rows[0].score).not.toBe(weighted.rows[0].score);
  });
  it('reveals names only after voting and when the setting is enabled',async()=> {
    await parsed('/settings','PATCH',{reveal_names:true},alice.token);
    const next=(await parsed<{matchup:ArenaMatch}>('/arena/next?task=government','POST',undefined,alice.token)).matchup; expect(next.names).toBeUndefined();
    expect((await request(`/judgments/${next.id}`,'GET',undefined,alice.token)).status).toBe(404);
    const result=await parsed<{names:{a:string;b:string}}>(`/judgments/${next.id}`,'POST',{overall:0,metrics:{}},alice.token); expect(result.names.a).toContain('[DEMO]');
  });
  it('grants admin only to administrator accounts, and ignores the retired admin header',async()=> {
    expect((await request('/admin/catalog','GET')).status).toBe(401);
    expect((await request('/admin/catalog','GET',undefined,alice.token)).status).toBe(403);
    const legacy=await mf.dispatchFetch('http://localhost/api/admin/catalog',{headers:{Origin:'http://localhost:5173','X-Admin-Secret':'test-admin-secret-with-more-than-thirty-two-characters'}});
    expect(legacy.status).toBe(401);
    expect((await request('/admin/catalog','GET',undefined,undefined,true)).status).toBe(200);
  });
  it('preserves raw text and already-seen snapshots after display edits',async()=> {
    const assigned=await db.prepare('SELECT m.response_low id FROM arena_assignments aa JOIN matchups m ON m.id=aa.matchup_id WHERE aa.id=?').bind(first.id).first<{id:string}>();
    const original=await parsed<{raw_output:string;display_output:string}>(`/admin/responses/${assigned!.id}`,'GET',undefined,undefined,true);
    await parsed(`/admin/responses/${assigned!.id}`,'PATCH',{display_output:'## Updated blind text\n\nA carefully revised argument.'},undefined,true);
    const current=await parsed<{raw_output:string;display_output:string}>(`/admin/responses/${assigned!.id}`,'GET',undefined,undefined,true); expect(current.raw_output).toBe(original.raw_output);
    const history=await parsed<Judgment>(`/judgments/${first.id}`,'GET',undefined,alice.token); expect([history.a,history.b]).toContain(original.display_output);
    await expect(db.prepare("UPDATE responses SET raw_output='tampered' WHERE id=?").bind(assigned!.id).run()).rejects.toThrow('immutable');
  });
  it('does not expose raw responses through public routes or profile data',async()=> {
    expect((await request(`/responses/${data.responses[0].id}`)).status).toBe(404);
    const response=await parsed('/systems/demo-atlas'); expect(JSON.stringify(response)).not.toContain('raw_output');
    const profile=await parsed('/profiles/alice'); expect(JSON.stringify(profile)).not.toMatch(/pin_hash|pin_salt|token_hash/);
  });
  it('preserves the original motion after topic metadata is edited',async()=> {
    const topic=await db.prepare('SELECT r.topic_id FROM arena_assignments aa JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low WHERE aa.id=?').bind(first.id).first<{topic_id:string}>();
    const original=data.topics.find(t=>t.id===topic!.topic_id)!;
    await parsed(`/admin/topics/${original.id}`,'PUT',{...original,motion:'An edited motion'},undefined,true);
    expect((await parsed<Judgment>(`/judgments/${first.id}`,'GET',undefined,alice.token)).motion).toBe(first.motion);
    await parsed(`/admin/topics/${original.id}`,'PUT',original,undefined,true);
  });
  it('rejects display text containing known system IDs',async()=> { expect((await request('/admin/import','POST',{responses:[{...data.responses[0],id:'identifying-run',sample:9,display_output:'Generated by demo-atlas.'}]},undefined,true)).status).toBe(400); });
  it('validates import duplicates atomically',async()=> {
    const response=await request('/admin/import','POST',{topics:[{id:'would-rollback',motion:'A test motion',category:'Serious'},data.topics[0]]},undefined,true); expect(response.status).toBe(400);
    expect(await db.prepare("SELECT id FROM topics WHERE id='would-rollback'").first()).toBeNull();
  });
  it('rejects broken references and cross-task AI votes',async()=> {
    expect((await request('/admin/import','POST',{ai_judges:[{id:'bad-judge',system_id:'missing',display_name:'Bad',version:'1'}]},undefined,true)).status).toBe(400);
    const vote={...data.ai_votes[0],id:'bad-task-vote',response_b:data.responses.find(r=>r.task==='prediction')!.id};
    expect((await request('/admin/import','POST',{ai_votes:[vote]},undefined,true)).status).toBe(400);
  });
  it('rejects incomplete Opposition relationships and reused contexts',async()=> {
    const run={...data.responses.find(r=>r.task==='rebuttal')!,id:'bad-rebuttal',sample:2,context_id:'ctx-0-0-prediction'};
    expect((await request('/admin/import','POST',{responses:[run]},undefined,true)).status).toBe(400);
    expect((await request('/admin/import','POST',{responses:[run],opposition_rebuttals:[{response_id:'bad-rebuttal',prediction_response_id:'demo-atlas-public-transit-prediction',fresh_context:1}]},undefined,true)).status).toBe(400);
  });
  it('supports cross-system prediction/rebuttal pipelines',async()=> {
    const run={...data.responses.find(r=>r.task==='rebuttal')!,id:'cross-rebuttal',system_id:'demo-cedar',sample:2,context_id:'cross-new-context'};
    expect((await request('/admin/import','POST',{responses:[run],opposition_rebuttals:[{response_id:'cross-rebuttal',prediction_response_id:'demo-atlas-public-transit-prediction',fresh_context:1}]},undefined,true)).status).toBe(201);
  });
  it('supports multiple samples but rejects duplicate sample numbers',async()=> {
    const run={...data.responses.find(r=>r.task==='government')!,id:'extra-sample',sample:2};
    expect((await request('/admin/import','POST',{responses:[run]},undefined,true)).status).toBe(201);
    expect((await request('/admin/import','POST',{responses:[{...run,id:'duplicate-sample'}]},undefined,true)).status).toBe(400);
  });
  it('separates AI judge rankings and does not count an older version twice',async()=> {
    const old=await parsed<Leaderboard>('/leaderboard?source=ai&judge=demo-judge-one');
    await parsed('/admin/import','POST',{ai_votes:[{...data.ai_votes[0],id:'newer-ai-version',version:'fixture-v2',judged_at:'2026-09-02T12:00:00.000Z'}]},undefined,true);
    expect((await parsed<Leaderboard>('/leaderboard?source=ai&judge=demo-judge-one')).comparisons).toBe(old.comparisons);
    expect((await parsed<Leaderboard>('/leaderboard?source=ai&judge=nonexistent')).comparisons).toBe(0);
  });
  it('validates configurable source and metric weights',async()=> {
    const catalog=await parsed<{weights:unknown[]}>('/admin/catalog','GET',undefined,undefined,true);
    expect((await request('/admin/weights','PUT',{source:{human:.9,ai:.5},benchmark:catalog.weights},undefined,true)).status).toBe(400);
    await parsed('/admin/weights','PUT',{source:{human:.75,ai:.25},benchmark:catalog.weights},undefined,true);
    expect((await parsed<Leaderboard>('/leaderboard?source=combined')).source_weights).toEqual({human:.75,ai:.25});
  });
  it('supports head-to-head with explicit insufficient-data states',async()=> { const result=await parsed<{breakdowns:{sufficient:boolean}[]}>('/compare/demo-atlas/demo-cedar'); expect(result.breakdowns).toHaveLength(13); expect(result.breakdowns.some(r=>!r.sufficient)).toBe(true); });
  it('enforces CORS without wildcard origins',async()=> {
    const denied=await mf.dispatchFetch('http://localhost/api/stats',{headers:{Origin:'https://untrusted.example'}}); expect(denied.status).toBe(403);
    const allowed=await request('/stats'); expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173'); expect(allowed.headers.get('Cache-Control')).toBe('no-store');
    const preflight=await mf.dispatchFetch('http://localhost/api/arena/next',{method:'OPTIONS',headers:{Origin:'http://localhost:5173'}}); expect(preflight.status).toBe(204);
  });
  it('bootstraps the founding administrator through the migration',async()=> {
    expect((await parsed<User>('/auth/me','GET',undefined,founder.token)).is_admin).toBe(1);
    expect((await parsed<User>('/auth/me','GET',undefined,alice.token)).is_admin).toBe(0);
    const admins=await db.prepare('SELECT username FROM users WHERE is_admin=1').all<{username:string}>();
    expect(admins.results.map(a=>a.username)).toEqual(['dannywang']);
  });
  it('lets an administrator promote and revoke another account',async()=> {
    const before=await parsed<{users:AccountRow[]}>('/admin/catalog','GET',undefined,undefined,true);
    expect(before.users.find(u=>u.username==='bob')?.is_admin).toBe(0);
    await parsed(`/admin/users/${bob.user.id}`,'PATCH',{is_admin:true},undefined,true);
    expect((await request('/admin/catalog','GET',undefined,bob.token)).status).toBe(200);
    await parsed(`/admin/users/${bob.user.id}`,'PATCH',{is_admin:false},undefined,true);
    expect((await request('/admin/catalog','GET',undefined,bob.token)).status).toBe(403);
    expect((await request(`/admin/users/${bob.user.id}`,'PATCH',{is_admin:true},alice.token)).status).toBe(403);
    expect((await request('/admin/users/missing-account','PATCH',{is_admin:true},undefined,true)).status).toBe(404);
  });
  it('never lets the last administrator lose access, including their own',async()=> {
    expect((await request(`/admin/users/${founder.user.id}`,'PATCH',{is_admin:false},undefined,true)).status).toBe(400);
    expect((await parsed<User>('/auth/me','GET',undefined,founder.token)).is_admin).toBe(1);
    await parsed(`/admin/users/${bob.user.id}`,'PATCH',{is_admin:true},undefined,true);
    await parsed(`/admin/users/${founder.user.id}`,'PATCH',{is_admin:false},undefined,true);
    expect((await request('/admin/catalog','GET',undefined,founder.token)).status).toBe(403);
    expect((await request(`/admin/users/${bob.user.id}`,'PATCH',{is_admin:false},bob.token)).status).toBe(400);
    expect((await parsed<User>('/auth/me','GET',undefined,bob.token)).is_admin).toBe(1);
  });
  it('rate-limits repeated PIN attempts',async()=> { for(let i=0;i<10;i++) await request('/auth/login','POST',{username:'nonexistent',pin:'1234'}); expect((await request('/auth/login','POST',{username:'nonexistent',pin:'1234'})).status).toBe(429); });
  it('expires and revokes sessions',async()=> { const logged=await parsed<{token:string}>('/auth/login','POST',{username:'bob',pin:'2468'}); await parsed('/auth/logout','POST',undefined,logged.token); expect((await request('/auth/me','GET',undefined,logged.token)).status).toBe(401); await db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').bind(bob.user.id).run(); expect((await request('/auth/me','GET',undefined,bob.token)).status).toBe(401); });
});
describe('display safety',()=> {
  it('removes raw HTML, citations, URLs and source sections',()=> { const result=sanitizeDisplay('Hello <script>alert(1)</script> **argument** [1]. See [evidence](https://example.com).\n\nSources:\nhttps://example.com'); expect(result).not.toMatch(/script|https|\[1\]|Sources/); expect(result).toContain('argument'); });
});
