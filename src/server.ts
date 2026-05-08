import http, { IncomingMessage, ServerResponse } from "node:http";

import { buildProtectedResourceMetadata } from "./auth/discovery.js";
import { parseScopes } from "./auth/scopes.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createRuntimeToolHandlers } from "./runtime.js";
import { createToolRegistry, listToolsForScopes, type ToolDefinition } from "./tools/registry.js";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolHandler = (arguments_: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;
export type ToolHandlerMap = Partial<Record<string, ToolHandler>>;

export interface CreateServerOptions {
  config: ServerConfig;
  tools?: readonly ToolDefinition[];
  toolHandlers?: ToolHandlerMap;
}

export function createHttpServer(options: CreateServerOptions): http.Server {
  const tools = options.tools ?? createToolRegistry();
  const toolHandlers = options.toolHandlers ?? {};

  return http.createServer((request, response) => {
    void routeRequest(request, response, options.config, tools, toolHandlers);
  });
}

export async function startHttpServerFromConfigFile(configPath: string): Promise<http.Server> {
  const config = await loadConfig(configPath);
  const runtime = await createRuntimeToolHandlers(config);
  const server = createHttpServer({ config, toolHandlers: runtime.handlers });
  server.on("close", () => runtime.close());
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
  tools: readonly ToolDefinition[],
  toolHandlers: ToolHandlerMap
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

  if (request.method === "POST" && url.pathname === "/mcp") {
    await handleMcpPost(request, response, tools, toolHandlers);
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleMcpPost(
  request: IncomingMessage,
  response: ServerResponse,
  tools: readonly ToolDefinition[],
  toolHandlers: ToolHandlerMap
): Promise<void> {
  let message: JsonRpcRequest;
  try {
    message = parseJsonRpcRequest(await readRequestBody(request));
  } catch {
    sendJson(response, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Parse error"
      }
    });
    return;
  }

  if (!mcpHeadersMatchRequest(request, message)) {
    sendJson(response, 400, {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32600,
        message: "MCP headers do not match JSON-RPC body"
      }
    });
    return;
  }

  if (message.method === "tools/list") {
    const scopes = parseScopes(extractDevelopmentScopeClaim(request.headers.authorization));
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: listToolsForScopes(scopes, tools)
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    await handleToolCall(request, response, message, tools, toolHandlers);
    return;
  }

  sendJson(response, 200, {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: "Method not found"
    }
  });
}

function mcpHeadersMatchRequest(request: IncomingMessage, message: JsonRpcRequest): boolean {
  const methodHeader = singleHeaderValue(request.headers["mcp-method"]);
  if (methodHeader !== undefined && methodHeader !== message.method) {
    return false;
  }

  const expectedName = mcpNameFromRequest(message);
  const nameHeader = singleHeaderValue(request.headers["mcp-name"]);
  if (nameHeader !== undefined && nameHeader !== expectedName) {
    return false;
  }

  return true;
}

function mcpNameFromRequest(message: JsonRpcRequest): string | undefined {
  if (message.method === "tools/call") {
    return parseToolCallParams(message.params)?.name;
  }
  if (message.method === "resources/read" || message.method === "prompts/get") {
    const params = message.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return undefined;
    }
    const key = message.method === "resources/read" ? "uri" : "name";
    const value = (params as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function handleToolCall(
  request: IncomingMessage,
  response: ServerResponse,
  message: JsonRpcRequest,
  tools: readonly ToolDefinition[],
  toolHandlers: ToolHandlerMap
): Promise<void> {
  const params = parseToolCallParams(message.params);
  if (params === undefined) {
    sendJson(response, 200, jsonRpcError(message.id, -32602, "Invalid params"));
    return;
  }

  const tool = tools.find((definition) => definition.name === params.name);
  const handler = toolHandlers[params.name];
  if (tool === undefined || handler === undefined) {
    sendJson(response, 200, jsonRpcError(message.id, -32601, "Method not found"));
    return;
  }

  const scopes = parseScopes(extractDevelopmentScopeClaim(request.headers.authorization));
  if (!scopes.has(tool.requiredScope)) {
    sendJson(response, 200, jsonRpcError(message.id, -32003, "forbidden_scope"));
    return;
  }

  const result = await handler(params.arguments);
  sendJson(response, 200, {
    jsonrpc: "2.0",
    id: message.id,
    result
  });
}

function parseToolCallParams(
  params: unknown
): { name: string; arguments: Record<string, unknown> } | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }
  const arguments_ = (params as { arguments?: unknown }).arguments;
  if (arguments_ === undefined) {
    return { name, arguments: {} };
  }
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    return undefined;
  }
  return { name, arguments: arguments_ as Record<string, unknown> };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): object {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonRpcRequest(source: string): JsonRpcRequest {
  const parsed = JSON.parse(source) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    typeof (parsed as { method?: unknown }).method !== "string"
  ) {
    throw new Error("Invalid JSON-RPC request");
  }
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error("Invalid JSON-RPC request id");
  }
  return parsed as JsonRpcRequest;
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
