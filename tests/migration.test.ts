import { it, expect } from 'vitest';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';

it('migrates a populated legacy database without changing responses, relationships or snapshots',async()=> {
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],log:new Log(LogLevel.ERROR)}));
  try {
    const db=await mf.getD1Database('DB');
    async function migrate(file:string) {
      const sql=(await readFile(`migrations/${file}`,'utf8')).replace(/^--.*$/gm,'');
      await db.batch(sql.split(/;\s*(?=(?:CREATE|INSERT|PRAGMA|ALTER|UPDATE|DROP)\b|$)/i).filter(s=>s.trim()).map(s=>db.prepare(s)));
    }
    const files=(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort();
    for(const file of files.filter(f=>!f.startsWith('0005'))) await migrate(file);
    await db.batch([
      db.prepare("INSERT INTO systems(id,display_name,provider,model,interface) VALUES('s','System','Provider','Model','Interface'),('s2','Second','Provider','Model','Interface')"),
      db.prepare("INSERT INTO topics(id,motion,category) VALUES('t','Historical motion','Serious')"),
      db.prepare("INSERT INTO users(id,username,pin_hash,pin_salt,user_type) VALUES('u','historical','hash','salt','Parliamentary Debater')"),
      ...['government','prediction','rebuttal','full_opposition'].map(task=>db.prepare('INSERT INTO responses(id,system_id,topic_id,task,raw_output,display_output,prompt,generated_at,interface,context_id) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(task,'s','t',task,'  Original raw\n','Original display','  Exact prompt\n','2026-01-01','Original interface',task)),
      db.prepare("INSERT INTO responses(id,system_id,topic_id,task,raw_output,display_output,prompt,generated_at,interface,context_id) VALUES('second','s2','t','government','Raw','Display','Prompt','2026-01-01','Interface','ctx2')"),
      db.prepare("INSERT INTO opposition_predictions VALUES('prediction')"),
      db.prepare("INSERT INTO opposition_rebuttals VALUES('rebuttal','prediction',1)"),
      db.prepare("INSERT INTO opposition_preps VALUES('full_opposition','prediction','rebuttal')"),
      db.prepare("INSERT INTO standardized_rebuttal_tasks VALUES('standard','t','Title','government','Exact shared case')"),
      db.prepare("INSERT INTO response_display_revisions(response_id,version,display_output) VALUES('government',1,'Historical display')"),
      db.prepare("INSERT INTO matchups VALUES('pair','government','second')"),
      db.prepare("INSERT INTO arena_assignments(id,user_id,matchup_id,swapped,snapshot_low,snapshot_high,context_snapshot) VALUES('assignment','u','pair',0,'Original A','Original B','Original context')"),
      db.prepare("INSERT INTO human_votes(id,overall) VALUES('assignment',1)"),
      db.prepare("INSERT INTO run_claims(id,system_id,topic_id,task,sample) VALUES('old-claim','s','t','government',2)"),
    ]);
    const responses=(await db.prepare('SELECT * FROM responses ORDER BY id').all()).results;
    const tables=['arena_assignments','matchups','human_votes','opposition_predictions','opposition_rebuttals','opposition_preps','response_display_revisions','standardized_rebuttal_tasks'];
    const before=await Promise.all(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all()));
    await migrate('0005_three_capabilities.sql');
    for(const row of responses) expect(await db.prepare('SELECT * FROM responses WHERE id=?').bind(row.id).first()).toMatchObject(row);
    for(let i=0;i<tables.length;i++) expect((await db.prepare(`SELECT * FROM ${tables[i]}`).all()).results).toEqual(before[i].results);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await db.prepare("SELECT status FROM run_claims WHERE id='old-claim'").first()).toEqual({status:'released'});
    await expect(db.prepare("UPDATE responses SET prompt='rewrite' WHERE id='government'").run()).rejects.toThrow('immutable');
  } finally {await mf.dispose();}
});
