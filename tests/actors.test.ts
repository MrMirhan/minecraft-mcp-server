import test from 'ava';
import sinon from 'sinon';
import { ActorsClient, sign, type ActorsFetch } from '../src/actors-client.js';
import { registerActorsTools } from '../src/tools/actors-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

const SECRET = '0123456789abcdef-secret';

test('the signature is the one the plugin and the Python client compute', (t) => {
  // Computed by agent/paper-actors/client/actors_client.py's sign() with the same inputs.
  t.is(sign(SECRET, 'POST', '/v1/act?x=1', 1793731187537, '00112233445566778899aabbccddeeff', Buffer.from('{"name":"Bot"}')),
    'b52997aa899f5a8e9b4c8d7177adf39fd846cd30786d6a160b263f027d095662');
});

function fakeFetch(answer: (url: string, body: unknown) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetcher: ActorsFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body.toString('utf8')) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, body });
    const a = answer(url, body);
    return { status: a.status, json: async () => a.body };
  };
  return { fetcher, calls };
}

test('requests are signed over the path, the time, a fresh nonce and the body', async (t) => {
  const { fetcher, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  const c = new ActorsClient('http://srv:4331/', SECRET, fetcher);
  await c.act('Bot', { do: 'goto', x: 1, y: 64, z: 2 });
  await c.actor('A B');
  const [act, actor] = calls;
  t.is(act.url, 'http://srv:4331/v1/act');
  t.deepEqual(act.body, { do: 'goto', x: 1, y: 64, z: 2, name: 'Bot' });
  const raw = Buffer.from(JSON.stringify(act.body));
  t.is(act.headers['X-Actors-Signature'], sign(SECRET, 'POST', '/v1/act', Number(act.headers['X-Actors-Time']), act.headers['X-Actors-Nonce'], raw));
  t.not(act.headers['X-Actors-Nonce'], actor.headers['X-Actors-Nonce']);
  t.is(actor.url, 'http://srv:4331/v1/actor?name=A%20B');
});

test('a refusal keeps the plugin\'s reason; no secret or no server says what to do', async (t) => {
  const { fetcher } = fakeFetch(() => ({ status: 409, body: { ok: false, error: 'out of reach (7.2 blocks)' } }));
  await t.throwsAsync(new ActorsClient('http://srv:4331', SECRET, fetcher).act('Bot', { do: 'break', x: 0, y: 0, z: 0 }), { message: 'out of reach (7.2 blocks)' });
  await t.throwsAsync(new ActorsClient('http://srv:4331', '', fetcher).state(), { message: /set PAPER_ACTORS_SECRET/ });
  const down = new ActorsClient('http://127.0.0.1:9', SECRET, async () => { throw new Error('connect ECONNREFUSED'); });
  await t.throwsAsync(down.metrics(), { message: /No paper-actors API at http:\/\/127.0.0.1:9/ });
});

function tools(client: ActorsClient) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection);
  registerActorsTools(factory, client);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  return {
    names: calls.map((c) => c.args[0] as string),
    get: (name: string) => calls.find((c) => c.args[0] === name)!.args[3] as (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  };
}

test('the actors tools: a crowd spawn, an action with do, despawn by prefix, metrics', async (t) => {
  const { fetcher, calls } = fakeFetch((url) => ({ status: 200, body: url.endsWith('/v1/metrics') ? { tps: [20, 20, 20], actors: 3 } : { queued: 3 } }));
  const { names, get } = tools(new ActorsClient('http://srv:4331', SECRET, fetcher));
  t.deepEqual(names.sort(), ['actors-act', 'actors-actor', 'actors-despawn', 'actors-events', 'actors-metrics', 'actors-scene-play', 'actors-scene-stop', 'actors-spawn', 'actors-state']);
  await get('actors-spawn')({ count: 3, prefix: 'Bot', spread: 16, at: [0, 64, 0], view: 2 });
  t.deepEqual(calls[0].body, { count: 3, prefix: 'Bot', spread: 16, at: [0, 64, 0], view: 2 });
  t.true((await get('actors-spawn')({})).isError);
  t.true((await get('actors-act')({ name: 'Bot1', action: { x: 1 } })).isError);
  await get('actors-act')({ name: 'Bot1', action: { do: 'click', slot: 3, type: 'shift' } });
  t.deepEqual(calls[1].body, { do: 'click', slot: 3, type: 'shift', name: 'Bot1' });
  await get('actors-despawn')({ prefix: 'Bot' });
  t.deepEqual(calls[2].body, { prefix: 'Bot' });
  t.true((await get('actors-metrics')({})).content[0].text.includes('"tps"'));
});
