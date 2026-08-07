import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { ActionManager, raceWithAbort } from '../action-manager.js';

const DEFAULT_COLLECT_MAX_DISTANCE = 32;
const DEFAULT_GOTO_STOP_DISTANCE = 1;
const DEFAULT_FOLLOW_STOP_DISTANCE = 3;
const DEFAULT_FOLLOW_TIMEOUT_MS = 30_000;
const MAX_FOLLOW_TIMEOUT_MS = 300_000;
const FOLLOW_POLL_INTERVAL_MS = 250;
const DEFAULT_SCAN_RADIUS = 8;
const MAX_SCAN_RADIUS = 32;
const MAX_SCAN_BLOCKS = 512;
const MAX_NOTABLE_BLOCKS = 10;
const NOTABLE_BLOCK_KEYWORDS = [
  'ore', 'chest', 'spawner', 'furnace', 'crafting_table',
  'anvil', 'enchanting_table', 'bed', 'ancient_debris'
];

class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDeadline<T>(work: Promise<T>, deadline: number | null, message: string): Promise<T> {
  if (deadline === null) {
    return work;
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new OperationTimeoutError(message));
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new OperationTimeoutError(message)), remaining);
    work.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

export function registerCompositeTools(factory: ToolFactory, getBot: () => mineflayer.Bot, actionManager: ActionManager): void {
  factory.registerTool(
    "collect-blocks",
    "Find, path to, and mine multiple blocks of one type, reporting how many were actually collected and why it stopped",
    {
      blockType: z.string().describe("Type of block to collect"),
      count: z.coerce.number().int().positive().optional().describe("How many blocks to collect (default: 1)"),
      maxDistance: z.coerce.number().finite().positive().optional().describe(`Maximum search distance for each block (default: ${DEFAULT_COLLECT_MAX_DISTANCE})`),
      timeoutMs: z.number().int().min(50).optional().describe("Overall timeout in milliseconds (default: no timeout)")
    },
    async ({ blockType, count = 1, maxDistance = DEFAULT_COLLECT_MAX_DISTANCE, timeoutMs }: { blockType: string; count?: number; maxDistance?: number; timeoutMs?: number }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blockDef = mcData.blocksByName[blockType];

      if (!blockDef) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : null;

      const result = await actionManager.run("collect-blocks", undefined, async (ctx) => {
        let collected = 0;

        try {
          while (collected < count) {
            if (ctx.signal.aborted) {
              return `Collected ${collected} of ${count} ${blockType}: interrupted by a new action`;
            }

            if (deadline !== null && Date.now() >= deadline) {
              throw new Error(`Timed out: collected ${collected} of ${count} ${blockType} before timing out`);
            }

            const [targetPos] = bot.findBlocks({
              point: bot.entity.position,
              matching: blockDef.id,
              maxDistance,
              count: 1
            });

            if (!targetPos) {
              return `Collected ${collected} of ${count} ${blockType}: no more found within ${maxDistance} blocks`;
            }

            const goal = new goals.GoalGetToBlock(targetPos.x, targetPos.y, targetPos.z);

            try {
              await raceWithAbort(
                withDeadline(bot.pathfinder.goto(goal), deadline, `Timed out moving to ${blockType}`),
                ctx.signal,
                () => bot.pathfinder.stop()
              );
            } catch (error) {
              if (error instanceof OperationTimeoutError) {
                throw new Error(`Timed out: collected ${collected} of ${count} ${blockType} while moving to the next block`, { cause: error });
              }
              if (ctx.signal.aborted) {
                return `Collected ${collected} of ${count} ${blockType}: interrupted by a new action while moving to the next block`;
              }
              throw new Error(`Collected ${collected} of ${count} ${blockType}: failed to reach block at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) - ${(error as Error).message}`, { cause: error });
            }

            const block = bot.blockAt(targetPos);
            if (!block || block.name !== blockType) {
              continue;
            }

            try {
              await withDeadline(bot.dig(block), deadline, `Timed out digging ${blockType}`);
            } catch (error) {
              if (error instanceof OperationTimeoutError) {
                bot.stopDigging();
                throw new Error(`Timed out: collected ${collected} of ${count} ${blockType} while digging`, { cause: error });
              }
              throw new Error(`Collected ${collected} of ${count} ${blockType}: failed to dig block at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) - ${(error as Error).message}`, { cause: error });
            }

            collected++;
          }

          return `Collected ${collected} of ${count} ${blockType}`;
        } finally {
          bot.pathfinder.stop();
        }
      });

      return result.success ? factory.createResponse(result.message) : factory.createErrorResponse(result.message);
    }
  );

  factory.registerTool(
    "goto-player",
    "Path to a named player and stop within a configurable distance",
    {
      username: z.string().describe("Player username to path to"),
      stopDistance: z.coerce.number().finite().positive().optional().describe(`How close to get to the player (default: ${DEFAULT_GOTO_STOP_DISTANCE})`),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (default: no timeout)")
    },
    async ({ username, stopDistance = DEFAULT_GOTO_STOP_DISTANCE, timeoutMs }: { username: string; stopDistance?: number; timeoutMs?: number }) => {
      const bot = getBot();
      const player = bot.players[username];

      if (!player || !player.entity) {
        return factory.createResponse(`Cannot path to ${username}: player not found or not in render distance`);
      }

      const target = player.entity.position;
      const goal = new goals.GoalNear(target.x, target.y, target.z, stopDistance);
      const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : null;

      const result = await actionManager.run("goto-player", undefined, async (ctx) => {
        try {
          await raceWithAbort(
            withDeadline(bot.pathfinder.goto(goal), deadline, `Timed out pathing to ${username}`),
            ctx.signal,
            () => bot.pathfinder.stop()
          );
          return `Reached ${username} (within ${stopDistance} blocks)`;
        } catch (error) {
          if (error instanceof OperationTimeoutError) {
            throw new Error(`Timed out after ${timeoutMs}ms while pathing to ${username}`, { cause: error });
          }
          if (ctx.signal.aborted) {
            throw new Error(`Interrupted by a new action while pathing to ${username}`, { cause: error });
          }
          throw error;
        } finally {
          bot.pathfinder.stop();
        }
      });

      return result.success ? factory.createResponse(result.message) : factory.createErrorResponse(result.message);
    }
  );

  factory.registerTool(
    "follow-player",
    "Follow a named player continuously until the timeout elapses or the player leaves render distance",
    {
      username: z.string().describe("Player username to follow"),
      stopDistance: z.coerce.number().finite().positive().optional().describe(`Distance to keep from the player (default: ${DEFAULT_FOLLOW_STOP_DISTANCE})`),
      timeoutMs: z.number().int().min(50).max(MAX_FOLLOW_TIMEOUT_MS).optional().describe(`How long to keep following in milliseconds (default: ${DEFAULT_FOLLOW_TIMEOUT_MS}, max: ${MAX_FOLLOW_TIMEOUT_MS})`)
    },
    async ({ username, stopDistance = DEFAULT_FOLLOW_STOP_DISTANCE, timeoutMs = DEFAULT_FOLLOW_TIMEOUT_MS }: { username: string; stopDistance?: number; timeoutMs?: number }) => {
      const bot = getBot();
      const player = bot.players[username];

      if (!player || !player.entity) {
        return factory.createResponse(`Cannot follow ${username}: player not found or not in render distance`);
      }

      const result = await actionManager.run("follow-player", undefined, async (ctx) => {
        const goal = new goals.GoalFollow(player.entity, stopDistance);
        bot.pathfinder.setGoal(goal, true);

        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;

        try {
          while (Date.now() < deadline) {
            if (ctx.signal.aborted) {
              return `Stopped following ${username} after ${Date.now() - startedAt}ms: interrupted by a new action`;
            }

            const current = bot.players[username];
            if (!current || !current.entity) {
              const followedMs = Date.now() - startedAt;
              return `Stopped following ${username} after ${followedMs}ms: player is no longer in range`;
            }
            await sleep(Math.min(FOLLOW_POLL_INTERVAL_MS, deadline - Date.now()));
          }
          return `Followed ${username} for ${timeoutMs}ms, then stopped (timeout reached)`;
        } finally {
          bot.pathfinder.stop();
          bot.pathfinder.setGoal(null);
        }
      });

      return result.success ? factory.createResponse(result.message) : factory.createErrorResponse(result.message);
    }
  );

  factory.registerTool(
    "scan-area",
    "Summarize what is around the bot: block type counts, notable blocks, entities and players. Useful for verifying a build or a spawn area",
    {
      radius: z.coerce.number().finite().positive().optional().describe(`Radius in blocks to scan (default: ${DEFAULT_SCAN_RADIUS}, max: ${MAX_SCAN_RADIUS})`),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds; later scan phases are skipped once it elapses (default: no timeout)")
    },
    async ({ radius = DEFAULT_SCAN_RADIUS, timeoutMs }: { radius?: number; timeoutMs?: number }) => {
      const bot = getBot();
      const clampedRadius = Math.min(radius, MAX_SCAN_RADIUS);
      const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : null;
      const notes: string[] = [];

      const positions = bot.findBlocks({
        point: bot.entity.position,
        matching: (block) => block.name !== 'air',
        maxDistance: clampedRadius,
        count: MAX_SCAN_BLOCKS
      });

      const blockCounts = new Map<string, number>();
      for (const pos of positions) {
        const block = bot.blockAt(pos);
        if (!block) continue;
        blockCounts.set(block.name, (blockCounts.get(block.name) ?? 0) + 1);
      }

      const sortedBlocks = [...blockCounts.entries()].sort((a, b) => b[1] - a[1]);
      const blockSummary = sortedBlocks.length > 0
        ? sortedBlocks.map(([name, n]) => `${name} x${n}`).join(', ')
        : 'none';

      const notableSummary = sortedBlocks
        .filter(([name]) => NOTABLE_BLOCK_KEYWORDS.some((keyword) => name.includes(keyword)))
        .slice(0, MAX_NOTABLE_BLOCKS)
        .map(([name, n]) => `${name} x${n}`)
        .join(', ');

      if (positions.length >= MAX_SCAN_BLOCKS) {
        notes.push(`block scan capped at ${MAX_SCAN_BLOCKS} blocks`);
      }

      let entitySummary = 'skipped (timed out)';
      let playerSummary = 'skipped (timed out)';

      if (deadline === null || Date.now() < deadline) {
        const selfPos = bot.entity.position;
        const entityCounts = new Map<string, number>();
        for (const entity of Object.values(bot.entities)) {
          if (entity.type === 'player') continue;
          if (selfPos.distanceTo(entity.position) > clampedRadius) continue;
          const label = entity.name || entity.type;
          entityCounts.set(label, (entityCounts.get(label) ?? 0) + 1);
        }
        const sortedEntities = [...entityCounts.entries()].sort((a, b) => b[1] - a[1]);
        entitySummary = sortedEntities.length > 0
          ? sortedEntities.map(([name, n]) => `${name} x${n}`).join(', ')
          : 'none';
      } else {
        notes.push('entity scan skipped: timed out');
      }

      if (deadline === null || Date.now() < deadline) {
        const selfPos = bot.entity.position;
        const players = Object.values(bot.players)
          .filter((p) => p.username !== bot.username && p.entity)
          .map((p) => ({ username: p.username, distance: selfPos.distanceTo(p.entity.position) }))
          .filter((p) => p.distance <= clampedRadius)
          .sort((a, b) => a.distance - b.distance);
        playerSummary = players.length > 0
          ? players.map((p) => `${p.username} (${p.distance.toFixed(1)}m)`).join(', ')
          : 'none';
      } else {
        notes.push('player scan skipped: timed out');
      }

      const lines = [
        `Scanned radius ${clampedRadius}: ${positions.length} non-air blocks`,
        `Block types: ${blockSummary}`,
        `Notable blocks: ${notableSummary || 'none'}`,
        `Entities: ${entitySummary}`,
        `Players: ${playerSummary}`
      ];

      if (notes.length > 0) {
        lines.push(`Notes: ${notes.join('; ')}`);
      }

      return factory.createResponse(lines.join('\n'));
    }
  );
}
