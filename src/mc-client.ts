import net from 'node:net';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const DEFAULT_HOST = process.env.MCCLI_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.MCCLI_PORT) || 25580;
const DEFAULT_LAUNCH_SCRIPT = process.env.MCCLI_LAUNCH_SCRIPT || '/app/mc-client/launch-client.sh';
const DEFAULT_SCREENSHOT_DIR = process.env.MCCLI_SCREENSHOT_DIR || '/app/mc-client/screenshots';
const DEFAULT_SOCKET_TIMEOUT_MS = Number(process.env.MCCLI_SOCKET_TIMEOUT_MS) || 10_000;
// Must match the fallback baked into launch-client.sh's own `${MCCLI_USERNAME:-...}`.
const DEFAULT_USERNAME = process.env.MCCLI_USERNAME || 'LLMBotClient';
// A real Minecraft client under software rendering realistically takes tens of seconds to
// reach the main menu / world, not the ~5-10s a normal socket call gets.
const DEFAULT_LAUNCH_TIMEOUT_MS = Number(process.env.MCCLI_LAUNCH_TIMEOUT_MS) || 90_000;
const LAUNCH_POLL_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 1500;
const LOG_RING_SIZE = 60;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const STOP_TIMEOUT_MS = 5000;

export function isValidMinecraftUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

/** Same derivation as Minecraft's `UUID.nameUUIDFromBytes` over `"OfflinePlayer:" + name` — a version-3, RFC 4122 UUID, so a given username always maps to the same offline UUID a server would compute. */
export function offlinePlayerUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export interface McClientOptions {
  host?: string;
  port?: number;
  socketTimeoutMs?: number;
  launchTimeoutMs?: number;
  launchScript?: string;
  screenshotDir?: string;
  autoLaunch?: boolean;
  spawnFn?: SpawnFn;
  username?: string;
}

export type McCommandResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

interface ProcessState {
  child: ChildProcess | null;
  startedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  spawnError: string | null;
  logLines: string[];
}

export interface McClientStatus {
  processState: 'not_started' | 'starting' | 'running' | 'exited';
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  spawnError: string | null;
  socketReachable: boolean;
  lastLogLines: string[];
  game: Record<string, unknown> | null;
  screen: Record<string, unknown> | null;
  username: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function freshState(previousLogLines: string[] = []): ProcessState {
  return {
    child: null,
    startedAt: null,
    exitCode: null,
    exitSignal: null,
    spawnError: null,
    logLines: previousLogLines
  };
}

/**
 * TCP/JSON client for the mc-cli NeoForge mod (Th0rgal/mc-cli). Talks newline-delimited
 * JSON request/response over a fresh connection per command, matching the mod's
 * ClientHandler (one request-response per line, no persistent session state on the wire).
 *
 * Also owns the lifecycle of the headless Minecraft client process itself: it is launched
 * lazily, on the first command that needs it, never at construction time.
 */
export class McClient {
  private readonly host: string;
  private readonly port: number;
  private readonly socketTimeoutMs: number;
  private readonly launchTimeoutMs: number;
  private readonly launchScript: string;
  private readonly screenshotDir: string;
  private readonly autoLaunch: boolean;
  private readonly spawnFn: SpawnFn;

  private state: ProcessState = freshState();
  private launchingPromise: Promise<McCommandResult> | null = null;
  private username: string;
  private uuid: string;

  constructor(options: McClientOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.socketTimeoutMs = options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
    this.launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    this.launchScript = options.launchScript ?? DEFAULT_LAUNCH_SCRIPT;
    this.screenshotDir = options.screenshotDir ?? DEFAULT_SCREENSHOT_DIR;
    this.autoLaunch = options.autoLaunch ?? true;
    this.spawnFn = options.spawnFn ?? (spawn as SpawnFn);
    this.username = options.username ?? DEFAULT_USERNAME;
    this.uuid = offlinePlayerUuid(this.username);
  }

  async request(
    command: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number; skipLaunch?: boolean } = {}
  ): Promise<McCommandResult> {
    if (this.autoLaunch && !opts.skipLaunch) {
      const launch = await this.ensureLaunched();
      if (!launch.ok) {
        return launch;
      }
    }
    return this.sendOnce(command, params, opts.timeoutMs ?? this.socketTimeoutMs);
  }

