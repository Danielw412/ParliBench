import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { api } from '../api';
import { download, SectionHead, useAction } from './ui';

export default function Export() {
  const action = useAction();
  const fetchAndSave = (scope: 'corpus' | 'backup') => action.run(async () => {
    const data = await api<unknown>(`/admin/export?scope=${scope}`);
    download(`parlibench-${scope}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, data);
  }, scope === 'backup' ? 'Full backup downloaded.' : 'Corpus downloaded.');
  return <section>
    <SectionHead title="Export & backup" description="Download benchmark data as JSON. Exports are recorded in the audit log." />
    <div className="export-options">
      <div className="tool-panel"><h3>Case corpus</h3>
        <p className="caption">Systems, topics, Government and Opposition responses, AI judges, and their AI judgments, in the JSON import format. Use it to seed another deployment or re-import in batches of 500 records.</p>
        <button className="button dark" disabled={action.busy} onClick={() => void fetchAndSave('corpus')}><DownloadSimpleIcon size={16} />Download corpus</button></div>
      <div className="tool-panel"><h3>Full backup</h3>
        <p className="caption">Every benchmark table: responses with revision history, structured cases, prompts, Rebuttal Pool, run records, matchups, Arena assignments, human and AI votes, weights, and the audit log. Accounts are included without PIN hashes, salts, or sessions.</p>
        <button className="button" disabled={action.busy} onClick={() => void fetchAndSave('backup')}><DownloadSimpleIcon size={16} />Download full backup</button></div>
    </div>
    {action.feedback}
  </section>;
}
