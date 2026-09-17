import { useState } from 'react';
import { UploadSimpleIcon } from '@phosphor-icons/react/dist/csr/UploadSimple';
import { api } from '../api';
import { SectionHead, useAction } from './ui';

export default function JsonImport() {
  const action = useAction();
  const [json, setJson] = useState('{\n  "systems": [],\n  "topics": [],\n  "responses": []\n}');
  function submit() {
    let payload: unknown;
    try { payload = JSON.parse(json); } catch { void action.run(() => Promise.reject(new Error('The payload is not valid JSON.'))); return; }
    void action.run(() => api<{ imported: Record<string, number> }>('/admin/import', { method: 'POST', body: JSON.stringify(payload) }),
      result => `Imported atomically: ${Object.entries(result.imported).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ') || 'no records'}.`);
  }
  return <section className="import-panel">
    <SectionHead title="JSON import" description="Import systems, topics, responses, AI judges, and AI judgments in one atomic batch: up to 500 records or 2 MB. Any invalid record or duplicate ID rejects the whole batch." />
    <label className="file-picker"><UploadSimpleIcon />Load JSON file<input type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2_000_000) void action.run(() => Promise.reject(new Error('File exceeds 2 MB. Split it into smaller batches.'))); else setJson(await file.text()); }} /></label>
    <label>Import payload<textarea className="json-editor" spellCheck={false} value={json} onChange={e => setJson(e.target.value)} rows={20} /></label>
    {action.feedback}
    <button className="button dark" disabled={action.busy} onClick={submit}><UploadSimpleIcon />{action.busy ? 'Importing…' : 'Validate & import'}</button>
    <p className="caption table-caption">Main keys: systems, topics, responses, ai_judges, ai_votes. An import-ready corpus can be downloaded from Export &amp; backup.</p>
  </section>;
}
