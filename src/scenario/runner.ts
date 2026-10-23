import { z } from 'zod';

/**
 * Scenario tests with bots: steps players would take and what they should see, checked within a time window.
 * Commands, chat and clicks change the server, so they run only on a server marked testServer; on any other
 * server a scenario may only join, wait, open menus with the held item and check what arrives.
 */

const botRef = z.object({ bot: z.string() });
const within = z.coerce.number().int().positive().max(120_000).optional();

const actionStep = botRef.extend({
  command: z.string().optional(),
  chat: z.string().optional(),
  wait: z.coerce.number().int().nonnegative().max(120_000).optional(),
  use_item: z.boolean().optional(),
  click_slot: z.coerce.number().int().optional(),
  close_window: z.boolean().optional()
});

const expectStep = z.object({
  expect_message: botRef.extend({ contains: z.string(), within }).optional(),
  expect_window: botRef.extend({ title_contains: z.string(), within }).optional(),
  expect_slot: botRef.extend({
    slot: z.coerce.number().int(),
    name_contains: z.string().optional(),
    lore_contains: z.string().optional(),
    within
  }).optional()
});

const step = z.union([expectStep.strict(), actionStep.strict()]);

const schema = z.object({
  name: z.string(),
  server: z.object({ host: z.string(), port: z.coerce.number().int(), testServer: z.boolean().optional() }),
  bots: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/) })).min(1).max(20),
  setup: z.array(actionStep.strict()).optional(),
  steps: z.array(step),
  cleanup: z.array(actionStep.strict()).optional()
});

export type Scenario = z.infer<typeof schema>;
type Step = z.infer<typeof step>;
type Action = z.infer<typeof actionStep>;

export interface ScenarioWindow {
  title: string;
  slots: Array<{ name: string; displayName?: string; lore?: string[] } | null>;
}

/** The part of a mineflayer bot a scenario uses. */
export interface ScenarioBot {
  username: string;
  currentWindow: ScenarioWindow | null;
  chat(line: string): void;
  activateItem(): void;
  clickWindow(slot: number, button: number, mode: number): Promise<void>;
  closeWindow(window: ScenarioWindow): void;
  quit(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface StepResult {
  phase: 'setup' | 'steps' | 'cleanup';
  index: number;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  ms: number;
  message?: string;
}

export interface ScenarioReport {
  name: string;
  passed: boolean;
  results: StepResult[];
  ms: number;
}

const DEFAULT_WITHIN = 5000;

function writes(a: Action): boolean {
  return a.command !== undefined || a.chat !== undefined || a.click_slot !== undefined;
}

/** Validates a scenario; throws with a clear message when it would change a server not marked testServer. */
export function parseScenario(input: unknown): Scenario {
  const s = schema.parse(input);
  const names = new Set(s.bots.map((b) => b.name));
  const allowed = new Set((process.env.SCENARIO_TEST_SERVERS ?? '').split(',').map((v) => v.trim()).filter(Boolean));
  const all: Array<Step> = [...(s.setup ?? []), ...s.steps, ...(s.cleanup ?? [])];
  for (const st of all) {
    const ref = 'bot' in st ? st.bot : (st.expect_message ?? st.expect_window ?? st.expect_slot)?.bot;
    if (ref !== undefined && !names.has(ref)) throw new Error(`step names bot "${ref}", which is not in bots`);
    if ('bot' in st && writes(st as Action)) {
      if (!s.server.testServer) {
        throw new Error('commands, chat and clicks change the server: they run only with server.testServer true (never on a live server)');
      }
      if (!allowed.has(`${s.server.host}:${s.server.port}`)) {
        throw new Error(`commands, chat and clicks require ${s.server.host}:${s.server.port} in SCENARIO_TEST_SERVERS; testServer alone is not permission`);
      }
    }
  }
  return s;
}

function describe(st: Step): string {
  if ('expect_message' in st && st.expect_message) return `expect message "${st.expect_message.contains}"`;
  if ('expect_window' in st && st.expect_window) return `expect window "${st.expect_window.title_contains}"`;
  if ('expect_slot' in st && st.expect_slot) return `expect slot ${st.expect_slot.slot}`;
  const a = st as Action;
  if (a.command !== undefined) return `${a.bot}: ${a.command}`;
  if (a.chat !== undefined) return `${a.bot} says "${a.chat}"`;
  if (a.wait !== undefined) return `wait ${a.wait} ms`;
  if (a.use_item) return `${a.bot}: use item`;
  if (a.click_slot !== undefined) return `${a.bot}: click slot ${a.click_slot}`;
  if (a.close_window) return `${a.bot}: close window`;
  return 'step';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function until<T>(check: () => T | undefined, ms: number, failure: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const v = check();
      if (v !== undefined) return resolve(v);
      if (Date.now() >= deadline) return reject(new Error(failure));
      setTimeout(tick, 25);
    };
    tick();
  });
}

