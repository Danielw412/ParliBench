import { z, ZodError } from 'zod';
import { credentials, registration, filterSchema, id, systemSchema, topicSchema } from './validation';
import { createSession, digest, equalSecret, hashPin, rateLimit, requireAdmin, requireUser } from './auth';
import { HttpError, one, rows } from './db';
import { bulkImport } from './importer';
import { nextMatch, saveVote, judgmentDetail } from './arena';
import { leaderboard, headToHead } from './statistics';
import { claimRun, recordRun, releaseRun, runBoard } from './scheduler';
import { validateBlindText } from './sanitize';
import { applicableMetrics, TASKS, type SystemInfo, type User } from '../shared/domain';

export type AppEnv = Cloudflare.Env & { PIN_PEPPER: string };
const json = (data: unknown, status = 200) => Response.json(data, { status });
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new HttpError(415, 'Expected application/json');
  if (!request.body) throw new HttpError(400, 'JSON body is required');
  const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 2_000_000) { await reader.cancel(); throw new HttpError(413, 'Import exceeds 2 MB. Split it into smaller batches.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
async function route(request: Request, env: AppEnv): Promise<Response> {
  const db = env.DB, url = new URL(request.url), path = url.pathname.replace(/\/$/, ''), method = request.method;
  const f = () => filterSchema.parse(Object.fromEntries(url.searchParams));
  if (path === '/api/health' && method === 'GET') {
    await one(db, 'SELECT 1 FROM source_weights LIMIT 1');
    return json({ status: 'ok', environment: env.ENVIRONMENT, generation: false });
  }
  if ((path === '/api/auth/register' || path === '/api/auth/login') && method === 'POST') {
    if (!env.PIN_PEPPER || env.PIN_PEPPER.length < 32) throw new HttpError(503, 'Authentication secret is not configured');
    const input = await body(request), isRegister = path.endsWith('register');
    const parsed = (isRegister ? registration : credentials).parse(input);
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    await rateLimit(db, `ip:${await digest(ip)}:${isRegister ? 'register' : 'login'}`, isRegister ? 20 : 60, 3600000);
    await rateLimit(db, `account:${parsed.username.toLowerCase()}`, 10, 900000);
    let user: User;
    if (isRegister) {
      const reg = registration.parse(input), salt = crypto.randomUUID(), userId = crypto.randomUUID();
      const hash = await hashPin(reg.pin, salt, env.PIN_PEPPER);
      try {
        await db.batch([
          db.prepare('INSERT INTO users(id,username,pin_hash,pin_salt,user_type) VALUES(?,?,?,?,?)').bind(userId, reg.username, hash, salt, reg.user_type),
          db.prepare('INSERT INTO user_settings(user_id) VALUES(?)').bind(userId),
        ]);
      } catch (error) {
        if (String(error).includes('UNIQUE')) throw new HttpError(409, 'That username is already taken'); throw error;
      }
      user = { id: userId, username: reg.username, user_type: reg.user_type, reveal_names: 0, is_admin: 0 };
    } else {
      const existing = await one<User & { pin_hash: string; pin_salt: string }>(db, 'SELECT u.*,us.reveal_names FROM users u JOIN user_settings us ON us.user_id=u.id WHERE username=? COLLATE NOCASE', parsed.username);
      const hash = await hashPin(parsed.pin, existing?.pin_salt || 'unknown-user-dummy-salt', env.PIN_PEPPER);
      if (!existing || !await equalSecret(existing.pin_hash, hash)) throw new HttpError(401, 'Username or PIN is incorrect');
      user = { id: existing.id, username: existing.username, user_type: existing.user_type, reveal_names: existing.reveal_names, is_admin: existing.is_admin };
    }
    return json({ token: await createSession(db, user.id), user }, isRegister ? 201 : 200);
  }
  if (path === '/api/auth/me' && method === 'GET') return json(await requireUser(request, db));
  if (path === '/api/auth/logout' && method === 'POST') {
    await requireUser(request, db);
    await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(request.headers.get('Authorization')!.slice(7))).run();
    return json({ ok: true });
  }
  if (path === '/api/settings' && method === 'PATCH') {
    const user = await requireUser(request, db);
    const input = z.object({ reveal_names: z.boolean() }).strict().parse(await body(request));
    await db.prepare('UPDATE user_settings SET reveal_names=? WHERE user_id=?').bind(input.reveal_names ? 1 : 0, user.id).run();
    return json({ ...user, reveal_names: input.reveal_names ? 1 : 0 });
  }
  if (path === '/api/arena/next' && method === 'POST') {
    const user = await requireUser(request, db);
    await rateLimit(db, `arena:${user.id}`, 120, 60000);
    return json({ matchup: await nextMatch(db, user, f()) });
  }
  const voteRoute = path.match(/^\/api\/judgments\/([a-zA-Z0-9_-]+)$/);
  if (voteRoute) {
    const user = await requireUser(request, db), voteId = voteRoute[1];
    if (method === 'GET') return json(await judgmentDetail(db, user, voteId));
    if (method === 'POST' || method === 'PUT') return json(await saveVote(db, user, voteId, await body(request), method === 'PUT'));
  }
  if (path === '/api/judgments' && method === 'GET') {
    const user = await requireUser(request, db);
    const offset = z.coerce.number().int().nonnegative().max(100000).parse(url.searchParams.get('offset') || 0);
    const data = await rows(db, `SELECT aa.id,coalesce(aa.motion_snapshot,t.motion) motion,coalesce(aa.category_snapshot,t.category) category,coalesce(aa.task_snapshot,r.task) task,v.updated_at,v.overall*CASE aa.swapped WHEN 1 THEN -1 ELSE 1 END overall FROM human_votes v
      JOIN arena_assignments aa ON aa.id=v.id JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low JOIN topics t ON t.id=r.topic_id
      WHERE aa.user_id=? ORDER BY v.updated_at DESC LIMIT 30 OFFSET ?`, user.id, offset);
    return json(data);
  }
  if (path === '/api/leaderboard' && method === 'GET') return json(await leaderboard(db, f()));
  if (path === '/api/systems' && method === 'GET') return json(await rows(db, 'SELECT * FROM systems ORDER BY display_name'));
  if (path === '/api/ai-judges' && method === 'GET') return json(await rows(db, 'SELECT * FROM ai_judges ORDER BY display_name'));
  if (path === '/api/stats' && method === 'GET') {
    return json(await one(db, `SELECT (SELECT count(*) FROM systems WHERE active=1) systems,(SELECT count(*) FROM topics WHERE active=1) topics,
      (SELECT count(*) FROM human_votes) human_votes,(SELECT count(*) FROM ai_votes) ai_votes,(SELECT count(*) FROM users) judges,
      (SELECT count(*) FROM systems WHERE active=1 AND display_name LIKE '%[DEMO]%') demo_systems`));
  }
  const systemRoute = path.match(/^\/api\/systems\/([a-zA-Z0-9_-]+)$/);
  if (systemRoute && method === 'GET') {
    const system = await one<SystemInfo>(db, 'SELECT * FROM systems WHERE id=?', systemRoute[1]);
    if (!system) throw new HttpError(404, 'System not found');
    const breakdowns = await Promise.all(['all', 'government', 'opposition'].map(async task => {
      const rank = await leaderboard(db, filterSchema.parse({ task, source: 'combined' }));
      return { label: task, row: rank.rows.find(r => r.id === system.id) };
    }));
    return json({ system, breakdowns });
  }
  const compareRoute = path.match(/^\/api\/compare\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
  if (compareRoute && method === 'GET') {
    if (compareRoute[1] === compareRoute[2]) throw new HttpError(400, 'Choose two different systems');
    const systems = await rows<SystemInfo>(db, 'SELECT * FROM systems WHERE id IN (?,?)', compareRoute[1], compareRoute[2]);
    if (systems.length !== 2) throw new HttpError(404, 'System not found');
    return json({ a: systems.find(s => s.id === compareRoute[1]), b: systems.find(s => s.id === compareRoute[2]), breakdowns: await headToHead(db, compareRoute[1], compareRoute[2]) });
  }
  const profileRoute = path.match(/^\/api\/profiles\/([a-zA-Z0-9_]+)(\/leaderboard)?$/);
  if (profileRoute && method === 'GET') {
    const user = await one<{ id: string; username: string; user_type: string; created_at: string }>(db, 'SELECT id,username,user_type,created_at FROM users WHERE username=? COLLATE NOCASE', profileRoute[1]);
    if (!user) throw new HttpError(404, 'Profile not found');
    if (profileRoute[2]) return json(await leaderboard(db, f(), user.id));
    const counts = await rows<{ category: string; task: string; count: number }>(db, `SELECT t.category,r.task,count(*) count FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id
      JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low JOIN topics t ON t.id=r.topic_id WHERE aa.user_id=? GROUP BY t.category,r.task`, user.id);
    return json({ ...user, counts, judgment_count: counts.reduce((sum, c) => sum + c.count, 0) });
  }
  if (path.startsWith('/api/admin')) {
    await rateLimit(db, `admin:${await digest(request.headers.get('CF-Connecting-IP') || 'local')}`, 60, 60000);
    const me = await requireAdmin(request, db);
    if (path === '/api/admin/catalog' && method === 'GET') {
      const [systems, topics, responses, standards, judges, weights, source, users] = await Promise.all([
        rows(db, 'SELECT * FROM systems'), rows(db, 'SELECT * FROM topics'),
        rows(db, 'SELECT id,system_id,topic_id,task,sample,display_version FROM responses ORDER BY id'),
        rows(db, 'SELECT * FROM standardized_rebuttal_tasks'), rows(db, 'SELECT * FROM ai_judges'),
        rows(db, 'SELECT * FROM benchmark_weights'), one(db, 'SELECT human,ai FROM source_weights WHERE id=1'),
        rows(db, 'SELECT id,username,user_type,created_at,is_admin FROM users ORDER BY is_admin DESC,username COLLATE NOCASE'),
      ]);
      return json({ systems, topics, responses, standards, judges, weights, source, users });
    }
    if (path === '/api/admin/import' && method === 'POST') {
      try { return json(await bulkImport(db, await body(request)), 201); }
      catch (error) {
        if (error instanceof ZodError || error instanceof HttpError) throw error;
        throw new HttpError(400, `Import rejected: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`);
      }
    }
    if (path === '/api/admin/next-run' && method === 'GET') return json(await runBoard(db));
    if (path === '/api/admin/runs' && method === 'POST') return json(await claimRun(db, await body(request)), 201);
    const run = path.match(/^\/api\/admin\/runs\/([a-zA-Z0-9-]+)\/(response|release)$/);
    if (run && method === 'POST') {
      if (run[2] === 'release') return json(await releaseRun(db, run[1]));
      try { return json(await recordRun(db, run[1], await body(request)), 201); }
      catch (error) {
        if (error instanceof ZodError || error instanceof HttpError) throw error;
        throw new HttpError(400, `Run rejected: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`);
      }
    }
    const display = path.match(/^\/api\/admin\/responses\/([a-zA-Z0-9_-]+)$/);
    if (display && method === 'GET') {
      const response = await one(db, 'SELECT * FROM responses WHERE id=?', display[1]);
      if (!response) throw new HttpError(404, 'Response not found'); return json(response);
    }
    if (display && method === 'PATCH') {
      const input = z.object({ display_output: z.string().min(1).max(100000) }).strict().parse(await body(request));
      const systems = await rows<SystemInfo>(db, 'SELECT * FROM systems');
      let clean: string;
      try { clean = validateBlindText(input.display_output, systems.flatMap(s => [s.id, s.display_name, s.provider, s.model, s.interface])); }
      catch (error) { throw new HttpError(400, (error as Error).message); }
      const changed = await db.batch([
        db.prepare('UPDATE responses SET display_output=?,display_version=display_version+1 WHERE id=?').bind(clean, display[1]),
        db.prepare('INSERT INTO response_display_revisions(response_id,version,display_output) SELECT id,display_version,display_output FROM responses WHERE id=?').bind(display[1]),
      ]);
      if (!changed[0].meta.changes) throw new HttpError(404, 'Response not found'); return json({ saved: true });
    }
    const entity = path.match(/^\/api\/admin\/(systems|topics)\/([a-zA-Z0-9_-]+)$/);
    if (entity && method === 'PUT') {
      const parsed = (entity[1] === 'systems' ? systemSchema : topicSchema).parse(await body(request));
      if (parsed.id !== entity[2]) throw new HttpError(400, 'ID cannot change');
      const values = Object.entries(parsed).filter(([k]) => k !== 'id');
      const result = await db.prepare(`UPDATE ${entity[1]} SET ${values.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).bind(...values.map(([,v]) => v), parsed.id).run();
      if (!result.meta.changes) throw new HttpError(404, 'Record not found'); return json({ saved: true });
    }
    if (path === '/api/admin/weights' && method === 'PUT') {
      const schema = z.object({ source: z.object({ human: z.number().min(0).max(1), ai: z.number().min(0).max(1) }),
        benchmark: z.array(z.object({ task: z.enum(TASKS), metric: id, weight: z.number().min(0).max(1) })) });
      const input = schema.parse(await body(request));
      if (Math.abs(input.source.human + input.source.ai - 1) > 1e-6) throw new HttpError(400, 'Source weights must sum to 1');
      for (const task of TASKS) {
        const entries = input.benchmark.filter(w => w.task === task);
        if (Math.abs(entries.reduce((s,w) => s+w.weight, 0) - 1) > 1e-6 || entries.length !== applicableMetrics(task).length || new Set(entries.map(e => e.metric)).size !== entries.length || entries.some(w => !applicableMetrics(task).includes(w.metric as never))) throw new HttpError(400, `Supply each applicable metric once for ${task}; weights must sum to 1`);
      }
      await db.batch([
        db.prepare('UPDATE source_weights SET human=?,ai=? WHERE id=1').bind(input.source.human, input.source.ai), db.prepare('DELETE FROM benchmark_weights'),
        ...input.benchmark.map(w => db.prepare('INSERT INTO benchmark_weights(task,metric,weight) VALUES(?,?,?)').bind(w.task,w.metric,w.weight)),
      ]);
      return json({ saved: true });
    }
    const account = path.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]+)$/);
    if (account && method === 'PATCH') {
      const input = z.object({ is_admin: z.boolean() }).strict().parse(await body(request));
      const target = await one<{ id: string; username: string; is_admin: number }>(db, 'SELECT id,username,is_admin FROM users WHERE id=?', account[1]);
      if (!target) throw new HttpError(404, 'Account not found');
      // The last administrator cannot be demoted, including by themselves, or nobody could grant the role back.
      if (target.is_admin && !input.is_admin) {
        const remaining = await one<{ n: number }>(db, 'SELECT count(*) n FROM users WHERE is_admin=1 AND id<>?', target.id);
        if (!remaining?.n) throw new HttpError(400, target.id === me.id ? 'You are the only administrator. Promote another account before removing your own access.' : 'ParliBench must keep at least one administrator.');
      }
      await db.prepare('UPDATE users SET is_admin=? WHERE id=?').bind(input.is_admin ? 1 : 0, target.id).run();
      return json({ saved: true, id: target.id, username: target.username, is_admin: input.is_admin ? 1 : 0 });
    }
  }
  throw new HttpError(404, 'Endpoint not found');
}
export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').map(v => v.trim());
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin', 'Referrer-Policy': 'no-referrer' });
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    headers.set('Access-Control-Max-Age', '600');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) response = json({ error: error.message }, error.status);
      else if (error instanceof ZodError) response = json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
      else if (String(error).includes('UNIQUE constraint')) response = json({ error: 'This record already exists' }, 409);
      else {
        console.error(JSON.stringify({ event: 'request_failed', path: new URL(request.url).pathname, message: error instanceof Error ? error.message : 'Unknown error' }));
        response = json({ error: 'The request could not be completed. Please try again.' }, 500);
      }
    }
    for (const [key, value] of headers) response.headers.set(key, value);
    return response;
  },
} satisfies ExportedHandler<AppEnv>;
