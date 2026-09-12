export async function rows<T>(db: D1Database, sql: string, ...params: (string | number | null)[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}
export async function one<T>(db: D1Database, sql: string, ...params: (string | number | null)[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}
export function insert(db: D1Database, table: string, data: Record<string, string | number | null>) {
  const keys = Object.keys(data);
  // Table and column identifiers come exclusively from validated internal schemas.
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...Object.values(data));
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
