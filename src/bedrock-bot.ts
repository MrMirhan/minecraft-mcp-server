import { randomUUID } from 'crypto';
import type { BedrockAuth } from './bedrock-auth.js';

// A Bedrock protocol bot (bedrock-protocol, MIT): it joins a Bedrock server, or a Java server through
// Geyser, as a player without a client. It reads what the server sends a player (chat, the tab list,
// forms, health, position) and sends chat, commands and form answers. It does not move by itself and
// draws nothing. It logs in offline (the server must allow offline players: online-mode=false, or
// Geyser's auth-type offline / Floodgate) or, with auth "microsoft", as a Microsoft account signed in
// with bedrock-login.

/** The Bedrock version the bot speaks unless told; bedrock-protocol's newest. */
export const BEDROCK_VERSION = '1.26.60';
const MAX_CHAT = 200;

export interface BedrockChat {
  at: number;
  type: string;
  source: string;
  message: string;
}

export interface BedrockForm {
  id: number;
  at: number;
  /** The form as the server sent it: {type: form | modal | custom_form, title, content, buttons, elements}. */
  form: unknown;
}

export interface BedrockState {
  connected: boolean;
  auth?: 'offline' | 'microsoft';
  account?: string;
  server?: string;
  username?: string;
  version?: string;
  position?: { x: number; y: number; z: number };
  dimension?: string;
  gamemode?: string;
  health?: number;
  players: string[];
  forms: number;
  lastDisconnect?: string;
}

type Packet = Record<string, unknown>;

/** What the bot uses of a bedrock-protocol client. */
interface Client {
  on(name: string, listener: (packet: Packet) => void): void;
  removeListener(name: string, listener: (packet: Packet) => void): void;
  queue(name: string, params: Record<string, unknown>): void;
  close(): void;
}

/**
 * The bedrock-protocol module (an optional dependency: its RakNet needs cmake and a C++ compiler to
 * build); tests hand in a fake one.
 */
export type BedrockModule = { createClient: (options: Record<string, unknown>) => Client };

const loadBedrock = async (): Promise<BedrockModule> => {
  try {
    // A variable, so TypeScript does not look for the optional package's types at build time.
    const name = 'bedrock-protocol';
    return ((await import(name)) as { default: BedrockModule }).default;
  } catch (err) {
    throw new Error(`bedrock-protocol is not installed (an optional dependency: its RakNet needs cmake and a C++ compiler to build). Install them and run npm install again. ${(err as Error).message}`, { cause: err });
  }
};

export class BedrockBot {
  private client: Client | null = null;
  private entityId: bigint = 0n;
  private chat: BedrockChat[] = [];
  private forms = new Map<number, BedrockForm>();
  private players = new Map<string, string>();
  private state: Omit<BedrockState, 'players' | 'forms'> = { connected: false };

  constructor(private load: () => Promise<BedrockModule> = loadBedrock, private auth?: BedrockAuth) {}

