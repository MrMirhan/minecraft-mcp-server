import test from 'ava';
import { EventEmitter } from 'events';
import { BedrockBot, type BedrockModule } from '../src/bedrock-bot.js';

/** A bedrock-protocol client in memory: what the bot queued, and packets the test sends it. */
class FakeClient extends EventEmitter {
  queued: { name: string; params: Record<string, unknown> }[] = [];
  closed = false;
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
  }
  queue(name: string, params: Record<string, unknown>) {
    this.queued.push({ name, params });
  }
  close() {
    this.closed = true;
  }
}

function fakeBedrock() {
  const clients: FakeClient[] = [];
  const module = { createClient: (options: Record<string, unknown>) => { const c = new FakeClient(options); clients.push(c); return c; } } as unknown as BedrockModule;
  return { load: async () => module, clients };
}

async function joined() {
  const fake = fakeBedrock();
  const bot = new BedrockBot(fake.load);
  const connecting = bot.connect({ host: '127.0.0.1', port: 19132, username: 'Tester' });
  await new Promise((r) => setImmediate(r));
  const client = fake.clients[0];
  client.emit('start_game', { runtime_entity_id: 7n, player_position: { x: 1.04, y: 32769.6, z: -2.5 }, dimension: 'overworld', player_gamemode: 'fallback', world_gamemode: 'creative' });
  client.emit('respawn', { position: { x: 1.04, y: 64, z: -2.5 }, state: 1, runtime_entity_id: 0n });
  client.emit('spawn');
  const state = await connecting;
  return { bot, client, state };
}

test('the bot joins offline, and knows where it spawned and its game mode (the world\'s, when the server says fallback)', async (t) => {
  const { client, state } = await joined();
  t.like(client.options, { host: '127.0.0.1', port: 19132, username: 'Tester', offline: true, version: '1.26.60' });
  t.like(state, { connected: true, server: '127.0.0.1:19132', username: 'Tester', position: { x: 1, y: 64, z: -2.5 }, gamemode: 'creative', forms: 0 });
});

test('a refusal before spawning fails the join with the server\'s reason', async (t) => {
  const fake = fakeBedrock();
  const bot = new BedrockBot(fake.load);
  const connecting = bot.connect({ host: 'h', port: 1, username: 'x' });
  await new Promise((r) => setImmediate(r));
  fake.clients[0].emit('kick', { message: 'You are not white-listed on this server!' });
  await t.throwsAsync(connecting, { message: /refused the bot: You are not white-listed/ });
  t.true(fake.clients[0].closed);
  t.false(bot.status().connected);
});

test('chat comes in and goes out; the tab list follows adds and removes', async (t) => {
  const { bot, client } = await joined();
  client.emit('text', { type: 'chat', source_name: 'Steve', message: 'hi bot' });
  client.emit('text', { type: 'translation', message: 'multiplayer.player.joined', parameters: ['Alex'] });
  t.deepEqual(bot.recentChat(5).map((l) => `${l.type} ${l.source} ${l.message}`), ['chat Steve hi bot', 'translation  multiplayer.player.joined [Alex]']);
  bot.sendChat('hello');
  t.like(client.queued.at(-1), { name: 'text', params: { type: 'chat', category: 'authored', source_name: 'Tester', message: 'hello', has_filtered_message: false } });
  client.emit('player_list', { records: [{ type: 'add', uuid: 'a', username: 'Steve' }, { type: 'add', uuid: 'b', username: 'Alex' }] });
  client.emit('player_list', { records: [{ type: 'remove', uuid: 'a' }] });
  t.deepEqual(bot.status().players, ['Alex']);
});

test('a command goes with the bot\'s entity id, and its answer is the output with the same uuid', async (t) => {
  const { bot, client } = await joined();
  const answer = bot.command('list');
  const sent = client.queued.at(-1)!;
  t.is(sent.name, 'command_request');
  t.like(sent.params, { command: '/list', internal: false, version: 'latest' });
  const origin = sent.params.origin as { uuid: string; player_entity_id: bigint; type: string };
  t.is(origin.player_entity_id, 7n);
  client.emit('command_output', { origin: { uuid: 'someone-else' }, output: [] });
  client.emit('command_output', { origin: { uuid: origin.uuid }, output: [{ message_id: 'commands.players.list', success: true, parameters: ['1', '10'] }] });
  t.deepEqual(await answer, ['ok: commands.players.list 1 10']);
  t.is(await bot.command('say hi', 20), null, 'no answer within the wait');
});

test('forms are kept until answered or closed, and an unknown form is refused', async (t) => {
  const { bot, client } = await joined();
  client.emit('modal_form_request', { form_id: 3, data: '{"type":"form","title":"Shipyard","content":"","buttons":[{"text":"Build"},{"text":"Repair"}]}' });
  client.emit('modal_form_request', { form_id: 4, data: '{"type":"modal","title":"Sure?","button1":"Yes","button2":"No"}' });
  t.is(bot.status().forms, 2);
  t.like(bot.pendingForms()[0], { id: 3, form: { title: 'Shipyard' } });
  bot.answerForm(3, 1);
  t.like(client.queued.at(-1), { name: 'modal_form_response', params: { form_id: 3, has_response_data: true, data: '1', has_cancel_reason: false } });
  bot.answerForm(4, undefined);
  t.like(client.queued.at(-1), { name: 'modal_form_response', params: { form_id: 4, has_response_data: false, has_cancel_reason: true, cancel_reason: 'closed' } });
  t.is(bot.status().forms, 0);
  t.throws(() => bot.answerForm(9, 0), { message: /No open form 9/ });
});

test('after the server ends the connection the bot says why, and refuses to send', async (t) => {
  const { bot, client } = await joined();
  client.emit('disconnect', { message: 'Server closed' });
  t.like(bot.status(), { connected: false, lastDisconnect: 'Server closed' });
  t.throws(() => bot.sendChat('x'), { message: /not connected: use bedrock-connect/ });
});
