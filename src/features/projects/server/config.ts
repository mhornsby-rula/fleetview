// Read/write ~/.fleetview.json — FleetView's own config (NOT ~/.claude).
// Safe file handling: missing/corrupt file falls back to defaults; never throws.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type FleetViewConfig } from '../shared/config';

const CONFIG_PATH = path.join(homedir(), '.fleetview.json');

const cleanStr = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
};

function uniqueStrings(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return Array.from(
    new Set(
      arr
        .filter((r): r is string => typeof r === 'string')
        .map((r) => r.trim())
        .filter((r) => r !== ''),
    ),
  );
}

/** Coerce untrusted JSON into a valid config: unique, trimmed repo paths, and
 *  preserve editor/host (dropping them here silently disabled both features). */
function normalize(input: unknown): FleetViewConfig {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const repos = uniqueStrings(obj.repos);
  const enabledRepos = uniqueStrings(obj.enabledRepos);
  const editor = cleanStr(obj.editor);
  const host = cleanStr(obj.host);
  return {
    repos,
    ...(enabledRepos.length ? { enabledRepos } : {}),
    ...(editor ? { editor } : {}),
    ...(host ? { host } : {}),
  };
}

export async function readConfig(): Promise<FleetViewConfig> {
  try {
    return normalize(JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(config: FleetViewConfig): Promise<FleetViewConfig> {
  const normalized = normalize(config);
  await writeFile(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export async function addRepo(repoPath: string): Promise<FleetViewConfig> {
  const config = await readConfig();
  return writeConfig({ ...config, repos: [...config.repos, repoPath.trim()] });
}

export async function removeRepo(repoPath: string): Promise<FleetViewConfig> {
  const target = repoPath.trim();
  const config = await readConfig();
  return writeConfig({ ...config, repos: config.repos.filter((r) => r !== target) });
}

// --- FleetView session reporting opt-in ---

const FLEETVIEW_BLOCK_START = '<!-- fleetview:start -->';
const FLEETVIEW_BLOCK_END = '<!-- fleetview:end -->';

const FLEETVIEW_INSTRUCTION = `${FLEETVIEW_BLOCK_START}
# FleetView session reporting

When you complete something significant (a fix, a feature, a refactor — not every small step), update \`.fleetview/sessions/$CLAUDE_CODE_SESSION_ID.json\` in the project root with a brief summary of what this session has accomplished so far.

The file schema:

\`\`\`json
{
  "summary": "1-5 sentences describing what this session has accomplished.",
  "updatedAt": "ISO 8601 timestamp"
}
\`\`\`

Rules:
- Create the \`.fleetview/sessions/\` directory if it doesn't exist.
- Overwrite the file each time — it's the current state, not a log.
- Keep the summary concise and focused on outcomes, not process.
- The \`summary\` field is cumulative — it covers everything accomplished in this session, not just the latest change.
- This is purely for visualization — it does not affect your work.
${FLEETVIEW_BLOCK_END}`;

async function injectClaudeMd(repoPath: string): Promise<void> {
  const claudeDir = path.join(repoPath, '.claude');
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  await mkdir(claudeDir, { recursive: true });
  let content = '';
  try { content = await readFile(claudeMd, 'utf8'); } catch { /* new file */ }
  if (content.includes(FLEETVIEW_BLOCK_START)) return;
  const sep = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : '';
  await writeFile(claudeMd, content + sep + FLEETVIEW_INSTRUCTION + '\n', 'utf8');
}

async function removeClaudeMd(repoPath: string): Promise<void> {
  const claudeMd = path.join(repoPath, '.claude', 'CLAUDE.md');
  let content: string;
  try { content = await readFile(claudeMd, 'utf8'); } catch { return; }
  const start = content.indexOf(FLEETVIEW_BLOCK_START);
  const end = content.indexOf(FLEETVIEW_BLOCK_END);
  if (start === -1 || end === -1) return;
  const before = content.slice(0, start).replace(/\n+$/, '');
  const after = content.slice(end + FLEETVIEW_BLOCK_END.length).replace(/^\n+/, '');
  const result = [before, after].filter(Boolean).join('\n\n');
  if (result.trim()) {
    await writeFile(claudeMd, result.endsWith('\n') ? result : result + '\n', 'utf8');
  } else {
    await rm(claudeMd, { force: true });
  }
}

export async function enableRepo(repoPath: string): Promise<FleetViewConfig> {
  const target = repoPath.trim();
  const config = await readConfig();
  const enabled = config.enabledRepos ?? [];
  if (!enabled.includes(target)) enabled.push(target);
  await injectClaudeMd(target);
  return writeConfig({ ...config, enabledRepos: enabled });
}

export async function disableRepo(repoPath: string): Promise<FleetViewConfig> {
  const target = repoPath.trim();
  const config = await readConfig();
  const enabled = (config.enabledRepos ?? []).filter((r) => r !== target);
  await removeClaudeMd(target);
  return writeConfig({ ...config, enabledRepos: enabled });
}

export { CONFIG_PATH };
