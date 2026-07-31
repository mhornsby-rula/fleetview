// Per-session digest: "what is this agent doing right now" and "what has it
// actually finished". Both are derived from the session transcript.
//
// Why the transcript and not the model's context: **compaction does not delete
// history from the JSONL**. Verified against a real compacted session — 18.6 MB,
// 8 `compact_boundary` entries, 949 entries still present before the first one.
// Compaction shrinks what the model can see; the file keeps everything. So a
// digest derived from the file survives compaction by construction, with no
// separate persistence layer.
//
// The cost of that is having to read the whole file rather than a tail, which is
// far too expensive at poll frequency. So this scans INCREMENTALLY: each session
// keeps a byte cursor and only parses what has been appended since last time.
// (Claude Code does the same thing for its own job tracking — see the
// `linkScanOffset` field in ~/.claude/jobs/<id>/state.json.)
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { summarizeTool } from './transcripts';
import type { AgentReport, Milestone, SessionDigest, TrailItem } from '../types';

/** How many recent tool calls to keep for the activity trail. */
const TRAIL_MAX = 8;
/** Cap on retained milestones — newest win; a long session shouldn't grow forever. */
const DONE_MAX = 60;

interface Cursor {
  offset: number;          // byte offset of the next unparsed line
  /** tool_use ids that have received a tool_result — i.e. that call has returned. */
  toolResults: Set<string>;
  /** Agent tool_use ids pending completion, mapped to their description. */
  pendingAgents: Map<string, string>;
  trail: TrailItem[];      // newest last
  done: Milestone[];       // newest last
  compactions: number;
  edits: number;
  tools: number;
  lastUser: string | null;
}

const cursors = new Map<string, Cursor>();

const fresh = (): Cursor => ({
  offset: 0, toolResults: new Set(), pendingAgents: new Map(), trail: [], done: [], compactions: 0, edits: 0, tools: 0, lastUser: null,
});

/**
 * Pull a commit subject out of a `git commit` invocation.
 * Handles `-m "subject"`, `-m 'subject'`, and the heredoc form this repo uses
 * (`git commit -F - <<'EOF'` … ), where the subject is the first non-empty line.
 */
