import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createDemoData, demoMetricVote } from './demo-data';
import type { ArenaMatch, User } from '../shared/domain';

const data = createDemoData();
mkdirSync('demo',{recursive:true});
writeFileSync('demo/benchmark.json',JSON.stringify(data,null,2));
if (process.argv.includes('--export-only')) { console.log('Exported fictional fixture to demo/benchmark.json'); process.exit(0); }
const base = process.env.SEED_API_URL || 'http://127.0.0.1:8787/api';
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Demo seeding is local-only. Explicitly import demo/benchmark.json through admin for a remote demo.');
async function call<T>(path:string, method='GET', body?:unknown, token?:string):Promise<T> {
  const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},body:body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json() as {error?:string};
  if(!response.ok) throw new Error(`${response.status}: ${result.error}`); return result as T;
}
const usernames = ['demo_debater','demo_observer','demo_debater_two','demo_observer_two'];
const accounts:{token:string;user:User}[] = [];
for (const [i,username] of usernames.entries()) {
  const user_type = i%2 ? 'Non-Parliamentary Debater' : 'Parliamentary Debater';
  try { accounts.push(await call('/auth/register','POST',{username,pin:'246810',user_type})); }
  catch(e) { if(!String(e).startsWith('Error: 409:')) throw e; accounts.push(await call('/auth/login','POST',{username,pin:'246810'})); }
}
// Importing is an administrator action. The local demo administrator is granted straight in D1,
// mirroring the migration that promoted the founding account in production.
const admin = accounts[0];
if (!admin.user.is_admin) execFileSync('node',['scripts/grant-admin.mjs',usernames[0]],{stdio:'inherit'});
const existing = await call<{id:string}[]>('/systems');
if (!existing.some(s => s.id === 'demo-atlas')) {
  // Split AI votes from corpus to keep imports comfortable on lower D1 query quotas.
  await call('/admin/import','POST',{...data,ai_votes:[]},admin.token);
  for(let i=0;i<data.ai_votes.length;i+=40) await call('/admin/import','POST',{ai_votes:data.ai_votes.slice(i,i+40)},admin.token);
  console.log('Imported clearly fictional corpus and AI judgments.');
} else console.log('Demo corpus already exists; preserving existing records.');
for (const [i,auth] of accounts.entries()) {
  const username = auth.user.username;
  const profile = await call<{judgment_count:number}>(`/profiles/${username}`);
  for(let n=profile.judgment_count;n<48;n++) {
    const task = ['government','opposition'][n%2];
    const {matchup} = await call<{matchup:ArenaMatch|null}>(`/arena/next?task=${task}`,'POST',undefined,auth.token);
    if(!matchup) continue;
    await call(`/judgments/${matchup.id}`,'POST',{overall:((n+i)%5)-2,metrics:demoMetricVote(matchup.metrics,n+i)},auth.token);
  }
  console.log(`Seeded ${username} (${auth.user.user_type}).`);
}
console.log('Local demo ready. Sign in as demo_debater or demo_observer with PIN 246810. These accounts and votes are fictional.');
console.log(`${usernames[0]} is the local demo administrator and can open /admin.`);
