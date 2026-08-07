import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import mineflayer from 'mineflayer';
import type { ChatMessage } from 'prismarine-chat';
import { WebViewer, attachUiState, getUiState, onUiStateChange, type UiState } from '../src/web-viewer.js';

function fakeMotd(text: string): ChatMessage {
  return { toMotd: () => text } as unknown as ChatMessage;
}

function makeFakeBot(overrides: Partial<{ version: string }> = {}): mineflayer.Bot {
  const bot = new EventEmitter() as unknown as mineflayer.Bot;
  (bot as unknown as { scoreboard: Record<string, { title: string; items: Array<{ name: string; displayName: ChatMessage; value: number }> } | undefined> }).scoreboard = {};
  (bot as unknown as { tablist: { header: ChatMessage; footer: ChatMessage } }).tablist = {
    header: fakeMotd(''),
    footer: fakeMotd('')
  };
  (bot as unknown as { bossBars: Array<{ entityUUID: string; title: ChatMessage; health: number; color: string; dividers: number }> }).bossBars = [];
  (bot as unknown as { version: string }).version = overrides.version ?? '1.21.4';
  return bot;
}

function setScoreboard(bot: mineflayer.Bot, slot: 'sidebar' | 'list' | 'belowName', title: string, items: Array<{ name: string; displayName: ChatMessage; value: number }>): void {
  (bot as unknown as { scoreboard: Record<string, { title: string; items: typeof items }> }).scoreboard[slot] = { title, items };
}

function setBossBars(bot: mineflayer.Bot, bars: Array<{ entityUUID: string; title: ChatMessage; health: number; color: string; dividers: number }>): void {
  (bot as unknown as { bossBars: typeof bars }).bossBars = bars;
}

function setTablist(bot: mineflayer.Bot, header: string, footer: string): void {
  (bot as unknown as { tablist: { header: ChatMessage; footer: ChatMessage } }).tablist = {
    header: fakeMotd(header),
    footer: fakeMotd(footer)
  };
}

