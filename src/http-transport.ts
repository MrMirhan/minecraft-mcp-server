import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MCP_PATH = "/mcp";

export interface HttpTransportOptions {
  port: number;
  authToken: string | undefined;
  createServer: () => McpServer;
  log: (level: string, message: string) => void;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    req.on("error", reject);
  });
}

export function startHttpTransport(options: HttpTransportOptions): http.Server {
  const { port, authToken, createServer, log } = options;
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  if (!authToken) {
    log('warn', `${MCP_PATH} endpoint is running WITHOUT authentication (set MCP_AUTH_TOKEN to require a bearer token).`);
  }

  const isAuthorized = (req: http.IncomingMessage): boolean => {
    if (!authToken) {
      return true;
    }
    const actual = req.headers.authorization;
    if (actual === undefined) {
      return false;
    }
    const expected = `Bearer ${authToken}`;
    if (Buffer.byteLength(actual) !== Buffer.byteLength(expected)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  };

  const handlePost = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, jsonRpcError(-32700, "Parse error: invalid JSON body"));
      return;
    }

    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(body)) {
      // A fresh McpServer is created per session, but every session shares the
      // single process-wide BotConnection captured by createServer().
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };
      const server = createServer();
      await server.connect(transport);
    } else {
      sendJson(res, 400, jsonRpcError(-32000, "Bad Request: no valid session ID provided"));
      return;
    }

    await transport.handleRequest(req, res, body);
  };

  const handleSessionRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      sendJson(res, 400, jsonRpcError(-32000, "Bad Request: missing or unknown session ID"));
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const pathname = url.split("?")[0];

    if (pathname !== MCP_PATH) {
      sendJson(res, 404, jsonRpcError(-32601, "Not found"));
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, jsonRpcError(-32001, "Unauthorized: missing or invalid bearer token"));
      return;
    }

    const handler =
      req.method === "POST" ? handlePost
      : req.method === "GET" || req.method === "DELETE" ? handleSessionRequest
      : null;

    if (!handler) {
      sendJson(res, 405, jsonRpcError(-32601, "Method not allowed"));
      return;
    }

    handler(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log('error', `Error handling ${req.method} ${MCP_PATH}: ${message}`);
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(-32603, "Internal server error"));
      }
    });
  });

  server.listen(port, () => {
    log('info', `Listening on port ${port} (MCP Streamable HTTP at ${MCP_PATH})`);
  });

  return server;
}
