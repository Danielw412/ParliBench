import { z } from 'zod';
import { one, rows } from './db';
import type { User } from '../shared/domain';
import type { AuditEntry, Page } from '../shared/admin';

export type Actor = Pick<User, 'id' | 'username'>;
// Returned as a statement so a change and its record commit in the same batch.
export function audit(db: D1Database, actor: Actor, action: string, entity: string, entityId: string | null, summary: string, detail: unknown = {}) {
  return db.prepare('INSERT INTO admin_audit(actor_id,actor_username,action,entity,entity_id,summary,detail_json) VALUES(?,?,?,?,?,?,?)')
    .bind(actor.id, actor.username, action, entity, entityId, summary.slice(0, 500), JSON.stringify(detail));
}
const auditQuery = z.object({
  entity: z.string().regex(/^[a-z_]{1,40}$/).optional(), q: z.string().trim().max(200).default(''),
  offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(200).default(50),
});
export async function listAudit(db: D1Database, params: URLSearchParams): Promise<Page<AuditEntry>> {
  const f = auditQuery.parse(Object.fromEntries(params));
  const where: string[] = ['1=1'], values: (string | number)[] = [];
  if (f.entity) { where.push('entity=?'); values.push(f.entity); }
  if (f.q) { where.push('(instr(lower(summary),lower(?))>0 OR instr(lower(actor_username),lower(?))>0 OR instr(lower(coalesce(entity_id,\'\')),lower(?))>0)'); values.push(f.q, f.q, f.q); }
  const [total, list] = await Promise.all([
    one<{ n: number }>(db, `SELECT count(*) n FROM admin_audit WHERE ${where.join(' AND ')}`, ...values),
    rows<AuditEntry>(db, `SELECT * FROM admin_audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, ...values, f.limit, f.offset),
  ]);
  return { rows: list, total: total?.n || 0, offset: f.offset, limit: f.limit };
}
