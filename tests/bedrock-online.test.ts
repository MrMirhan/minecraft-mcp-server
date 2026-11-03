import test from 'ava';
import sinon from 'sinon';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BedrockAuth, describeLogin, type AuthLib } from '../src/bedrock-auth.js';
import { BedrockBot, type BedrockModule } from '../src/bedrock-bot.js';
import { BedrockClient, query, type Fetcher, type Runner } from '../src/bedrock-client.js';
import { registerBedrockClientTools } from '../src/tools/bedrock-client-tools.js';
import { registerBedrockTools } from '../src/tools/bedrock-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

// ---------------------------------------------------------------- a fake prismarine-auth

class MemCache {
  static files = new Map<string, unknown>();
  constructor(readonly file: string) {}
  async getCached() { return MemCache.files.get(this.file) ?? {}; }
  async setCached(v: unknown) { MemCache.files.set(this.file, v); fs.writeFileSync(this.file, JSON.stringify(v)); }
  async setCachedPartial(v: unknown) { await this.setCached(v); }
  async reset() { await this.setCached({}); return {}; }
}

function fakeAuth(opts: { signedIn?: boolean; code?: boolean; finish?: Promise<void> } = {}) {
  const made: Array<{ cache: (o: { cacheName: string; username?: string }) => MemCache; options: Record<string, unknown> }> = [];
  const lib: AuthLib = {
    switchTitle: 'switch-title',
    FileCache: MemCache as unknown as AuthLib['FileCache'],
    Authflow: class {
      msa: { verifyTokens(): Promise<boolean> };
      constructor(_u: string, private cache: (o: { cacheName: string }) => MemCache, options: Record<string, unknown>, private onCode: (c: unknown) => void) {
        made.push({ cache, options });
        this.msa = { verifyTokens: async () => Boolean(opts.signedIn) };
      }
      async getXboxToken() {
        if (opts.code) this.onCode({ user_code: 'ABCD1234', verification_uri: 'https://www.microsoft.com/link', expires_in: 900 });
        await (opts.finish ?? Promise.resolve());
        await this.cache({ cacheName: 'live' }).setCached({ token: 't' });
        return { userXUID: '2535' };
      }
    } as unknown as AuthLib['Authflow']
  };
  return { lib, made };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-auth-'));

test('one account\'s token files, owner-only, whatever player name a connection asks with', async (t) => {
  const dir = tmp();
  const auth = new BedrockAuth(dir, () => fakeAuth().lib);
  const cache = auth.cacheFor('work');
  await cache({ cacheName: 'xbl', username: 'Steve' }).setCached({ a: 1 });
  t.is(fs.statSync(path.join(dir, 'work_xbl-cache.json')).mode & 0o777, 0o600);
  t.deepEqual(await cache({ cacheName: 'xbl', username: '2535400' }).getCached(), { a: 1 });
  t.throws(() => cache({ cacheName: 'nope' }), { message: /Unknown token cache/ });
  t.throws(() => auth.cacheFor('../x'), { message: /account name/ });
  t.is(auth.logout('work'), 1);
  t.false(fs.existsSync(path.join(dir, 'work_xbl-cache.json')));
});

test('login answers the device code at once and finishes in the background', async (t) => {
  let finish: () => void = () => {};
  const { lib, made } = fakeAuth({ code: true, finish: new Promise<void>((r) => { finish = r; }) });
  const auth = new BedrockAuth(tmp(), () => lib);
  const first = await auth.login('default', 2000);
  t.is(first.state, 'waiting');
  t.like(first.code, { code: 'ABCD1234', url: 'https://www.microsoft.com/link', link: 'https://microsoft.com/link?otc=ABCD1234', expiresIn: 900 });
  t.true(describeLogin(first).includes('enter the code ABCD1234'));
  t.like(made[made.length - 1].options, { authTitle: 'switch-title', flow: 'live', deviceType: 'Nintendo' });
  t.is((await auth.login('default', 2000)).code?.code, 'ABCD1234', 'a second call shows the same code');
  finish();
  await new Promise((r) => setTimeout(r, 10));
  t.like(await auth.status('default'), { state: 'signed-in', xuid: '2535' });
});

test('login says signed in without a code when the tokens are good', async (t) => {
  const auth = new BedrockAuth(tmp(), () => fakeAuth({ signedIn: true }).lib);
  t.deepEqual(await auth.login(), { account: 'default', state: 'signed-in' });
  t.is((await new BedrockAuth(tmp(), () => fakeAuth().lib).status()).state, 'signed-out');
});

// ---------------------------------------------------------------- the bot, online

class FakeClient extends EventEmitter {
  constructor(readonly options: Record<string, unknown>) { super(); }
  queue() {}
  close() {}
}

function fakeBedrock() {
  const clients: FakeClient[] = [];
  const module = { createClient: (o: Record<string, unknown>) => { const c = new FakeClient(o); clients.push(c); return c; } } as unknown as BedrockModule;
  return { load: async () => module, clients };
}

test('offline stays the default and pins RakNet; microsoft uses the signed-in account\'s cache', async (t) => {
  const fake = fakeBedrock();
  const auth = new BedrockAuth(tmp(), () => fakeAuth({ signedIn: true }).lib);
  const bot = new BedrockBot(fake.load, auth);
  const offline = bot.connect({ host: 'h', port: 1, username: 'Steve' });
  await new Promise((r) => setImmediate(r));
  t.like(fake.clients[0].options, { offline: true, username: 'Steve', transport: 'raknet' });
  fake.clients[0].emit('spawn');
  t.like(await offline, { auth: 'offline', username: 'Steve' });

  const online = bot.connect({ host: 'h', port: 1, username: 'ignored', auth: 'microsoft', account: 'work' });
  await new Promise((r) => setTimeout(r, 5));
  const c = fake.clients[1];
  t.like(c.options, { offline: false, username: 'work', transport: 'raknet', flow: 'live', authTitle: 'switch-title' });
  t.is(typeof c.options.profilesFolder, 'function');
  (c as unknown as { profile: { name: string } }).profile = { name: 'RealGamertag' };
  c.emit('spawn');
  t.like(await online, { auth: 'microsoft', account: 'work', username: 'RealGamertag', connected: true });
});

test('microsoft refuses before connecting when not signed in, and when the sign-in expired mid-join', async (t) => {
  const fake = fakeBedrock();
  const signedOut = new BedrockBot(fake.load, new BedrockAuth(tmp(), () => fakeAuth().lib));
  await t.throwsAsync(signedOut.connect({ host: 'h', port: 1, username: 'x', auth: 'microsoft' }), { message: /not signed in with Microsoft: call bedrock-login/ });
  t.is(fake.clients.length, 0);

  const bot = new BedrockBot(fake.load, new BedrockAuth(tmp(), () => fakeAuth({ signedIn: true }).lib));
  const joining = bot.connect({ host: 'h', port: 1, username: 'x', auth: 'microsoft' });
  await new Promise((r) => setTimeout(r, 5));
  (fake.clients[0].options.onMsaCode as () => void)();
  await t.throwsAsync(joining, { message: /expired: call bedrock-login again/ });
});

// ---------------------------------------------------------------- the real client's tools

function tools(client: BedrockClient, auth?: BedrockAuth) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection);
  registerBedrockClientTools(factory, client);
  if (auth) registerBedrockTools(factory, new BedrockBot(fakeBedrock().load, auth), auth);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  return (name: string) => {
    const call = calls.find((c) => c.args[0] === name);
    if (!call) throw new Error(`no tool ${name}`);
    return call.args[3] as (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }>;
  };
}

