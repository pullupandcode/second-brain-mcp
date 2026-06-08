import { createHash } from "node:crypto";
import http, { IncomingMessage, ServerResponse } from "node:http";

import { buildProtectedResourceMetadata } from "./auth/discovery.js";
import { AuthError, authenticateRequest, type AuthenticatedRequest } from "./auth/jwt.js";
import type { Scope } from "./auth/scopes.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createRuntimeToolHandlers } from "./runtime.js";
import { createToolRegistry, listToolsForScopes, type ToolDefinition } from "./tools/registry.js";

type JsonRpcId = string | number;
const MAX_REQUEST_BODY_BYTES = 1_000_000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
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

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}

interface JsonObjectSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export type ToolHandler = (arguments_: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;
export type ToolHandlerMap = Partial<Record<string, ToolHandler>>;

export interface OperationalLogEntry {
  ts: string;
  sub: string;
  client_id?: string;
  tool: string;
  args_hash: string;
  args?: Record<string, unknown>;
  result: "ok" | "error" | "forbidden_scope";
  duration_ms: number;
}

export type OperationalLogger = (entry: OperationalLogEntry) => void;

export interface CreateServerOptions {
  config: ServerConfig;
  tools?: readonly ToolDefinition[];
  toolHandlers?: ToolHandlerMap;
  operationalLogger?: OperationalLogger;
}

export function createHttpServer(options: CreateServerOptions): http.Server {
  const tools = options.tools ?? createToolRegistry();
  const toolHandlers = options.toolHandlers ?? {};
  const operationalLogger = options.operationalLogger;

  return http.createServer((request, response) => {
    void routeRequest(request, response, options.config, tools, toolHandlers, operationalLogger);
  });
}

export async function startHttpServerFromConfigFile(configPath: string): Promise<http.Server> {
  const config = await loadConfig(configPath);
  const runtime = await createRuntimeToolHandlers(config);
  const server = createHttpServer({
    config,
    tools: createToolRegistry({ ocrEnabled: config.ocr.enabled }),
    toolHandlers: runtime.handlers,
    operationalLogger: (entry) => {
      console.log(JSON.stringify(entry));
    }
  });
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
  toolHandlers: ToolHandlerMap,
  operationalLogger: OperationalLogger | undefined
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
    const auth = await authenticateHttpRequest(request, response, config);
    if (auth === undefined) {
      return;
    }
    sendJson(response, 200, { tools: listMcpToolsForScopes(auth.scopes, tools) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/mcp") {
    await handleMcpPost(request, response, config, tools, toolHandlers, operationalLogger);
    return;
  }

  if (request.method === "GET" && url.pathname === "/mcp") {
    sendMethodNotAllowed(response, "POST");
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleMcpPost(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  tools: readonly ToolDefinition[],
  toolHandlers: ToolHandlerMap,
  operationalLogger: OperationalLogger | undefined
): Promise<void> {
  let message: JsonRpcRequest;
  try {
    message = parseJsonRpcRequest(await readRequestBody(request));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Request body too large"
        }
      });
      return;
    }
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
    if (message.id === undefined) {
      sendEmpty(response, 202);
      return;
    }
    const auth = await authenticateHttpRequest(request, response, config);
    if (auth === undefined) {
      return;
    }
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: listMcpToolsForScopes(auth.scopes, tools)
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    await handleToolCall(request, response, config, message, tools, toolHandlers, operationalLogger);
    return;
  }

  if (message.method === "initialize") {
    if (message.id === undefined) {
      sendEmpty(response, 202);
      return;
    }
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: readProtocolVersion(message.params),
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "second-brain-mcp",
          version: "0.1.0"
        }
      }
    });
    return;
  }

  const emptyMethodResult = emptyResultForMethod(message.method);
  if (emptyMethodResult !== undefined) {
    if (message.id === undefined) {
      sendEmpty(response, 202);
      return;
    }
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: emptyMethodResult
    });
    return;
  }

  if (message.id === undefined) {
    sendEmpty(response, 202);
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

function emptyResultForMethod(method: string): object | undefined {
  if (method === "ping") {
    return {};
  }
  if (method === "resources/list") {
    return { resources: [] };
  }
  if (method === "resources/templates/list") {
    return { resourceTemplates: [] };
  }
  if (method === "prompts/list") {
    return { prompts: [] };
  }
  return undefined;
}

function listMcpToolsForScopes(
  scopes: ReadonlySet<Scope>,
  tools: readonly ToolDefinition[]
): McpToolDefinition[] {
  return listToolsForScopes(scopes, tools).map(toMcpToolDefinition);
}

function toMcpToolDefinition(tool: ToolDefinition): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchemaForTool(tool)
  };
}

