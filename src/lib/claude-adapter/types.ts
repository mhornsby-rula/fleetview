// Public data shapes for the Monitor plane. These are FleetView's own types —
// deliberately decoupled from Claude Code's internal on-disk shapes, which are
// parsed and normalized in ./internal and never leak past this package.

export interface Task {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  status: 'pending' | 'in_progress' | 'completed' | (string & {});
  blocks?: string[];
  blockedBy?: string[];
}

export interface PlanItem {
  content: string;
  status: string;
}

/** Lifecycle of a plan-gated feature agent (self-reported via .fleetview/plan.json). */
export type TeammatePhase = 'planning' | 'awaiting-approval' | 'working' | 'done' | 'blocked';

/** Shape an agent writes to <worktree>/.fleetview/plan.json (M6 self-reporting). */
export interface AgentPlanFile {
  task?: string;
  phase?: TeammatePhase | (string & {});
  steps?: { id?: string; subject: string; status?: string }[];
  updatedAt?: string;
}

export interface Teammate {
  agentId: string;
  name: string;
  agentType: string;
  isLead: boolean;
  cwd: string | null;
  worktree: string | null;
  branch: string | null;
  desc?: string;
  model?: string | null;
  /** Self-reported lifecycle phase (M6); present only for plan-gated agents. */
  phase?: TeammatePhase | (string & {});
  /** The in-progress task this agent owns, if any. */
  task: { subject: string; activeForm?: string } | null;
  /** One-line "what it's doing now" (latest tool call). */
  action: string | null;
  actionAt: string | null;
  /** Self-completing checklist (this owner's tasks). */
  plan: PlanItem[] | null;
  /** True when its transcript hasn't advanced recently. Says "quiet", NOT "done" —
   *  an agent can be idle or waiting on a prompt and still very much alive. */
  stale: boolean;
  /**
   * The agent has RETURNED (or been dismissed) and is no longer running.
   * Determined from the spawning tool_use receiving a tool_result in the parent
   * transcript — definitive, unlike inferring it from silence.
   * `null` when it can't be determined (no toolUseId in meta.json).
   */
  finished: boolean | null;
  hasTranscript: boolean;
}

/** A live Claude Code process, as reported by `claude agents --json`. */
export interface LiveSession {
  sessionId: string;
  pid: number | null;
  cwd: string;
  kind: 'interactive' | 'background';
  /** Session name — derived (e.g. "fleetview-b6") or the task title for bg agents. */
  name: string | null;
  startedAt: number | null;
  /** "busy" | "idle" | "waiting" | "shell". Absent until the session reports one. */
  status: string | null;
  /** Why it's parked, e.g. "permission prompt" / "dialog open". */
  waitingFor: string | null;
  /** "working" | "blocked" | … */
  state: string | null;
  /** Background job id, when kind === 'background'. */
  jobId: string | null;
}

/** A session on disk (live or past), from the SDK's listSessions(). */
export interface KnownSession {
  sessionId: string;
  summary: string;
  cwd: string;
  gitBranch: string | null;
  lastModified: number | null;
  createdAt: number | null;
}

export interface Session {
  /** Canonical id — always the full session UUID. */
  id: string;
  live: boolean;
  /**
   * FleetView is observing a live process for this session (it never owns one).
   * Replaces v1's `owned`, which meant "FleetView spawned it".
   */
  attached: boolean;
  /** A tool-permission request from this session is parked awaiting a decision. */
  needsApproval: boolean;
  /** How many are parked (not just whether any are). */
  pendingApprovals: number;
  /** True when at least one parked request is an AskUserQuestion. */
  hasQuestion: boolean;
  cwd: string | null;
  leadSessionId: string | null;
  /** Human-readable session name, when known. */
  name: string | null;
  kind: 'interactive' | 'background' | null;
  /** Liveness detail straight from the CLI; null for past sessions. */
  status: string | null;
  waitingFor: string | null;
  pid: number | null;
  gitBranch: string | null;
  lastActiveAt: number | null;
  tasks: Task[];
  counts: { pending: number; in_progress: number; completed: number };
  members: Teammate[];
}

export interface Project {
  path: string;
  name: string;
  live: boolean;
  /** Whether FleetView session reporting is enabled for this repo. */
  reportingEnabled: boolean;
  activeTeammates: number;
  sessions: Session[];
}

export interface Fleet {
  generatedAt: string;
  home: string;
  projects: Project[];
}

export interface FleetConfig {
  /** Additional watched repo paths — always shown as projects (additive, not a filter). */
  repos?: string[];
  /** Repos where session reporting is enabled. */
  enabledRepos?: string[];
}

/**
 * Permission requests currently parked in the hook bridge, keyed by canonical
 * session id. This is the only live fact the monitor snapshot needs from the
 * rest of the app — liveness itself now comes from `claude agents --json`,
 * not from FleetView owning a process.
 */
