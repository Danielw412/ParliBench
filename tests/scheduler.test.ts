import { describe, expect, it } from 'vitest';
import { buildCandidates, rankCandidates, type Candidate, type Coverage } from '../worker/scheduler';

const system = (id:string) => ({id,display_name:id,provider:'Provider',model:'Model',interface:'Interface',reasoning:null,configuration:'',active:1});
const topic = (id:string) => ({id,motion:`Motion ${id}`,category:'Serious'});
const slot = (system_id:string,topic_id:string,task:string,runs=1,std='') => ({system_id,topic_id,task,std,active_runs:runs,top_sample:runs});
const coverage = (partial:Partial<Coverage> = {}):Coverage => ({systems:[],topics:[],slots:[],oppositions:[],pool:[],prompts:['government','opposition'].map(task=>({id:task,task:task as 'government'|'opposition',version:1,template:'Prepare {MOTION}',created_by:null,created_at:''})),claims:[],...partial});
const chain = (id:string,system_id:string,topic_id:string,opposition_response_id:string|null = null) => ({id,system_id,topic_id,opposition_response_id,display_output:'Stage text',opposition_output:opposition_response_id ? 'Prediction text' : null});
const at = (c:Candidate) => [c.system_id,c.topic_id,c.task].join('/');
const steady = () => 0; // No tie-break jitter, so priority order alone is asserted.

describe('next run selection',() => {
  it('offers only runs that can be imported right now',() => {
    const candidates = buildCandidates(coverage({systems:[system('s1')],topics:[topic('t1')]}));
    expect(candidates.map(at)).toEqual(['s1/t1/government','s1/t1/opposition']);
  });
  it('requires a prompt, frozen Government and own Opposition before Rebuttal',()=> {
    const data=coverage({systems:[system('s1')],topics:[topic('t1')]});
    data.pool.push({government_response_id:'gov',topic_id:'t1',core_case_json:'{}'});
    data.oppositions.push({id:'opp',system_id:'s1',topic_id:'t1',case_json:'{}'});
    expect(buildCandidates(data).some(c=>c.task==='rebuttal')).toBe(false);
    data.prompts.push({id:'r',task:'rebuttal',version:1,template:'test',created_by:null,created_at:''});
    expect(buildCandidates(data).find(c=>c.task==='rebuttal')).toMatchObject({government_source_response_id:'gov',opposition_source_response_id:'opp'});
    data.oppositions[0].system_id='s2';
    expect(buildCandidates(data).some(c=>c.task==='rebuttal')).toBe(false);
  });
  it('filters the shared recommendation path without falling back to another system',()=> {
    const data=coverage({systems:[system('s1'),system('s2')],topics:[topic('t1')]});
    expect(rankCandidates(data,steady,'s2').every(c=>c.system_id==='s2')).toBe(true);
    expect(rankCandidates(data,steady,'inactive')).toEqual([]);
  });
  it('numbers the next sample above every run already recorded',() => {
    const candidates = buildCandidates(coverage({systems:[system('s1')],topics:[topic('t1')],slots:[{...slot('s1','t1','government',1),top_sample:4}]}));
    expect(candidates.find(c => c.task === 'government')?.sample).toBe(5);
    expect(candidates.find(c => c.task === 'opposition')?.sample).toBe(1);
  });
  it('never repeats a covered combination while any combination is untested',() => {
    const ranked = rankCandidates(coverage({systems:[system('s1'),system('s2')],topics:[topic('t1'),topic('t2')],
      slots:[slot('s1','t1','government',3),slot('s1','t1','opposition',3),slot('s1','t2','government',1)]}),steady);
    const covered = new Set(['s1/t1/government','s1/t1/opposition','s1/t2/government']);
    expect(covered.has(at(ranked[0]))).toBe(false);
    expect(ranked.slice(-3).every(c => covered.has(at(c)))).toBe(true);
  });
  it('prefers an untested model and topic pair over an untested task on a covered pair',() => {
    const ranked = rankCandidates(coverage({systems:[system('s1'),system('s2')],topics:[topic('t1'),topic('t2')],
      slots:[slot('s1','t1','government',1),slot('s1','t2','government',1),slot('s2','t1','government',1)]}),steady);
    expect([ranked[0].system_id,ranked[0].topic_id]).toEqual(['s2','t2']);
  });
  it('brings an underrepresented model forward',() => {
    const ranked = rankCandidates(coverage({systems:[system('busy'),system('quiet')],topics:[topic('t1')],
      slots:[slot('busy','t1','government',2)]}),steady);
    expect(ranked[0].system_id).toBe('quiet');
  });
  it('brings an underrepresented topic forward',() => {
    const ranked = rankCandidates(coverage({systems:[system('s1')],topics:[topic('busy'),topic('quiet')],
      slots:[slot('s1','busy','government',2)]}),steady);
    expect(ranked[0].topic_id).toBe('quiet');
  });
  it('corrects an imbalance between Government and Opposition',() => {
    // Each model has one covered slot on one side, so only the side deficit separates the two runs.
    const ranked = rankCandidates(coverage({systems:[system('s1'),system('s2')],topics:[topic('t1')],
      slots:[slot('s1','t1','government',1),slot('s2','t1','opposition',1)]}),steady);
    expect(at(ranked[0])).toBe('s1/t1/opposition');
  });
  it('keeps the least-tested combination coming once everything has coverage',() => {
    const ranked = rankCandidates(coverage({systems:[system('s1')],topics:[topic('t1'),topic('t2')],
      slots:[slot('s1','t1','government',1),slot('s1','t1','opposition',2),slot('s1','t2','government',1),slot('s1','t2','opposition',1)]}),steady);
    expect(ranked).toHaveLength(4);
    expect(at(ranked[0])).not.toBe('s1/t1/opposition');
    expect(at(ranked[3])).toBe('s1/t1/opposition');
    expect(ranked[0].sample).toBe(2);
  });
  it('spreads tie-breaks instead of always returning the same database row',() => {
    const data = coverage({systems:['s1','s2','s3'].map(system),topics:['t1','t2','t3'].map(topic)});
    const chosen = new Set(Array.from({length:60},() => at(rankCandidates(data)[0])));
    expect(chosen.size).toBeGreaterThan(3);
  });
  it('has nothing to recommend without an active model and topic',() => {
    expect(rankCandidates(coverage({systems:[system('s1')]}))).toHaveLength(0);
    expect(rankCandidates(coverage({topics:[topic('t1')]}))).toHaveLength(0);
  });
});