function makeFakeWindow(title: string, slots: Array<{ name: string; count: number; displayName: string } | null>): NonNullable<mineflayer.Bot['currentWindow']> {
  const win = new EventEmitter() as unknown as NonNullable<mineflayer.Bot['currentWindow']>;
  (win as unknown as { title: string }).title = title;
  (win as unknown as { slots: typeof slots }).slots = slots;
  return win;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// --- UI state store ---

test('getUiState returns a default empty state for a fresh bot', (t) => {
  const bot = makeFakeBot();
  const state = getUiState(bot);

  t.deepEqual(state.title, { title: null, subtitle: null, actionBar: null });
  t.deepEqual(state.tablist, { header: '', footer: '' });
  t.deepEqual(state.bossBars, []);
  t.deepEqual(state.scoreboards, { sidebar: null, list: null, belowName: null });
  t.is(state.resourcePack, null);
  t.is(state.window, null);
});

test('attachUiState is idempotent per bot', (t) => {
  const bot = makeFakeBot();
  attachUiState(bot);
  const countAfterFirst = bot.listenerCount('actionBar');
  attachUiState(bot);
  t.is(bot.listenerCount('actionBar'), countAfterFirst);
  t.is(countAfterFirst, 1);
});

test('title and subtitle events are captured', (t) => {
  const bot = makeFakeBot();
  attachUiState(bot);
  bot.emit('title', 'Welcome', 'title');
  bot.emit('title', 'to the server', 'subtitle');

  const state = getUiState(bot);
  t.is(state.title.title, 'Welcome');
  t.is(state.title.subtitle, 'to the server');
});

test('actionBar event preserves section-sign color codes via toMotd', (t) => {
  const bot = makeFakeBot();
  attachUiState(bot);
  bot.emit('actionBar', fakeMotd('§aHealthy'));

  t.is(getUiState(bot).title.actionBar, '§aHealthy');
});

test('resourcePack normalizes both argument orders', (t) => {
  const botUrlFirst = makeFakeBot();
  attachUiState(botUrlFirst);
  botUrlFirst.emit('resourcePack', 'https://example.com/pack.zip', 'abc123');
  t.deepEqual(getUiState(botUrlFirst).resourcePack, { url: 'https://example.com/pack.zip', hash: 'abc123' });

  const botHashFirst = makeFakeBot();
  attachUiState(botHashFirst);
  botHashFirst.emit('resourcePack', 'abc123', 'https://example.com/pack.zip');
  t.deepEqual(getUiState(botHashFirst).resourcePack, { url: 'https://example.com/pack.zip', hash: 'abc123' });
});

test('scoreboard events refresh the sidebar/list/belowName snapshot', (t) => {
  const bot = makeFakeBot();
  attachUiState(bot);
  setScoreboard(bot, 'sidebar', 'Stats', [{ name: 'k1', displayName: fakeMotd('§bKills'), value: 5 }]);
  bot.emit('scoreboardCreated', {} as unknown as mineflayer.ScoreBoard);

  t.deepEqual(getUiState(bot).scoreboards.sidebar, { title: 'Stats', items: [{ name: 'k1', displayName: '§bKills', value: 5 }] });
  t.is(getUiState(bot).scoreboards.list, null);
});

test('bossBar events refresh the boss bar list from bot.bossBars', (t) => {
  const bot = makeFakeBot();
  attachUiState(bot);
  setBossBars(bot, [{ entityUUID: 'u1', title: fakeMotd('§cDragon'), health: 0.5, color: 'red', dividers: 0 }]);
  bot.emit('bossBarCreated', {} as unknown as mineflayer.BossBar);

  t.deepEqual(getUiState(bot).bossBars, [{ entityUUID: 'u1', title: '§cDragon', health: 0.5, color: 'red', dividers: 0 }]);
});

test('tablist is read live rather than cached', (t) => {
  const bot = makeFakeBot();
  t.deepEqual(getUiState(bot).tablist, { header: '', footer: '' });

  setTablist(bot, '§eHeader', '§eFooter');

  t.deepEqual(getUiState(bot).tablist, { header: '§eHeader', footer: '§eFooter' });
});

test('windowOpen/updateSlot/windowClose track the open window', (t) => {
  const bot = makeFakeBot();
  attachUiState(bot);
  const win = makeFakeWindow('Chest', [null, { name: 'minecraft:diamond', count: 3, displayName: 'Diamond' }]);

  bot.emit('windowOpen', win);
  t.deepEqual(getUiState(bot).window, { title: 'Chest', slots: [{ slot: 1, name: 'minecraft:diamond', count: 3, displayName: 'Diamond' }] });

  (win as unknown as { slots: Array<{ name: string; count: number; displayName: string } | null> }).slots[0] = { name: 'minecraft:stick', count: 1, displayName: 'Stick' };
  (win as unknown as EventEmitter).emit('updateSlot');
  const afterUpdate = getUiState(bot).window;
  t.true(afterUpdate!.slots.some((s) => s.slot === 0 && s.name === 'minecraft:stick'));

  bot.emit('windowClose', win);
  t.is(getUiState(bot).window, null);
});

test('onUiStateChange notifies subscribers and stops after unsubscribe', (t) => {
  const bot = makeFakeBot();
  const received: UiState[] = [];
  const unsubscribe = onUiStateChange(bot, (state) => received.push(state));

  bot.emit('actionBar', fakeMotd('hi'));
  t.is(received.length, 1);

  unsubscribe();
  bot.emit('actionBar', fakeMotd('bye'));
  t.is(received.length, 1);
});

// --- WebViewer HTTP surface ---

test('start returns a reachable url and isRunning reflects state', async (t) => {
  const viewer = new WebViewer({ port: 0, attach: sinon.stub() });
  t.false(viewer.isRunning());

  const url = await viewer.start(null);
  t.teardown(() => viewer.stop());

  t.true(viewer.isRunning());
  t.regex(url, /^http:\/\/localhost:\d+\/$/);
  t.is(viewer.getUrl(), url);

  viewer.stop();
  t.false(viewer.isRunning());
  t.is(viewer.getUrl(), null);
});

test.serial('start rejects when the configured port collides with the MCP http port', async (t) => {
  const savedServerPort = process.env.SERVER_PORT;
  const savedPort = process.env.PORT;
  delete process.env.SERVER_PORT;
  delete process.env.PORT;

  try {
    const viewer = new WebViewer({ port: 3000, attach: sinon.stub() });
    await t.throwsAsync(() => viewer.start(null), { message: /collides/ });
  } finally {
    if (savedServerPort !== undefined) process.env.SERVER_PORT = savedServerPort; else delete process.env.SERVER_PORT;
    if (savedPort !== undefined) process.env.PORT = savedPort; else delete process.env.PORT;
  }
});

test('GET / serves the overlay page with the expected overlay markers', async (t) => {
  const viewer = new WebViewer({ port: 0, attach: sinon.stub() });
  const url = await viewer.start(null);
  t.teardown(() => viewer.stop());

  const res = await fetch(url);
  const body = await res.text();

  t.is(res.status, 200);
  t.true((res.headers.get('content-type') ?? '').includes('text/html'));
  t.true(body.includes('id="scoreboard"'));
  t.true(body.includes('id="bossbars"'));
  t.true(body.includes('id="actionbar"'));
  t.true(body.includes('id="tablist"'));
  t.true(body.includes('id="window"'));
  t.true(body.includes("EventSource('ui-state')"));
});

test('GET / honors X-Forwarded-Prefix with a base tag for subpath deployments', async (t) => {
  const viewer = new WebViewer({ port: 0, attach: sinon.stub() });
  const url = await viewer.start(null);
  t.teardown(() => viewer.stop());

  const res = await fetch(url, { headers: { 'x-forwarded-prefix': '/mcp-viewer' } });
  const body = await res.text();

  t.true(body.includes('<base href="/mcp-viewer/">'));
});

test('GET /ui-state streams an initial default snapshot as SSE', async (t) => {
  const viewer = new WebViewer({ port: 0, attach: sinon.stub() });
  const url = await viewer.start(null);
  t.teardown(() => viewer.stop());

  const res = await fetch(new URL('ui-state', url));
  t.is(res.status, 200);
  t.true((res.headers.get('content-type') ?? '').includes('text/event-stream'));

  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();

  const chunk = Buffer.from(value!).toString('utf8');
  t.true(chunk.startsWith('data: '));
  const parsed = JSON.parse(chunk.slice('data: '.length).trim());
  t.deepEqual(parsed.title, { title: null, subtitle: null, actionBar: null });
});

test('GET /view/* returns 503 before any bot is attached', async (t) => {
  const viewer = new WebViewer({ port: 0, attach: sinon.stub() });
  const url = await viewer.start(null);
  t.teardown(() => viewer.stop());

  const res = await fetch(new URL('view/', url));
  t.is(res.status, 503);
});

test('unknown paths return 404', async (t) => {
  const viewer = new WebViewer({ port: 0, attach: sinon.stub() });
  const url = await viewer.start(null);
  t.teardown(() => viewer.stop());

  const res = await fetch(new URL('nope', url));
  t.is(res.status, 404);
});

test('GET /view/* and /socket.io/* proxy to the internal viewer once a bot is attached', async (t) => {
  let internalServer: http.Server | undefined;
  const attach = sinon.stub().callsFake((bot: mineflayer.Bot, options: { port: number }) => {
    internalServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`internal:${req.url}`);
    });
    internalServer.listen(options.port);
    (bot as unknown as { viewer: { close: () => void } }).viewer = { close: sinon.stub() };
  });

  const viewer = new WebViewer({ port: 0, attach });
  const url = await viewer.start(null);
  t.teardown(() => {
    viewer.stop();
    internalServer?.close();
  });

  const fakeBot = makeFakeBot({ version: '1.21.4' });
  viewer.rebind(fakeBot);
  await waitFor(() => internalServer !== undefined && internalServer.listening);

  const viewRes = await fetch(new URL('view/foo?x=1', url));
  t.is(await viewRes.text(), 'internal:/foo?x=1');

  const socketRes = await fetch(new URL('socket.io/?transport=polling', url));
  t.is(await socketRes.text(), 'internal:/socket.io/?transport=polling');
});

