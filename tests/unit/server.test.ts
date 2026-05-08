import { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { createHttpServer, startHttpServerFromConfigFile } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import type { ToolHandlerMap } from "../../src/server.js";
import { VaultWriteAuditStore } from "../../src/vault/audit.js";

const config: ServerConfig = {
  listen: "127.0.0.1:0",
  publicBaseUrl: new URL("https://second-brain-mcp.example.com"),
  vaultPath: "/vault",
  statePath: "/state",
  auth: {
    audience: "second-brain-mcp",
    trustedIssuers: [new URL("https://idp.example.com/application/o/second-brain-mcp-human/")],
    discoveryAuthorizationServer: new URL(
      "https://idp.example.com/application/o/second-brain-mcp-human/"
    ),
    jwksCacheTtlSeconds: 3600
  },
  index: {
    sqlitePath: "/state/index.sqlite",
    watcherPolling: false,
    ignoredGlobs: []
  },
  writes: {
    cooldownSeconds: 2
  },
  dailyNote: {
    captureDefaultPattern: "B"
  },
  logging: {
    logArgs: false
  }
};

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        })
    )
  );
});

describe("createHttpServer", () => {
  test("serves health status", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("serves OAuth protected-resource metadata", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: "https://second-brain-mcp.example.com",
      authorization_servers: ["https://idp.example.com/application/o/second-brain-mcp-human/"]
    });
  });

  test("serves scope-filtered tools from development bearer token", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/tools`, {
      headers: {
        authorization: "Bearer scope=vault:read daily:append"
      }
    });
    const body = (await response.json()) as { tools: Array<{ name: string }> };
    const names = body.tools.map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(names).toContain("read_note");
    expect(names).toContain("daily_note_append");
    expect(names).not.toContain("create_note");
  });

  test("returns 404 for unknown routes", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("serves JSON-RPC tools/list over the MCP endpoint", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer scope=vault:read daily:append",
        "content-type": "application/json",
        "mcp-method": "tools/list"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    });
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(names).toContain("read_note");
    expect(names).toContain("daily_note_append");
    expect(names).not.toContain("create_note");
  });

  test("dispatches JSON-RPC tools/call to registered handlers", async () => {
    const baseUrl = await startServer({
      read_note: async (arguments_) => ({
        content: [{ type: "text", text: JSON.stringify(arguments_) }],
        structuredContent: { ok: true }
      })
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer scope=vault:read",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "read_note"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        method: "tools/call",
        params: { name: "read_note", arguments: { path: "Inbox/Test.md" } }
      })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      result: {
        content: [{ type: "text", text: '{"path":"Inbox/Test.md"}' }],
        structuredContent: { ok: true }
      }
    });
  });

  test("rejects JSON-RPC tools/call without the required scope", async () => {
    const baseUrl = await startServer({
      read_note: async () => ({
        content: [{ type: "text", text: "should not run" }]
      })
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer scope=vault:capture",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "read_note"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request-2",
        method: "tools/call",
        params: { name: "read_note", arguments: { path: "Inbox/Test.md" } }
      })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "request-2",
      error: {
        code: -32003,
        message: "forbidden_scope"
      }
    });
  });

  test("returns JSON-RPC method errors for unsupported MCP methods", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "resources/read"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request-3",
        method: "resources/read",
        params: { uri: "file:///missing.md" }
      })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "request-3",
      error: {
        code: -32601,
        message: "Method not found"
      }
    });
  });

  test("rejects MCP requests when standard headers do not match the JSON-RPC body", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "wrong_tool"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "header-mismatch",
        method: "tools/call",
        params: { name: "read_note", arguments: {} }
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "header-mismatch",
      error: {
        code: -32600,
        message: "MCP headers do not match JSON-RPC body"
      }
    });
  });

  test("starts an HTTP server from a TOML config file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-server-"));
    try {
      await mkdir(join(tempRoot, "vault"), { recursive: true });
      await mkdir(join(tempRoot, "state"), { recursive: true });
      const configPath = join(tempRoot, "config.toml");
      await writeFile(
        configPath,
        `
listen = "127.0.0.1:0"
public_base_url = "https://second-brain-mcp.example.com"
vault_path = "${tempRoot}/vault"
state_path = "${tempRoot}/state"

[auth]
audience = "second-brain-mcp"
trusted_issuers = ["https://idp.example.com/application/o/second-brain-mcp-human/"]
discovery_authorization_server = "https://idp.example.com/application/o/second-brain-mcp-human/"
jwks_cache_ttl_seconds = 3600

[index]
watcher_polling = false
ignored_globs = ["**/*.sync-conflict-*"]

[writes]
cooldown_seconds = 0

[daily_note]
capture_default_pattern = "A"

[logging]
log_args = false
`
      );

      const server = await startHttpServerFromConfigFile(configPath);
      servers.push(server);
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const health = await fetch(`${baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wires config-backed read tools into JSON-RPC tools/call", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-runtime-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
      await mkdir(join(vaultPath, "Inbox"), { recursive: true });
      await mkdir(statePath, { recursive: true });
      await writeFile(join(vaultPath, "Inbox", "Hello.md"), "# Hello\n\nruntime read\n");
      const configPath = join(tempRoot, "config.toml");
      await writeFile(
        configPath,
        `
listen = "127.0.0.1:0"
public_base_url = "https://second-brain-mcp.example.com"
vault_path = "${vaultPath}"
state_path = "${statePath}"

[auth]
audience = "second-brain-mcp"
trusted_issuers = ["https://idp.example.com/application/o/second-brain-mcp-human/"]
discovery_authorization_server = "https://idp.example.com/application/o/second-brain-mcp-human/"
jwks_cache_ttl_seconds = 3600

[index]
watcher_polling = false
ignored_globs = ["**/*.sync-conflict-*"]

[writes]
cooldown_seconds = 0

[daily_note]
capture_default_pattern = "A"

[logging]
log_args = false
`
      );

      const server = await startHttpServerFromConfigFile(configPath);
      servers.push(server);
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer scope=vault:read",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "read_note"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "read_note", arguments: { path: "Inbox/Hello.md" } }
        })
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 10,
        result: {
          content: [{ type: "text", text: expect.stringContaining("runtime read") }],
          structuredContent: {
            path: "Inbox/Hello.md",
            parsed: {
              title: "Hello"
            }
          }
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wires config-backed write tools into JSON-RPC tools/call with audit", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-write-runtime-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
      const auditPath = join(statePath, "write-audit.sqlite");
      await mkdir(vaultPath, { recursive: true });
      await mkdir(statePath, { recursive: true });
      const configPath = join(tempRoot, "config.toml");
      await writeFile(
        configPath,
        `
listen = "127.0.0.1:0"
public_base_url = "https://second-brain-mcp.example.com"
vault_path = "${vaultPath}"
state_path = "${statePath}"

[auth]
audience = "second-brain-mcp"
trusted_issuers = ["https://idp.example.com/application/o/second-brain-mcp-human/"]
discovery_authorization_server = "https://idp.example.com/application/o/second-brain-mcp-human/"
jwks_cache_ttl_seconds = 3600

[index]
watcher_polling = false
ignored_globs = ["**/*.sync-conflict-*"]

[writes]
cooldown_seconds = 0

[daily_note]
capture_default_pattern = "A"

[logging]
log_args = false
`
      );

      const server = await startHttpServerFromConfigFile(configPath);
      servers.push(server);
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const createResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer scope=vault:write",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "create_note"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "create",
          method: "tools/call",
          params: {
            name: "create_note",
            arguments: {
              path: "Inbox/Written.md",
              content: "Written from runtime",
              frontmatter: { source: "test" }
            }
          }
        })
      });
      const createBody = (await createResponse.json()) as {
        result: { structuredContent: { resultSha256: string } };
      };

      expect(createResponse.status).toBe(200);
      expect(await readFile(join(vaultPath, "Inbox", "Written.md"), "utf8")).toBe(
        "---\nsource: test\n---\nWritten from runtime"
      );

      const replaceResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer scope=vault:write",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "replace_note"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "replace",
          method: "tools/call",
          params: {
            name: "replace_note",
            arguments: {
              path: "Inbox/Written.md",
              content: "Replaced from runtime",
              base_sha256: createBody.result.structuredContent.resultSha256
            }
          }
        })
      });

      expect(replaceResponse.status).toBe(200);
      expect(await readFile(join(vaultPath, "Inbox", "Written.md"), "utf8")).toBe(
        "Replaced from runtime"
      );

      const audit = new VaultWriteAuditStore({ sqlitePath: auditPath });
      try {
        expect(audit.listRecentWrites().map((row) => row.operation)).toEqual([
          "replace_note",
          "create_note"
        ]);
      } finally {
        audit.close();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function startServer(toolHandlers: ToolHandlerMap = {}): Promise<string> {
  const server = createHttpServer({ config, toolHandlers });
  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