function inputSchemaForTool(tool: ToolDefinition): JsonObjectSchema {
  const schema = namedInputSchemaForTool(tool.name);
  if (schema !== undefined) {
    return schema;
  }

  return emptyInputSchema();
}

function namedInputSchemaForTool(name: string): JsonObjectSchema | undefined {
  if (name === "read_note") {
    return objectInputSchema(["path"], { path: stringProperty("Vault-relative markdown path.") });
  }
  if (name === "create_note") {
    return objectInputSchema(["path", "content"], {
      path: stringProperty("Vault-relative markdown path."),
      content: stringProperty("Full note content."),
      frontmatter: objectProperty("Optional frontmatter fields.")
    });
  }
  if (name === "replace_note") {
    return objectInputSchema(["path", "content", "base_sha256"], {
      path: stringProperty("Vault-relative markdown path."),
      content: stringProperty("Replacement note content."),
      base_sha256: stringProperty("Current note SHA-256 for optimistic concurrency."),
      frontmatter: objectProperty("Optional replacement frontmatter fields.")
    });
  }
  if (name === "delete_note") {
    return objectInputSchema(["path", "base_sha256"], {
      path: stringProperty("Vault-relative markdown path."),
      base_sha256: stringProperty("Current note SHA-256 for optimistic concurrency.")
    });
  }
  if (name === "hard_delete_note") {
    return objectInputSchema(["path", "base_sha256"], {
      path: stringProperty("Vault-relative markdown path."),
      base_sha256: stringProperty("Current note SHA-256 for optimistic concurrency.")
    });
  }
  if (name === "list_folder") {
    return objectInputSchema(["path"], {
      path: stringProperty("Vault-relative folder path. Use an empty string for the vault root."),
      recursive: booleanProperty("Whether to list folders recursively.")
    });
  }
  if (name === "search") {
    return objectInputSchema(["query"], {
      query: stringProperty("Search query."),
      filters: objectProperty("Optional search filters, such as a folder prefix.")
    });
  }
  if (name === "get_backlinks" || name === "get_outgoing_links") {
    return objectInputSchema(["path"], { path: stringProperty("Vault-relative markdown path.") });
  }
  if (name === "update_frontmatter") {
    return objectInputSchema(["path", "patch", "base_sha256"], {
      path: stringProperty("Vault-relative markdown path."),
      patch: objectProperty("Frontmatter keys and values to merge."),
      base_sha256: stringProperty("Current note SHA-256 for optimistic concurrency.")
    });
  }
  if (name === "replace_section_by_marker") {
    return objectInputSchema(["path", "marker_name", "content", "base_sha256"], {
      path: stringProperty("Vault-relative markdown path."),
      marker_name: stringProperty("MCP marker section name."),
      content: stringProperty("Replacement section content."),
      base_sha256: stringProperty("Current note SHA-256 for optimistic concurrency.")
    });
  }
  if (name === "daily_note_append") {
    return dailyNoteAppendInputSchema();
  }
  if (name === "daily_note_get") {
    return objectInputSchema([], {
      date: stringProperty("Optional ISO date. Defaults to today.")
    });
  }
  if (name === "daily_note_repair_markers") {
    return objectInputSchema(["base_sha256"], {
      base_sha256: stringProperty("Current daily note SHA-256 for optimistic concurrency."),
      date: stringProperty("Optional ISO date. Defaults to today.")
    });
  }
  if (name === "capture_for_date" || name === "inbox_capture") {
    return captureInputSchema(name === "inbox_capture");
  }

  if (name === "create_record") {
    return objectInputSchema(["type", "title"], {
      type: stringProperty("Framework record type, such as capture, map, project, or source."),
      title: stringProperty("Record title."),
      date: stringProperty("Optional ISO date or datetime. Defaults to now."),
      body: stringProperty("Optional note body appended after any configured template."),
      fields: objectProperty("Optional frontmatter fields.")
    });
  }
  if (name === "find_maps") {
    return objectInputSchema([], {
      topic: stringProperty("Optional topic query.")
    });
  }
  if (name === "link_to_page") {
    return objectInputSchema(["notebook", "page_uuid"], {
      notebook: stringProperty("Notebook UUID or identifier."),
      page_uuid: stringProperty("Page UUID.")
    });
  }
  if (name === "framework_init") {
    return objectInputSchema(["framework"], {
      framework: enumStringProperty(["lyt", "para", "zettel"], "Framework preset to initialize."),
      output_path: stringProperty("Optional vault-relative schema output path."),
      mode: enumStringProperty(["create", "overwrite"], "Optional initialization mode.")
    });
  }
  if (name === "framework_register") {
    return objectInputSchema(["name", "path"], {
      name: stringProperty("Overlay name."),
      path: stringProperty("Vault-relative overlay schema path."),
      priority: integerProperty("Optional overlay priority. Lower values load first.")
    });
  }
  if (name === "framework_unregister") {
    return objectInputSchema(["name"], {
      name: stringProperty("Overlay name to unregister.")
    });
  }
  if (name === "ocr_notebook") {
    return objectInputSchema(["identifier"], {
      identifier: stringProperty("Notebook identifier."),
      pages: integerArrayProperty("Optional page numbers to OCR."),
      force: booleanProperty("Whether to force a new OCR job.")
    });
  }
  if (name === "ocr_status") {
    return objectInputSchema(["job_id"], {
      job_id: stringProperty("OCR job id.")
    });
  }
  if (name === "ocr_renumber_notebook") {
    return objectInputSchema(["notebook_id"], {
      notebook_id: stringProperty("Notebook id to renumber.")
    });
  }

  return undefined;
}

