import { z } from 'zod';
import { TASKS, TASK_LABELS, type User } from '../shared/domain';
import type { PromptUsage } from '../shared/admin';
import { audit } from './audit';
import { coreCaseForRebuttal, structuredCaseSchema } from '../shared/cases';
import { id } from './validation';
import { HttpError, one, rows } from './db';
import { listPrompts, revisePrompt } from './prompts';
import { extractCase, storeCase, type ExtractorEnv } from './cases';
import { validateBlindText } from './sanitize';

export async function benchmarkAdmin(db: D1Database, path: string, method: string, body: () => Promise<unknown>, me: User, env: ExtractorEnv): Promise<unknown | undefined> {
  const userId = me.id;
  if (path === '/api/admin/prompts') {
    if (method === 'GET') {
      const revisions=await listPrompts(db);
      const usage=new Map((await rows<{id:string;claims:number;responses:number}>(db,'SELECT p.id,(SELECT count(*) FROM run_claims c WHERE c.prompt_revision_id=p.id) claims,(SELECT count(*) FROM responses r WHERE r.prompt_revision_id=p.id) responses FROM prompt_revisions p')).map(u=>[u.id,u]));
      return revisions.map(r=>({...r,claims:usage.get(r.id)?.claims || 0,responses:usage.get(r.id)?.responses || 0})) satisfies PromptUsage[];
    }
    if (method === 'POST') {
      const input=z.object({task:z.enum(TASKS),template:z.string()}).strict().parse(await body());
      const saved=await revisePrompt(db,input.task,input.template,userId);
      await db.batch([audit(db,me,'revise','prompt',saved.id,`Saved a new ${TASK_LABELS[input.task]} prompt revision`)]);
      return saved;
    }
  }
  if (path === '/api/admin/rebuttal-pool') {
    if (method === 'GET') {
      return rows(db,`SELECT r.id response_id,r.topic_id,t.motion,s.display_name government_system,r.active,
        p.frozen_at,c.status extraction_status,
        CASE WHEN r.active=0 THEN 'Source unavailable: response inactive' WHEN t.active=0 THEN 'Topic inactive' WHEN c.status IS NULL OR c.status<>'ready' THEN 'Structured case unavailable' ELSE 'Available' END availability
        FROM responses r JOIN topics t ON t.id=r.topic_id JOIN systems s ON s.id=r.system_id
        LEFT JOIN rebuttal_pool p ON p.government_response_id=r.id LEFT JOIN structured_cases c ON c.response_id=r.id
        WHERE r.task='government' ORDER BY t.motion,p.frozen_at DESC,s.display_name,r.sample`);
    }
    if (method === 'POST') {
      const input=z.object({response_ids:z.array(id).min(1).max(100)}).strict().parse(await body());
      const identities=await rows<{id:string;display_name:string;provider:string;model:string;interface:string}>(db,'SELECT * FROM systems');
      const statements: D1PreparedStatement[]=[];
      for (const responseId of [...new Set(input.response_ids)]) {
        const run=await one<{topic_id:string;case_json:string}>(db,`SELECT r.topic_id,c.case_json FROM responses r JOIN structured_cases c ON c.response_id=r.id JOIN topics t ON t.id=r.topic_id WHERE r.id=? AND r.task='government' AND r.active=1 AND t.active=1 AND c.status='ready'`,responseId);
        if (!run) throw new HttpError(409,`Government source ${responseId} is unavailable or needs extraction`);
        const core=JSON.stringify(coreCaseForRebuttal(structuredCaseSchema.parse(JSON.parse(run.case_json))));
        // Reject identifying content instead of changing frozen argument wording.
        if (validateBlindText(core,identities.flatMap(s=>[s.id,s.display_name,s.provider,s.model,s.interface])) !== core) throw new HttpError(400,'Remove identifying content from the structured case before freezing');
        statements.push(db.prepare('INSERT OR IGNORE INTO rebuttal_pool(government_response_id,topic_id,core_case_json,frozen_by) VALUES(?,?,?,?)').bind(responseId,run.topic_id,core,userId));
      }
      statements.push(audit(db,me,'freeze','rebuttal_pool',null,`Froze ${statements.length} Government source${statements.length===1 ? '' : 's'} into the Rebuttal Pool`,{response_ids:input.response_ids}));
      await db.batch(statements); return {frozen:true};
    }
  }
  const extraction=path.match(/^\/api\/admin\/responses\/([a-zA-Z0-9_-]+)\/structure(\/retry)?$/);
  if (extraction) {
    const responseId=extraction[1];
    if (method==='GET') return {structure:await one(db,'SELECT * FROM structured_cases WHERE response_id=?',responseId)};
    if (method==='POST' && extraction[2]) {
      const structure=await extractCase(db,responseId,env);
      await db.batch([audit(db,me,'extract','response',responseId,'Retried structured extraction')]);
      return {structure};
    }
    if (method==='PUT' && !extraction[2]) {
      const run=await one<{task:string}>(db,'SELECT task FROM responses WHERE id=?',responseId);
      if (!run || !['government','opposition'].includes(run.task)) throw new HttpError(400,'Choose a case-generation response');
      const value=structuredCaseSchema.parse(await body());
      await storeCase(db,responseId,value,'manual',null,userId);
      await db.batch([audit(db,me,'structure','response',responseId,'Saved a manual structured-case revision')]);
      return {saved:true};
    }
  }
  return undefined;
}
