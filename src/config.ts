import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export type TransportKind = 'stdio' | 'http';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  transport: TransportKind;
  httpPort: number;
  authToken: string | undefined;
  explicitHost: boolean;
}

const DEFAULT_MC_HOST = 'localhost';
const DEFAULT_MC_PORT = 25565;
const DEFAULT_USERNAME = 'LLMBot';
const DEFAULT_HTTP_PORT = 3000;

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function envNumber(name: string): number | undefined {
  const value = envString(name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseConfig(): ServerConfig {
  const argv = yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host (falls back to MC_HOST)'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port (falls back to MC_PORT)'
    })
    .option('username', {
      type: 'string',
      description: 'Bot username (falls back to MC_USERNAME)'
    })
    .option('transport', {
      type: 'string',
      description: 'MCP transport: stdio or http (falls back to MCP_TRANSPORT)'
    })
    .option('http-port', {
      type: 'number',
      description: 'Port for the http transport (falls back to SERVER_PORT then PORT)'
    })
    .option('auth-token', {
      type: 'string',
      description: 'Bearer token required by the http transport (falls back to MCP_AUTH_TOKEN)'
    })
    .help()
    .alias('help', 'h')
    .parseSync();

  const hostFlagPassed = argv.host !== undefined;
  const hostEnv = envString('MC_HOST');

  const host = argv.host ?? hostEnv ?? DEFAULT_MC_HOST;
  const port = argv.port ?? envNumber('MC_PORT') ?? DEFAULT_MC_PORT;
  const username = argv.username ?? envString('MC_USERNAME') ?? DEFAULT_USERNAME;

  const transport = (argv.transport ?? envString('MCP_TRANSPORT') ?? 'stdio') as TransportKind;
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`Invalid transport "${transport}". Expected "stdio" or "http".`);
  }

  const httpPort = argv['http-port'] ?? envNumber('SERVER_PORT') ?? envNumber('PORT') ?? DEFAULT_HTTP_PORT;
  const authToken = argv['auth-token'] ?? envString('MCP_AUTH_TOKEN');

  return {
    host,
    port,
    username,
    transport,
    httpPort,
    authToken,
    explicitHost: hostFlagPassed || hostEnv !== undefined
  };
}
