import test from 'ava';
import type { AddressInfo } from 'node:net';
import { startHttpTransport } from '../src/http-transport.js';
import { createMcpServer } from '../src/server-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import { MessageStore } from '../src/message-store.js';

const AUTH_TOKEN = 'test-secret-token';

const INIT_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ava-test-client', version: '1.0.0' }
  }
};

const ACCEPT = 'application/json, text/event-stream';

function startServer(
  authToken: string | undefined,
  limits: { maxSessions?: number; sessionIdleMs?: number } = {}
): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const connection = new BotConnection(
      { host: 'localhost', port: 25565, username: 'LLMBot' },
      { onLog: () => undefined, onChatMessage: () => undefined }
    );
    const messageStore = new MessageStore();
    const server = startHttpTransport({
      port: 0,
      authToken,
      createServer: () => createMcpServer(connection, messageStore),
      log: () => undefined,
      ...limits
    });
    server.on('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/mcp`,
        close: () => server.close()
      });
    });
  });
}

// The transport returns POST results as SSE frames (event: message\ndata: <json>\n\n).
function parseSsePayload(text: string): Record<string, unknown> {
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  if (!line) {
    throw new Error(`No SSE data line in response: ${text}`);
  }
  return JSON.parse(line.slice('data:'.length).trim());
}

test.serial('POST /mcp initialize without auth returns 401', async (t) => {
  const { baseUrl, close } = await startServer(AUTH_TOKEN);
  t.teardown(close);

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
    body: JSON.stringify(INIT_REQUEST)
  });

  t.is(res.status, 401);
});

test.serial('POST /mcp initialize with bearer token succeeds and lists all tools', async (t) => {
  const { baseUrl, close } = await startServer(AUTH_TOKEN);
  t.teardown(close);

  const initRes = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${AUTH_TOKEN}`
    },
    body: JSON.stringify(INIT_REQUEST)
  });

  t.is(initRes.status, 200);
  const sessionId = initRes.headers.get('mcp-session-id');
  t.truthy(sessionId);

  const initBody = parseSsePayload(await initRes.text());
  t.is((initBody as { id: number }).id, 1);
  t.truthy((initBody as { result?: unknown }).result);

  const listRes = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId as string
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });

  t.is(listRes.status, 200);
  const listBody = parseSsePayload(await listRes.text());
  const tools = (listBody as { result: { tools: { name: string }[] } }).result.tools;
  t.is(tools.length, 141);

  const names = tools.map((tool) => tool.name);
  t.true(names.includes('connect-to-server'));
  t.true(names.includes('disconnect'));
  t.true(names.includes('get-connection-status'));
});

test.serial('initialize returns server instructions', async (t) => {
  const { baseUrl, close } = await startServer(AUTH_TOKEN);
  t.teardown(close);

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${AUTH_TOKEN}`
    },
    body: JSON.stringify(INIT_REQUEST)
  });

  const body = parseSsePayload(await res.text()) as { result: { instructions?: string } };
  const instructions = body.result.instructions;

  t.truthy(instructions);
  t.true(instructions!.includes('get-status'));
  t.true(instructions!.includes('does not see the client'));
});

async function openSession(baseUrl: string): Promise<string> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT, Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify(INIT_REQUEST)
  });
  await res.text();
  return res.headers.get('mcp-session-id') as string;
}

async function listStatus(baseUrl: string, sessionId: string): Promise<number> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
  await res.text();
  return res.status;
}

// Clients that never end their session (one session per call) must not grow the process until it runs out of memory.
test.serial('the least recently used session is closed when the session limit is reached', async (t) => {
  const { baseUrl, close } = await startServer(AUTH_TOKEN, { maxSessions: 2 });
  t.teardown(close);

  const first = await openSession(baseUrl);
  const second = await openSession(baseUrl);
  t.is(await listStatus(baseUrl, first), 200);
  const third = await openSession(baseUrl);

  t.is(await listStatus(baseUrl, second), 400);
  t.is(await listStatus(baseUrl, first), 200);
  t.is(await listStatus(baseUrl, third), 200);
});

