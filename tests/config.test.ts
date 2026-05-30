import test from 'ava';
import { parseConfig } from '../src/config.js';

test('parseConfig returns default values', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js'];
  
  const config = parseConfig();
  
  t.is(config.host, 'localhost');
  t.is(config.port, 25565);
  t.is(config.username, 'LLMBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses custom host', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--host', 'example.com'];
  
  const config = parseConfig();
  
  t.is(config.host, 'example.com');
  t.is(config.port, 25565);
  t.is(config.username, 'LLMBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses custom port', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--port', '12345'];
  
  const config = parseConfig();
  
  t.is(config.host, 'localhost');
  t.is(config.port, 12345);
  t.is(config.username, 'LLMBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses custom username', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--username', 'CustomBot'];
  
  const config = parseConfig();
  
  t.is(config.host, 'localhost');
  t.is(config.port, 25565);
  t.is(config.username, 'CustomBot');
  
  process.argv = originalArgv;
});

test('parseConfig parses all custom options', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--host', 'server.net', '--port', '9999', '--username', 'TestBot'];
  
  const config = parseConfig();
  
  t.is(config.host, 'server.net');
  t.is(config.port, 9999);
  t.is(config.username, 'TestBot');
  
  process.argv = originalArgv;
});

test('parseConfig handles numeric port as number type', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--port', '30000'];

  const config = parseConfig();

  t.is(typeof config.port, 'number');
  t.is(config.port, 30000);

  process.argv = originalArgv;
});

const TRANSPORT_ENV = ['MCP_TRANSPORT', 'SERVER_PORT', 'PORT', 'MCP_AUTH_TOKEN', 'MC_HOST', 'MC_PORT', 'MC_USERNAME'];

function withCleanEnv(fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of TRANSPORT_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const key of TRANSPORT_ENV) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

test.serial('parseConfig defaults transport to stdio and httpPort to 3000', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js'];
  withCleanEnv(() => {
    const config = parseConfig();
    t.is(config.transport, 'stdio');
    t.is(config.httpPort, 3000);
    t.is(config.authToken, undefined);
    t.false(config.explicitHost);
  });
  process.argv = originalArgv;
});

test.serial('parseConfig --transport http sets http transport', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--transport', 'http', '--http-port', '8080', '--auth-token', 'abc'];
  withCleanEnv(() => {
    const config = parseConfig();
    t.is(config.transport, 'http');
    t.is(config.httpPort, 8080);
    t.is(config.authToken, 'abc');
  });
  process.argv = originalArgv;
});

test.serial('parseConfig reads env fallbacks for transport, port, token and host', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js'];
  withCleanEnv(() => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.SERVER_PORT = '4567';
    process.env.MCP_AUTH_TOKEN = 'envtoken';
    process.env.MC_HOST = 'mc.example.com';
    process.env.MC_PORT = '12345';
    process.env.MC_USERNAME = 'EnvBot';

    const config = parseConfig();
    t.is(config.transport, 'http');
    t.is(config.httpPort, 4567);
    t.is(config.authToken, 'envtoken');
    t.is(config.host, 'mc.example.com');
    t.is(config.port, 12345);
    t.is(config.username, 'EnvBot');
    t.true(config.explicitHost);
  });
  process.argv = originalArgv;
});

test.serial('parseConfig SERVER_PORT takes precedence over PORT', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js'];
  withCleanEnv(() => {
    process.env.SERVER_PORT = '5000';
    process.env.PORT = '6000';
    const config = parseConfig();
    t.is(config.httpPort, 5000);
  });
  process.argv = originalArgv;
});

test.serial('parseConfig CLI host flag wins over MC_HOST env', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--host', 'cli.example.com'];
  withCleanEnv(() => {
    process.env.MC_HOST = 'env.example.com';
    const config = parseConfig();
    t.is(config.host, 'cli.example.com');
    t.true(config.explicitHost);
  });
  process.argv = originalArgv;
});

test.serial('parseConfig throws on invalid transport value', (t) => {
  const originalArgv = process.argv;
  process.argv = ['node', 'script.js', '--transport', 'websocket'];
  withCleanEnv(() => {
    t.throws(() => parseConfig(), { message: /Invalid transport/ });
  });
  process.argv = originalArgv;
});
