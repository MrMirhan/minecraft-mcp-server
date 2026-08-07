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

function startServer(authToken: string | undefined): Promise<{ baseUrl: string; close: () => void }> {
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
      log: () => undefined
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
  t.is(tools.length, 61);

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
