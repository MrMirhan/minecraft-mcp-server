import test from 'ava';
import net, { type AddressInfo, type Socket } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { McClient } from '../src/mc-client.js';

const TEST_SCREENSHOT_DIR = path.join(os.tmpdir(), 'mc-client-test-screenshots');

type Handler = (request: { id?: string; command: string; params?: Record<string, unknown> }, socket: Socket) => void | Promise<void>;

function startFakeServer(handler: Handler): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) return;
        const line = buffer.slice(0, newlineIndex);
        handler(JSON.parse(line), socket);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

function reply(socket: Socket, body: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(body)}\n`);
}

test('request sends a newline-delimited JSON request and parses a success response', async (t) => {
  const { port, close } = await startFakeServer((req, socket) => {
    t.is(req.command, 'status');
    reply(socket, { id: req.id, success: true, data: { in_game: true, time: 6000 } });
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 2000 });
  const result = await client.request('status', {});

  t.deepEqual(result, { ok: true, data: { in_game: true, time: 6000 } });
  await close();
});

test('request sends id, command and params in the documented shape', async (t) => {
  let received: unknown;
  const { port, close } = await startFakeServer((req, socket) => {
    received = req;
    reply(socket, { id: req.id, success: true, data: {} });
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 2000 });
  await client.request('teleport', { x: 1, y: 64, z: -2 });

  t.truthy(received);
  const req = received as { id: string; command: string; params: Record<string, unknown> };
  t.is(typeof req.id, 'string');
  t.true(req.id.length > 0);
  t.is(req.command, 'teleport');
  t.deepEqual(req.params, { x: 1, y: 64, z: -2 });
  await close();
});

test('request surfaces the mod error code and message on failure responses', async (t) => {
  const { port, close } = await startFakeServer((req, socket) => {
    reply(socket, { id: req.id, success: false, error: { code: 'NOT_IN_GAME', message: 'Player not in world' } });
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 2000 });
  const result = await client.request('status', {});

  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('NOT_IN_GAME'));
    t.true(result.error.includes('Player not in world'));
  }
  await close();
});

test('request reassembles a response split across multiple TCP chunks', async (t) => {
  const { port, close } = await startFakeServer((req, socket) => {
    const body = `${JSON.stringify({ id: req.id, success: true, data: { chunked: true } })}\n`;
    socket.write(body.slice(0, 5));
    setTimeout(() => socket.write(body.slice(5)), 20);
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 2000 });
  const result = await client.request('status', {});

  t.deepEqual(result, { ok: true, data: { chunked: true } });
  await close();
});

test('request returns a clear error when the response is not valid JSON', async (t) => {
  const { port, close } = await startFakeServer((_req, socket) => {
    socket.write('not json at all\n');
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 2000 });
  const result = await client.request('status', {});

  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('not valid JSON'));
  }
  await close();
});

test('request times out instead of hanging when the server never responds', async (t) => {
  const { port, close } = await startFakeServer(() => {
    // never reply
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 150 });
  const result = await client.request('status', {});

  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('Timed out'));
  }
  await close();
});

test('request returns a clear error when nothing is listening on the port', async (t) => {
  const client = new McClient({ host: '127.0.0.1', port: 1, autoLaunch: false, socketTimeoutMs: 2000 });
  const result = await client.request('status', {});

  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('Could not reach'));
  }
});

test('request returns a clear error when the connection closes with no response', async (t) => {
  const { port, close } = await startFakeServer((_req, socket) => {
    socket.end();
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 2000 });
  const result = await client.request('status', {});

  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.length > 0);
  }
  await close();
});

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
  return child;
}

test('captureScreenshot returns a clear error when the client is unreachable', async (t) => {
  const client = new McClient({ host: '127.0.0.1', port: 1, autoLaunch: false, socketTimeoutMs: 500, screenshotDir: TEST_SCREENSHOT_DIR });
  const result = await client.captureScreenshot(false);

  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('Could not reach'));
  }
});

test('captureScreenshot reads the file the mod wrote and returns its bytes', async (t) => {
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const { port, close } = await startFakeServer(async (req, socket) => {
    t.is(req.command, 'screenshot');
    const targetPath = (req.params as { path: string }).path;
    const fs = await import('node:fs/promises');
    await fs.writeFile(targetPath, fakePng);
    reply(socket, { id: req.id, success: true, data: { path: targetPath, width: 1, height: 1 } });
  });

  const client = new McClient({ host: '127.0.0.1', port, autoLaunch: false, socketTimeoutMs: 2000, screenshotDir: TEST_SCREENSHOT_DIR });
  const result = await client.captureScreenshot(true);

  t.true(result.ok);
  if (result.ok) {
    t.deepEqual(result.buffer, fakePng);
  }
  await close();
});

test('getStatus reports not_started before any request is made', async (t) => {
  const client = new McClient({ host: '127.0.0.1', port: 1, autoLaunch: false });
  const status = await client.getStatus();

  t.is(status.processState, 'not_started');
  t.is(status.pid, null);
  t.false(status.socketReachable);
});

test('getStatus reports exited with diagnostics after the process exits before becoming reachable', async (t) => {
  const child = fakeChild();
  const spawnFn = () => child;

  const client = new McClient({
    host: '127.0.0.1',
    port: 1,
    launchScript: '/does/not/matter.sh',
    spawnFn,
    launchTimeoutMs: 500
  });

  const requestPromise = client.request('status', {});
  (child.stdout as unknown as EventEmitter).emit('data', Buffer.from('booting client\n'));
  child.emit('exit', 1, null);

  const result = await requestPromise;
  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('exited before it became reachable'));
    t.true(result.error.includes('booting client'));
  }

  const status = await client.getStatus();
  t.is(status.processState, 'exited');
  t.is(status.exitCode, 1);
  t.true(status.lastLogLines.includes('booting client'));
});

test('getStatus reports the spawn error when the launch script itself cannot start', async (t) => {
  const spawnFn = (): ChildProcess => {
    throw new Error('ENOENT: no such file');
  };

  const client = new McClient({
    host: '127.0.0.1',
    port: 1,
    launchScript: '/does/not/exist.sh',
    spawnFn,
    launchTimeoutMs: 500
  });

  const result = await client.request('status', {});
  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('ENOENT'));
  }

  const status = await client.getStatus();
  t.truthy(status.spawnError);
  t.true(status.spawnError!.includes('ENOENT'));
});

test('request auto-launches once, connects, and reuses the running process on the next call', async (t) => {
  const { port, close } = await startFakeServer((req, socket) => {
    reply(socket, { id: req.id, success: true, data: {} });
  });

  const child = fakeChild();
  let spawnCount = 0;
  const spawnFn = () => {
    spawnCount++;
    return child;
  };

  const client = new McClient({ host: '127.0.0.1', port, launchScript: '/fake.sh', spawnFn, launchTimeoutMs: 5000 });

  const first = await client.request('status', {});
  const second = await client.request('status', {});

  t.true(first.ok);
  t.true(second.ok);
  t.is(spawnCount, 1);
  await close();
});
