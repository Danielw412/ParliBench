import { z } from 'zod';

const content = z.string().max(100000);
export const structuredCaseSchema = z.object({
  schema_version: z.literal(1).default(1), motion_interpretation: content,
  contentions: z.array(z.object({
    number: z.number().int().positive(), title: content.min(1), claim: content.min(1),
    warrants: z.array(content.min(1)).min(1).max(40), impact: content.min(1),
    comparative: content, likely_response: content, defense: content,
  }).strict()).min(1).max(20), round_priorities: content,
}).strict().refine(c => new Set(c.contentions.map(v => v.number)).size === c.contentions.length, 'Contention numbers must be unique');
export type StructuredCase = z.infer<typeof structuredCaseSchema>;
export const coreCaseSchema = z.object({ contentions: z.array(structuredCaseSchema.shape.contentions.element.pick({title:true,claim:true,warrants:true,impact:true})).min(1).max(20) }).strict();
export function coreCaseForRebuttal(value: StructuredCase) {
  return { contentions: value.contentions.map(({ title, claim, warrants, impact }) => ({ title, claim, warrants: [...warrants], impact })) };
}
export function coreCaseMarkdown(value: z.infer<typeof coreCaseSchema>): string {
  return value.contentions.map((c,i)=>`## Contention ${i+1}: ${c.title}\n\n### Claim\n\n${c.claim}\n\n### Warrants\n\n${c.warrants.join('\n\n')}\n\n### Impact\n\n${c.impact}`).join('\n\n');
}

/** Conservative parser: only the requested headings, never guesses missing arguments. */
export function parseCase(text: string): StructuredCase | null {
  const result: StructuredCase = { schema_version: 1, motion_interpretation: '', contentions: [], round_priorities: '' };
  let current: StructuredCase['contentions'][number] | undefined;
  let field = '', buffer: string[] = [];
  const flush = () => {
    const value = buffer.join('\n').trim(); buffer = [];
    if (field === 'motion_interpretation' || field === 'round_priorities') result[field] = value;
    else if (current && field === 'warrants') current.warrants = value ? value.split(/\n\s*\n/) : [];
    else if (current && ['claim','impact','comparative','likely_response','defense'].includes(field)) Object.assign(current, { [field]: value });
    else if (value) throw new Error('Unrecognized case content');
  };
  const seen = new Set<string>();
  try {
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      const heading = line.match(/^\s*#{1,3}\s+(.+?)\s*#*\s*$/)?.[1]
        ?? line.match(/^\s*\*\*(.+?)\*\*\s*$/)?.[1];
      const title = heading?.replace(/\*\*/g, '').replace(/:$/, '').trim();
      const contention = title?.match(/^Contention\s+(\d+)\s*[:.\-–]\s*(.+)$/i);
      const key = title?.toLowerCase();
      const mapped = key === 'motion interpretation' ? 'motion_interpretation' : key === 'round priorities' ? 'round_priorities'
        : key && /^likely (government|opposition) response$/.test(key) ? 'likely_response'
        : key && /^(government |opposition )?defen[cs]e$/.test(key) ? 'defense'
        : key && ['claim','warrants','impact','comparative'].includes(key) ? key : '';
      if (contention || mapped) {
        flush();
        if (contention) {
          current = { number: Number(contention[1]), title: contention[2], claim: '', warrants: [], impact: '', comparative: '', likely_response: '', defense: '' };
          result.contentions.push(current); field = '';
        } else {
          const scope = ['motion_interpretation','round_priorities'].includes(mapped) ? mapped : `${current?.number}:${mapped}`;
          if (seen.has(scope)) return null;
          seen.add(scope); field = mapped;
        }
      } else buffer.push(line);
    }
    flush();
    const parsed = structuredCaseSchema.safeParse(result);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** Also serves as a stable plain-text snapshot format for Arena. */
export function caseMarkdown(value: StructuredCase, task: string): string {
  const section = (title: string, text: string, level = 3) => text ? `${'#'.repeat(level)} ${title}\n\n${text}\n\n` : '';
  return section('Motion Interpretation', value.motion_interpretation, 2) + value.contentions.map(c =>
    `## Contention ${c.number}: ${c.title}\n\n` + section('Claim', c.claim) + section('Warrants', c.warrants.join('\n\n'))
    + section('Impact', c.impact) + section('Comparative', c.comparative)
    + section(`Likely ${task === 'government' ? 'Opposition' : 'Government'} Response`, c.likely_response) + section('Defense', c.defense)
  ).join('') + section('Round Priorities', value.round_priorities, 2);
}