export async function runScenario(s: Scenario, createBot: (name: string, server: Scenario['server']) => ScenarioBot): Promise<ScenarioReport> {
  const started = Date.now();
  const bots = new Map<string, ScenarioBot>();
  const messages = new Map<string, string[]>();
  const results: StepResult[] = [];
  try {
    await Promise.all(s.bots.map((b) => new Promise<void>((resolve, reject) => {
      const bot = createBot(b.name, s.server);
      bots.set(b.name, bot);
      messages.set(b.name, []);
      bot.on('messagestr', (m: unknown) => messages.get(b.name)?.push(String(m)));
      const timer = setTimeout(() => reject(new Error(`${b.name} did not spawn within 30 s`)), 30_000);
      bot.once('spawn', () => { clearTimeout(timer); resolve(); });
      bot.once('kicked', (reason: unknown) => { clearTimeout(timer); reject(new Error(`${b.name} was kicked: ${String(reason)}`)); });
    })));

    const exec = async (st: Step): Promise<void> => {
      if ('expect_message' in st && st.expect_message) {
        const e = st.expect_message;
        const seen = messages.get(e.bot) ?? [];
        const from = seen.length;
        // a message that arrived since the previous step counts too
        const start = Math.max(0, from - 20);
        await until(() => seen.slice(start).find((m) => m.includes(e.contains)), e.within ?? DEFAULT_WITHIN,
          `no message containing "${e.contains}" within ${e.within ?? DEFAULT_WITHIN} ms (last: ${seen.slice(-3).join(' | ') || 'none'})`);
        return;
      }
      if ('expect_window' in st && st.expect_window) {
        const e = st.expect_window;
        const bot = bots.get(e.bot)!;
        await until(() => (bot.currentWindow && bot.currentWindow.title.includes(e.title_contains) ? true : undefined), e.within ?? DEFAULT_WITHIN,
          `no window titled "${e.title_contains}" within ${e.within ?? DEFAULT_WITHIN} ms (open: ${bot.currentWindow?.title ?? 'none'})`);
        return;
      }
      if ('expect_slot' in st && st.expect_slot) {
        const e = st.expect_slot;
        const bot = bots.get(e.bot)!;
        await until(() => {
          const item = bot.currentWindow?.slots[e.slot];
          if (!item) return undefined;
          const name = `${item.displayName ?? ''} ${item.name}`;
          if (e.name_contains && !name.includes(e.name_contains)) return undefined;
          if (e.lore_contains && !(item.lore ?? []).some((l) => l.includes(e.lore_contains!))) return undefined;
          return true;
        }, e.within ?? DEFAULT_WITHIN, `slot ${e.slot} does not match within ${e.within ?? DEFAULT_WITHIN} ms`);
        return;
      }
      const a = st as Action;
      const bot = bots.get(a.bot)!;
      if (a.command !== undefined) bot.chat(a.command.startsWith('/') ? a.command : `/${a.command}`);
      if (a.chat !== undefined) bot.chat(a.chat);
      if (a.use_item) bot.activateItem();
      if (a.click_slot !== undefined) await bot.clickWindow(a.click_slot, 0, 0);
      if (a.close_window && bot.currentWindow) bot.closeWindow(bot.currentWindow);
      if (a.wait !== undefined) await sleep(a.wait);
    };

    const phase = async (name: StepResult['phase'], list: Step[], stopOnFail: boolean): Promise<boolean> => {
      let ok = true;
      for (let i = 0; i < list.length; i++) {
        const st = list[i];
        if (!ok && stopOnFail) {
          results.push({ phase: name, index: i, name: describe(st), status: 'skipped', ms: 0 });
          continue;
        }
        const t0 = Date.now();
        try {
          await exec(st);
          results.push({ phase: name, index: i, name: describe(st), status: 'passed', ms: Date.now() - t0 });
        } catch (err) {
          ok = false;
          results.push({ phase: name, index: i, name: describe(st), status: 'failed', ms: Date.now() - t0, message: err instanceof Error ? err.message : String(err) });
        }
      }
      return ok;
    };

    const setupOk = await phase('setup', s.setup ?? [], true);
    if (setupOk) await phase('steps', s.steps, true);
    else s.steps.forEach((st, i) => results.push({ phase: 'steps', index: i, name: describe(st), status: 'skipped', ms: 0 }));
    await phase('cleanup', s.cleanup ?? [], false);
  } catch (err) {
    results.push({ phase: 'setup', index: -1, name: 'join', status: 'failed', ms: Date.now() - started, message: err instanceof Error ? err.message : String(err) });
  } finally {
    for (const bot of bots.values()) {
      try { bot.quit(); } catch { /* already gone */ }
    }
  }
  return { name: s.name, passed: results.every((r) => r.status !== 'failed'), results, ms: Date.now() - started };
}

function xml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

export function toJUnit(r: ScenarioReport): string {
  const failures = r.results.filter((x) => x.status === 'failed').length;
  const skipped = r.results.filter((x) => x.status === 'skipped').length;
  const cases = r.results.map((x) => {
    const open = `  <testcase classname="${xml(r.name)}.${x.phase}" name="${xml(`${x.index}: ${x.name}`)}" time="${(x.ms / 1000).toFixed(3)}"`;
    if (x.status === 'failed') return `${open}>\n    <failure message="${xml(x.message ?? '')}"/>\n  </testcase>`;
    if (x.status === 'skipped') return `${open}>\n    <skipped/>\n  </testcase>`;
    return `${open}/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(r.name)}" tests="${r.results.length}" failures="${failures}" skipped="${skipped}" time="${(r.ms / 1000).toFixed(3)}">\n${cases.join('\n')}\n</testsuite>\n`;
}