test('client tools call mccli and read the bridge, with its token; a screenshot comes back as an image', async (t) => {
  const ran: string[][] = [];
  const runner: Runner = async (file, args) => {
    ran.push([file, ...args]);
    if (args[1] === 'screenshot') {
      fs.writeFileSync(args[3], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return JSON.stringify({ success: true, data: { path: args[3], width: 1280, height: 720 }, error: null });
    }
    if (args[1] === 'launch') return JSON.stringify({ success: false, data: null, error: { message: 'No game files for any version' } });
    return JSON.stringify({ success: true, data: { clicked: [1, 2] }, error: null });
  };
  const fetched: Array<{ url: string; init: Parameters<Fetcher>[1] }> = [];
  const fetcher: Fetcher = async (url, init) => {
    fetched.push({ url, init });
    if (url.endsWith('/form')) return { status: 400, json: async () => ({ error: 'no open form 3 for Steve' }) };
    return { status: 200, json: async () => ({ name: 'Steve', health: 20, chat: [{ id: 1, type: 'chat', source: 'Alex', message: 'hi' }] }) };
  };
  const get = tools(new BedrockClient('mccli-test', 'http://bridge:19150', 'secret-token-1234567', runner, fetcher));

  const click = await get('bedrock-client-click')({ x: 10, y: 20 });
  t.deepEqual(ran[0], ['mccli-test', 'bedrock', 'click', '10', '20', '--button', 'left']);
  t.is(click.content[1].type, 'image');
  t.is(click.content[1].data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  const launch = await get('bedrock-client-launch')({});
  t.true(launch.isError);
  t.true(launch.content[0].text?.includes('No game files'));

  const state = await get('bedrock-client-state')({ player: 'Steve' });
  t.is(fetched[0].url, 'http://bridge:19150/state?player=Steve');
  t.is(fetched[0].init.headers.authorization, 'Bearer secret-token-1234567');
  t.true(state.content[0].text?.includes('"health": 20'));
  t.true((await get('bedrock-client-chat-log')({ since: 0 })).content[0].text?.includes('1 [chat] Alex: hi'));
  const form = await get('bedrock-client-form-respond')({ id: 3, response: 1 });
  t.true(form.isError);
  t.deepEqual(JSON.parse(fetched[fetched.length - 1].init.body!), { id: 3, response: 1 });
});

test('mccli missing, or no bridge, says what to do', async (t) => {
  const missing = new BedrockClient('nope', 'http://127.0.0.1:9', '', async () => { throw Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }); },
    async () => { throw new Error('connect ECONNREFUSED'); });
  await t.throwsAsync(missing.mccli(['status']), { message: /nope is not installed/ });
  await t.throwsAsync(missing.bridge('/status'), { message: /No bridge at http:\/\/127.0.0.1:9: start it with `mccli bedrock bridge/ });
  t.is(query({ player: undefined, since: 0 }), '?since=0');
});

test('bedrock-login and its status are tools of the bedrock set', async (t) => {
  const get = tools(new BedrockClient('x', 'http://b', '', async () => '{}', fetch as unknown as Fetcher), new BedrockAuth(tmp(), () => fakeAuth({ code: true, finish: new Promise(() => {}) }).lib));
  const login = await get('bedrock-login')({});
  t.true(login.content[0].text?.includes('open https://www.microsoft.com/link and enter the code ABCD1234'));
  t.true((await get('bedrock-login-status')({})).content[0].text?.includes('enter the code'));
});
