import http, { IncomingMessage, ServerResponse } from "node:http";

import { buildProtectedResourceMetadata } from "./auth/discovery.js";
import { parseScopes } from "./auth/scopes.js";
import type { ServerConfig } from "./config.js";
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
  console.error("Direct server startup requires config-file loading in a later implementation slice.");
  process.exitCode = 1;
}