export interface PendingSnapshot {
  pendingBySession: Record<string, number>;
  /**
   * cwd per session with a parked request. A permission can arrive from a session
   * discovery hasn't indexed yet — a brand-new one blocked on its very first tool
   * call never registers with `claude agents --json` — and without somewhere to
   * render the card the whole approve-from-the-browser flow is unusable exactly
   * when it matters most.
   */
  cwdBySession?: Record<string, string>;
  /** Sessions that have at least one parked AskUserQuestion. */
  hasQuestionBySession?: Record<string, boolean>;
}

// --- Permissions: answering a question the session asked (hook bridge) ---

/** What the user decided about a parked tool-permission request. */
export type PermissionDecision = 'allow' | 'deny' | 'always';

/**
 * A tool call parked awaiting the user's decision, received via Claude Code's
 * `PermissionRequest` hook over HTTP.
 *
 * Field notes, verified against CLI 2.1.220 — the payload is thinner than the
 * SDK's `canUseTool` options were:
 * - There is **no tool_use_id and no request id** in the hook payload, so
 *   `requestId` is minted by FleetView; the held HTTP connection is the identity.
 * - `agentId`/`agentType` are present **only for subagents**. `agentId === null`
 *   means the lead/main agent asked.
 * - A subagent reports its **own** `sessionId`, not its parent's — hence
 *   `parentSessionId`, resolved by FleetView so the card can be grouped.
 */
export interface PermissionRequest {
  requestId: string;
  /** The session that asked. For a subagent this is the SUBAGENT's own id. */
  sessionId: string;
  /** Resolved parent session, when a subagent asked; else null. */
  parentSessionId: string | null;
  cwd: string;
  toolName: string;
  input: unknown;
  /** null === the lead/main agent asked. */
  agentId: string | null;
  agentType: string | null;
  /** The CLI's own `permission_suggestions`, verbatim. Often a session-scoped
   *  `setMode` that persists nothing — see respondPermission for why we don't
   *  simply echo it back. */
  suggestions?: unknown[];
  receivedAt: string;
}

/** Events pushed to the browser over SSE. Sourced from hooks + transcript tails. */
export interface SessionEvent {
  kind: 'permission' | 'permission_resolved' | 'activity' | 'error';
  sessionId: string;
  permission?: PermissionRequest;
  decision?: PermissionDecision;
  text?: string;
  at?: string;
}

// --- Session digest: "doing now" + "done so far" ---

/** One recent tool call, for the activity trail. */
export interface TrailItem {
  name: string;
  summary: string;
  at: string | null;
}

/** A high-level thing the session actually finished. */
export interface Milestone {
  /** `reported` = the agent said so itself; the rest are derived from the transcript.
   *  `commit` is the strongest derived signal — verifiable and self-titled. */
  kind: 'reported' | 'commit' | 'task' | 'plan' | 'compaction' | 'subagent';
  text: string;
  at: string | null;
}

/**
 * What an agent writes about itself to
 * `<cwd>/.fleetview/sessions/<CLAUDE_CODE_SESSION_ID>.json`.
 * Session-level sibling of the per-worktree `.fleetview/plan.json` convention.
 */
export interface AgentReport {
  /** 1-3 sentences on the conceptual work in flight. */
  now: string | null;
  /** 1-5 sentence summary of what this session has accomplished. */
  summary: string | null;
  /** High-level things finished this session, oldest first. */
  done: string[];
  updatedAt: string | null;
}

/**
 * Derived from the session transcript, which retains everything across context
 * compactions — so this survives compaction without a separate store.
 */
export interface SessionDigest {
  /** 1-3 sentences on what's happening — the agent's own words when it reports
   *  them, else a conceptual description of recent activity. Never a command. */
  now: string | null;
  /** 1-5 sentence summary of what this session has accomplished overall. */
  summary: string | null;
  /** True when the agent maintains its own report (see AgentReport). */
  reported: boolean;
  reportedAt: string | null;
  /** The most recent tool call. Kept for the teammates line; the panels don't
   *  surface raw commands. */
  doing: TrailItem | null;
  /** Recent tool calls, newest first. */
  trail: TrailItem[];
  /** Milestones, newest first. */
  done: Milestone[];
  compactions: number;
  edits: number;
  tools: number;
  /** The last real user prompt — what it's currently working toward. */
  lastRequest: string | null;
}

// --- Session environment: metadata from the init system message ---

/** Static metadata extracted from the session's init system message. */
export interface SessionEnvironment {
  cwd: string;
  model: string;
  skills: string[];
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode: string;
  version: string;
}

/** One normalized transcript entry, for rendering a session read-only. */
export type ChatItem =
  | { kind: 'user'; text: string; at?: string }
  | { kind: 'assistant'; text: string; at?: string }
  | { kind: 'tool'; name: string; summary: string; at?: string }
  | { kind: 'result'; tokens?: number; at?: string }
  | { kind: 'notification'; text: string; at?: string }
  | { kind: 'plan'; text: string; path: string; at?: string };
