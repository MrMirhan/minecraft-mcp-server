import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { BotConnection } from '../src/bot-connection.js';

function makeFakeBot(): mineflayer.Bot {
  const bot = new EventEmitter() as unknown as mineflayer.Bot & { quit: sinon.SinonStub };
  bot.quit = sinon.stub();
  (bot as unknown as { chat: sinon.SinonStub }).chat = sinon.stub();
  (bot as unknown as { pathfinder: unknown }).pathfinder = { setMovements: sinon.stub() };
  (bot as unknown as { username: string }).username = 'LLMBot';
  (bot as unknown as { version: string }).version = '1.21.11';
  (bot as unknown as { registry: unknown }).registry = minecraftData('1.21.11');
  (bot as unknown as { entity: unknown }).entity = { position: { x: 1, y: 2, z: 3 } };
  return bot;
}

test('constructor initializes with correct state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
  t.deepEqual(connection.getConfig(), config);
  t.is(connection.getBot(), null);
  t.false(connection.isConnected());
});

test('constructor accepts custom reconnect delay', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const customDelay = 5000;
  const connection = new BotConnection(config, callbacks, customDelay);

  t.is(connection.getState(), 'disconnected');
});

test('getState returns current state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
});

test('getConfig returns configuration', (t) => {
  const config = { host: 'example.com', port: 30000, username: 'MyBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const returnedConfig = connection.getConfig();
  t.is(returnedConfig.host, 'example.com');
  t.is(returnedConfig.port, 30000);
  t.is(returnedConfig.username, 'MyBot');
});

test('getBot returns null initially', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getBot(), null);
});

test('isConnected returns false when state is disconnected', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.false(connection.isConnected());
});

test('formatError handles Error objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const error = new Error('Test error');
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(error);

  t.is(formatted, 'Test error');
});

test('formatError handles plain objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const errorObj = { code: 'ECONNREFUSED', message: 'Connection refused' };
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(errorObj);

  t.true(formatted.includes('ECONNREFUSED'));
  t.true(formatted.includes('Connection refused'));
});

test('formatError handles strings', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError('Simple error');

  t.is(formatted, '"Simple error"');
});

test('formatError handles non-serializable objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(circular);

  t.is(typeof formatted, 'string');
});

test('checkConnectionAndReconnect returns connected when already connected', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { hasTarget: boolean }).hasTarget = true;
  (connection as unknown as { state: string }).state = 'connected';

  const result = await connection.checkConnectionAndReconnect();

  t.true(result.connected);
  t.is(result.message, undefined);
});

test('checkConnectionAndReconnect returns message when connecting', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { hasTarget: boolean }).hasTarget = true;
  (connection as unknown as { state: string }).state = 'connecting';

  const result = await connection.checkConnectionAndReconnect();

  t.false(result.connected);
  t.true(result.message!.includes('connecting'));
});

test('checkConnectionAndReconnect includes setup instructions on failure', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks, 100);

  (connection as unknown as { hasTarget: boolean }).hasTarget = true;
  (connection as unknown as { state: string }).state = 'disconnected';

  // Stub attemptReconnect to prevent actual connection attempt
  const attemptReconnectStub = sinon.stub(connection as unknown as { attemptReconnect: () => void }, 'attemptReconnect').callsFake(() => {
    (connection as unknown as { state: string }).state = 'connecting';
  });

  const result = await connection.checkConnectionAndReconnect();

  t.true(attemptReconnectStub.calledOnce);
  t.false(result.connected);
  t.true(result.message!.includes('Cannot connect'));
  t.true(result.message!.includes('localhost:25565'));
  t.true(result.message!.includes('github.com'));

  attemptReconnectStub.restore();
});

test('cleanup clears reconnect timer', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { reconnectTimer: ReturnType<typeof setTimeout> }).reconnectTimer = setTimeout(() => {}, 10000);

  t.notThrows(() => {
    connection.cleanup();
  });
});