function commitSubject(cmd: string): string | null {
  // `git commit` must appear in COMMAND position — start of the string or after a
  // shell separator. Matching it anywhere produced false positives from scripts
  // that merely mention it: a `python3 - <<'PY'` block containing the literal
  // "git commit" was reported as a commit titled "import json".
  const GIT_COMMIT = /(?:^|[\n;&|(]|&&|\|\|)\s*git\s+(?:-\S+\s+)*commit\b([^\n]*)/;
  const m = GIT_COMMIT.exec(cmd);
  if (!m) return null;
  const flags = m[1];

  const inline = flags.match(/-m\s+(["'])([\s\S]*?)\1/);
  if (inline) return inline[2].split('\n')[0].trim() || null;

  // Heredoc form (`git commit -F - <<'EOF'`). Only trust the heredoc when the
  // commit actually reads its message from stdin, otherwise any nearby heredoc
  // would be mistaken for the message.
  if (/-F\s*-/.test(flags)) {
    const here = cmd.match(/<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\1/);
    const first = here?.[2].split('\n').map(l => l.trim()).find(Boolean);
    if (first) return first;
  }
  return null;
}

function pushDone(c: Cursor, item: Milestone) {
  // Same milestone can be re-observed if a file is re-scanned from scratch.
  if (c.done.some(d => d.kind === item.kind && d.text === item.text)) return;
  c.done.push(item);
  if (c.done.length > DONE_MAX) c.done.shift();
}

function ingest(c: Cursor, line: string) {
  let o: any;
  try { o = JSON.parse(line); } catch { return; }

  if (o?.type === 'system' && o?.subtype === 'compact_boundary') {
    c.compactions++;
    pushDone(c, {
      kind: 'compaction',
      text: `Context compacted${o?.compactMetadata?.trigger ? ` (${o.compactMetadata.trigger})` : ''}`,
      at: o?.timestamp ?? null,
    });
    return;
  }

  if (o?.type === 'user') {
    const content = o?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          c.toolResults.add(b.tool_use_id);
          const desc = c.pendingAgents.get(b.tool_use_id);
          if (desc) {
            c.pendingAgents.delete(b.tool_use_id);
            pushDone(c, { kind: 'subagent', text: desc, at: o.timestamp ?? null });
          }
        }
      }
    }
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
        : '';
    const trimmed = text.trim();
    // Skip tool plumbing and system-injected reminders; keep real prompts.
    if (trimmed && !trimmed.startsWith('<')) c.lastUser = trimmed.slice(0, 200);
    return;
  }

  if (o?.type !== 'assistant' || !Array.isArray(o?.message?.content)) return;

  for (const b of o.message.content) {
    if (!b || b.type !== 'tool_use') continue;
    c.tools++;

    const summary = summarizeTool(b.name, b.input);
    c.trail.push({ name: b.name, summary, at: o.timestamp ?? null });
    if (c.trail.length > TRAIL_MAX) c.trail.shift();

    if (b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit') c.edits++;

    if (b.name === 'Agent' && b.id) {
      const desc = b.input?.description || b.input?.prompt?.slice(0, 80) || 'subagent';
      c.pendingAgents.set(b.id, desc);
    }

    if (b.name === 'Bash') {
      const subject = commitSubject(String(b.input?.command ?? ''));
      if (subject) pushDone(c, { kind: 'commit', text: subject, at: o.timestamp ?? null });
    }

    if (b.name === 'ExitPlanMode') {
      pushDone(c, { kind: 'plan', text: 'Plan approved', at: o.timestamp ?? null });
    }

    // The harness task tools are the model's own statement of completion.
    if (b.name === 'TaskUpdate' && b.input?.status === 'completed') {
      pushDone(c, { kind: 'task', text: `Task #${b.input.taskId} completed`, at: o.timestamp ?? null });
    }
    if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
      for (const t of b.input.todos) {
        if (t?.status === 'completed' && t?.content) {
          pushDone(c, { kind: 'task', text: String(t.content), at: o.timestamp ?? null });
        }
      }
    }
  }
}

/**
 * The agent's own account of what it's doing and what it has finished.
 *
 * Extends the existing `.fleetview/plan.json` self-report convention to the
 * session level. The agent writes `<cwd>/.fleetview/sessions/<sessionId>.json`,
 * where the id comes from `CLAUDE_CODE_SESSION_ID` — verified to be exported to
 * every session and to track the *current* id (it follows a `/clear` fork).
 *
 * When present this is authoritative: a sentence the agent wrote about its own
 * intent beats anything inferred from which tool happened to run last. Same
 * precedence rule `plan.json`'s `phase` already has over harness-derived state.
 */
async function readReport(cwd: string | null, sessionId: string): Promise<AgentReport | null> {
  if (!cwd || !sessionId) return null;
  const p = path.join(cwd, '.fleetview', 'sessions', `${sessionId}.json`);
  try {
    const raw = JSON.parse(await readFile(p, 'utf8'));
    const done = Array.isArray(raw?.done)
      ? raw.done.filter((d: unknown) => typeof d === 'string' && d.trim()).map((d: string) => d.trim())
      : [];
    const now = typeof raw?.now === 'string' ? raw.now.trim() : '';
    const summary = typeof raw?.summary === 'string' ? raw.summary.trim() : '';
    if (!now && !done.length && !summary) return null;
    return { now: now || null, summary: summary || null, done, updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null };
  } catch {
    return null;
  }
}

/** Conceptual description of recent activity derived from the tool trail.
 *  Aims for sentences like "Investigating route handler in main.ts" or
 *  "Waiting for report back from code-reviewer agent" rather than generic
 *  "editing files" or tool names. */
function describeActivity(trail: TrailItem[]): string | null {
  if (!trail.length) return null;

  // Most recent tool call is the best signal for "what it's doing right now".
  const latest = trail[trail.length - 1];
  const desc = describeOne(latest);
  if (desc) return desc;

  // If the latest didn't produce a good sentence, try the second-most-recent.
  if (trail.length > 1) {
    const prev = describeOne(trail[trail.length - 2]);
    if (prev) return prev;
  }

  return null;
}

function describeOne(item: TrailItem): string | null {
  const name = item.name;
  const summary = item.summary;

  if (name === 'Agent' || name === 'Task') {
    // summary looks like "Spawn code-reviewer: Review the auth middleware"
    const m = summary.match(/^Spawn\s+(\S+?)(?::\s*(.+))?$/);
    if (m) {
      const agentType = m[1];
      const task = m[2];
      if (task) return `Delegating to ${agentType} agent — ${task}`;
      return `Waiting for report back from ${agentType} agent`;
    }
    return 'Coordinating subagents';
  }

  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
    // summary looks like "Edit App.tsx" or "Write store.ts"
    const file = summary.replace(/^(Edit|Write|NotebookEdit)\s*/, '');
    if (file) return `Writing code in ${file}`;
    return 'Writing code';
  }

  if (name === 'Read') {
    const file = summary.replace(/^Read\s*/, '');
    if (file) return `Investigating ${file}`;
    return 'Reading through the codebase';
  }

  if (name === 'Grep') {
    const pattern = summary.replace(/^Grep\s*/, '');
    if (pattern) return `Searching for "${pattern}"`;
    return 'Searching the codebase';
  }

  if (name === 'Glob') {
    const pattern = summary.replace(/^Glob\s*/, '');
    if (pattern) return `Looking for files matching ${pattern}`;
    return 'Scanning file structure';
  }

  if (name === 'Bash') {
    // summary looks like "Bash: description" or "Bash: raw command"
    const cmd = summary.replace(/^Bash:\s*/, '');
    if (!cmd) return 'Executing a command';
    // If the tool had a human-written description, use it directly.
    // Heuristic: descriptions are sentence-like (start with uppercase or a verb),
    // while raw commands start with lowercase or special chars.
    if (/^[A-Z]/.test(cmd) && !cmd.startsWith('/')) return cmd;
    // Try to extract intent from common command patterns
    if (/\b(test|jest|vitest|mocha|pytest)\b/i.test(cmd)) return 'Running tests';
    if (/\btsc\b|type.?check/i.test(cmd)) return 'Type-checking the project';
    if (/\b(build|compile|vite build|webpack)\b/i.test(cmd)) return 'Building the project';
    if (/\bgit\s+(status|diff|log)\b/.test(cmd)) return 'Checking git state';
    if (/\bgit\s+commit\b/.test(cmd)) return 'Committing changes';
    if (/\b(curl|fetch|wget)\b/.test(cmd)) return 'Making an HTTP request';
    if (/\b(npm|pnpm|yarn)\s+(install|add)\b/.test(cmd)) return 'Installing dependencies';
    if (/\bdev\b|server/i.test(cmd)) return 'Starting a dev server';
    return `Executing: ${cmd.slice(0, 60)}`;
  }

  if (name === 'AskUserQuestion') {
    return 'Waiting for your answer';
  }

  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] || 'external';
    return `Working with ${server}`;
  }

  return null;
}