test('rebind closes the previous bot viewer before attaching the next one', async (t) => {
  const attach = sinon.stub().callsFake((bot: mineflayer.Bot) => {
    (bot as unknown as { viewer: { close: sinon.SinonStub } }).viewer = { close: sinon.stub() };
  });
  const viewer = new WebViewer({ port: 0, attach });
  await viewer.start(null);
  t.teardown(() => viewer.stop());

  const botA = makeFakeBot({ version: '1.21.4' });
  viewer.rebind(botA);
  await waitFor(() => attach.calledOnce);
  const botAViewer = (botA as unknown as { viewer: { close: sinon.SinonStub } }).viewer;

  const botB = makeFakeBot({ version: '1.21.4' });
  viewer.rebind(botB);
  await waitFor(() => attach.calledTwice);

  t.true(botAViewer.close.calledOnce);

  const botBViewer = (botB as unknown as { viewer: { close: sinon.SinonStub } }).viewer;
  viewer.rebind(null);
  t.true(botBViewer.close.calledOnce);
});

test('attaching skips a version with no older assets to fall back to', async (t) => {
  const attach = sinon.stub();
  const viewer = new WebViewer({ port: 0, attach });
  await viewer.start(null);
  t.teardown(() => viewer.stop());

  viewer.rebind(makeFakeBot({ version: '1.0.0' }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.false(attach.called);
  t.regex(viewer.getVersionWarning() ?? '', /no older assets/);
});

test('attaching warns but still proceeds for a version newer than supported', async (t) => {
  const attach = sinon.stub().callsFake((bot: mineflayer.Bot) => {
    (bot as unknown as { viewer: { close: () => void } }).viewer = { close: sinon.stub() };
  });
  const viewer = new WebViewer({ port: 0, attach });
  await viewer.start(null);
  t.teardown(() => viewer.stop());

  const bot = makeFakeBot({ version: '9.9.9' });
  viewer.rebind(bot);
  await waitFor(() => attach.called);

  t.regex(viewer.getVersionWarning() ?? '', /newer/);
});
