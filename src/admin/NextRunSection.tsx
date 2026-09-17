import { Link } from 'react-router-dom';
import NextRun from '../NextRun';
import { adminLink, SectionHead } from './ui';

export default function NextRunSection() {
  return <section>
    <SectionHead title="Next Run" description={<>The least-covered executable run, with its rendered prompt. Start it, run the model externally, then record the response. Finished and released runs are listed in <Link className="inline-link" to={adminLink('runs')}>Run history</Link>.</>} />
    <NextRun />
  </section>;
}