  async getStatus(): Promise<McClientStatus> {
    const alive = this.isProcessAlive();
    const socketReachable = await this.probeSocket(PROBE_TIMEOUT_MS);

    let processState: McClientStatus['processState'];
    if (this.launchingPromise && !socketReachable) {
      processState = 'starting';
    } else if (this.state.child === null) {
      processState = 'not_started';
    } else if (alive) {
      processState = socketReachable ? 'running' : 'starting';
    } else {
      processState = 'exited';
    }

    let game: Record<string, unknown> | null = null;
    let screen: Record<string, unknown> | null = null;
    if (socketReachable) {
      const gameResult = await this.sendOnce('status', {}, PROBE_TIMEOUT_MS);
      if (gameResult.ok) {
        game = gameResult.data;
      }
      const screenResult = await this.sendOnce('window', { action: 'status' }, PROBE_TIMEOUT_MS);
      if (screenResult.ok) {
        screen = screenResult.data;
      }
    }

    return {
      processState,
      pid: this.state.child?.pid ?? null,
      startedAt: this.state.startedAt ? new Date(this.state.startedAt).toISOString() : null,
      exitCode: this.state.exitCode,
      exitSignal: this.state.exitSignal,
      spawnError: this.state.spawnError,
      socketReachable,
      lastLogLines: this.state.logLines.slice(-10),
      game,
      screen,
      username: this.username
    };
  }

  getScreenshotDir(): string {
    return this.screenshotDir;
  }

  /** Username is a JVM property fixed at launch, so changing it restarts a running client. */
  async setUsername(username: string): Promise<McCommandResult> {
    if (!isValidMinecraftUsername(username)) {
      return { ok: false, error: `"${username}" is not a valid Minecraft username (3-16 letters, digits and underscores).` };
    }

    const uuid = offlinePlayerUuid(username);
    const wasRunning = this.isProcessAlive();
    this.username = username;
    this.uuid = uuid;

    if (!wasRunning) {
      return { ok: true, data: { username, uuid, restarted: false } };
    }

    await this.stopProcess();
    const launch = await this.ensureLaunched();
    if (!launch.ok) {
      return { ok: false, error: `Username updated to "${username}" but the client failed to restart: ${launch.error}` };
    }
    return { ok: true, data: { username, uuid, restarted: true } };
  }

  async captureScreenshot(clean: boolean): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
    try {
      await fsp.mkdir(this.screenshotDir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `Could not create the screenshot directory ${this.screenshotDir}: ${errorMessage(err)}` };
    }

    const filePath = path.join(this.screenshotDir, `${randomUUID()}.png`);
    const result = await this.request('screenshot', { path: filePath, clean });
    if (!result.ok) {
      return result;
    }

