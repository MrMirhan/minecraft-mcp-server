import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { ActionManager } from '../action-manager.js';

export function registerControlTools(
  factory: ToolFactory,
  getBot: () => mineflayer.Bot,
  actionManager: ActionManager
): void {
  factory.registerTool(
    "stop",
    "Stop whatever action the bot is currently performing",
    {},
    async () => {
      const current = actionManager.getCurrentAction();
      await actionManager.interrupt();

      const bot = getBot();
      try {
        bot.pathfinder.stop();
      } catch {
        // pathfinder may not be initialized yet
      }

      if (!current) {
        return factory.createResponse("Nothing was running");
      }

      return factory.createResponse(`Stopped "${current.label}" (was running for ${current.runningForMs}ms)`);
    }
  );

  factory.registerTool(
    "get-current-action",
    "Get the action the bot is currently performing and how long it has been running",
    {},
    async () => {
      const current = actionManager.getCurrentAction();

      if (!current) {
        return factory.createResponse("No action is currently running");
      }

      return factory.createResponse(`Running "${current.label}" for ${current.runningForMs}ms`);
    }
  );
}
