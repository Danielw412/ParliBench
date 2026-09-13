import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { coreCaseForRebuttal, parseCase, structuredCaseSchema, caseMarkdown } from '../shared/cases';
import { renderPrompt } from '../worker/prompts';
import { defaultExtractorModels, extractCase } from '../worker/cases';
import { demoCase } from '../scripts/demo-data';

const raw=demoCase('This House would test each case.','government','Reliable access');
describe('prompt and structured case helpers',()=> {
  it.each(['government','opposition'] as const)('renders the actual %s seed with only the motion',task=> {
    const seed=readFileSync(`prompts/${task}.txt`,'utf8');
    const motion='Literal $& and {MOTION} within the motion';
    expect(renderPrompt(task,seed,{MOTION:motion})).toBe(seed.replace('{MOTION}',()=>motion));
    expect(()=>renderPrompt(task,seed,{})).toThrow('unavailable');
  });
  it('preserves structured fields verbatim, including multiple warrant paragraphs',()=> {
    const result=parseCase(raw)!;
    expect(result.contentions[0].title).toBe('Reliable access');
    expect(result.contentions[0].warrants).toHaveLength(2);
    for(const warrant of result.contentions[0].warrants) expect(raw).toContain(warrant);
    expect(parseCase(caseMarkdown(result,'government'))).toEqual(result);
    expect(parseCase(raw.replaceAll('\n','\r\n'))).toEqual(result);
  });
  it('refuses ambiguous, incomplete, duplicated, or unrecognized structure',()=> {
    expect(parseCase('A single unstructured paragraph.')).toBeNull();
    expect(parseCase(raw.replace('### Claim','### Unknown'))).toBeNull();
    expect(parseCase(raw+'\n\n### Claim\n\nA duplicate.')).toBeNull();
    expect(parseCase('Unrecognized preamble\n\n'+raw)).toBeNull();
    expect(structuredCaseSchema.safeParse({...parseCase(raw),provider:'identity'}).success).toBe(false);
  });
  it('strips everything except the four permitted contention fields',()=> {
    const full=parseCase(raw)!;const core=coreCaseForRebuttal(full);
    expect(Object.keys(core)).toEqual(['contentions']);
    expect(Object.keys(core.contentions[0])).toEqual(['title','claim','warrants','impact']);
    core.contentions[0].warrants.push('Separate array');expect(full.contentions[0].warrants).toHaveLength(2);
  });
});

// Storage itself is exercised against D1 in run-queue.test.ts. Here the boundary is observed
// so network failures and extractor hallucinations can be injected without real API calls.
function extractionDB(input:string) {
  const writes:unknown[][]=[];
  const db={prepare:(sql:string)=>{
    const statement={bind:(...args:unknown[])=>{if(sql.startsWith('INSERT')) writes.push(args);return statement;},first:async()=>sql.includes('raw_output') ? {raw_output:input,task:'government'} : null};
    return statement;
  },batch:async()=>[]};
  return {db:db as unknown as D1Database,writes};
}
afterEach(()=>vi.unstubAllGlobals());
describe('optional Gemini extraction',()=> {
  it('does not call Gemini when headings parse or no key is configured',async()=> {
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await extractCase(extractionDB(raw).db,'response',{GEMINI_API_KEY:'test-key'});
    const missing=extractionDB('Free-form case');await extractCase(missing.db,'response');
    expect(fetch).not.toHaveBeenCalled();expect(missing.writes[0][1]).toBe('failed');
  });
  it('tries the requested fallback sequence and stores only a validated verbatim result',async()=> {
    const expected=parseCase(raw)!;
    const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:404})).mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(new Response('',{status:429})).mockResolvedValueOnce(Response.json({candidates:[{content:{parts:[{text:JSON.stringify(expected)}]}}]}));
    vi.stubGlobal('fetch',fetch);
    const observed=extractionDB('Preamble forces model fallback\n'+raw);
    await extractCase(observed.db,'response',{GEMINI_API_KEY:'test-key'});
    expect(fetch.mock.calls.map(c=>String(c[0]).split('/models/')[1].split(':')[0])).toEqual(defaultExtractorModels);
    expect(observed.writes[0][1]).toBe('ready');expect(observed.writes[0][3]).toBe(defaultExtractorModels[3]);
    expect(JSON.parse(observed.writes[0][2] as string)).toEqual(expected);
  });
  it('rejects invented wording and records all fallback failures',async()=> {
    const wrong=parseCase(raw)!;wrong.contentions[0].claim='Invented by the extractor.';
    const fetch=vi.fn().mockImplementation(async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(wrong)}]}}]}));vi.stubGlobal('fetch',fetch);
    const observed=extractionDB('Preamble\n'+raw);await extractCase(observed.db,'response',{GEMINI_API_KEY:'test-key'});
    expect(fetch).toHaveBeenCalledTimes(4);expect(observed.writes[0][1]).toBe('failed');expect(observed.writes[0][4]).toContain('changed original wording');
  });
});
