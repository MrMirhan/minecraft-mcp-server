import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { ActionManager, ActionResult, raceWithAbort } from '../action-manager.js';

const FLIGHT_TIMEOUT_MS = 20000;

function respondToAction(factory: ToolFactory, result: ActionResult) {
  if (result.interrupted) {
    return { content: [{ type: 'text' as const, text: `Interrupted: ${result.message}` }], isError: true };
  }
  return result.success ? factory.createResponse(result.message) : factory.createErrorResponse(result.message);
}

export function registerFlightTools(factory: ToolFactory, getBot: () => mineflayer.Bot, actionManager: ActionManager): void {
  factory.registerTool(
    "fly-to",
    "Make the bot fly to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      if (!bot.creative) {
        return factory.createResponse("Creative mode is not available. Cannot fly.");
      }

      const destination = new Vec3(x, y, z);

      const result = await actionManager.run("fly-to", FLIGHT_TIMEOUT_MS, async (ctx) => {
        try {
          await raceWithAbort(bot.creative.flyTo(destination), ctx.signal, () => bot.creative.stopFlying());
          return `Successfully flew to position (${x}, ${y}, ${z}).`;
        } finally {
          bot.creative.stopFlying();
        }
      });

      if (result.timedout) {
        const currentPosAfterTimeout = bot.entity.position;
        return factory.createErrorResponse(
          `Flight timed out after ${FLIGHT_TIMEOUT_MS / 1000} seconds. The destination may be unreachable. ` +
          `Current position: (${Math.floor(currentPosAfterTimeout.x)}, ${Math.floor(currentPosAfterTimeout.y)}, ${Math.floor(currentPosAfterTimeout.z)})`
        );
      }

      return respondToAction(factory, result);
    }
  );
}
