import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { WebViewer, attachUiState } from './web-viewer.js';

const SUPPORTED_MINECRAFT_VERSION = '1.21.11';

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

interface BotConfig {
  host: string;
  port: number;
  username: string;
  version?: string;
}

interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyDisconnected = false;
  private hasTarget = false;
  private readonly reconnectDelayMs: number;
  private readonly webViewer = new WebViewer();

  constructor(config: BotConfig, callbacks: ConnectionCallbacks, reconnectDelayMs = 2000) {
    this.config = config;
    this.callbacks = callbacks;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  getWebViewer(): WebViewer {
    return this.webViewer;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    this.bot = this.createAndAttachBot();
    this.state = 'connecting';
    this.isReconnecting = false;
    this.manuallyDisconnected = false;
    this.hasTarget = true;
  }

  private createAndAttachBot(): mineflayer.Bot {
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      plugins: { pathfinder },
      ...(this.config.version ? { version: this.config.version } : {}),
    };

    const bot = mineflayer.createBot(botOptions);
    attachUiState(bot);
    this.registerEventHandlers(bot);
    return bot;
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    bot.once('spawn', async () => {
      this.state = 'connected';
      this.webViewer.rebind(bot);
      this.callbacks.onLog('info', 'Bot spawned in world');

      const mcData = minecraftData(bot.version);
      const defaultMove = new Movements(bot, mcData);
      bot.pathfinder.setMovements(defaultMove);

      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onChatMessage(username, message);
    });

    bot.on('kicked', (reason) => {
      this.callbacks.onLog('error', `Bot was kicked from server: ${this.formatError(reason)}`);
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const errorCode = (err as { code?: string }).code || 'Unknown error';
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.callbacks.onLog('error', `Bot error [${errorCode}]: ${errorMsg}`);

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', (reason) => {
      this.callbacks.onLog('info', `Bot disconnected: ${this.formatError(reason)}`);

      if (this.state === 'connected') {
        this.state = 'disconnected';
      }

      if (this.bot === bot) {
        this.webViewer.rebind(null);
        try {
          bot.removeAllListeners();
          this.bot = null;
          this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
        } catch (err) {
          this.callbacks.onLog('warn', `Error cleaning up bot on end event: ${this.formatError(err)}`);
        }
      }
    });
  }

  attemptReconnect(): void {
    if (this.isReconnecting || this.state === 'connecting') {
      return;
    }

    this.isReconnecting = true;
    this.state = 'connecting';
    this.callbacks.onLog('info', `Attempting to reconnect to Minecraft server in ${this.reconnectDelayMs}ms...`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.bot) {
        try {
          this.bot.removeAllListeners();
          this.bot.quit('Reconnecting...');
          this.callbacks.onLog('info', 'Old bot instance cleaned up');
        } catch (err) {
          this.callbacks.onLog('warn', `Error while cleaning up old bot: ${this.formatError(err)}`);
        }
        this.webViewer.rebind(null);
      }

      this.callbacks.onLog('info', 'Creating new bot instance...');
      this.connect();
    }, this.reconnectDelayMs);
  }

  async connectTo(
    config: BotConfig,
    timeoutMs = 30000
  ): Promise<{ host: string; port: number; username: string; version: string; position: { x: number; y: number; z: number } }> {
    // Detach the old bot before quitting it, so its 'end' handler cannot null/clobber the new this.bot.
    const oldBot = this.bot;
    if (oldBot) {
      oldBot.removeAllListeners();
      try {
        oldBot.quit('Switching servers');
      } catch (err) {
        this.callbacks.onLog('warn', `Error while quitting previous bot: ${this.formatError(err)}`);
      }
    }
    this.webViewer.rebind(null);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
    this.manuallyDisconnected = false;

    this.config = config;
    this.hasTarget = true;

    const bot = this.createAndAttachBot();
    this.bot = bot;
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timeout);
        bot.removeListener('spawn', onSpawn);
        bot.removeListener('error', onFailure);
        bot.removeListener('kicked', onFailure);
        bot.removeListener('end', onFailure);
      };

      const fail = (reason: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        bot.removeAllListeners();
        // On 'end' the handler from registerEventHandlers runs first and has already nulled
        // this.bot, so a null here still means the failed attempt is the current one.
        if (this.bot === bot || this.bot === null) {
          this.bot = null;
          this.state = 'disconnected';
        }
        try {
          bot.quit('Connection failed');
        } catch {
          // bot may not have an open socket yet
        }
        reject(new Error(reason));
      };

      const onSpawn = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const position = bot.entity.position;
        resolve({
          host: config.host,
          port: config.port,
          username: bot.username ?? config.username,
          version: bot.version,
          position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
        });
      };

      const onFailure = (reason: unknown): void => {
        fail(`Failed to connect to ${config.host}:${config.port}: ${this.formatError(reason)}`);
      };

      const timeout = setTimeout(() => {
        fail(`Timed out connecting to ${config.host}:${config.port} after ${timeoutMs}ms`);
      }, timeoutMs);

      bot.once('spawn', onSpawn);
      bot.once('error', onFailure);
      bot.once('kicked', onFailure);
      bot.once('end', onFailure);
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;

    if (this.bot) {
      const bot = this.bot;
      bot.removeAllListeners();
      try {
        bot.quit('Disconnected by request');
      } catch (err) {
        this.callbacks.onLog('warn', `Error while disconnecting bot: ${this.formatError(err)}`);
      }
      this.webViewer.rebind(null);
      this.bot = null;
    }

    this.state = 'disconnected';
    this.manuallyDisconnected = true;
  }

  getConnectionInfo(): { connected: boolean; state: string; host: string | null; port: number | null; username: string | null; version: string | null } {
    const hasTarget = this.hasTarget && !this.manuallyDisconnected;
    return {
      connected: this.isConnected(),
      state: this.state,
      host: hasTarget ? this.config.host : null,
      port: hasTarget ? this.config.port : null,
      username: hasTarget ? this.config.username : null,
      version: this.bot?.version ?? null
    };
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    if (this.manuallyDisconnected || !this.hasTarget) {
      return {
        connected: false,
        message: 'Not connected to any Minecraft server. Use the connect-to-server tool (host, port) to join one.'
      };
    }

    const currentState = this.state;

    if (currentState === 'disconnected') {
      this.attemptReconnect();

      const maxWaitTime = this.reconnectDelayMs + 5000;
      const pollInterval = 100;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        if (this.state === 'connected') {
          return { connected: true };
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      const errorMessage =
        `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}\n\n` +
        `Please ensure:\n` +
        `1. Minecraft server is running on ${this.config.host}:${this.config.port}\n` +
        `2. Server is accessible from this machine\n` +
        `3. Server version is compatible (latest supported: ${SUPPORTED_MINECRAFT_VERSION})\n\n` +
        `For setup instructions, visit: https://github.com/yuniko-software/minecraft-mcp-server`;

      return { connected: false, message: errorMessage };
    }

    if (currentState === 'connecting') {
      return { connected: false, message: 'Bot is connecting to the Minecraft server. Please wait a moment and try again.' };
    }

    return { connected: true };
  }

  cleanup(): void {
    this.webViewer.stop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.bot) {
      const bot = this.bot;
      bot.removeAllListeners();
      try {
        bot.quit('Server shutting down');
      } catch (err) {
        this.callbacks.onLog('warn', `Error during cleanup: ${this.formatError(err)}`);
      }
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
