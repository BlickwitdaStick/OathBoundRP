import http from 'node:http';

/**
 * Fixed loopback port where the launcher listens for the voice ticket handoff.
 * CEF (`skymp/ui/index.html`, `forwardVoiceHandoff`) POSTs the 'sender'
 * ticket + actorId here, and the launcher starts `voice-helper.exe`.
 *
 * Fixed and known to both sides, like the OAuth callback's port 19847 — CEF
 * is a third process, there is no channel to negotiate a port.
 */
export const VOICE_HANDOFF_PORT = 19848;

const MAX_BODY_BYTES = 4096;
const TICKET_RE = /^[a-f0-9]{8,128}$/i;

/**
 * Loopback HTTP server for the voice handoff.
 *
 * "Armed" only between a `launch-game` and the end of that game session: a
 * POST outside that window answers 409. It lowers the chance of some random
 * local process firing the helper when no game is running — inside the window,
 * the game's CEF is the expected sender, and the ticket is already single-use
 * with a 30s TTL.
 *
 * @param {{ onHandoff: (h: { actorId: number, ticket: string, host: string, port: number }) => Promise<{ pid?: number }>, host?: string, port?: number }} opts
 */
export function createVoiceHandoffServer({ onHandoff, host = '127.0.0.1', port = VOICE_HANDOFF_PORT }) {
  let armed = false;

  const server = http.createServer((req, res) => {
    // CEF loads index.html as file:// (origin "null") — without CORS allowed
    // the fetch doesn't even go out.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'POST' || (req.url || '').split('?')[0] !== '/voice-handoff') {
      res.writeHead(404); return res.end();
    }
    if (!armed) {
      res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: 'disarmed' }));
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.writeHead(413); return res.end(JSON.stringify({ ok: false, error: 'too_large' }));
    }

    let raw = '';
    let aborted = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) { aborted = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (aborted) return;

      let body;
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'bad_json' }));
      }

      const actorId = Number(body && body.actorId);
      const ticket = body && typeof body.ticket === 'string' ? body.ticket : '';
      const vhost = body && typeof body.host === 'string' && body.host ? body.host : '127.0.0.1';
      const vport = Number(body && body.port) || 7778;

      if (!Number.isInteger(actorId) || actorId <= 0 || !TICKET_RE.test(ticket) || !Number.isInteger(vport) || vport <= 0) {
        res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'bad_body' }));
      }

      try {
        const result = await onHandoff({ actorId, ticket, host: vhost, port: vport });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, pid: result && result.pid }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: (err && err.message) || 'spawn_failed' }));
      }
    });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        const onErr = (e) => reject(e);
        server.once('error', onErr);
        server.listen(port, host, () => {
          server.removeListener('error', onErr);
          resolve(server.address());
        });
      });
    },
    arm() { armed = true; },
    disarm() { armed = false; },
    isArmed() { return armed; },
    address() { return server.address(); },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
