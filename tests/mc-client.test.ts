import test from 'ava';
import net, { type AddressInfo, type Socket } from 'node:net';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { McClient, isValidMinecraftUsername, offlinePlayerUuid } from '../src/mc-client.js';

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

function fakeChild(pid = 4242): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: (signal?: string) => {
      setImmediate(() => child.emit('exit', 0, signal ?? 'SIGTERM'));
      return true;
    }
  });
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

test('offlinePlayerUuid derives a deterministic RFC4122 version-3 UUID from the username', (t) => {
  const uuid = offlinePlayerUuid('Notch');

  t.regex(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  t.is(uuid, offlinePlayerUuid('Notch'));
  t.not(uuid, offlinePlayerUuid('Steve'));
});

test('isValidMinecraftUsername enforces the 3-16 char alnum/underscore rule', (t) => {
  t.true(isValidMinecraftUsername('LLMBotClient'));
  t.true(isValidMinecraftUsername('a_b'));
  t.false(isValidMinecraftUsername('ab'));
  t.false(isValidMinecraftUsername('a'.repeat(17)));
  t.false(isValidMinecraftUsername('has space'));
  t.false(isValidMinecraftUsername('has-dash'));
});

test('getStatus reports the default username before any request is made', async (t) => {
  const client = new McClient({ host: '127.0.0.1', port: 1, autoLaunch: false, username: 'DefaultName' });
  const status = await client.getStatus();

  t.is(status.username, 'DefaultName');
});

test('spawnProcess passes the current username and its derived uuid as env vars to the launch script', async (t) => {
  let capturedEnv: SpawnOptions['env'];
  const child = fakeChild();
  const spawnFn = (_cmd: string, _args: readonly string[], options: SpawnOptions) => {
    capturedEnv = options.env;
    return child;
  };

  const client = new McClient({ host: '127.0.0.1', port: 1, launchScript: '/fake.sh', spawnFn, launchTimeoutMs: 200, username: 'Steve' });
  await client.request('status', {}, { timeoutMs: 200 });

  t.is(capturedEnv?.MCCLI_USERNAME, 'Steve');
  t.is(capturedEnv?.MCCLI_UUID, offlinePlayerUuid('Steve'));
});

test('setUsername rejects an invalid username without touching the running process', async (t) => {
  const child = fakeChild();
  let spawnCount = 0;
  const spawnFn = () => {
    spawnCount++;
    return child;
  };

  const client = new McClient({ host: '127.0.0.1', port: 1, launchScript: '/fake.sh', spawnFn, launchTimeoutMs: 200, username: 'Original' });
  const result = await client.setUsername('a b');

  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('not a valid Minecraft username'));
  }
  t.is(spawnCount, 0);

  const status = await client.getStatus();
  t.is(status.username, 'Original');
});

test('setUsername records the new value without restarting when the client is not running', async (t) => {
  let spawnCount = 0;
  const spawnFn = () => {
    spawnCount++;
    return fakeChild();
  };

  const client = new McClient({ host: '127.0.0.1', port: 1, launchScript: '/fake.sh', spawnFn, launchTimeoutMs: 200, username: 'Original' });
  const result = await client.setUsername('NewName');

  t.true(result.ok);
  if (result.ok) {
    t.deepEqual(result.data, { username: 'NewName', uuid: offlinePlayerUuid('NewName'), restarted: false });
  }
  t.is(spawnCount, 0);

  const status = await client.getStatus();
  t.is(status.username, 'NewName');
});

test('setUsername kills the running process and relaunches it with the new username', async (t) => {
  const { port, close } = await startFakeServer((req, socket) => {
    reply(socket, { id: req.id, success: true, data: {} });
  });

  const children: ChildProcess[] = [];
  const killSignals: (string | undefined)[] = [];
  const spawnFn = () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      pid: 1000 + children.length,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (signal?: string | number) => {
        const sig = typeof signal === 'string' ? signal : undefined;
        killSignals.push(sig);
        setImmediate(() => child.emit('exit', 0, sig ?? 'SIGTERM'));
        return true;
      }
    });
    children.push(child);
    return child;
  };

  const client = new McClient({ host: '127.0.0.1', port, launchScript: '/fake.sh', spawnFn, launchTimeoutMs: 5000, username: 'OldName' });
  await client.request('status', {});

  const result = await client.setUsername('NewName');

  t.true(result.ok);
  if (result.ok) {
    t.is(result.data.restarted, true);
    t.is(result.data.username, 'NewName');
  }
  t.is(children.length, 2);
  t.true(killSignals.includes('SIGTERM'));

  const status = await client.getStatus();
  t.is(status.username, 'NewName');

  await close();
});

test('setUsername reports a clear error, without wedging the client, when the restart fails', async (t) => {
  let spawnCount = 0;
  const spawnFn = () => {
    spawnCount++;
    if (spawnCount === 1) {
      return fakeChild(1);
    }
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      pid: 2,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => { setImmediate(() => child.emit('exit', 0, 'SIGTERM')); return true; }
    });
    setImmediate(() => child.emit('exit', 1, null));
    return child;
  };

  const client = new McClient({ host: '127.0.0.1', port: 1, launchScript: '/fake.sh', spawnFn, launchTimeoutMs: 500, username: 'OldName' });
  await client.request('status', {}, { timeoutMs: 200 });

  const result = await client.setUsername('NewName');
  t.false(result.ok);
  if (!result.ok) {
    t.true(result.error.includes('failed to restart'));
  }

  const status = await client.getStatus();
  t.is(status.username, 'NewName');
  t.is(status.processState, 'exited');
});
