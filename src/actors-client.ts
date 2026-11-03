import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * A client for paper-actors' control API: fake players on a Paper test server, driven over signed JSON over HTTP.
 * Requests are signed with HMAC-SHA256 (the same scheme as paper-actors' client/actors_client.py): the key is
 * HMAC(secret, "paper-actors/v1"); the signed text is method, path with query, time, nonce and the body's SHA-256.
 *
 *   PAPER_ACTORS_URL     the API (default http://127.0.0.1:4331; reach a remote server through an SSH tunnel, or set the
 *                        plugin's api.host and use its address)
 *   PAPER_ACTORS_SECRET  the plugin's secret (16+ characters; 32+ when the API is not on loopback)
 */

const KEY_LABEL = 'paper-actors/v1';

export function signingKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

export function sign(secret: string, method: string, pathAndQuery: string, time: number, nonce: string, body: Buffer): string {
  const text = [method.toUpperCase(), pathAndQuery, String(time), nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  return createHmac('sha256', signingKey(secret)).update(text).digest('hex');
}

export type ActorsFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

export class ActorsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class ActorsClient {
  private readonly url: string;

  constructor(
    url = process.env.PAPER_ACTORS_URL || 'http://127.0.0.1:4331',
    private readonly secret = process.env.PAPER_ACTORS_SECRET || '',
    private readonly fetcher: ActorsFetch = fetch as unknown as ActorsFetch,
    private readonly timeoutMs = 15_000
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  configured(): boolean {
    return this.secret.length >= 16;
  }

  async request(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!this.configured()) {
      throw new Error('paper-actors is not set up here: set PAPER_ACTORS_SECRET (the plugin\'s secret) and PAPER_ACTORS_URL');
    }
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
    const time = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
      'X-Actors-Time': String(time),
      'X-Actors-Nonce': nonce,
      'X-Actors-Signature': sign(this.secret, method, pathAndQuery, time, nonce, raw),
      'Content-Type': 'application/json'
    };
    let res;
    try {
      res = await this.fetcher(this.url + pathAndQuery, { method, headers, ...(raw.length ? { body: raw } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new Error(`No paper-actors API at ${this.url} (${(err as Error).message}): is the plugin running, and the port reachable?`, { cause: err });
    }
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.status !== 200) throw new ActorsError(res.status, String(data.error ?? `request failed (${res.status})`));
    return data;
  }

  state() { return this.request('GET', '/v1/state'); }
  metrics() { return this.request('GET', '/v1/metrics'); }
  actor(name: string) { return this.request('GET', `/v1/actor?name=${encodeURIComponent(name)}`); }
  events(since = 0, limit = 200) { return this.request('GET', `/v1/events?since=${since}&limit=${limit}`); }
  spawn(body: Record<string, unknown>) { return this.request('POST', '/v1/spawn', body); }
  despawn(body: Record<string, unknown>) { return this.request('POST', '/v1/despawn', body); }
  act(name: string, action: Record<string, unknown>) { return this.request('POST', '/v1/act', { ...action, name }); }
  scenePlay(scene: unknown) { return this.request('POST', '/v1/scene/play', { scene }); }
  sceneStop() { return this.request('POST', '/v1/scene/stop', {}); }
}
