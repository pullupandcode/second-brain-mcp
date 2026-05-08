import http, { IncomingMessage, ServerResponse } from "node:http";

import { buildProtectedResourceMetadata } from "./auth/discovery.js";
import { parseScopes } from "./auth/scopes.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createToolRegistry, listToolsForScopes, type ToolDefinition } from "./tools/registry.js";

export interface CreateServerOptions {
  config: ServerConfig;
  tools?: readonly ToolDefinition[];
}

export function createHttpServer(options: CreateServerOptions): http.Server {
  const tools = options.tools ?? createToolRegistry();

  return http.createServer((request, response) => {
    void routeRequest(request, response, options.config, tools);
  });
}

export async function startHttpServerFromConfigFile(configPath: string): Promise<http.Server> {
  const config = await loadConfig(configPath);
  const server = createHttpServer({ config });
  const listen = parseListenAddress(config.listen);
  await new Promise<void>((resolve) => {
    server.listen(listen.port, listen.host, resolve);
  });
  return server;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  tools: readonly ToolDefinition[]
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    sendJson(response, 200, buildProtectedResourceMetadata(config));
    return;
  }

  if (request.method === "GET" && url.pathname === "/tools") {
    const scopes = parseScopes(extractDevelopmentScopeClaim(request.headers.authorization));
    sendJson(response, 200, { tools: listToolsForScopes(scopes, tools) });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function extractDevelopmentScopeClaim(authorization: string | undefined): string | undefined {
  const prefix = "Bearer scope=";
  if (authorization?.startsWith(prefix) !== true) {
    return undefined;
  }
  return authorization.slice(prefix.length);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startServerCli(process.argv.slice(2));
}

async function startServerCli(args: string[]): Promise<void> {
  const configPath = parseConfigPathArg(args);
  if (configPath === undefined) {
    console.error("Usage: second-brain-mcp --config <config.toml>");
    process.exitCode = 1;
    return;
  }

  try {
    const server = await startHttpServerFromConfigFile(configPath);
    const address = server.address();
    if (typeof address === "object" && address !== null) {
      console.error(`second-brain-mcp listening on ${address.address}:${address.port}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseConfigPathArg(args: string[]): string | undefined {
  const configIndex = args.indexOf("--config");
  if (configIndex !== -1) {
    return args[configIndex + 1];
  }
  return args[0];
}

function parseListenAddress(listen: string): { host: string; port: number } {
  const separator = listen.lastIndexOf(":");
  if (separator === -1) {
    throw new Error("listen must be formatted as host:port");
  }
  const host = listen.slice(0, separator);
  const port = Number(listen.slice(separator + 1));
  if (host.length === 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("listen must be formatted as host:port");
  }
  return { host, port };
}
