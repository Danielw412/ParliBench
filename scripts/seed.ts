import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createDemoData, demoMetricVote } from './demo-data';
import type { ArenaMatch, User } from '../shared/domain';

const data = createDemoData();
mkdirSync('demo',{recursive:true});
writeFileSync('demo/benchmark.json',JSON.stringify(data,null,2));
if (process.argv.includes('--export-only')) { console.log('Exported fictional fixture to demo/benchmark.json'); process.exit(0); }
const base = process.env.SEED_API_URL || 'http://127.0.0.1:8787/api';
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Demo seeding is local-only. Explicitly import demo/benchmark.json through admin for a remote demo.');
const vars = readFileSync('.dev.vars','utf8');
const secret = vars.match(/^ADMIN_SECRET=(.+)$/m)?.[1]?.trim();
if (!secret) throw new Error('Run npm run setup first');
async function call<T>(path:string, method='GET', body?:unknown, token?:string):Promise<T> {
  const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {}),...(path.startsWith('/admin') ? {'X-Admin-Secret':secret!} : {})},body:body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json() as {error?:string};
  if(!response.ok) throw new Error(`${response.status}: ${result.error}`); return result as T;
}
const existing = await call<{id:string}[]>('/systems');
if (!existing.some(s => s.id === 'demo-atlas')) {
  // Split AI votes from corpus to keep imports comfortable on lower D1 query quotas.
  await call('/admin/import','POST',{...data,ai_votes:[]});
  for(let i=0;i<data.ai_votes.length;i+=40) await call('/admin/import','POST',{ai_votes:data.ai_votes.slice(i,i+40)});
  console.log('Imported clearly fictional corpus and AI judgments.');
} else console.log('Demo corpus already exists; preserving existing records.');
for (const [i,username] of ['demo_debater','demo_observer','demo_debater_two','demo_observer_two'].entries()) {
  const user_type = i%2 ? 'Non-Parliamentary Debater' : 'Parliamentary Debater';
  let auth: {token:string;user:User};
  try { auth = await call('/auth/register','POST',{username,pin:'246810',user_type}); }
  catch(e) { if(!String(e).startsWith('Error: 409:')) throw e; auth = await call('/auth/login','POST',{username,pin:'246810'}); }
  const profile = await call<{judgment_count:number}>(`/profiles/${username}`);
  for(let n=profile.judgment_count;n<48;n++) {
    const task = ['government','prediction','standardized_rebuttal','full_opposition'][n%4];
    const {matchup} = await call<{matchup:ArenaMatch|null}>(`/arena/next?task=${task}`,'POST',undefined,auth.token);
    if(!matchup) continue;
    await call(`/judgments/${matchup.id}`,'POST',{overall:((n+i)%5)-2,metrics:demoMetricVote(matchup.metrics,n+i)},auth.token);
  }
  console.log(`Seeded ${username} (${user_type}).`);
}
console.log('Local demo ready. Sign in as demo_debater or demo_observer with PIN 246810. These accounts and votes are fictional.');