test.serial('a session left idle is closed', async (t) => {
  const { baseUrl, close } = await startServer(AUTH_TOKEN, { sessionIdleMs: 150 });
  t.teardown(close);

  const id = await openSession(baseUrl);
  t.is(await listStatus(baseUrl, id), 200);
  await new Promise((resolve) => setTimeout(resolve, 600));
  t.is(await listStatus(baseUrl, id), 400);
});

test.serial('POST /mcp with unknown session ID returns 400', async (t) => {
  const { baseUrl, close } = await startServer(AUTH_TOKEN);
  t.teardown(close);

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': 'does-not-exist'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  });

  t.is(res.status, 400);
});

test.serial('unauthenticated server (no token) allows initialize', async (t) => {
  const { baseUrl, close } = await startServer(undefined);
  t.teardown(close);

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
    body: JSON.stringify(INIT_REQUEST)
  });

  t.is(res.status, 200);
  t.truthy(res.headers.get('mcp-session-id'));
});


test.serial('GET /files serves a recording to an authorized caller only, and DELETE removes it', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  process.env.MC_RECORDINGS_DIR = dir;
  fs.writeFileSync(path.join(dir, 'shot-1.mp4'), Buffer.from('video-bytes'));
  const { baseUrl, close } = await startServer(AUTH_TOKEN);
  t.teardown(() => { close(); delete process.env.MC_RECORDINGS_DIR; });
  const files = baseUrl.replace(/\/mcp$/, '/files');
  t.is((await fetch(`${files}/shot-1.mp4`)).status, 401);
  const ok = await fetch(`${files}/shot-1.mp4`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
  t.is(ok.status, 200);
  t.is(ok.headers.get('content-length'), '11');
  t.is(await ok.text(), 'video-bytes');
  t.is((await fetch(`${files}/..%2Fsecret.mp4`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).status, 404);
  t.is((await fetch(`${files}/missing.mp4`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).status, 404);
  t.is((await fetch(`${files}/shot-1.mp4`, { method: 'DELETE', headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).status, 204);
  t.false(fs.existsSync(path.join(dir, 'shot-1.mp4')));
});

test.serial('GET /live streams the client screen as MJPEG to an authorized caller and stops ffmpeg when they leave', async (t) => {
  const { liveArgs } = await import('../src/live.js');
  const args = liveArgs(':99', 12, 640);
  t.deepEqual(args.slice(0, 8), ['-loglevel', 'error', '-f', 'x11grab', '-framerate', '12', '-video_size', '1280x720']);
  t.true(args.includes(':99'));
  t.true(args.join(' ').includes('scale=640:-2'));
  t.is(args[args.length - 1], '-');
  const { macLiveArgs } = await import('../src/live.js');
  const mac = macLiveArgs('Capture screen 0', 15, 960);
  t.deepEqual(mac.slice(0, 11), ['-loglevel', 'error', '-f', 'avfoundation', '-capture_cursor', '0', '-pixel_format', 'nv12', '-framerate', '15', '-i']);
  t.true(mac.includes('Capture screen 0:none'));
  t.true(mac.join(' ').includes('scale=960:-2'));
  const { modLive } = await import('../src/live.js');
  const m = modLive({ MCCLI_HOST: '10.0.0.2', MCCLI_TOKEN: 'tok' }, 99, 50);
  t.is(m.url, 'http://10.0.0.2:25590/live?fps=30&width=160');
  t.is(m.token, 'tok');
  const capped = liveArgs(':99', 999, 99999);
  t.true(capped.includes('30'));
  t.true(capped.join(' ').includes('scale=1280:-2'));
  const { baseUrl, close } = await startServer(AUTH_TOKEN);
  t.teardown(close);
  const live = baseUrl.replace(/\/mcp$/, '/live');
  t.is((await fetch(live)).status, 401);
  process.env.MC_LIVE_DISPLAY_SOCKET = '/nonexistent/X99';
  process.env.MC_LIVE_SOURCE = 'x11';
  const res = await fetch(live, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
  delete process.env.MC_LIVE_DISPLAY_SOCKET;
  delete process.env.MC_LIVE_SOURCE;
  t.is(res.status, 503);
});
