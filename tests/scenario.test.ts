import test from 'ava';
import { EventEmitter } from 'node:events';
import { parseScenario, runScenario, toJUnit, type ScenarioBot } from '../src/scenario/runner.js';

class FakeBot extends EventEmitter implements ScenarioBot {
  sent: string[] = [];
  clicked: number[] = [];
  currentWindow: ScenarioBot['currentWindow'] = null;
  constructor(public username: string, private readonly script: (bot: FakeBot, line: string) => void = () => undefined) {
    super();
    setImmediate(() => this.emit('spawn'));
  }
  chat(line: string): void {
    this.sent.push(line);
    this.script(this, line);
  }
  activateItem(): void {
    this.currentWindow = { title: 'Kit Shop', slots: [null, { name: 'diamond_sword', displayName: 'Warrior Kit', lore: ['Price: 500'] }] };
    this.emit('windowOpen', this.currentWindow);
  }
  async clickWindow(slot: number): Promise<void> {
    this.clicked.push(slot);
  }
  closeWindow(): void {
    this.currentWindow = null;
  }
  quit(): void {
    this.emit('end');
  }
}

const base = { name: 'shop', server: { host: 'h', port: 1 }, bots: [{ name: 'tester' }] };

// The allowlist is explicit even when a scenario claims it is a test server.
process.env.SCENARIO_TEST_SERVERS = 'h:1';

test('a testServer flag alone cannot authorize commands on another server', (t) => {
  const write = [{ bot: 'tester', command: '/give @s diamond' }];
  const err = t.throws(() => parseScenario({ ...base, server: { host: 'live.example', port: 25565, testServer: true }, steps: write }));
  t.true(err?.message.includes('SCENARIO_TEST_SERVERS'));
  t.throws(() => parseScenario({ ...base, server: { host: 'h', port: 2, testServer: true }, steps: write }));
  t.notThrows(() => parseScenario({ ...base, server: { host: 'h', port: 1, testServer: true }, steps: write }));
});

test('commands and clicks are refused on a server not marked as a test server', (t) => {
  const err = t.throws(() => parseScenario({ ...base, steps: [{ bot: 'tester', command: '/give @s diamond' }] }));
  t.true(err?.message.includes('testServer'));
  t.throws(() => parseScenario({ ...base, steps: [{ bot: 'tester', click_slot: 3 }] }));
  t.throws(() => parseScenario({ ...base, steps: [{ bot: 'tester', use_item: true }] }));
  t.throws(() => parseScenario({ ...base, steps: [{ bot: 'tester', close_window: true }] }));
  t.throws(() => parseScenario({ ...base, setup: [{ bot: 'tester', command: '/clear' }], steps: [] }));
  t.notThrows(() => parseScenario({ ...base, steps: [{ expect_window: { bot: 'tester', title_contains: 'Shop' } }] }));
});

test('a scenario passes when the expected message, window and slot arrive in time', async (t) => {
  const scenario = parseScenario({
    ...base,
    server: { host: 'h', port: 1, testServer: true },
    steps: [
      { bot: 'tester', command: '/kit' },
      { expect_message: { bot: 'tester', contains: 'Welcome', within: 500 } },
      { bot: 'tester', use_item: true },
      { expect_window: { bot: 'tester', title_contains: 'Shop', within: 500 } },
      { expect_slot: { bot: 'tester', slot: 1, name_contains: 'Warrior', lore_contains: '500' } },
      { bot: 'tester', click_slot: 1 }
    ]
  });
  const bots: FakeBot[] = [];
  const report = await runScenario(scenario, (name) => {
    const bot = new FakeBot(name, (b, line) => {
      if (line === '/kit') setTimeout(() => b.emit('messagestr', 'Welcome to kits'), 20);
    });
    bots.push(bot);
    return bot;
  });
  t.true(report.passed, JSON.stringify(report.results));
  t.deepEqual(bots[0].sent, ['/kit']);
  t.deepEqual(bots[0].clicked, [1]);
});

test('a missing message fails the step after its window and still runs cleanup', async (t) => {
  const scenario = parseScenario({
    ...base,
    server: { host: 'h', port: 1, testServer: true },
    steps: [{ expect_message: { bot: 'tester', contains: 'never', within: 50 } }, { bot: 'tester', chat: 'not reached' }],
    cleanup: [{ bot: 'tester', command: '/clear' }]
  });
  let bot: FakeBot | undefined;
  const report = await runScenario(scenario, (name) => (bot = new FakeBot(name)));
  t.false(report.passed);
  t.is(report.results.filter((r) => r.status === 'failed').length, 1);
  t.true(report.results.some((r) => r.status === 'skipped'));
  t.deepEqual(bot?.sent, ['/clear']);
  const xml = toJUnit(report);
  t.true(xml.includes('<testsuite name="shop"'));
  t.true(xml.includes('<failure'));
});
