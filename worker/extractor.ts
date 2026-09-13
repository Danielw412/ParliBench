import { z } from 'zod';
import { structuredCaseSchema } from '../shared/cases';

// Generation needs the shape, not the application's large length/count bounds.
// Keep those bounds and refinements in structuredCaseSchema for local validation.
function generationShape(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['type', 'required', 'additionalProperties']) {
    if (key in schema) result[key] = schema[key];
  }
  if (schema.properties) result.properties = Object.fromEntries(
    Object.entries(schema.properties as Record<string, Record<string, unknown>>)
      .map(([key, value]) => [key, generationShape(value)]),
  );
  if (schema.items) result.items = generationShape(schema.items as Record<string, unknown>);
  if ('const' in schema) result.enum = [schema.const];
  return result;
}

export const extractorJsonSchema = generationShape(z.toJSONSchema(structuredCaseSchema, { unrepresentable: 'any' }));

export async function geminiHttpError(response: Response, apiKey: string): Promise<string> {
  let detail = '';
  try {
    const payload = await response.json() as { error?: { status?: unknown; message?: unknown } };
    detail = [payload.error?.status, payload.error?.message].filter(v => typeof v === 'string').join(': ');
  } catch { /* Non-JSON errors still retain their HTTP status. */ }
  // Never persist a credential echoed by an upstream error, or dump response bodies.
  if (apiKey) detail = detail.split(apiKey).join('[redacted]');
  detail = detail.replace(/AIza[\w-]+/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}