function emptyInputSchema(): JsonObjectSchema {
  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
}

function objectInputSchema(
  required: string[],
  properties: Record<string, unknown>
): JsonObjectSchema {
  return {
    type: "object",
    ...(required.length === 0 ? {} : { required }),
    properties,
    additionalProperties: false
  };
}

function stringProperty(description: string): object {
  return { type: "string", description };
}

function booleanProperty(description: string): object {
  return { type: "boolean", description };
}

function integerProperty(description: string): object {
  return { type: "integer", description };
}

function objectProperty(description: string): object {
  return { type: "object", description };
}

function integerArrayProperty(description: string): object {
  return {
    type: "array",
    items: { type: "integer" },
    description
  };
}

function enumStringProperty(values: string[], description: string): object {
  return { type: "string", enum: values, description };
}

function dailyNoteAppendInputSchema(): JsonObjectSchema {
  return {
    type: "object",
    required: ["content", "base_sha256"],
    properties: {
      content: {
        type: "string",
        description: "Markdown content to append to the daily note section."
      },
      base_sha256: {
        type: "string",
        description: "Current daily note SHA-256 for optimistic concurrency."
      },
      date: {
        type: "string",
        description: "Optional ISO date. Defaults to today."
      },
      section: {
        type: "string",
        description: "Optional configured daily note section name."
      }
    },
    additionalProperties: false
  };
}