test('cleanup does not throw when no bot exists', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.notThrows(() => {
    connection.cleanup();
  });
});

test.serial('checkConnectionAndReconnect returns not-connected without reconnecting when no target', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const config = { host: 'localhost', port: 25565, username: 'TestBot' };
    const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
    const connection = new BotConnection(config, callbacks);
    const attemptReconnect = sinon.spy(connection as unknown as { attemptReconnect: () => void }, 'attemptReconnect');

    const result = await connection.checkConnectionAndReconnect();

    t.false(result.connected);
    t.true(result.message!.includes('Not connected to any Minecraft server'));
    t.true(result.message!.includes('connect-to-server'));

    clock.tick(60000);
    t.true(attemptReconnect.notCalled);
  } finally {
    clock.restore();
  }
});

test.serial('checkConnectionAndReconnect returns not-connected without reconnecting after manual disconnect', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const config = { host: 'localhost', port: 25565, username: 'TestBot' };
    const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
    const connection = new BotConnection(config, callbacks);
    (connection as unknown as { hasTarget: boolean }).hasTarget = true;
    (connection as unknown as { manuallyDisconnected: boolean }).manuallyDisconnected = true;
    const attemptReconnect = sinon.spy(connection as unknown as { attemptReconnect: () => void }, 'attemptReconnect');

    const result = await connection.checkConnectionAndReconnect();

    t.false(result.connected);
    t.true(result.message!.includes('Not connected to any Minecraft server'));

    clock.tick(60000);
    t.true(attemptReconnect.notCalled);
  } finally {
    clock.restore();
  }
});

test('disconnect sets manual flag, clears timer and quits the bot', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const fakeBot = makeFakeBot();
  const removeAllListeners = sinon.spy(fakeBot, 'removeAllListeners');
  (connection as unknown as { bot: mineflayer.Bot }).bot = fakeBot;
  (connection as unknown as { hasTarget: boolean }).hasTarget = true;
  (connection as unknown as { reconnectTimer: ReturnType<typeof setTimeout> }).reconnectTimer = setTimeout(() => {}, 10000);

  connection.disconnect();

  t.true(removeAllListeners.called);
  t.true((fakeBot.quit as sinon.SinonStub).called);
  t.is(connection.getBot(), null);
  t.is(connection.getState(), 'disconnected');
  t.is((connection as unknown as { manuallyDisconnected: boolean }).manuallyDisconnected, true);
  t.is((connection as unknown as { reconnectTimer: unknown }).reconnectTimer, null);
});

test.serial('connectTo detaches the old bot before attaching the new one', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const oldBot = makeFakeBot();
  const oldRemoveAll = sinon.spy(oldBot, 'removeAllListeners');
  (connection as unknown as { bot: mineflayer.Bot }).bot = oldBot;

  const newBot = makeFakeBot();
  const createBot = sinon.stub(mineflayer, 'createBot').returns(newBot);

  try {
    const promise = connection.connectTo({ host: 'new.example.com', port: 25565, username: 'TestBot' });

    t.true(oldRemoveAll.calledBefore(createBot), 'old listeners must be removed before new bot is created');
    t.true((oldBot.quit as sinon.SinonStub).called);
    t.is(connection.getBot(), newBot);

    newBot.emit('spawn');
    const result = await promise;

    t.is(result.host, 'new.example.com');
    t.is(result.version, '1.21.11');
    t.deepEqual(result.position, { x: 1, y: 2, z: 3 });
  } finally {
    createBot.restore();
  }
});

test.serial('connectTo resolves with connection info on spawn', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const newBot = makeFakeBot();
  const createBot = sinon.stub(mineflayer, 'createBot').returns(newBot);

  try {
    const promise = connection.connectTo({ host: 'h', port: 1234, username: 'Bobby' });
    newBot.emit('spawn');
    const result = await promise;

    t.is(result.host, 'h');
    t.is(result.port, 1234);
    t.is(result.username, 'LLMBot');
    t.is(connection.getState(), 'connected');
    t.true(connection.isConnected());
  } finally {
    createBot.restore();
  }
});

