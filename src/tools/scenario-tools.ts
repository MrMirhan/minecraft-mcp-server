import { z } from 'zod';
import fs from 'node:fs/promises';
import { ToolFactory } from '../tool-factory.js';
import { parseScenario, runScenario, toJUnit, type ScenarioBot, type Scenario } from '../scenario/runner.js';
import { mineflayerScenarioBot } from '../scenario/mineflayer-bot.js';

export function registerScenarioTools(
  factory: ToolFactory,
  createBot: (name: string, server: Scenario['server']) => ScenarioBot = mineflayerScenarioBot
): void {
  factory.registerTool(
    "scenario-run",
    "Run a scenario test with protocol bots: bots join, take steps (command, chat, use_item, click_slot, close_window, wait) and check what arrives within a time window (expect_message, expect_window, expect_slot). Commands, chat and clicks run only when server.testServer is true; on a live server a scenario may only join, open menus with the held item and check. Give the scenario object or a file path; optional junit writes a JUnit report.",
    {
      scenario: z.record(z.string(), z.unknown()).optional().describe("The scenario object {name, server{host,port,testServer}, bots[{name}], setup, steps, cleanup}"),
      file: z.string().optional().describe("Path to a scenario JSON file instead"),
      junit: z.string().optional().describe("Write a JUnit XML report here")
    },
    async ({ scenario, file, junit }: { scenario?: Record<string, unknown>; file?: string; junit?: string }) => {
      let parsed: Scenario;
      try {
        const input = scenario ?? (file ? JSON.parse(await fs.readFile(file, 'utf8')) : undefined);
        if (!input) return factory.createErrorResponse('Give scenario or file');
        parsed = parseScenario(input);
      } catch (err) {
        return factory.createErrorResponse(`Invalid scenario: ${err instanceof Error ? err.message : String(err)}`);
      }
      const report = await runScenario(parsed, createBot);
      if (junit) await fs.writeFile(junit, toJUnit(report));
      const lines = report.results.map((r) => `${r.status} ${r.phase} ${r.index}: ${r.name}${r.message ? ` - ${r.message}` : ''}`);
      return factory.createResponse(`${report.passed ? 'PASSED' : 'FAILED'} ${report.name} (${report.ms} ms)\n${lines.join('\n')}`);
    },
    { skipConnectionCheck: true }
  );
}
