import { ToolFactory } from '../tool-factory.js';
import { BotConnection } from '../bot-connection.js';

export function registerViewerTools(factory: ToolFactory, connection: BotConnection): void {
  factory.registerTool(
    "start-viewer",
    "Start the live web viewer showing the bot's 3D view with a Minecraft UI overlay, returning the URL to open in a browser",
    {},
    async () => {
      const webViewer = connection.getWebViewer();
      const url = await webViewer.start(connection.getBot());
      const warning = webViewer.getVersionWarning();
      return factory.createResponse(warning ? `Web viewer running at ${url}\n${warning}` : `Web viewer running at ${url}`);
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "stop-viewer",
    "Stop the live web viewer and release its port",
    {},
    async () => {
      connection.getWebViewer().stop();
      return factory.createResponse("Web viewer stopped.");
    },
    { skipConnectionCheck: true }
  );

  factory.registerTool(
    "get-viewer-url",
    "Get the URL of the live web viewer, if it is currently running",
    {},
    async () => {
      const url = connection.getWebViewer().getUrl();
      if (!url) {
        return factory.createResponse("The web viewer is not running. Use the start-viewer tool to start it.");
      }
      return factory.createResponse(`Web viewer running at ${url}`);
    },
    { skipConnectionCheck: true }
  );
}