    try {
      const buffer = await fsp.readFile(filePath);
      return { ok: true, buffer };
    } catch (err) {
      return { ok: false, error: `The client reported a successful screenshot but the file could not be read: ${errorMessage(err)}` };
    } finally {
      fsp.unlink(filePath).catch(() => undefined);
    }
  }

  private isProcessAlive(): boolean {
    return this.state.child !== null
      && this.state.exitCode === null
      && this.state.exitSignal === null
      && this.state.spawnError === null;
  }

  private appendLog(chunk: string): void {
    for (const part of chunk.split('\n')) {
      const trimmed = part.trim();
      if (trimmed) {
        this.state.logLines.push(trimmed);
      }
    }
    if (this.state.logLines.length > LOG_RING_SIZE) {
      this.state.logLines.splice(0, this.state.logLines.length - LOG_RING_SIZE);
    }
  }

  private stopProcess(timeoutMs: number = STOP_TIMEOUT_MS): Promise<void> {
    const child = this.state.child;
    if (!child || !this.isProcessAlive()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.once('exit', () => clearTimeout(killTimer));
    });
  }

  private spawnProcess(): void {
    this.state = freshState(this.state.logLines);
    this.state.startedAt = Date.now();

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.launchScript, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MCCLI_USERNAME: this.username, MCCLI_UUID: this.uuid }
      });
    } catch (err) {
      this.state.spawnError = errorMessage(err);
      return;
    }

    this.state.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString('utf8')));
    child.on('error', (err) => {
      this.state.spawnError = errorMessage(err);
    });
    child.on('exit', (code, signal) => {
      this.state.exitCode = code;
      this.state.exitSignal = signal;
    });
  }

  private probeSocket(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(this.port, this.host);
    });
  }

  private async ensureLaunched(): Promise<McCommandResult> {
    if (this.isProcessAlive() && await this.probeSocket(PROBE_TIMEOUT_MS)) {
      return { ok: true, data: {} };
    }

    if (this.launchingPromise) {
      return this.launchingPromise;
    }

    this.launchingPromise = this.doLaunch();
    try {
      return await this.launchingPromise;
    } finally {
      this.launchingPromise = null;
    }
  }

  private async doLaunch(): Promise<McCommandResult> {
    if (!this.isProcessAlive()) {
      this.spawnProcess();
    }

    const deadline = Date.now() + this.launchTimeoutMs;
    while (Date.now() < deadline) {
      const early = this.checkEarlyFailure();
      if (early) {
        return early;
      }

      const remainingMs = Math.max(200, deadline - Date.now());
      if (await this.probeSocket(Math.min(PROBE_TIMEOUT_MS, remainingMs))) {
        return { ok: true, data: {} };
      }
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_INTERVAL_MS));
    }

    const early = this.checkEarlyFailure();
    if (early) {
      return early;
    }

    const tail = this.state.logLines.slice(-10).join(' | ') || '(no output captured)';
    return {
      ok: false,
      error: `Timed out after ${this.launchTimeoutMs}ms waiting for the Minecraft client to become reachable at ${this.host}:${this.port}. Last log lines: ${tail}`
    };
  }

  private checkEarlyFailure(): McCommandResult | null {
    if (this.state.spawnError) {
      return { ok: false, error: `Failed to launch the Minecraft client (${this.launchScript}): ${this.state.spawnError}` };
    }
    if (this.state.exitCode !== null || this.state.exitSignal !== null) {
      return { ok: false, error: this.describeEarlyExit() };
    }
    return null;
  }

  private describeEarlyExit(): string {
    const tail = this.state.logLines.slice(-10).join(' | ') || '(no output captured)';
    return `The Minecraft client process exited before it became reachable (code ${this.state.exitCode ?? 'null'}, signal ${this.state.exitSignal ?? 'null'}). Last log lines: ${tail}`;
  }

  private sendOnce(command: string, params: Record<string, unknown>, timeoutMs: number): Promise<McCommandResult> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      let buffer = '';

      const finish = (result: McCommandResult): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(timeoutMs);

      socket.on('timeout', () => {
        finish({ ok: false, error: `Timed out after ${timeoutMs}ms waiting for the client to respond to "${command}"` });
      });

      socket.on('error', (err) => {
        finish({ ok: false, error: `Could not reach the Minecraft client at ${this.host}:${this.port}: ${err.message}` });
      });

      socket.on('close', () => {
        finish({ ok: false, error: `Connection to the Minecraft client closed before a response was received for "${command}"` });
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          return;
        }

        const line = buffer.slice(0, newlineIndex);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          finish({ ok: false, error: `Received a response that was not valid JSON from the client: ${line.slice(0, 200)}` });
          return;
        }

        if (!parsed || typeof parsed !== 'object') {
          finish({ ok: false, error: 'Received a malformed response from the client' });
          return;
        }

        const response = parsed as { success?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } };
        if (response.success) {
          finish({ ok: true, data: response.data ?? {} });
        } else {
          const code = response.error?.code ?? 'UNKNOWN_ERROR';
          const message = response.error?.message ?? 'no error message provided';
          finish({ ok: false, error: `${command} failed (${code}): ${message}` });
        }
      });

      socket.connect(this.port, this.host, () => {
        const request = { id: randomUUID(), command, params };
        socket.write(`${JSON.stringify(request)}\n`);
      });
    });
  }
}
