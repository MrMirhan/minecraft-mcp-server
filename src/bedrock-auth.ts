import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Microsoft (Xbox Live) sign-in for Bedrock: a device code the model shows the person, who enters it at
 * microsoft.com/link; the tokens are cached and renew themselves. One cache, keyed by an account name, serves
 * the Bedrock bot and mc-cli's bridge (`mccli bedrock bridge --auth microsoft`) when both use one folder:
 * the files are `<account>_<cache>-cache.json`, the layout mc-cli's bedrock/auth.mjs writes.
 */

const requireCjs = createRequire(import.meta.url);

interface TokenCache {
  getCached(): Promise<unknown>;
  setCached(value: unknown): Promise<void>;
  setCachedPartial(value: unknown): Promise<void>;
  reset(): Promise<unknown>;
}

export type CacheFactory = (opts: { cacheName: string; username?: string }) => TokenCache;

interface Authflow {
  msa: { verifyTokens(): Promise<boolean> };
  getXboxToken(): Promise<{ userXUID?: string }>;
}

/** What the sign-in needs from prismarine-auth; tests hand in a fake. */
export interface AuthLib {
  Authflow: new (username: string, cache: CacheFactory, options: Record<string, unknown>, onCode: (code: DeviceCodeResponse) => void) => Authflow;
  FileCache: new (file: string) => TokenCache;
  switchTitle: string;
}

interface DeviceCodeResponse {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  message?: string;
}

export interface DeviceCode {
  code: string;
  url: string;
  link: string;
  expiresIn: number;
  expiresAt: number;
}

export interface LoginState {
  account: string;
  state: 'signed-in' | 'waiting' | 'signed-out' | 'failed';
  code?: DeviceCode;
  xuid?: string;
  error?: string;
}

const CACHE_IDS = ['msal', 'live', 'sisu', 'xbl', 'bed', 'mca', 'mcs', 'pfb'];

function loadLib(): AuthLib {
  const auth = requireCjs('prismarine-auth') as { Authflow: AuthLib['Authflow']; Titles: { MinecraftNintendoSwitch: string } };
  const FileCache = requireCjs('prismarine-auth/src/common/cache/FileCache') as AuthLib['FileCache'];
  return { Authflow: auth.Authflow, FileCache, switchTitle: auth.Titles.MinecraftNintendoSwitch };
}

export function defaultAuthDir(): string {
  return process.env.BEDROCK_AUTH_DIR || process.env.MCCLI_BEDROCK_AUTH || path.join(os.homedir(), '.minecraft-mcp', 'bedrock-auth');
}

export function checkAccount(account: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(account)) throw new Error('An account name is 1-64 letters, digits, dots, dashes or underscores');
  return account;
}

export class BedrockAuth {
  private lib: AuthLib | null = null;
  private logins = new Map<string, LoginState & { done?: Promise<void> }>();

  constructor(readonly dir: string = defaultAuthDir(), private load: () => AuthLib = loadLib) {}

  private auth(): AuthLib {
    this.lib ??= this.load();
    return this.lib;
  }

  /** bedrock-protocol's default sign-in (the Switch title over the live flow), which mc-cli's bridge uses too. */
  options(): Record<string, unknown> {
    return { authTitle: this.auth().switchTitle, deviceType: 'Nintendo', flow: 'live' };
  }

  /** The account's token files, whatever player name a connection asks with. */
  cacheFor(account = 'default'): CacheFactory {
    checkAccount(account);
    const { FileCache } = this.auth();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return ({ cacheName }) => {
      if (!CACHE_IDS.includes(cacheName)) throw new Error(`Unknown token cache '${cacheName}'`);
      const file = path.join(this.dir, `${account}_${cacheName}-cache.json`);
      const cache = new FileCache(file);
      // Tokens are secrets: owner-only files, whichever way the cache writes them.
      for (const method of ['setCached', 'reset'] as const) {
        const original = cache[method].bind(cache) as (...a: unknown[]) => Promise<unknown>;
        (cache as unknown as Record<string, unknown>)[method] = async (...a: unknown[]) => {
          const out = await original(...a);
          fs.chmodSync(file, 0o600);
          return out;
        };
      }
      return cache;
    };
  }

