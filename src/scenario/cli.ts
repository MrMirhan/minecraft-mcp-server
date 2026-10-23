#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseScenario, runScenario, toJUnit } from './runner.js';
import { mineflayerScenarioBot } from './mineflayer-bot.js';

/** npm run scenario -- <scenario.json> [--junit report.xml]: exit code 0 when every step passed. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const junitAt = args.indexOf('--junit');
  if (!file) {
    console.error('usage: scenario <scenario.json> [--junit report.xml]');
    process.exit(2);
  }
  const scenario = parseScenario(JSON.parse(await fs.readFile(file, 'utf8')));
  const report = await runScenario(scenario, mineflayerScenarioBot);
  for (const r of report.results) {
    console.log(`${r.status === 'passed' ? 'ok  ' : r.status === 'failed' ? 'FAIL' : 'skip'} ${r.phase} ${r.index}: ${r.name}${r.message ? ` - ${r.message}` : ''}`);
  }
  if (junitAt >= 0 && args[junitAt + 1]) await fs.writeFile(args[junitAt + 1], toJUnit(report));
  console.log(report.passed ? `PASSED ${report.name}` : `FAILED ${report.name}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
