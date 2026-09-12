import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, useLocation } from 'react-router-dom';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ScalesIcon } from '@phosphor-icons/react/dist/csr/Scales';
import { SunIcon } from '@phosphor-icons/react/dist/csr/Sun';
import { MoonIcon } from '@phosphor-icons/react/dist/csr/Moon';
import { useAuth } from './auth';
import { useResource } from './api';
import { Loading, ErrorState, RankingTable } from './components';
import { VOTE_OPTIONS, type Leaderboard } from '../shared/domain';
const Arena = lazy(() => import('./pages/Arena'));
const Leaderboards = lazy(() => import('./pages/Leaderboards'));
const Auth = lazy(() => import('./pages/Auth'));
const Profile = lazy(() => import('./pages/Profile'));
const Judgments = lazy(() => import('./pages/Judgments'));
const System = lazy(() => import('./pages/System'));
const Compare = lazy(() => import('./pages/Compare'));
const Admin = lazy(() => import('./pages/Admin'));

interface Stats { systems: number; topics: number; human_votes: number; ai_votes: number; judges: number; demo_systems: number }

export default function App() {
  const { user, signOut } = useAuth(), location = useLocation();
  const [theme, setTheme] = useState(() => localStorage.getItem('parlibench.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('parlibench.theme', theme); }, [theme]);
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  const stats = useResource<Stats>('/stats');
  useEffect(() => { window.addEventListener('parlibench:judgment', stats.reload); return () => window.removeEventListener('parlibench:judgment', stats.reload); }, [stats.reload]);
  const demo = !!stats.data && stats.data.systems > 0 && stats.data.demo_systems === stats.data.systems;
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><div className="wrap nav-wrap">
      <Link className="brand" to="/" aria-label="ParliBench home"><ScalesIcon size={22} weight="bold" />ParliBench</Link>
      <nav aria-label="Main navigation"><NavLink to="/arena">Arena</NavLink><NavLink to="/leaderboard">Leaderboard</NavLink>{user && <NavLink to={`/profile/${user.username}`}>My profile</NavLink>}</nav>
      <div className="nav-actions">
        <button className="icon-button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <MoonIcon size={18} /> : <SunIcon size={18} />}</button>
        {user ? <><span className="nav-username">{user.username}</span><button className="text-button" onClick={() => void signOut()}>Sign out</button></> : <><Link className="nav-link" to="/login">Sign in</Link><Link className="button small dark" to="/register">Create account</Link></>}
      </div>
    </div></header>
    {demo && <div className="demo-notice"><p className="wrap">Demonstration dataset. Every system, response, and judgment shown here is fictional.</p></div>}
    <main id="main"><Suspense fallback={<Loading />}><Routes>
      <Route path="/" element={<Home stats={stats.data} />} />
      <Route path="/arena" element={<Arena />} />
      <Route path="/leaderboard" element={<Leaderboards />} />
      <Route path="/login" element={<Auth mode="login" />} />
      <Route path="/register" element={<Auth mode="register" />} />
      <Route path="/profile/me/judgments" element={<Judgments />} />
      <Route path="/profile/:username" element={<Profile />} />
      <Route path="/systems/:id" element={<System />} />
      <Route path="/compare/:a/:b" element={<Compare />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="*" element={<div className="empty-state"><h1>Page not found</h1><Link to="/">Back to ParliBench</Link></div>} />
    </Routes></Suspense></main>
    <footer className="site-footer"><div className="wrap footer-wrap"><Link className="footer-brand" to="/">ParliBench</Link><nav aria-label="Footer"><Link to="/leaderboard">Methodology</Link><Link to="/admin">Admin</Link><a href="https://github.com/Danielw412/ParliBench" target="_blank" rel="noreferrer">GitHub <ArrowUpRightIcon /></a></nav></div></footer>
  </>;
}

function Home({ stats }: { stats: Stats | null }) {
  const rank = useResource<Leaderboard>('/leaderboard?source=human&metric=overall');
  return <div className="home">
    <section className="hero">
      <div className="hero-copy">
        <h1>Parliamentary Debate Benchmark</h1>
        <p className="hero-subtitle">An AI systems benchmark for evaluating debate prep strength.</p>
        <div className="hero-actions"><Link className="button dark" to="/arena">Enter the Arena <ArrowRightIcon size={18} /></Link><Link className="button" to="/leaderboard">View leaderboard</Link></div>
      </div>
      <HeroFigure />
    </section>
    <section className="home-standings">
      <div className="section-heading"><h2>Leaderboard</h2><Link className="inline-link" to="/leaderboard">All rankings <ArrowRightIcon size={15} /></Link></div>
      <div className="table-topline"><span>Overall Preference · Human judges</span>{stats && <span>{stats.human_votes.toLocaleString()} judgments across {stats.topics} motions</span>}</div>
      {rank.loading ? <Loading /> : rank.error ? <ErrorState message={rank.error} retry={rank.reload} /> : rank.data && <RankingTable rows={rank.data.rows.slice(0, 5)} compact />}
      <p className="caption">Bradley-Terry ratings from pairwise judgments. Bars show 95% intervals.</p>
    </section>
    <section className="home-method">
      <h2>How it works</h2>
      <dl>
        <div><dt>Blind comparison</dt><dd>Judges read two complete responses to the same motion. System names stay hidden until after the vote.</dd></div>
        <div><dt>Six metrics</dt><dd>Argument strength, evidence, creativity, and strategic prioritization for every task. Opposition tasks add threat identification and rebuttal quality. Any metric can be skipped.</dd></div>
        <div><dt>Pairwise ranking</dt><dd>Bradley-Terry ratings from human and AI judgments, reported with 95% intervals. Overall Preference and the Weighted Benchmark are ranked separately.</dd></div>
        <div><dt>Offline responses</dt><dd>Every response and AI judgment is generated elsewhere and imported. This site never calls a model.</dd></div>
      </dl>
    </section>
  </div>;
}

// Schematic of one Arena matchup: a motion, two anonymous responses, and the five-point scale.
function HeroFigure() {
  const lines = (widths: number[]) => <div className="figure-lines">{widths.map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
  return <div className="hero-figure" aria-hidden="true">
    <div className="figure-motion"><span>Motion</span><p>This House would make public transport free at the point of use.</p></div>
    <div className="figure-pair">
      <div className="figure-response"><div className="figure-head"><span className="letter-square">A</span><span>Identity hidden</span></div>{lines([100, 92, 97, 64, 88, 41])}</div>
      <div className="figure-response"><div className="figure-head"><span className="letter-square outline">B</span><span>Identity hidden</span></div>{lines([100, 86, 95, 72, 50])}</div>
    </div>
    <div className="figure-scale">{VOTE_OPTIONS.map(option => <span key={option.value} className={option.value === 1 ? 'selected' : ''}><span className="full-label">{option.label}</span><span className="short-label">{option.short}</span></span>)}</div>
  </div>;
}
