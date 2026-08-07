import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { ActionManager, ActionResult, raceWithAbort } from '../action-manager.js';

type Direction = 'forward' | 'back' | 'left' | 'right';

function respondToAction(factory: ToolFactory, result: ActionResult) {
  if (result.interrupted) {
    return { content: [{ type: 'text' as const, text: `Interrupted: ${result.message}` }], isError: true };
  }
  return result.success ? factory.createResponse(result.message) : factory.createErrorResponse(result.message);
}

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot, actionManager: ActionManager): void {
  factory.registerTool(
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const bot = getBot();
      const position = bot.entity.position;
      const pos = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      };
      return factory.createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-to-position",
    "Move the bot to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      range: z.coerce.number().finite().optional().describe("How close to get to the target (default: 1)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (min: 50, default: no timeout)")
    },
    async ({ x, y, z, range = 1, timeoutMs }: { x: number; y: number; z: number; range?: number; timeoutMs?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const goal = new goals.GoalNear(x, y, z, range);

      const result = await actionManager.run("move-to-position", timeoutMs, async (ctx) => {
        const gotoPromise = bot.pathfinder.goto(goal);
        await raceWithAbort(gotoPromise, ctx.signal, () => bot.pathfinder.stop());
        return `Successfully moved to position near (${x}, ${y}, ${z})`;
      });

      if (result.timedout) {
        return factory.createErrorResponse(`Move timed out after ${timeoutMs}ms`);
      }
      return respondToAction(factory, result);
    }
  );

  factory.registerTool(
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      await bot.lookAt(new Vec3(x, y, z), true);
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "jump",
    "Make the bot jump",
    {},
    async () => {
      const bot = getBot();
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      return factory.createResponse("Successfully jumped");
    }
  );

  factory.registerTool(
    "move-in-direction",
    "Move the bot in a specific direction for a duration",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move"),
      duration: z.number().optional().describe("Duration in milliseconds (default: 1000)")
    },
    async ({ direction, duration = 1000 }: { direction: Direction, duration?: number }) => {
      const bot = getBot();

      const result = await actionManager.run(`move-in-direction:${direction}`, undefined, async (ctx) => {
        return new Promise<string>((resolve) => {
          const startedAt = Date.now();
          bot.setControlState(direction, true);

          const finish = (message: string): void => {
            bot.setControlState(direction, false);
            clearTimeout(timer);
            ctx.signal.removeEventListener('abort', onAbort);
            resolve(message);
          };

          const onAbort = (): void => finish(`Stopped moving ${direction} after ${Date.now() - startedAt}ms`);
          ctx.signal.addEventListener('abort', onAbort, { once: true });

          const timer = setTimeout(() => finish(`Moved ${direction} for ${duration}ms`), duration);
        });
      });

      return respondToAction(factory, result);
    }
  );
}