  /**
   * Joins `host:port`; resolves once the bot has spawned. Offline it is `username`; with auth "microsoft" it
   * is the account's Xbox profile, and the account must be signed in (bedrock-login) first.
   */
  async connect(opts: { host: string; port: number; username: string; version?: string; timeoutMs?: number; auth?: 'offline' | 'microsoft'; account?: string }): Promise<BedrockState> {
    this.disconnect();
    const online = opts.auth === 'microsoft';
    const account = opts.account ?? 'default';
    if (online) {
      if (!this.auth) throw new Error('Microsoft sign-in is not set up in this server');
      if (!(await this.auth.isSignedIn(account))) throw new Error(`Account "${account}" is not signed in with Microsoft: call bedrock-login first`);
    }
    const bedrock = await this.load();
    const version = opts.version ?? BEDROCK_VERSION;
    let refuse: (err: Error) => void = () => {};
    const client = bedrock.createClient({
      host: opts.host,
      port: opts.port,
      username: online ? account : opts.username,
      offline: !online,
      version,
      // A host and port mean RakNet; left open, bedrock-protocol also tries NetherNet LAN discovery and can
      // land on a LAN world (mc-cli's bridge) answering on the same host.
      transport: 'raknet',
      conLog: null,
      ...(online ? {
        ...this.auth!.options(),
        profilesFolder: this.auth!.cacheFor(account),
        // Only when the cached sign-in could not be renewed: never wait on a code nobody sees.
        onMsaCode: () => refuse(new Error(`The sign-in of "${account}" expired: call bedrock-login again`))
      } : {})
    });
    this.client = client;
    this.chat = [];
    this.forms.clear();
    this.players.clear();
    this.state = { connected: false, auth: online ? 'microsoft' : 'offline', ...(online ? { account } : {}), server: `${opts.host}:${opts.port}`, username: online ? undefined : opts.username, version };
    const on = (name: string, fn: (p: Packet) => void) => client.on(name, fn);
    on('start_game', (p) => {
      this.entityId = BigInt(p.runtime_entity_id as bigint | number);
      this.state.position = vec(p.player_position);
      this.state.dimension = String(p.dimension);
      // "fallback": the player has the world's game mode.
      this.state.gamemode = String(p.player_gamemode === 'fallback' ? p.world_gamemode : p.player_gamemode);
    });
    // The server places the player with respawn packets; the last one (state 1, ready) is where it spawned.
    on('respawn', (p) => { this.state.position = vec(p.position); });
    on('move_player', (p) => {
      if (BigInt(p.runtime_id as bigint | number) === this.entityId) this.state.position = vec(p.position);
    });
    on('set_health', (p) => { this.state.health = p.health as number; });
    on('set_player_game_type', (p) => { this.state.gamemode = String(p.gamemode); });
    on('change_dimension', (p) => { this.state.dimension = String(p.dimension); this.state.position = vec(p.position); });
    on('text', (p) => this.note({ at: Date.now(), type: String(p.type), source: String(p.source_name ?? ''), message: textOf(p) }));
    on('modal_form_request', (p) => {
      const id = p.form_id as number;
      let form: unknown = p.data;
      try { form = JSON.parse(String(p.data)); } catch { /* keep the raw text */ }
      this.forms.set(id, { id, at: Date.now(), form });
    });
    on('player_list', (p) => {
      for (const r of (p.records as { type?: string; uuid: string; username?: string }[] | undefined) ?? []) {
        if (r.type === 'remove') this.players.delete(r.uuid);
        else this.players.set(r.uuid, r.username ?? r.uuid);
      }
    });
    const ended = (why: string) => {
      this.state.connected = false;
      this.state.lastDisconnect = why;
    };
    on('disconnect', (p) => ended(String(p.message || p.reason || 'disconnected')));
    on('close', () => { if (this.state.connected) ended('the connection closed'); });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`The bot did not spawn within ${opts.timeoutMs ?? 30000} ms`)), opts.timeoutMs ?? 30000);
      const fail = (err: Error) => {
        clearTimeout(timer);
        this.close();
        reject(err);
      };
      refuse = fail;
      on('spawn', () => {
        clearTimeout(timer);
        this.state.connected = true;
        // Online, the name is the account's gamertag, known once the server accepted it.
        if (online) this.state.username = (client as unknown as { username?: string; profile?: { name?: string } }).profile?.name
          ?? (client as unknown as { username?: string }).username;
        resolve();
      });
      on('kick', (p) => fail(new Error(`The server refused the bot: ${String(p.message ?? p.reason ?? 'kicked')}`)));
      on('disconnect', (p) => { if (!this.state.connected) fail(new Error(`The server refused the bot: ${String(p.message || p.reason)}`)); });
      on('error', (e) => { if (!this.state.connected) fail((e as unknown) instanceof Error ? (e as unknown as Error) : new Error(String(e))); });
    });
    return this.status();
  }

  disconnect(): void {
    if (this.client) this.state.lastDisconnect = 'the bot left';
    this.close();
  }

  status(): BedrockState {
    return { ...this.state, players: [...this.players.values()].sort(), forms: this.forms.size };
  }

  /** The newest `count` chat lines, oldest first. */
  recentChat(count: number): BedrockChat[] {
    return this.chat.slice(-count);
  }

  pendingForms(): BedrockForm[] {
    return [...this.forms.values()];
  }

  sendChat(message: string): void {
    this.live().queue('text', {
      needs_translation: false, category: 'authored', type: 'chat', source_name: this.state.username ?? '', message,
      xuid: '', platform_chat_id: '', has_filtered_message: false
    });
  }

  /** Runs `command` as the bot; the server's answer, when it sends one within `waitMs`. */
  async command(command: string, waitMs = 2000): Promise<string[] | null> {
    const client = this.live();
    const uuid = randomUUID();
    const answer = new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => { off(); resolve(null); }, waitMs);
      const listener = (p: Packet) => {
        if ((p.origin as { uuid?: string } | undefined)?.uuid !== uuid) return;
        clearTimeout(timer);
        off();
        const out = (p.output as { message_id: string; success: boolean; parameters: string[] }[]) ?? [];
        resolve(out.map((o) => `${o.success ? 'ok' : 'failed'}: ${o.message_id}${o.parameters.length ? ` ${o.parameters.join(' ')}` : ''}`));
      };
      const off = () => client.removeListener('command_output', listener);
      client.on('command_output', listener);
    });
    client.queue('command_request', {
      command: command.startsWith('/') ? command : `/${command}`,
      origin: { type: 'player', uuid, request_id: '', player_entity_id: this.entityId },
      internal: false,
      version: 'latest'
    });
    return answer;
  }

  /** Answers form `id`: `response` (a button index, true/false, or the custom form's values), or closes it. */
  answerForm(id: number, response: unknown | undefined): void {
    if (!this.forms.has(id)) throw new Error(`No open form ${id}; bedrock-forms lists the open ones`);
    this.live().queue('modal_form_response', response === undefined
      ? { form_id: id, has_response_data: false, has_cancel_reason: true, cancel_reason: 'closed' }
      : { form_id: id, has_response_data: true, data: JSON.stringify(response), has_cancel_reason: false });
    this.forms.delete(id);
  }

  private live(): Client {
    if (!this.client || !this.state.connected) throw new Error('The Bedrock bot is not connected: use bedrock-connect');
    return this.client;
  }

  private note(line: BedrockChat): void {
    this.chat.push(line);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
  }

  private close(): void {
    const client = this.client;
    this.client = null;
    this.state.connected = false;
    try { client?.close(); } catch { /* already closed */ }
  }
}

function vec(v: unknown): { x: number; y: number; z: number } | undefined {
  const p = v as { x?: number; y?: number; z?: number } | undefined;
  return p && typeof p.x === 'number' ? { x: Math.round(p.x * 10) / 10, y: Math.round((p.y ?? 0) * 10) / 10, z: Math.round((p.z ?? 0) * 10) / 10 } : undefined;
}

/** A text packet's words: its message, with a translation's parameters after it. */
function textOf(p: Packet): string {
  const params = Array.isArray(p.parameters) && p.parameters.length ? ` [${(p.parameters as string[]).join(', ')}]` : '';
  return `${String(p.message ?? '')}${params}`;
}
