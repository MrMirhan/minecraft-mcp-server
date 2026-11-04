import fs from "node:fs";
import http from "node:http";
import { recordingPath } from "./recordings.js";
import { serveLive } from "./live.js";
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
  /** Open sessions kept at most; the least recently used one is closed first. Default 32. */
  maxSessions?: number;
  /** A session with no request for this long is closed. Default 15 minutes. */
  sessionIdleMs?: number;
}

const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 15 * 60 * 1000;

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
  // Each session holds its own McpServer with every tool registered. A client that opens a session per call and
  // never ends it (DELETE) would grow the process until it runs out of memory, so sessions are capped and expire.
  // Map order is the use order: a request moves its session to the end.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastSeen = new Map<string, number>();
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  const touch = (id: string): StreamableHTTPServerTransport | undefined => {
    const transport = transports.get(id);
    if (!transport) return undefined;
    transports.delete(id);
    transports.set(id, transport);
    lastSeen.set(id, Date.now());
    return transport;
  };

  const closeSession = (id: string): void => {
    const transport = transports.get(id);
    transports.delete(id);
    lastSeen.delete(id);
    transport?.close().catch(() => undefined);
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, seen] of lastSeen) {
      if (now - seen > idleMs) closeSession(id);
    }
  }, Math.max(50, Math.min(60_000, Math.floor(idleMs / 2))));
  sweep.unref();

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
    const known = sessionId ? touch(sessionId) : undefined;
    if (known) {
      transport = known;
    } else if (!sessionId && isInitializeRequest(body)) {
      // A fresh McpServer is created per session, but every session shares the
      // single process-wide BotConnection captured by createServer().
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          while (transports.size >= maxSessions) {
            const oldest = transports.keys().next().value as string;
            closeSession(oldest);
          }
          transports.set(id, transport);
          lastSeen.set(id, Date.now());
        }
      });
      transport.onclose = () => {
        if (transport.sessionId && transports.get(transport.sessionId) === transport) {
          transports.delete(transport.sessionId);
          lastSeen.delete(transport.sessionId);
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
    const transport = sessionId ? touch(sessionId) : undefined;
    if (!transport) {
      sendJson(res, 400, jsonRpcError(-32000, "Bad Request: missing or unknown session ID"));
      return;
    }
    await transport.handleRequest(req, res);
  };

  // GET streams a recording, DELETE removes it once the caller has its copy.
  const serveRecording = (req: http.IncomingMessage, res: http.ServerResponse, name: string): void => {
    const file = recordingPath(name);
    let size: number;
    try {
      size = file ? fs.statSync(file).size : -1;
    } catch {
      size = -1;
    }
    if (!file || size < 0) {
      sendJson(res, 404, jsonRpcError(-32601, "Not found"));
      return;
    }
    if (req.method === "DELETE") {
      fs.rmSync(file, { force: true });
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, jsonRpcError(-32601, "Method not allowed"));
      return;
    }
    const type = file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": String(size) });
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const pathname = url.split("?")[0];

    if (pathname === "/live") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, jsonRpcError(-32001, "Unauthorized: missing or invalid bearer token"));
        return;
      }
      void serveLive(req, res, log);
      return;
    }

    if (pathname.startsWith("/files/")) {
      if (!isAuthorized(req)) {
        sendJson(res, 401, jsonRpcError(-32001, "Unauthorized: missing or invalid bearer token"));
        return;
      }
      serveRecording(req, res, decodeURIComponent(pathname.slice("/files/".length)));
      return;
    }

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

  server.on('close', () => {
    clearInterval(sweep);
    for (const id of [...transports.keys()]) closeSession(id);
  });
  return server;
}
