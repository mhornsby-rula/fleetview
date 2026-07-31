// Config route for the projects feature. The lead mounts this from the main http
// handler: `if (await handleConfigRoute(req, res)) return;` before the SPA fallback.
// Servers report; the UI decides — responses are pure { ok, config, reason } data.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigRequest, ConfigResponse } from '../shared/config';
import { addRepo, disableRepo, enableRepo, readConfig, removeRepo } from './config';

function json(res: ServerResponse, code: number, body: ConfigResponse) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** Server-side guard: watched repos must be absolute, existing directories. */
async function validateAdd(repoPath: string): Promise<string | null> {
  const p = repoPath.trim();
  if (!p) return 'empty-path';
  if (!path.isAbsolute(p)) return 'not-absolute';
  try {
    if (!(await stat(p)).isDirectory()) return 'not-a-directory';
  } catch {
    return 'not-found';
  }
  return null;
}

/**
 * Handles GET/POST /api/config. Returns true when it owned the request (response
 * already written), false to let the caller fall through to other routes.
 */
export async function handleConfigRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/api/config') return false;

  const method = (req.method || 'GET').toUpperCase();
  try {
    if (method === 'GET') {
      json(res, 200, { ok: true, config: await readConfig() });
      return true;
    }
    if (method === 'POST') {
      const body = (await readBody(req)) as Partial<ConfigRequest>;
      const target = typeof body.path === 'string' ? body.path : '';

      if (body.action === 'add') {
        const reason = await validateAdd(target);
        if (reason) {
          json(res, 200, { ok: false, config: await readConfig(), reason });
          return true;
        }
        json(res, 200, { ok: true, config: await addRepo(target) });
        return true;
      }
      if (body.action === 'remove') {
        json(res, 200, { ok: true, config: await removeRepo(target) });
        return true;
      }
      if (body.action === 'enable') {
        const reason = await validateAdd(target);
        if (reason) {
          json(res, 200, { ok: false, config: await readConfig(), reason });
          return true;
        }
        json(res, 200, { ok: true, config: await enableRepo(target) });
        return true;
      }
      if (body.action === 'disable') {
        json(res, 200, { ok: true, config: await disableRepo(target) });
        return true;
      }
      json(res, 200, { ok: false, config: await readConfig(), reason: 'bad-request' });
      return true;
    }

    json(res, 405, { ok: false, config: await readConfig(), reason: 'method-not-allowed' });
    return true;
  } catch {
    // Malformed body or fs error — report, don't crash the server.
    json(res, 200, { ok: false, config: await readConfig().catch(() => ({ repos: [] })), reason: 'server-error' });
    return true;
  }
}
