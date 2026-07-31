// Monitor-plane assembly. FleetView observes Claude Code sessions; it never owns
// one, so discovery must not depend on ownership.
//
// Discovery order:
//   1. `claude agents --json`  -> every LIVE session, with real liveness.
//   2. SDK listSessions(dir)   -> every session on disk for a watched repo.
//   3. ~/.claude/teams          -> ENRICHMENT ONLY (team rosters).
//   4. Transcripts (TodoWrite) -> task board derived from the lead's plan checklist.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, TEAMS, PROJECTS, encodeCwd } from './paths';
import { readActivity, readModel, transcriptCwd } from './transcripts';
import { liveSessions, knownSessions, canonicalSessionId } from './sessions';
import { completedToolUses } from './digest';
import type {
  Fleet, Project, Session, Task, Teammate, FleetConfig,
  AgentPlanFile, LiveSession, KnownSession,
} from '../types';

const pexec = promisify(execFile);

async function readJson(p: string): Promise<any | null> {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

// agent-<id>.meta.json is written once when the agent spawns and never changes.
// Re-reading + parsing one per agent per poll (64 of them here) is pure waste.
const metaCache = new Map<string, any>();
async function readMeta(p: string): Promise<any> {
  const hit = metaCache.get(p);
  if (hit !== undefined) return hit;
  const v = (await readJson(p)) || {};
  metaCache.set(p, v);
  return v;
}
async function listDirs(p: string): Promise<string[]> {
  try { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

async function loadLiveTeams(): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const n of await listDirs(TEAMS)) { const c = await readJson(path.join(TEAMS, n, 'config.json')); if (c) out[n] = c; }
  return out;
}

// A session's transcript is <projects>/<encodeCwd(cwd)>/<sessionId>.jsonl. When cwd
// is known this is a direct hit; the scan is only a fallback for orphaned ids.
async function transcriptPath(sessionId: string, cwd: string | null): Promise<string | null> {
  if (cwd) {
    const direct = path.join(PROJECTS, encodeCwd(cwd), `${sessionId}.jsonl`);
    try { await stat(direct); return direct; } catch { /* fall through */ }
  }
  for (const pd of await listDirs(PROJECTS)) {
    const p = path.join(PROJECTS, pd, `${sessionId}.jsonl`);
    try { await stat(p); return p; } catch { /* keep looking */ }
  }
  return null;
}

interface WorktreeInfo { path: string; branch: string | null; }

async function worktreeAgents(repoCwd: string): Promise<Record<string, WorktreeInfo>> {
  const map: Record<string, WorktreeInfo> = {};
  try {
    const { stdout } = await pexec('git', ['-C', repoCwd, 'worktree', 'list', '--porcelain'], { maxBuffer: 1 << 20 });
    const blocks = stdout.split('\n\n');
    for (const block of blocks) {
      const wtMatch = block.match(/^worktree (.*\/\.claude\/worktrees\/agent-([0-9a-f]+))\s*$/m);
      if (!wtMatch) continue;
      const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
      map[wtMatch[2]] = { path: wtMatch[1], branch: branchMatch ? branchMatch[1] : null };
    }
  } catch { /* not a git repo / no worktrees */ }
  return map;
}

type WorktreeCache = (repoCwd: string) => Promise<Record<string, WorktreeInfo>>;

/**
 * Memoize `git worktree list` per repo for the lifetime of ONE buildFleet call.
 *
 * Subagent discovery runs per session, and a repo commonly has dozens of sessions
 * — without this, a single /api/fleet poll spawned one `git` process per session
 * (measured: 35 spawns, 30s cold / 7.4s warm on an endpoint polled every 2.5s).
 * Sessions in a repo share one worktree list, so one spawn per repo is enough.
 */
function worktreeCache(): WorktreeCache {
  const cache = new Map<string, Promise<Record<string, WorktreeInfo>>>();
  return (repoCwd: string) => {
    let hit = cache.get(repoCwd);
    if (!hit) cache.set(repoCwd, hit = worktreeAgents(repoCwd));
    return hit;
  };
}

function newTeammate(partial: Partial<Teammate> & Pick<Teammate, 'agentId' | 'name' | 'agentType' | 'isLead'>): Teammate {
  return {
    cwd: null, worktree: null, branch: null, task: null, action: null, actionAt: null,
    plan: null, hasTranscript: false, stale: false, finished: null, ...partial,
  };
}

// M6: an agent self-reports its plan + progress to <worktree>/.fleetview/plan.json.
// This keeps progress tracking off the orchestrator's critical path.
async function readAgentPlan(worktreeCwd: string): Promise<AgentPlanFile | null> {
  return readJson(path.join(worktreeCwd, '.fleetview', 'plan.json'));
}
function applyPlanFile(t: Teammate, pf: AgentPlanFile | null) {
  if (!pf) return;
  if (pf.phase) t.phase = pf.phase;
  if (Array.isArray(pf.steps) && pf.steps.length) {
    t.plan = pf.steps.map(s => ({ content: s.subject, status: s.status || 'pending' }));
    const ip = pf.steps.find(s => s.status === 'in_progress');
    t.task = { subject: ip?.subject || pf.task || t.task?.subject || '' };
  } else if (pf.task) {
    t.task = { subject: pf.task };
  }
}

// Feature/worktree agents are spawned via the Agent tool and do NOT register in the
// team roster, so they're discovered from the session's subagents/ dir + meta.json.
// This works identically for terminal-started sessions — verified: a session started
// in a terminal had six agent-*.jsonl pairs here.
async function discoverSubagents(
  repoCwd: string,
  sessionId: string,
  worktrees: WorktreeCache,
  parentTranscript: string | null,
): Promise<Teammate[]> {
  const dir = path.join(PROJECTS, encodeCwd(repoCwd), sessionId, 'subagents');
  let files: string[]; try { files = (await readdir(dir)).filter(f => /^agent-.*\.jsonl$/.test(f)); } catch { return []; }
  const wt = await worktrees(repoCwd);
  // Which spawns have returned from the SESSION lead. Absence means still running.
  const returnedFromSession = await completedToolUses(parentTranscript);
  // Depth-2+ agents return to their parent agent, not the session — cache per parent.
  const returnedFromAgent = new Map<string, Set<string>>();
  async function returnedFrom(parentAgentId: string): Promise<Set<string>> {
    let s = returnedFromAgent.get(parentAgentId);
    if (s) return s;
    s = await completedToolUses(path.join(dir, `agent-${parentAgentId}.jsonl`));
    returnedFromAgent.set(parentAgentId, s);
    return s;
  }
  const out: Teammate[] = [];
  for (const f of files) {
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const full = path.join(dir, f);
    let mtime = 0; try { mtime = (await stat(full)).mtimeMs; } catch { continue; }
    const meta = await readMeta(path.join(dir, `agent-${id}.meta.json`));
    const a = await readActivity(full);
    const model = await readModel(full);
    const returned = meta.parentAgentId
      ? await returnedFrom(meta.parentAgentId)
      : returnedFromSession;
    const t = newTeammate({
      agentId: id,
      name: meta.name || meta.agentType || `agent-${id.slice(0, 8)}`,
      agentType: meta.agentType || `agent-${id.slice(0, 8)}`,
      desc: meta.description || '',
      isLead: false,
      cwd: wt[id]?.path || null,
      worktree: wt[id]?.path || null,
      branch: wt[id]?.branch || null,
      action: a.action, actionAt: a.at, plan: a.plan,
      model,
      hasTranscript: true,
      stale: Date.now() - mtime > 15000,
      finished: typeof meta.toolUseId === 'string' ? returned.has(meta.toolUseId) : null,
    });
    if (t.cwd) applyPlanFile(t, await readAgentPlan(t.cwd));
    out.push(t);
  }
  // Report every agent; the UI decides what to show (house rule). v1 dropped stale
  // non-worktree agents here, which meant any session whose agents had finished
  // rendered "no teammates" — the opposite of a tool for mapping parallel work.
  // `stale` is carried through so the UI can de-emphasize finished agents.
  return out.sort((x, y) => Number(x.stale) - Number(y.stale) || x.agentType.localeCompare(y.agentType));
}

interface Draft {
  id: string;
  cwd: string | null;
  live: boolean;
  name: string | null;
  kind: 'interactive' | 'background' | null;
  status: string | null;
  waitingFor: string | null;
  pid: number | null;
  gitBranch: string | null;
  lastActiveAt: number | null;
  tasks: Task[];
  team: any | null;
}

function draft(id: string): Draft {
  return {
    id, cwd: null, live: false, name: null, kind: null, status: null, waitingFor: null,
    pid: null, gitBranch: null, lastActiveAt: null, tasks: [], team: null,
  };
}

export async function buildFleet(config: FleetConfig = {}): Promise<Fleet> {
  // --- 1. Live sessions: the authoritative liveness signal, ownership-independent.
  const live = await liveSessions();

  // --- 2. On-disk sessions for every repo we care about (watched + wherever
  //        something is live right now).
  const repos = new Set<string>([...(config.repos ?? []), ...live.map(l => l.cwd)]);
  // Repos are independent; scanning them serially cost the sum rather than the max.
  const known: KnownSession[] = (await Promise.all([...repos].map(r => knownSessions(r)))).flat();

  // Canonical id universe, used to resolve truncated `session-<8hex>` task dirs.
  const allIds = new Set<string>([...live.map(l => l.sessionId), ...known.map(k => k.sessionId)]);

  const drafts = new Map<string, Draft>();
  const get = (id: string) => { let d = drafts.get(id); if (!d) drafts.set(id, d = draft(id)); return d; };

  for (const l of live as LiveSession[]) {
    const d = get(l.sessionId);
    d.live = true;
    d.cwd = l.cwd;
    d.name = l.name;
    d.kind = l.kind;
    d.status = l.status;
    d.waitingFor = l.waitingFor;
    d.pid = l.pid;
    d.lastActiveAt = l.startedAt;
  }
  for (const k of known) {
    const d = get(k.sessionId);
    d.cwd ||= k.cwd;
    // The transcript summary WINS over the CLI's name. `claude agents --json`
    // usually reports a derived slug (`fleetview-81` — folder name + hash), which
    // tells you nothing; listSessions gives the real title / first prompt
    // ("Review the roadmap"). Fall back to the CLI name when there's no summary.
    if (k.summary) d.name = k.summary;
    d.gitBranch ||= k.gitBranch;
    if (k.lastModified && (!d.lastActiveAt || k.lastModified > d.lastActiveAt)) d.lastActiveAt = k.lastModified;
  }

  // --- 3. Enrichment from ~/.claude/teams. These no longer create tiles on
  //        their own unless they resolve to a real session — an unresolvable
  //        `session-<8hex>` dir is an orphan (transcript cleaned up) and is dropped.
  const teams = await loadLiveTeams();
  for (const [name, team] of Object.entries<any>(teams)) {
    const id = canonicalSessionId(name, allIds);
    if (!id) continue;
    const d = get(id);
    d.team ||= team;
    if (!d.cwd) {
      const lead = (team.members || []).find((m: any) => m.agentId === team.leadAgentId) || team.members?.[0];
      d.cwd = lead?.cwd || null;
    }
  }

  // --- 4. Build the public Session for each draft. Sessions are independent, so
  //        this fans out — done sequentially it was the other half of the latency
  //        problem (dozens of transcript reads + stat walks, one after another).
  const worktrees = worktreeCache();
  const sessions = await Promise.all([...drafts.values()].map(async (d): Promise<Session> => {
    if (!d.cwd) d.cwd = await transcriptCwd(await transcriptPath(d.id, null));

    let members: Teammate[];
    if (d.team) {
      members = (d.team.members || []).map((m: any) => newTeammate({
        agentId: m.agentId, name: m.name, agentType: m.agentType,
        isLead: m.agentId === d.team.leadAgentId, cwd: m.cwd || null,
      }));
      for (const t of d.tasks) {
        if (t.owner && !members.some(m => m.name === t.owner || m.agentType === t.owner))
          members.push(newTeammate({ agentId: t.owner, name: t.owner, agentType: t.owner, isLead: false }));
      }
    } else {
      members = [...new Set(d.tasks.map(t => t.owner).filter(Boolean))]
        .map((o: any) => newTeammate({ agentId: o, name: o, agentType: o, isLead: false }));
    }

    // The lead ALWAYS exists — it is the session itself. v1 only synthesized this
    // for sessions it owned, which is why the orchestrator's own row vanished the
    // moment a tasks/ or teams/ dir appeared (FUTURE.md).
    if (!members.some(m => m.isLead)) {
      members.unshift(newTeammate({
        agentId: 'lead', name: d.name || 'session', agentType: 'orchestrator', isLead: true, cwd: d.cwd,
      }));
    }

    // Read the lead's transcript first — this populates plan from TodoWrite.
    const lead = members.find(m => m.isLead)!;
    const tp = await transcriptPath(d.id, d.cwd);
    if (tp) {
      const a = await readActivity(tp);
      lead.action = a.action; lead.actionAt = a.at; lead.hasTranscript = true;
      if (a.plan) lead.plan = a.plan;
      lead.model = await readModel(tp);
    }

    // Promote the lead's TodoWrite plan items to session tasks.
    if (d.tasks.length === 0 && lead.plan?.length) {
      d.tasks = lead.plan.map((p, i) => ({
        id: String(i + 1),
        subject: p.content,
        status: p.status === 'completed' ? 'completed' as const : p.status === 'in_progress' ? 'in_progress' as const : 'pending' as const,
      }));
    }

    const ownedBy = (m: Teammate) => d.tasks.filter(t => t.owner === m.name || t.owner === m.agentType);
    for (const m of members) {
      if (m.isLead) continue;
      const ip = d.tasks.find(t => t.status === 'in_progress' && (t.owner === m.name || t.owner === m.agentType));
      m.task = ip ? { subject: ip.subject, activeForm: ip.activeForm } : null;
      const owned = ownedBy(m);
      if (owned.length) m.plan = owned.map(t => ({ content: t.subject, status: t.status }));
    }

    // Subagent discovery is gated on cwd alone — NOT on liveness. A session that
    // has stopped still has teammates worth showing.
    if (d.cwd) {
      for (const sub of await discoverSubagents(d.cwd, d.id, worktrees, await transcriptPath(d.id, d.cwd))) {
        // A self-reported plan file (sub.phase set) is authoritative; otherwise
        // fall back to the harness task list grouped by owner.
        if (!sub.phase) {
          const owned = d.tasks.filter(t => t.owner === sub.agentType || t.owner === sub.name);
          if (owned.length && !sub.plan) sub.plan = owned.map(t => ({ content: t.subject, status: t.status }));
          const ip = d.tasks.find(t => t.status === 'in_progress' && (t.owner === sub.agentType || t.owner === sub.name));
          if (ip) sub.task = { subject: ip.subject, activeForm: ip.activeForm };
        }
        if (!members.some(m => m.agentId === sub.agentId)) members.push(sub);
      }
    }

    // Parked-permission counts are applied by readFleet, not baked in here, so a
    // cached snapshot can still report an approval the instant it arrives.
    return {
      id: d.id,
      live: d.live,
      attached: d.live,
      needsApproval: false,
      pendingApprovals: 0,
      hasQuestion: false,
      cwd: d.cwd,
      leadSessionId: d.id,
      name: d.name,
      kind: d.kind,
      status: d.status,
      waitingFor: d.waitingFor,
      pid: d.pid,
      gitBranch: d.gitBranch,
      lastActiveAt: d.lastActiveAt,
      tasks: d.tasks,
      counts: {
        pending: d.tasks.filter(t => t.status === 'pending').length,
        in_progress: d.tasks.filter(t => t.status === 'in_progress').length,
        completed: d.tasks.filter(t => t.status === 'completed').length,
      },
      members,
    };
  }));

  // --- 5. Bucket into projects. Watched repos are ADDITIVE, never a filter.
  const enabled = new Set(config.enabledRepos ?? []);
  const byProject: Record<string, Project> = {};
  const mkProject = (key: string): Project =>
    (byProject[key] ||= { path: key, name: path.basename(key) || key, sessions: [], live: false, reportingEnabled: enabled.has(key), activeTeammates: 0 });

  for (const s of sessions) mkProject(s.cwd || '(unknown project)').sessions.push(s);
  for (const repo of config.repos ?? []) mkProject(repo);

  const projects = Object.values(byProject).map(p => {
    p.sessions.sort((a, b) =>
      Number(b.live) - Number(a.live) ||
      (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) ||
      b.id.localeCompare(a.id));
    p.live = p.sessions.some(s => s.live);
    // "Active" means actually working right now — a finished agent still listed on
    // the session page must not inflate this count.
    p.activeTeammates = p.sessions
      .filter(s => s.live)
      .flatMap(s => s.members.filter(m => !m.isLead && !m.stale)).length;
    return p;
  }).sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));

  return { generatedAt: new Date().toISOString(), home: HOME, projects };
}
