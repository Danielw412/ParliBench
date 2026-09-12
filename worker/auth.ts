import { HttpError, one } from './db';
import type { User } from '../shared/domain';
const encoder = new TextEncoder();
export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashPin(pin: string, salt: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin + ':' + pepper), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [aa, bb] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return difference === 0;
}
export function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
export async function createSession(db: D1Database, userId: string) {
  const token = randomToken();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await digest(token), userId, Date.now() + 30 * 86400000),
  ]);
  return token;
}
export async function requireUser(request: Request, db: D1Database): Promise<User> {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new HttpError(401, 'Please sign in to continue.');
  const user = await one<User>(db, 'SELECT u.id,u.username,u.user_type,us.reveal_names FROM sessions s JOIN users u ON u.id=s.user_id JOIN user_settings us ON us.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?', await digest(token), Date.now());
  if (!user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  return user;
}
export async function rateLimit(db: D1Database, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const result = await db.prepare(`INSERT INTO rate_limits(key,attempts,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,
    expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING attempts`).bind(key, now + windowMs, now, now).first<{ attempts: number }>();
  if (result && result.attempts > limit) throw new HttpError(429, 'Too many attempts. Please try again later.');
}
