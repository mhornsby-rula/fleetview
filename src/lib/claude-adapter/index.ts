// @fleetview/claude-adapter — the ONLY module allowed to touch Claude Code's
// on-disk state, transcripts, or CLI. Features consume this typed interface and
// never reach past it. If Claude Code changes its internals, this is the edit.
//
// This interface is READ-ONLY by design. FleetView visualizes Claude Code
// sessions; the terminal session is the source of truth. There is deliberately
// no way to spawn, message, resume or stop a session from here — see PLAN.md.
import { execFileSync } from 'node:child_process';
import { buildFleet } from './internal/fleet';
import type { PendingSnapshot, Fleet, FleetConfig, Session } from './types';

export * from './types';
export { readSessionHistory, readSubagentHistory } from './internal/history';
export { readSessionDigest } from './internal/sessions';
export { liveSessions, knownSessions, canonicalSessionId, isWaiting, resolveParentSession } from './internal/sessions';
export { readSessionEnvironment } from './internal/environment';

// Building the fleet costs a few hundred ms — it walks every session, every
// subagent dir and every worktree. Node is single-threaded, so paying that on the
// request path meant the 2.5s fleet poll periodically stalled everything else the
// UI asked for (measured: /api/session/history jumping from 31ms to ~500ms while a
// build was in flight). That reads as intermittent lag on a session page.
//
// So: serve the last snapshot immediately and rebuild in the background. Freshness
// is unchanged in practice — the data was already at most one poll old — but no
// request ever waits behind a build, and N open tabs share one build instead of
// each triggering their own.
const FLEET_TTL_MS = 1500;
let fleetAt = 0;
let fleetValue: Fleet | null = null;
let fleetInflight: Promise<Fleet> | null = null;

function cachedFleet(config: FleetConfig): Promise<Fleet> {
  const fresh = fleetValue && Date.now() - fleetAt < FLEET_TTL_MS;
  if (!fresh && !fleetInflight) {
    fleetInflight = buildFleet(config)
      .then(f => { fleetValue = f; fleetAt = Date.now(); return f; })
      .catch(e => { if (fleetValue) return fleetValue; throw e; })
      .finally(() => { fleetInflight = null; });
  }
  return fleetValue ? Promise.resolve(fleetValue) : fleetInflight!;
}

/**
 * Apply the hook bridge's parked-permission counts to a (possibly cached) fleet.
 *
 * Deliberately NOT part of the cached build: an approval request must show up on
 * the very next poll, not whenever the snapshot happens to refresh. Cheap enough
 * to redo per request, and never mutates the cached objects.
 */
function withPending(fleet: Fleet, pending?: PendingSnapshot): Fleet {
  const counts = pending?.pendingBySession;
  if (!counts || Object.keys(counts).length === 0) return fleet;

  const questions = pending?.hasQuestionBySession ?? {};
  const seen = new Set<string>();
  const projects = fleet.projects.map(p => ({
    ...p,
    sessions: p.sessions.map(s => {
      const n = counts[s.id] ?? 0;
      const hq = !!questions[s.id];
      if (n > 0) seen.add(s.id);
      if (n === s.pendingApprovals && hq === s.hasQuestion) return s;
      return { ...s, pendingApprovals: n, needsApproval: n > 0, hasQuestion: hq };
    }),
  }));

  // A request can arrive from a session discovery hasn't indexed. Measured: a
  // session blocked on its very first tool call never registers with
  // `claude agents --json` and has written no transcript, so it produced no tile —
  // and a card with nowhere to render is a card you cannot click. Surface a
  // minimal session for it, in the right project, from what the hook told us.
  const cwds = pending?.cwdBySession ?? {};
  const byPath = new Map(projects.map(p => [p.path, p]));
  for (const [sessionId, n] of Object.entries(counts)) {
    if (n <= 0 || seen.has(sessionId)) continue;
    const cwd = cwds[sessionId] ?? null;
    const key = cwd ?? '(unknown project)';
    let project = byPath.get(key);
    if (!project) {
      project = { path: key, name: key.split('/').pop() || key, sessions: [], live: true, reportingEnabled: false, activeTeammates: 0 };
      byPath.set(key, project);
      projects.push(project);
    }
    project!.live = true;
    project!.sessions = [pendingOnlySession(sessionId, cwd, n, !!questions[sessionId]), ...project!.sessions];
  }

  return { ...fleet, projects };
}

/** The minimum a session page needs to render an approval card for a session we
 *  know nothing else about yet. Everything unknown stays null rather than guessed. */
function pendingOnlySession(id: string, cwd: string | null, pendingApprovals: number, hasQuestion = false): Session {
  return {
    id, live: true, attached: true,
    needsApproval: true, pendingApprovals, hasQuestion,
    cwd, leadSessionId: id,
    name: null, kind: null, status: 'waiting', waitingFor: 'permission request',
    pid: null, gitBranch: null, lastActiveAt: Date.now(),
    tasks: [], counts: { pending: 0, in_progress: 0, completed: 0 },
    members: [],
  };
}

/** Monitor plane: a normalized snapshot of every project/session/teammate.
 *  `pending` carries the hook bridge's parked permission counts per session — the
 *  only live fact not derivable from Claude Code's own state. */
export async function readFleet(config: FleetConfig = {}, pending?: PendingSnapshot): Promise<Fleet> {
  return withPending(await cachedFleet(config), pending);
}

/** Installed Claude Code version — used for graceful degradation later. */
export function claudeVersion(): string {
  try { return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}