  private flow(account: string, onCode: (code: DeviceCodeResponse) => void): Authflow {
    const { Authflow } = this.auth();
    return new Authflow('', this.cacheFor(account), this.options(), onCode);
  }

  /** Whether the account has a usable sign-in; never asks for a code. */
  async isSignedIn(account = 'default'): Promise<boolean> {
    try {
      return Boolean(await this.flow(account, () => { throw new Error('not signed in'); }).msa.verifyTokens());
    } catch {
      return false;
    }
  }

  /**
   * Starts a sign-in. Resolves as soon as there is something to tell the person: signed in already, or the
   * device code to enter (the sign-in then finishes in the background; `status` follows it).
   */
  async login(account = 'default', codeWaitMs = 20000): Promise<LoginState> {
    checkAccount(account);
    const pending = this.logins.get(account);
    if (pending?.state === 'waiting' && pending.code && pending.code.expiresAt > Date.now()) return this.status(account);
    if (await this.isSignedIn(account)) {
      const state: LoginState = { account, state: 'signed-in' };
      this.logins.set(account, state);
      return state;
    }
    const entry: LoginState & { done?: Promise<void> } = { account, state: 'waiting' };
    this.logins.set(account, entry);
    let gotCode: () => void = () => {};
    const codeShown = new Promise<void>((resolve) => { gotCode = resolve; });
    const flow = this.flow(account, (c) => {
      entry.code = {
        code: c.user_code,
        url: c.verification_uri,
        link: `https://microsoft.com/link?otc=${c.user_code}`,
        expiresIn: c.expires_in,
        expiresAt: Date.now() + c.expires_in * 1000
      };
      gotCode();
    });
    entry.done = flow.getXboxToken().then((xbox) => {
      entry.state = 'signed-in';
      entry.xuid = xbox.userXUID;
      delete entry.code;
    }, (err: unknown) => {
      entry.state = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      delete entry.code;
    }).finally(() => gotCode());
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([codeShown, new Promise((r) => { timer = setTimeout(r, codeWaitMs); })]);
    clearTimeout(timer);
    return this.status(account);
  }

  /** Where a sign-in stands; signed-out when none was started and the tokens are not usable. */
  async status(account = 'default'): Promise<LoginState> {
    checkAccount(account);
    const entry = this.logins.get(account);
    if (entry) {
      const { done: _done, ...state } = entry;
      void _done;
      if (state.state === 'waiting' && state.code && state.code.expiresAt <= Date.now()) {
        return { account, state: 'failed', error: 'The code expired; call bedrock-login again' };
      }
      return state;
    }
    return { account, state: (await this.isSignedIn(account)) ? 'signed-in' : 'signed-out' };
  }

  logout(account = 'default'): number {
    checkAccount(account);
    this.logins.delete(account);
    let removed = 0;
    for (const id of CACHE_IDS) {
      const file = path.join(this.dir, `${account}_${id}-cache.json`);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    }
    return removed;
  }
}

/** The sign-in, for a person to act on. */
export function describeLogin(s: LoginState): string {
  switch (s.state) {
    case 'signed-in':
      return `Account "${s.account}" is signed in with Microsoft${s.xuid ? ` (xuid ${s.xuid})` : ''}. bedrock-connect with auth "microsoft" joins online servers as it; mc-cli's bridge uses it when it shares the token folder.`;
    case 'waiting':
      return s.code
        ? `To sign in "${s.account}", open ${s.code.url} and enter the code ${s.code.code} (or open ${s.code.link}). The code expires in ${Math.round((s.code.expiresAt - Date.now()) / 60000)} minutes. Then check with bedrock-login-status.`
        : `The sign-in of "${s.account}" is starting; check again with bedrock-login-status.`;
    case 'failed':
      return `The sign-in of "${s.account}" failed: ${s.error}`;
    default:
      return `Account "${s.account}" is not signed in. bedrock-login starts a sign-in.`;
  }
}
