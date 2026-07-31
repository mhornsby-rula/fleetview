import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Type-only import: erased at build, so no Node code leaks into the browser bundle.
import type { Fleet, Project, Session, SessionDigest } from '../lib/claude-adapter/types';
import { ProjectSwitcher } from '../features/projects/web';
import { projectSlugs } from '../features/projects/shared/slug';
import { Teammates } from '../features/teammates/web';
import { TaskBoard } from '../features/task-board/web';
import { SessionView, NowPanel, SummaryPanel } from '../features/session-view/web';
import { HookSetup } from '../features/hooks/web';
import { ThemeToggle } from '../features/theme/web/ThemeToggle';
import { useVisiblePoll } from '../ui/useVisiblePoll';
import { usePath, parseRoute, navigate, projectPath, sessionPath } from './router';
import './SessionNav.css';

export function App() {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const prevStatus = useRef<Map<string, string | null> | null>(null);
  const path = usePath();
  const route = parseRoute(path);

  const pollFleet = useCallback(() => {
    void (async () => {
      try {
        const d: Fleet = await (await fetch('/api/fleet')).json();
        setFleet(d); setErr(null);
      } catch (e: any) { setErr(String(e?.message || e)); }
    })();
  }, []);
  useVisiblePoll(pollFleet, 2500);

  useEffect(() => {
    if (!fleet) return;
    const allSessions = fleet.projects.flatMap((p) => p.sessions);
    const currentStatus = new Map(allSessions.map((s) => [s.id, s.live ? (s.status || 'live') : 'dead']));

    if (prevStatus.current !== null) {
      const notify: string[] = [];
      for (const [id, prev] of prevStatus.current) {
        const curr = currentStatus.get(id);
        // Session died (was live, now gone or dead)
        if (prev !== 'dead' && (curr === 'dead' || !curr)) notify.push(id);
        // Session went idle after being busy (finished a turn)
        if (prev === 'busy' && curr === 'idle') notify.push(id);
      }
      if (notify.length > 0) {
        setCompleted((prev) => {
          const next = new Set(prev);
          for (const id of notify) {
            if (id !== route.sessionId) next.add(id);
          }
          return next;
        });
      }
    }

    prevStatus.current = currentStatus;
  }, [fleet, route.sessionId]);

  useEffect(() => {
    if (completed.size > 0) {
      document.title = `✓ ${completed.size} done — FleetView`;
    } else {
      document.title = 'FleetView';
    }
  }, [completed]);

  const clearCompleted = useCallback((id: string) => {
    setCompleted((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Hooks must run before any early return; derive slug maps from the current fleet.
  const slugMaps = useMemo(() => projectSlugs((fleet?.projects ?? []).map((p) => p.path)), [fleet]);

  if (!fleet) return <div className="empty">{err ? `Error: ${err}` : 'Loading fleet…'}</div>;

  // Clean slugs (repo folder name) ↔ absolute paths, resolved against the live fleet.
  const { toSlug, toPath } = slugMaps;
  const selectedRepo = (route.slug && toPath.get(route.slug)) ?? fleet.projects[0]?.path ?? null;
  const project = fleet.projects.find((p) => p.path === selectedRepo) ?? null;
  const slug = selectedRepo ? toSlug.get(selectedRepo) ?? '' : '';
  const session = project && route.sessionId
    ? project.sessions.find((s) => s.id === route.sessionId) ?? null
    : null;

  if (route.sessionId && completed.has(route.sessionId)) {
    clearCompleted(route.sessionId);
  }

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}>▚ FLEETVIEW</button>
        <span className="tag">monitor</span>
        <span className="spacer" />
        <span className="stamp mono">updated {new Date(fleet.generatedAt).toLocaleTimeString()}</span>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <SessionNav fleet={fleet} slugMaps={slugMaps} activeSessionId={route.sessionId ?? null} completed={completed} clearCompleted={clearCompleted} />
          <ThemeToggle />
        </aside>
        <main className="main">
          {!project ? (
            <div className="empty">Select a project.</div>
          ) : route.sessionId ? (
            <SessionPage repo={project.path} slug={slug} sessionId={route.sessionId} session={session} />
          ) : (
            <ProjectView project={project} slug={slug} completed={completed} clearCompleted={clearCompleted} />
          )}
        </main>
      </div>
    </div>
  );
}

function ProjectView({ project, slug, completed, clearCompleted }: { project: Project; slug: string; completed: Set<string>; clearCompleted: (id: string) => void }) {
  return (
    <>
      <HookSetup />
      <div className="pv-head">
        <div>
          <h2 className="pv-title">{project.name}</h2>
          <div className="pv-path mono">{project.path}</div>
        </div>
      </div>

      {project.sessions.length === 0 ? (
        <div className="empty">
          No sessions yet. Run <code>claude</code> in this folder and it will appear here.
        </div>
      ) : (
        <div className="session-list">
          {project.sessions.map((s) => <SessionTile key={s.id} slug={slug} s={s} completed={completed.has(s.id)} clearCompleted={clearCompleted} />)}
        </div>
      )}
    </>
  );
}

function SessionTile({ slug, s, completed, clearCompleted }: { slug: string; s: Session; completed: boolean; clearCompleted: (id: string) => void }) {
  const cls = 'tile' + (s.needsApproval ? ' flagged' : '') + (completed ? ' completed' : '');
  return (
    <button type="button" className={cls} onClick={() => { if (completed) clearCompleted(s.id); navigate(sessionPath(slug, s.id)); }}>
      <div className="tile-head">
        {s.live ? <span className="live"><span className="dot" />{s.status || 'live'}</span> : <span className="idle">◦ inactive</span>}
        {s.kind === 'background' && <span className="tile-own">bg</span>}
        {s.needsApproval && (
          <span className="tile-approve">
            {s.pendingApprovals > 1 ? `${s.pendingApprovals} need approval` : 'needs approval'}
          </span>
        )}
      </div>
      {s.name && <div className="tile-name">{s.name}</div>}
      <div className="tile-uuid mono">{s.id}</div>
      {s.waitingFor && <div className="tile-waiting">waiting · {s.waitingFor}</div>}
      {s.gitBranch && <div className="tile-branch mono">⎇ {s.gitBranch}</div>}
    </button>
  );
}

type IndicatorState = 'idle' | 'working' | 'permission' | 'question';

function indicatorOf(s: Session): IndicatorState {
  if (s.hasQuestion) return 'question';
  if (s.needsApproval) return 'permission';
  if (s.status === 'busy') return 'working';
  return 'idle';
}

function SessionIndicator({ state }: { state: IndicatorState }) {
  switch (state) {
    case 'question': return <span className="snav-ind snav-ind-question">?</span>;
    case 'permission': return <span className="snav-ind snav-ind-permission">!</span>;
    case 'working': return <span className="snav-ind snav-ind-working" />;
    case 'idle': default: return <span className="snav-ind snav-ind-idle" />;
  }
}

function SessionNav({ fleet, slugMaps, activeSessionId, completed, clearCompleted }: {
  fleet: Fleet;
  slugMaps: { toSlug: Map<string, string>; toPath: Map<string, string> };
  activeSessionId: string | null;
  completed: Set<string>;
  clearCompleted: (id: string) => void;
}) {
  // Track which sessions the user has viewed (mark as "read").
  const readRef = useRef<Set<string>>(new Set());

  // Mark the active session as read whenever it changes.
  useEffect(() => {
    if (activeSessionId) readRef.current.add(activeSessionId);
  }, [activeSessionId]);

  const groups = useMemo(() => {
    const out: { project: Project; slug: string; sessions: Session[] }[] = [];
    for (const p of fleet.projects) {
      const live = p.sessions.filter(s => s.live);
      if (live.length === 0) continue;
      out.push({ project: p, slug: slugMaps.toSlug.get(p.path) ?? '', sessions: live });
    }
    return out;
  }, [fleet, slugMaps]);

  if (groups.length === 0) return null;

  return (
    <div className="snav">
      <div className="label">Active sessions</div>
      {groups.map(({ project, slug, sessions }) => (
        <div key={project.path} className="snav-group">
          <button
            type="button"
            className="snav-project-btn"
            onClick={() => navigate(projectPath(slug))}
          >
            {project.name}
          </button>
          <div className="snav-list">
            {sessions.map(s => {
              const active = s.id === activeSessionId;
              const done = completed.has(s.id);
              const unread = !readRef.current.has(s.id) && !active;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={'snav-item'
                    + (active ? ' sel' : '')
                    + (done ? ' done' : '')
                    + (s.hasQuestion ? ' has-question' : s.needsApproval ? ' flagged' : '')
                    + (unread ? ' unread' : '')}
                  onClick={() => { if (done) clearCompleted(s.id); readRef.current.add(s.id); navigate(sessionPath(slug, s.id)); }}
                >
                  <SessionIndicator state={indicatorOf(s)} />
                  <span className="snav-name">{s.name || s.id}</span>
                  {s.needsApproval && <span className="snav-badge">!</span>}
                  {s.live && (
                    <span
                      className="snav-focus"
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (done) clearCompleted(s.id);
                        readRef.current.add(s.id);
                        navigate(sessionPath(slug, s.id));
                        void fetch('/api/session/focus', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ sessionId: s.id, cwd: s.cwd }),
                        });
                      }}
                      title="Focus terminal"
                    >
                      →
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionPage({ repo, slug, sessionId, session }: { repo: string; slug: string; sessionId: string; session: Session | null }) {
  const [digest, setDigest] = useState<SessionDigest | null>(null);
  return (
    <div className="sp">
      <div className="sp-crumbs">
        <button type="button" className="link" onClick={() => navigate(projectPath(slug))}>← {repo.split('/').pop()}</button>
        <span className="sp-crumb-sep">/</span>
        <span className="mono sp-crumb-id" title={sessionId}>{session?.name || sessionId}</span>
      </div>
      <div className="sp-grid">
        <div className="sp-chat">
          <SessionView session={session} repo={repo} sessionId={sessionId} onDigest={setDigest} />
        </div>
        <div className="sp-agents">
          <section className="card">
            <div className="col">
              <h3>Team — what each agent is doing</h3>
              {session && session.members.length > 0
                ? <Teammates members={session.members} session={{ live: session.live, status: session.status }} approvable={false} />
                : <div className="none">No teammates in this session.</div>}
            </div>
          </section>
          <NowPanel
            digest={digest}
            live={!!session?.live}
            status={session?.status}
            waitingFor={session?.waitingFor}
          />
          <SummaryPanel digest={digest} />
          {session && session.tasks.length > 0 && (
            <section className="card">
              <div className="col">
                <h3>Task board</h3>
                <TaskBoard tasks={session.tasks} />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
