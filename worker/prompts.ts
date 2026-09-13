import government from '../prompts/government.txt';
import opposition from '../prompts/opposition.txt';
import { HttpError, rows } from './db';
import type { PromptRevision, Task } from '../shared/domain';

export const promptDefaults = { government, opposition };
// Provisional input contract only; no Rebuttal wording is supplied or seeded.
export const placeholders = (task: Task) => task === 'rebuttal' ? ['MOTION','GOVERNMENT_CASE','OPPOSITION_CASE'] : ['MOTION'];
export function validateTemplate(task: Task, template: string) {
  const required = placeholders(task), found = [...template.matchAll(/\{([^{}]+)\}/g)].map(m => m[1]);
  if (!template.trim() || template.length > 100000) throw new HttpError(400, 'Template must contain 1–100000 characters');
  if (required.some(p => !found.includes(p)) || found.some(p => !required.includes(p))) throw new HttpError(400, `Use exactly these placeholders: ${required.map(p => `{${p}}`).join(', ')}`);
}
export function renderPrompt(task: Task, template: string, inputs: Record<string, string>) {
  validateTemplate(task, template);
  if (placeholders(task).some(p => !inputs[p])) throw new HttpError(409, 'Required prompt inputs are unavailable');
  // Single pass: a motion containing braces or dollar signs is never interpreted as a template.
  return template.replace(/\{([^{}]+)\}/g, (_, key: string) => inputs[key]);
}
export async function listPrompts(db: D1Database) {
  await db.batch(Object.entries(promptDefaults).map(([task, template]) => db.prepare(
    'INSERT OR IGNORE INTO prompt_revisions(id,task,version,template) VALUES(?,?,1,?)'
  ).bind(`seed-${task}-v1`, task, template)));
  return rows<PromptRevision>(db, 'SELECT * FROM prompt_revisions ORDER BY task,version DESC');
}
export async function revisePrompt(db: D1Database, task: Task, template: string, userId: string) {
  validateTemplate(task, template); await listPrompts(db);
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO prompt_revisions(id,task,version,template,created_by) SELECT ?,?,coalesce(max(version),0)+1,?,? FROM prompt_revisions WHERE task=?').bind(id,task,template,userId,task).run();
  return { id };
}
