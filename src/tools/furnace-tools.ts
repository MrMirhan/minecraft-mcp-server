import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { ActionContext, ActionManager, raceWithAbort } from '../action-manager.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot, actionManager: ActionManager): void {
  factory.registerTool(
    "smelt-item",
    "Smelt items using a furnace-like block",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      inputItem: z.string().trim().min(1).describe("Name of item to smelt"),
      inputCount: z.number().int().positive().optional().describe("Amount of input to smelt (default: 1)"),
      fuelItem: z.string().trim().min(1).describe("Name of fuel item"),
      fuelCount: z.number().int().positive().optional().describe("Amount of fuel to use (default: 1)"),
      takeOutput: z.boolean().optional().describe("Whether to take output when ready (default: true)"),
      timeoutMs: z.number().int().positive().optional().describe("Timeout waiting for output in ms (default: 60000)")
    },
    async ({
      x,
      y,
      z,
      inputItem,
      inputCount = 1,
      fuelItem,
      fuelCount = 1,
      takeOutput = true,
      timeoutMs = 60000
    }: {
      x: number;
      y: number;
      z: number;
      inputItem: string;
      inputCount?: number;
      fuelItem: string;
      fuelCount?: number;
      takeOutput?: boolean;
      timeoutMs?: number;
    }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      const furnacePos = new Vec3(x, y, z);
      const furnaceBlock = bot.blockAt(furnacePos);

      if (!furnaceBlock || !FURNACE_BLOCKS.has(furnaceBlock.name)) {
        return factory.createResponse(`No furnace block found at (${x}, ${y}, ${z})`);
      }

      const items = bot.inventory.items();
      const input = items.find((item) => item.name.includes(inputItem.toLowerCase()));
      if (!input) {
        return factory.createResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
      }

      const fuel = items.find((item) => item.name.includes(fuelItem.toLowerCase()));
      if (!fuel) {
        return factory.createResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
      }

      const resolvedInputCount = Math.min(inputCount, input.count);
      const resolvedFuelCount = Math.min(fuelCount, fuel.count);

      const result = await actionManager.run("smelt-item", timeoutMs, async (ctx) => {
        // These awaits can hang indefinitely (an unreachable furnace never sends its window,
        // a laggy server never acks the slot click). raceWithAbort frees this caller on abort,
        // but cannot cancel mineflayer's own pending promise; it keeps running detached and
        // its eventual result is discarded (see ActionManager.run).
        const furnace = await raceWithAbort(bot.openFurnace(furnaceBlock), ctx.signal, () => undefined);
        const cleanup = () => {
          try {
            furnace.close();
          } catch {
            // ignore
          }
        };

        try {
          const existingInput = furnace.inputItem();
          if (existingInput && existingInput.name !== input.name) {
            return `Furnace input slot is occupied by ${existingInput.name}`;
          }

          const existingFuel = furnace.fuelItem();
          if (existingFuel && existingFuel.name !== fuel.name) {
            return `Furnace fuel slot is occupied by ${existingFuel.name}`;
          }

          await raceWithAbort(furnace.putFuel(fuel.type, fuel.metadata ?? null, resolvedFuelCount), ctx.signal, () => undefined);
          await raceWithAbort(furnace.putInput(input.type, input.metadata ?? null, resolvedInputCount), ctx.signal, () => undefined);

          if (!takeOutput) {
            return `Started smelting ${resolvedInputCount} ${input.name} with ${resolvedFuelCount} ${fuel.name}`;
          }

          try {
            await waitForOutput(furnace, ctx);
            const taken = await furnace.takeOutput();
            return `Smelted ${taken.count} ${taken.name}`;
          } catch {
            return `No output after ${timeoutMs}ms (loaded ${resolvedInputCount} ${input.name} and ${resolvedFuelCount} ${fuel.name} into the furnace)`;
          }
        } finally {
          cleanup();
        }
      });

      return result.success ? factory.createResponse(result.message) : factory.createErrorResponse(result.message);
    }
  );
}

function waitForOutput(furnace: mineflayer.Furnace, ctx: ActionContext): Promise<Item> {
  const existing = furnace.outputItem();
  if (existing) {
    return Promise.resolve(existing);
  }

  return new Promise<Item>((resolve, reject) => {
    const cleanup = (): void => {
      furnace.removeListener('update', onUpdate);
      ctx.signal.removeEventListener('abort', onAbort);
    };

    const onUpdate = (): void => {
      const output = furnace.outputItem();
      if (output) {
        cleanup();
        resolve(output);
      }
    };

    const onAbort = (): void => {
      cleanup();
      reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Smelting interrupted'));
    };

    furnace.on('update', onUpdate);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}
