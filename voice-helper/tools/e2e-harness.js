#!/usr/bin/env node
/**
 * e2e-harness.js — starts the voip-service in isolation, with fake positions, to
 * prove the voice pipeline without needing a Skyrim server running.
 *
 * ⚠️ LOCAL TEST TOOL. It issues a voice ticket for any actorId that asks, with
 * no authentication at all — exactly the hole the ticket handshake exists to
 * close. It only makes sense on 127.0.0.1, on a development machine. Never near
 * production, never with a public bind.
 *
 * What it sets up:
 *   - a mocked `mp`, with positions you control over HTTP;
 *   - the real voip-service (same code as the gamemode), on a known port;
 *   - an HTTP server that serves `skymp/ui/index.html` and issues tickets.
 *
 * Usage:
 *   node voice-helper/tools/e2e-harness.js [--voip-port 7778] [--http-port 8099]
 *
 * Routes:
 *   GET /                          → the real index.html from skymp/ui/
 *   GET /ticket?actorId=0xFF000A12 → { actorId, ticket, host, port }
 *   GET /move?actorId=..&x=..&y=..&z=..  → repositions an actor
 *   GET /state                     → positions and connected actors
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const VOIP_PORT = Number.parseInt(argOf('--voip-port', '7778'), 10);
const HTTP_PORT = Number.parseInt(argOf('--http-port', '8099'), 10);

const UI_ROOT = path.resolve(__dirname, '..', '..', 'skymp', 'ui');
const GAMEMODE = path.resolve(__dirname, '..', '..', 'skymp', 'gamemode');

// Actor positions in the world, in Skyrim units.
const positions = new Map();

// The gamemode talks to the server through this global. The voip-service only
// reads `locationalData`, so that's all the mock needs to provide.
global.mp = {
  get: (actorId, prop) => {
    if (prop !== 'locationalData') return null;
    const pos = positions.get(Number(actorId));
    return pos ? { pos } : null;
  },
  set: () => {}
};

// `database` is pulled in transitively by `commands`; without a stub, the
// harness tries to open MySQL just to issue a ticket.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/database') || request === './database') {
    return { query: async () => [], init: () => {} };
  }
  return originalLoad.apply(this, arguments);
};
const voip = require(path.join(GAMEMODE, 'voip-service.js'));
const { VOICE_RANGES } = require(path.join(GAMEMODE, 'core', 'proximity-ranges.js'));
Module._load = originalLoad;

voip.startVoipServer(VOIP_PORT, '127.0.0.1');

function json(res, code, body) {
  const raw = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    // The page is served from here and talks to the WebSocket on another port;
    // without this, the page's own fetch of /ticket would be blocked.
    'Access-Control-Allow-Origin': '*'
  });
  res.end(raw);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
  const actorId = Number.parseInt(url.searchParams.get('actorId'), 0);

  if (url.pathname === '/ticket') {
    if (!Number.isFinite(actorId)) return json(res, 400, { error: 'invalid actorId' });
    // Tickets are per role: the same player needs one for the helper (`sender`)
    // and one for the UI (`listener`), and neither works in place of the other.
    // Without `role` the route returns the listener one — which is what the
    // page itself fetches on load.
    const role = url.searchParams.get('role') || 'listener';
    if (!voip.VOIP_ROLES.includes(role)) {
      return json(res, 400, { error: `invalid role: ${role}` });
    }
    const ticket = voip.issueTicket(actorId, role);
    return json(res, 200, { actorId, ticket, role, host: '127.0.0.1', port: VOIP_PORT });
  }

  if (url.pathname === '/move') {
    if (!Number.isFinite(actorId)) return json(res, 400, { error: 'invalid actorId' });
    const pos = ['x', 'y', 'z'].map((k) => Number.parseFloat(url.searchParams.get(k) || '0'));
    positions.set(actorId, pos);
    voip.tickProximity(); // apply now instead of waiting for the 2s ticker
    return json(res, 200, { actorId, pos });
  }

  if (url.pathname === '/state') {
    return json(res, 200, {
      ranges: VOICE_RANGES,
      positions: [...positions.entries()].map(([id, pos]) => ({
        actorId: id, hex: '0x' + id.toString(16), pos
      })),
      connected: voip.getConnectedVoipActors().map((id) => '0x' + id.toString(16)),
      audience: [...voip._audienceByActor.entries()].map(([id, list]) => ({
        speaker: '0x' + id.toString(16),
        listeners: list.map((l) => ({ actorId: '0x' + l.actorId.toString(16), volume: l.volume }))
      }))
    });
  }

  // Anything else: serve the UI directory.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.resolve(UI_ROOT, rel);
  if (!file.startsWith(UI_ROOT)) { res.writeHead(403); return res.end('nope'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    const mime = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[harness] voip-service   ws://127.0.0.1:${VOIP_PORT}`);
  console.log(`[harness] UI + tickets   http://127.0.0.1:${HTTP_PORT}/`);
  console.log(`[harness] normal range   ${VOICE_RANGES.normal} units`);
  console.log('[harness] ⚠️  issues tickets without authentication — local machine only.');
});

process.on('SIGINT', () => {
  voip.stopVoipServer();
  server.close();
  process.exit(0);
});