function captureInputSchema(includeStrategy: boolean): JsonObjectSchema {
  return {
    type: "object",
    required: ["content", "source_client"],
    properties: {
      content: {
        type: "string",
        description: "Markdown content to capture."
      },
      source_client: {
        type: "string",
        description: "Client or integration creating the capture."
      },
      date: {
        type: "string",
        description: "Optional ISO date or datetime. Defaults to now."
      },
      source_id: {
        type: "string",
        description: "Optional stable source identifier for deduplication."
      },
      capture_type: {
        type: "string",
        description: "Optional capture category."
      },
      title: {
        type: "string",
        description: "Optional capture title."
      },
      ...(includeStrategy
        ? {
            strategy: {
              type: "string",
              enum: ["create", "replace_by_source_id"],
              description: "Optional inbox capture strategy."
            }
          }
        : {})
    },
    additionalProperties: false
  };
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
  config: ServerConfig,
  message: JsonRpcRequest,
  tools: readonly ToolDefinition[],
  toolHandlers: ToolHandlerMap,
  operationalLogger: OperationalLogger | undefined
): Promise<void> {
  const startedAt = Date.now();
  const params = parseToolCallParams(message.params);
  if (message.id === undefined) {
    sendEmpty(response, 202);
    return;
  }
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

  const auth = await authenticateHttpRequest(request, response, config);
  if (auth === undefined) {
    return;
  }
  if (!auth.scopes.has(tool.requiredScope)) {
    logToolCall(operationalLogger, config, auth, params, "forbidden_scope", startedAt);
    sendJson(response, 200, jsonRpcError(message.id, -32003, "forbidden_scope"));
    return;
  }

  let result: McpToolResult;
  try {
    result = await handler(params.arguments);
  } catch (error) {
    logToolCall(operationalLogger, config, auth, params, "error", startedAt);
    sendJson(
      response,
      200,
      jsonRpcError(
        message.id,
        -32602,
        sanitizeToolErrorMessage(error, config)
      )
    );
    return;
  }

  logToolCall(operationalLogger, config, auth, params, "ok", startedAt);
  sendJson(response, 200, {
    jsonrpc: "2.0",
    id: message.id,
    result
  });
}

function logToolCall(
  operationalLogger: OperationalLogger | undefined,
  config: ServerConfig,
  auth: AuthenticatedRequest,
  params: { name: string; arguments: Record<string, unknown> },
  result: OperationalLogEntry["result"],
  startedAt: number
): void {
  if (operationalLogger === undefined) {
    return;
  }
  operationalLogger({
    ts: new Date().toISOString(),
    sub: auth.subject,
    ...(auth.clientId === undefined ? {} : { client_id: auth.clientId }),
    tool: params.name,
    args_hash: hashArguments(params.arguments),
    ...(config.logging.logArgs ? { args: params.arguments } : {}),
    result,
    duration_ms: Math.max(0, Date.now() - startedAt)
  });
}

function hashArguments(arguments_: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(arguments_)).digest("hex")}`;
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

function sanitizeToolErrorMessage(error: unknown, config: ServerConfig): string {
  if (!(error instanceof Error)) {
    return "Tool call failed";
  }
  const message = error.message;
  if (sensitivePaths(config).some((sensitivePath) => message.includes(sensitivePath))) {
    return "Tool call failed";
  }
  return message;
}

function sensitivePaths(config: ServerConfig): string[] {
  return [
    config.vaultPath,
    config.statePath,
    config.index.sqlitePath,
    config.audit.archivePath
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function readProtocolVersion(params: unknown): string {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return "2025-03-26";
  }
  const protocolVersion = (params as Record<string, unknown>).protocolVersion;
  return typeof protocolVersion === "string" && protocolVersion.length > 0
    ? protocolVersion
    : "2025-03-26";
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string): object {
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
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
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
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    throw new Error("Invalid JSON-RPC request id");
  }
  return parsed as JsonRpcRequest;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

async function authenticateHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig
): Promise<AuthenticatedRequest | undefined> {
  try {
    return await authenticateRequest(request.headers, config);
  } catch (error) {
    if (error instanceof AuthError) {
      sendAuthError(response, error);
      return undefined;
    }
    throw error;
  }
}

function sendAuthError(response: ServerResponse, error: AuthError): void {
  response.writeHead(error.statusCode, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": `Bearer error="${error.code}", error_description="${sanitizeHeaderValue(
      error.message
    )}"`
  });
  response.end(JSON.stringify({ error: error.code, message: error.message }));
}

function sanitizeHeaderValue(value: string): string {
  return value.replaceAll('"', "'").replaceAll(/[\r\n]/g, " ");
}

function sendEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode);
  response.end();
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, {
    allow
  });
  response.end();
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