/**
 * Read (or incrementally update) a session's digest.
 *
 * Never throws — an unreadable or unparseable transcript yields an empty digest,
 * matching the rest of the adapter's defensive posture.
 */
/**
 * Advance the incremental cursor for a transcript and return it.
 * Shared by the digest and by subagent-completion lookups so one pass serves both.
 */
async function scan(transcriptPath: string): Promise<Cursor | null> {
  let size = 0;
  try { ({ size } = await stat(transcriptPath)); } catch { return null; }

  let c = cursors.get(transcriptPath);
  // A shrunk file means it was replaced (or forked over) — rescan from scratch.
  if (!c || size < c.offset) cursors.set(transcriptPath, c = fresh());

  if (size > c.offset) {
    const fh = await open(transcriptPath, 'r').catch(() => null);
    if (fh) {
      try {
        const len = size - c.offset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, c.offset);
        const chunk = buf.subarray(0, bytesRead);
        // Only consume up to the last complete line; a partial trailing line is
        // left for the next pass rather than parsed as garbage.
        const lastNl = chunk.lastIndexOf(0x0a);
        if (lastNl >= 0) {
          for (const line of chunk.subarray(0, lastNl).toString('utf8').split('\n')) {
            if (line) ingest(c, line);
          }
          c.offset += lastNl + 1;
        }
      } finally { await fh.close(); }
    }
  }
  return c;
}

/**
 * Which spawned agents have RETURNED, by the `toolUseId` in their meta.json.
 *
 * This is the definitive "is it still running" signal, and it replaces guessing
 * from transcript staleness — a quiet agent may simply be idle or waiting, which
 * is not the same as finished. A subagent's spawning `Agent`/`Task` tool_use gets
 * a matching `tool_result` in the PARENT transcript the moment it returns (or is
 * dismissed), so presence of that id means done and absence means still alive.
 */
export async function completedToolUses(transcriptPath: string | null): Promise<Set<string>> {
  if (!transcriptPath) return new Set();
  const c = await scan(transcriptPath);
  return c ? c.toolResults : new Set();
}

export async function readDigest(
  transcriptPath: string | null,
  opts: { cwd?: string | null; sessionId?: string } = {},
): Promise<SessionDigest> {
  const report = await readReport(opts.cwd ?? null, opts.sessionId ?? '');
  const empty: SessionDigest = {
    now: report?.now ?? null,
    summary: report?.summary ?? null,
    reported: !!report,
    reportedAt: report?.updatedAt ?? null,
    doing: null, trail: [],
    done: (report?.done ?? []).map(text => ({ kind: 'reported' as const, text, at: null })),
    compactions: 0, edits: 0, tools: 0, lastRequest: null,
  };
  if (!transcriptPath) return empty;
  const c = await scan(transcriptPath);
  if (!c) return empty;

  const trail = [...c.trail].reverse();       // newest first
  const derived = [...c.done].reverse();      // newest first

  return {
    // The agent's own sentence wins; otherwise say what it's conceptually doing
    // rather than naming the tool — a command string is not an explanation.
    now: report?.now ?? describeActivity(trail),
    summary: report?.summary ?? null,
    reported: !!report,
    reportedAt: report?.updatedAt ?? null,
    doing: trail[0] ?? null,
    trail,
    // Agent-maintained list is authoritative; derived milestones are the fallback
    // so a session that never adopts the convention still shows something real.
    done: report?.done.length
      ? report.done.map(text => ({ kind: 'reported' as const, text, at: null }))
      : derived,
    compactions: c.compactions,
    edits: c.edits,
    tools: c.tools,
    lastRequest: c.lastUser,
  };
}