test.serial('connectTo rejects and cleans up when the bot errors before spawn', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const newBot = makeFakeBot();
  const createBot = sinon.stub(mineflayer, 'createBot').returns(newBot);

  try {
    const promise = connection.connectTo({ host: 'bad', port: 1, username: 'TestBot' });
    newBot.emit('error', new Error('ECONNREFUSED'));

    await t.throwsAsync(promise, { message: /Failed to connect to bad:1/ });
    t.is(connection.getBot(), null);
    t.is(connection.getState(), 'disconnected');
    t.true((newBot.quit as sinon.SinonStub).called);
  } finally {
    createBot.restore();
  }
});

test.serial('connectTo rejects on timeout when no spawn occurs', async (t) => {
  const clock = sinon.useFakeTimers();
  const createBot = sinon.stub(mineflayer, 'createBot').returns(makeFakeBot());
  try {
    const config = { host: 'localhost', port: 25565, username: 'TestBot' };
    const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
    const connection = new BotConnection(config, callbacks);

    const promise = connection.connectTo({ host: 'silent', port: 25565, username: 'TestBot' }, 5000);
    const assertion = t.throwsAsync(promise, { message: /Timed out connecting to silent:25565 after 5000ms/ });

    await clock.tickAsync(5000);
    await assertion;

    t.is(connection.getBot(), null);
    t.is(connection.getState(), 'disconnected');
  } finally {
    createBot.restore();
    clock.restore();
  }
});

test.serial('connectTo does not accumulate listeners across repeated connect/disconnect cycles', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const bots: (mineflayer.Bot & { quit: sinon.SinonStub })[] = [];
  const createBot = sinon.stub(mineflayer, 'createBot').callsFake(() => {
    const bot = makeFakeBot() as mineflayer.Bot & { quit: sinon.SinonStub };
    sinon.spy(bot, 'removeAllListeners');
    bots.push(bot);
    return bot;
  });

  try {
    const servers = [
      { host: 'a.example.com', port: 25565, username: 'TestBot' },
      { host: 'b.example.com', port: 25565, username: 'TestBot' },
      { host: 'c.example.com', port: 25565, username: 'TestBot' },
    ];

    // Cycle 1: connect → spawn → disconnect
    const p1 = connection.connectTo(servers[0]);
    bots[0].emit('spawn');
    await p1;
    connection.disconnect();

    // Cycle 2: connect → spawn → disconnect
    const p2 = connection.connectTo(servers[1]);
    bots[1].emit('spawn');
    await p2;
    connection.disconnect();

    // Cycle 3: connect → spawn (leave connected)
    const p3 = connection.connectTo(servers[2]);
    bots[2].emit('spawn');
    await p3;

    // Each bot displaced by a subsequent connectTo must have had removeAllListeners called.
    // bot[0] was detached when connectTo(servers[1]) ran (oldBot path in connectTo).
    t.true(
      (bots[0].removeAllListeners as unknown as sinon.SinonSpy).called,
      'bot[0] removeAllListeners must have been called (detach-before-quit in connectTo)'
    );
    // bot[1] was detached when connectTo(servers[2]) ran.
    t.true(
      (bots[1].removeAllListeners as unknown as sinon.SinonSpy).called,
      'bot[1] removeAllListeners must have been called (detach-before-quit in connectTo)'
    );

    // Each removeAllListeners on a displaced bot was called BEFORE that bot's quit.
    t.true(
      (bots[0].removeAllListeners as unknown as sinon.SinonSpy).calledBefore(bots[0].quit),
      'bot[0] removeAllListeners must precede quit'
    );
    t.true(
      (bots[1].removeAllListeners as unknown as sinon.SinonSpy).calledBefore(bots[1].quit),
      'bot[1] removeAllListeners must precede quit'
    );
  } finally {
    createBot.restore();
  }
});
