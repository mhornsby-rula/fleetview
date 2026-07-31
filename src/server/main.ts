// FleetView API server (Node stdlib http). Dev: Vite proxies /api here.
// Prod: also serves the built SPA from dist/. Binds localhost only.
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { readFleet, claudeVersion } from '../lib/claude-adapter/index';
import { handleConfigRoute, readConfig } from '../features/projects/server';
import { handleSessionRoute } from '../features/session-view/server';
import { handleHooksRoute } from '../features/hooks/server';
import { handleTerminalFocusRoute } from '../features/terminal-focus/server';
import { pendingSnapshot, releaseAll } from './bus';
import { handleOpenRoute } from './open';

const PORT = Number(process.env.PORT) || 4317;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', '..', 'dist');

function send(res: ServerResponse, code: number, body: string | Buffer, type = 'application/json') {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}
function contentType(f: string): string {
  switch (path.extname(f)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript';
    case '.css': return 'text/css';
    case '.json': return 'application/json';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/fleet') {
      const cfg = await readConfig();
      return send(res, 200, JSON.stringify(await readFleet({ repos: cfg.repos, enabledRepos: cfg.enabledRepos }, pendingSnapshot())));
    }
    if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, claude: claudeVersion() }));
    if (await handleConfigRoute(req, res)) return;
    if (await handleTerminalFocusRoute(req, res)) return;
    if (await handleSessionRoute(req, res)) return;
    if (await handleHooksRoute(req, res)) return;
    if (await handleOpenRoute(req, res)) return;

    // static SPA (prod only; dev is served by Vite).
    // Asset filenames are content-hashed so they can cache forever, but index.html
    // must NOT — it's what points at the current hash. Without this a rebuilt UI
    // keeps serving the old bundle to an already-open tab.
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(DIST, rel);
    const cache = (f: string) =>
      f.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
    try {
      if ((await stat(file)).isFile()) {
        res.setHeader('cache-control', cache(file));
        return send(res, 200, await readFile(file), contentType(file));
      }
    } catch { /* fall through to SPA index */ }
    try {
      res.setHeader('cache-control', 'no-cache');
      return send(res, 200, await readFile(path.join(DIST, 'index.html')), 'text/html; charset=utf-8');
    } catch {
      return send(res, 404, 'not found (run `pnpm dev` and use the Vite URL, or `pnpm build`)', 'text/plain');
    }
  } catch (e: any) {
    send(res, 500, 'error: ' + (e?.message || String(e)), 'text/plain');
  }
});

function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${port}`);
    }
  }
  return out;
}

// Bind host: env HOST → config.host → localhost. "0.0.0.0" exposes on the LAN
// (unauthenticated — trusted networks only).
(async () => {
  const cfg = await readConfig().catch(() => null);
  const HOST = process.env.HOST || cfg?.host || '127.0.0.1';
  const exposed = HOST !== '127.0.0.1' && HOST !== 'localhost';
  server.listen(PORT, HOST, () => {
    process.stdout.write(`FleetView → http://127.0.0.1:${PORT}\n`);
    if (exposed) {
      for (const u of lanUrls(PORT)) process.stdout.write(`FleetView LAN → ${u}\n`);
      process.stdout.write(
        '⚠  FleetView is UNAUTHENTICATED and can approve tool calls, open files, and read ~/.claude.\n' +
        '   Exposing on the LAN means anyone on this network can too — use only on a trusted network.\n',
      );
    }
  });
})();

// FleetView owns no processes, but it may be HOLDING permission hook responses —
// release them on shutdown so no terminal session is left blocked waiting on us.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  releaseAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
