import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The real Bedrock client, driven as mc-cli drives it: `mccli bedrock ...` starts it (mcpelauncher), takes its
 * screenshots and sends it mouse and keys; mc-cli's bridge, which carries its game to the server, says what
 * happens in that game (position, health, inventory, chat, forms) on its control API.
 *
 *   MCCLI_BIN                  the mccli command (default: mccli)
 *   BEDROCK_BRIDGE_URL         the bridge's control API (default: http://127.0.0.1:19150; also MCCLI_BEDROCK_BRIDGE_URL)
 *   BEDROCK_BRIDGE_TOKEN       its token, when it listens beyond loopback (also MCCLI_BEDROCK_BRIDGE_TOKEN)
 *   BEDROCK_DISPLAY            the X display the client draws on (default: DISPLAY, else :98)
 *   BEDROCK_START_XVFB         true: start Xvfb on that display when it is not up (the image's Bedrock variant sets it)
 */

export type Runner = (file: string, args: string[], timeoutMs: number, env: Record<string, string | undefined>) => Promise<string>;
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const run: Runner = (file, args, timeoutMs, env) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout) => {
    // mccli answers JSON on stdout and exits 1 on a failure it explains; only a missing command or a timeout is an error here.
    if (stdout && stdout.trim()) return resolve(stdout);
    if (err) return reject(err);
    resolve(stdout);
  });
});

export class BedrockClient {
  constructor(
    private readonly bin = process.env.MCCLI_BIN || 'mccli',
    private readonly bridgeUrl = (process.env.BEDROCK_BRIDGE_URL || process.env.MCCLI_BEDROCK_BRIDGE_URL || 'http://127.0.0.1:19150').replace(/\/$/, ''),
    private readonly bridgeToken = process.env.BEDROCK_BRIDGE_TOKEN || process.env.MCCLI_BEDROCK_BRIDGE_TOKEN || '',
    private readonly runner: Runner = run,
    private readonly fetcher: Fetcher = fetch as unknown as Fetcher,
    readonly display = process.env.BEDROCK_DISPLAY || process.env.DISPLAY || ':98',
    private readonly startXvfb = process.env.BEDROCK_START_XVFB === 'true'
  ) {}

  /** Brings up Xvfb on the client's display when told to and it is not up yet. */
  async ensureDisplay(): Promise<void> {
    if (!this.startXvfb) return;
    const socket = `/tmp/.X11-unix/X${this.display.replace(/^:/, '').split('.')[0]}`;
    if (existsSync(socket)) return;
    spawn('Xvfb', [this.display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 200));
    if (!existsSync(socket)) throw new Error(`Xvfb did not come up on ${this.display}`);
  }

  /** `mccli bedrock <args>`: its `data`, or its error as a thrown message. */
  async mccli(args: string[], timeoutMs = 60_000): Promise<Record<string, unknown>> {
    let out: string;
    try {
      if (args[0] === 'launch') await this.ensureDisplay();
      out = await this.runner(this.bin, ['bedrock', ...args], timeoutMs, { ...process.env, DISPLAY: this.display });
    } catch (err) {
      const e = err as Error & { code?: string; killed?: boolean };
      if (e.code === 'ENOENT') throw new Error(`${this.bin} is not installed: the real Bedrock client needs mc-cli's CLI (pip install mc-cli's cli/, or set MCCLI_BIN)`, { cause: err });
      if (e.killed) throw new Error(`mccli bedrock ${args[0]} did not answer within ${timeoutMs / 1000} s`, { cause: err });
      throw err;
    }
    let parsed: { success?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
    try {
      parsed = JSON.parse(out.trim().split('\n').pop() ?? '');
    } catch {
      throw new Error(`mccli answered something that is not JSON: ${out.slice(0, 200)}`);
    }
    if (!parsed.success) throw new Error(parsed.error?.message ?? 'mccli failed');
    return parsed.data ?? {};
  }

  /** A screenshot of the client's window, as PNG bytes. */
  async screenshot(): Promise<{ png: Buffer; width: number; height: number }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bedrock-shot-'));
    const file = path.join(dir, 'shot.png');
    try {
      const data = await this.mccli(['screenshot', '--path', file]);
      return { png: await fs.readFile(file), width: Number(data.width), height: Number(data.height) };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** A call to the bridge's control API. */
  async bridge(pathAndQuery: string, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.bridgeToken) headers.authorization = `Bearer ${this.bridgeToken}`;
    let res;
    try {
      res = await this.fetcher(this.bridgeUrl + pathAndQuery, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (err) {
      throw new Error(`No bridge at ${this.bridgeUrl}: start it with \`mccli bedrock bridge --target host:port\` and set BEDROCK_BRIDGE_URL (${(err as Error).message})`, { cause: err });
    }
    const data = await res.json() as Record<string, unknown>;
    if (res.status !== 200) throw new Error(`The bridge answered ${res.status}: ${String(data.error ?? '')}`);
    return data;
  }
}

export function query(params: Record<string, string | number | undefined>): string {
  const given = Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string | number][];
  return given.length ? `?${new URLSearchParams(given.map(([k, v]) => [k, String(v)])).toString()}` : '';
}
