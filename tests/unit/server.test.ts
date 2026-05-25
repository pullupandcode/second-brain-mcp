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
  ocr: {
    enabled: false
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

  test("wires config-backed frontmatter and marker write tools into JSON-RPC tools/call", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-write-extensions-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
      const auditPath = join(statePath, "write-audit.sqlite");
      await mkdir(join(vaultPath, "Inbox"), { recursive: true });
      await mkdir(statePath, { recursive: true });
      await writeFile(
        join(vaultPath, "Inbox", "Section.md"),
        [
          "---",
          "title: Section",
          "---",
          "# Section",
          "",
          "<!-- mcp:section capture start -->",
          "old capture",
          "<!-- mcp:section capture end -->"
        ].join("\n")
      );
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

      const readBeforeFrontmatter = await callTool(baseUrl, "read_note", {
        path: "Inbox/Section.md"
      });
      const frontmatterResponse = await callTool(baseUrl, "update_frontmatter", {
        path: "Inbox/Section.md",
        patch: { status: "reviewed", tags: ["phase-5"] },
        base_sha256: readBeforeFrontmatter.result.structuredContent.currentSha256
      });

      expect(frontmatterResponse.response.status).toBe(200);
      expect(frontmatterResponse.result.structuredContent.path).toBe("Inbox/Section.md");
      expect(await readFile(join(vaultPath, "Inbox", "Section.md"), "utf8")).toContain(
        "status: reviewed"
      );

      const readBeforeMarker = await callTool(baseUrl, "read_note", {
        path: "Inbox/Section.md"
      });
      const markerResponse = await callTool(baseUrl, "replace_section_by_marker", {
        path: "Inbox/Section.md",
        marker_name: "capture",
        content: "new capture",
        base_sha256: readBeforeMarker.result.structuredContent.currentSha256
      });

      expect(markerResponse.response.status).toBe(200);
      expect(markerResponse.result.structuredContent.path).toBe("Inbox/Section.md");
      expect(await readFile(join(vaultPath, "Inbox", "Section.md"), "utf8")).toContain(
        "<!-- mcp:section capture start -->\nnew capture\n<!-- mcp:section capture end -->"
      );

      const audit = new VaultWriteAuditStore({ sqlitePath: auditPath });
      try {
        expect(audit.listRecentWrites().map((row) => row.operation)).toEqual([
          "replace_section_by_marker",
          "update_frontmatter"
        ]);
      } finally {
        audit.close();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wires config-backed framework record tools into JSON-RPC tools/call", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-record-runtime-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
      const auditPath = join(statePath, "write-audit.sqlite");
      await mkdir(join(vaultPath, "_meta"), { recursive: true });
      await mkdir(join(vaultPath, "Calendar", "Records", "Captures"), { recursive: true });
      await mkdir(statePath, { recursive: true });
      await writeFile(
        join(vaultPath, "_meta", "framework.yaml"),
        [
          "version: 1",
          "schema_kind: base",
          "framework: custom",
          "types:",
          "  meeting:",
          "    description: Meeting",
          "    folder: Calendar/Records/Meetings",
          "    filename: \"{date:YYYY-MM-DD} [{title}].md\"",
          "  capture:",
          "    description: Capture",
          "    folder: Calendar/Records/Captures",
          "    filename: \"{date:YYYY-MM-DD HH-mm} [{title}].md\""
        ].join("\n")
      );
      await writeFile(
        join(vaultPath, "Calendar", "Records", "Captures", "2026-05-08 14-00 [Page 1].md"),
        [
          "---",
          "type: capture",
          "title: Page 1",
          "date: 2026-05-08",
          "source_client: rmocr",
          "source_id: rmpage:notebook:page-1",
          "---",
          "Original OCR"
        ].join("\n")
      );
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

      const typeResponse = await callTool(baseUrl, "list_record_types", {}, "vault:read");

      expect(typeResponse.response.status).toBe(200);
      expect(typeResponse.result.structuredContent.recordTypes).toEqual([
        { name: "capture", folder: "Calendar/Records/Captures", description: "Capture" },
        { name: "meeting", folder: "Calendar/Records/Meetings", description: "Meeting" }
      ]);

      const createResponse = await callTool(
        baseUrl,
        "create_record",
        {
          type: "meeting",
          title: "Planning",
          date: "2026-05-08T15:30:00Z",
          body: "Decision log",
          fields: { attendees: ["[[Ada]]"] }
        },
        "vault:write"
      );

      expect(createResponse.response.status).toBe(200);
      expect(createResponse.result.structuredContent.path).toBe(
        "Calendar/Records/Meetings/2026-05-08 [Planning].md"
      );
      const meetingPath = join(
        vaultPath,
        "Calendar",
        "Records",
        "Meetings",
        "2026-05-08 [Planning].md"
      );
      expect(await readFile(meetingPath, "utf8")).toContain("Decision log");

      const captureResponse = await callTool(
        baseUrl,
        "capture_for_date",
        {
          content: "Remember the MCP runtime.",
          date: "2026-05-08T16:45:00Z",
          source_client: "codex",
          source_id: "msg-123",
          capture_type: "idea",
          title: "Runtime capture"
        },
        "vault:capture"
      );

      expect(captureResponse.response.status).toBe(200);
      expect(captureResponse.result.structuredContent.path).toBe(
        "Calendar/Records/Captures/2026-05-08 16-45 [Runtime capture].md"
      );

      const replaceResponse = await callTool(
        baseUrl,
        "inbox_capture",
        {
          content: "Updated OCR",
          date: "2026-05-08T17:00:00Z",
          source_client: "rmocr",
          source_id: "rmpage:notebook:page-1",
          strategy: "replace_by_source_id",
          title: "Page 1 revised"
        },
        "vault:capture"
      );

      expect(replaceResponse.response.status).toBe(200);
      expect(replaceResponse.result.structuredContent.path).toBe(
        "Calendar/Records/Captures/2026-05-08 14-00 [Page 1].md"
      );
      const replacedCapturePath = join(
        vaultPath,
        "Calendar",
        "Records",
        "Captures",
        "2026-05-08 14-00 [Page 1].md"
      );
      expect(await readFile(replacedCapturePath, "utf8")).toContain("Updated OCR");

      const audit = new VaultWriteAuditStore({ sqlitePath: auditPath });
      try {
        expect(audit.listRecentWrites().map((row) => row.operation)).toEqual([
          "replace_note",
          "create_note",
          "create_note"
        ]);
      } finally {
        audit.close();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wires config-backed framework management tools into JSON-RPC tools/call", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-framework-runtime-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
      await mkdir(join(vaultPath, "_meta", "overlays"), { recursive: true });
      await mkdir(statePath, { recursive: true });
      await writeFile(
        join(vaultPath, "_meta", "overlays", "work.yaml"),
        [
          "version: 1",
          "schema_kind: overlay",
          "name: work",
          "types:",
          "  decision:",
          "    description: Decision",
          "    folder: Calendar/Records/Decisions",
          "    filename: \"{date:YYYY-MM-DD} [{title}].md\""
        ].join("\n")
      );
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

      const initResponse = await callTool(
        baseUrl,
        "framework_init",
        { framework: "lyt" },
        "admin"
      );

      expect(initResponse.response.status).toBe(200);
      expect(initResponse.result.structuredContent).toMatchObject({
        path: "_meta/framework.yaml",
        framework: "lyt",
        created: true,
        overwritten: false
      });

      const registerResponse = await callTool(
        baseUrl,
        "framework_register",
        { name: "work", path: "_meta/overlays/work.yaml", priority: 5 },
        "admin"
      );

      expect(registerResponse.response.status).toBe(200);
      expect(registerResponse.result.structuredContent.result).toEqual([
        {
          name: "work",
          path: "_meta/overlays/work.yaml",
          priority: 5,
          status: "registered"
        }
      ]);

      const composeResponse = await callTool(baseUrl, "framework_compose", {}, "admin");

      expect(composeResponse.response.status).toBe(200);
      expect(composeResponse.result.structuredContent.types).toMatchObject({
        decision: {
          description: "Decision",
          folder: "Calendar/Records/Decisions"
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wires config-backed OCR tools into JSON-RPC tools/call when enabled", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-ocr-runtime-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
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

[ocr]
enabled = true

[logging]
log_args = false
`
      );

      const server = await startHttpServerFromConfigFile(configPath);
      servers.push(server);
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const listResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer scope=admin",
          "content-type": "application/json",
          "mcp-method": "tools/list"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ocr-list",
          method: "tools/list"
        })
      });
      const listBody = (await listResponse.json()) as {
        result: { tools: Array<{ name: string }> };
      };

      expect(listResponse.status).toBe(200);
      expect(listBody.result.tools.map((tool) => tool.name)).toContain("ocr_notebook");

      const queueResponse = await callTool(
        baseUrl,
        "ocr_notebook",
        { identifier: "rmnotebook:abc", pages: [1, 2], force: true },
        "admin"
      );

      expect(queueResponse.response.status).toBe(200);
      expect(queueResponse.result.structuredContent).toMatchObject({
        state: "queued",
        type: "notebook"
      });
      expect(typeof queueResponse.result.structuredContent.job_id).toBe("string");

      const statusResponse = await callTool(
        baseUrl,
        "ocr_status",
        { job_id: queueResponse.result.structuredContent.job_id },
        "admin"
      );

      expect(statusResponse.response.status).toBe(200);
      expect(statusResponse.result.structuredContent).toMatchObject({
        state: "queued",
        type: "notebook",
        input: {
          identifier: "rmnotebook:abc",
          pages: [1, 2],
          force: true
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wires config-backed daily note tools into JSON-RPC tools/call", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-daily-runtime-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
      await mkdir(join(vaultPath, "Calendar", "Days"), { recursive: true });
      await mkdir(join(vaultPath, "x", "Templates"), { recursive: true });
      await mkdir(statePath, { recursive: true });
      await writeFile(
        join(vaultPath, "x", "Templates", "Daily Template.md"),
        [
          "# today's agenda",
          "<!-- mcp:section agenda start -->",
          "<!-- mcp:section agenda end -->",
          "",
          "# daily log",
          "<!-- mcp:section daily-captures start -->",
          "<!-- mcp:section daily-captures end -->",
          "",
          "# last light",
          "<!-- mcp:section last-light-summary start -->",
          "<!-- mcp:section last-light-summary end -->"
        ].join("\n")
      );
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

      const getResponse = await callTool(
        baseUrl,
        "daily_note_get",
        { date: "2026-05-25T09:30:00Z" },
        "vault:read"
      );

      expect(getResponse.response.status).toBe(200);
      expect(getResponse.result.structuredContent.path).toBe("Calendar/Days/2026-05-25.md");
      expect(await readFile(join(vaultPath, "Calendar", "Days", "2026-05-25.md"), "utf8"))
        .toContain("<!-- mcp:section daily-captures start -->");

      const appendResponse = await callTool(
        baseUrl,
        "daily_note_append",
        {
          date: "2026-05-25T09:30:00Z",
          section: "daily-log",
          content: "- captured through runtime",
          base_sha256: getResponse.result.structuredContent.currentSha256
        },
        "daily:append"
      );

      expect(appendResponse.response.status).toBe(200);
      expect(await readFile(join(vaultPath, "Calendar", "Days", "2026-05-25.md"), "utf8"))
        .toContain(
          "<!-- mcp:section daily-captures start -->\n- captured through runtime\n<!-- mcp:section daily-captures end -->"
        );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wires config-backed map and structure tools into JSON-RPC tools/call", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-structure-runtime-"));
    try {
      const vaultPath = join(tempRoot, "vault");
      const statePath = join(tempRoot, "state");
      await mkdir(join(vaultPath, "_meta"), { recursive: true });
      await mkdir(join(vaultPath, "Atlas", "Maps"), { recursive: true });
      await mkdir(join(vaultPath, "Calendar", "Records", "Captures"), { recursive: true });
      await mkdir(statePath, { recursive: true });
      await writeFile(
        join(vaultPath, "_meta", "framework.yaml"),
        [
          "version: 1",
          "schema_kind: base",
          "framework: custom",
          "types:",
          "  map:",
          "    description: Map of content",
          "    folder: Atlas/Maps",
          "    filename: \"{title}.md\"",
          "  capture:",
          "    description: Capture",
          "    folder: Calendar/Records/Captures",
          "    filename: \"{title}.md\""
        ].join("\n")
      );
      await writeFile(
        join(vaultPath, "Atlas", "Maps", "Home.md"),
        [
          "---",
          "tags: [map]",
          "---",
          "# Home",
          "",
          "Alpaca planning hub."
        ].join("\n")
      );
      await writeFile(
        join(vaultPath, "Atlas", "Maps", "People.md"),
        "# People\n\nRelationship index.\n"
      );
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

      const mapsResponse = await callTool(
        baseUrl,
        "find_maps",
        { topic: "alpaca" },
        "vault:read"
      );

      expect(mapsResponse.response.status).toBe(200);
      expect(mapsResponse.result.structuredContent.maps).toEqual([
        {
          path: "Atlas/Maps/Home.md",
          title: "Home",
          tags: ["map"],
          aliases: [],
          currentSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      ]);

      const structureResponse = await callTool(baseUrl, "get_vault_structure", {}, "vault:read");

      expect(structureResponse.response.status).toBe(200);
      expect(structureResponse.result.structuredContent.folders).toEqual([
        { path: "_meta", type: "directory" },
        { path: "Atlas", type: "directory" },
        { path: "Calendar", type: "directory" }
      ]);
      expect(structureResponse.result.structuredContent.recordTypes).toEqual([
        { name: "capture", folder: "Calendar/Records/Captures", description: "Capture" },
        { name: "map", folder: "Atlas/Maps", description: "Map of content" }
      ]);
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

async function callTool(
  baseUrl: string,
  name: string,
  arguments_: Record<string, unknown>,
  scopes = "vault:read vault:write"
): Promise<{
  response: Response;
  result: { structuredContent: Record<string, unknown> };
}> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer scope=${scopes}`,
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: arguments_ }
    })
  });

  const body = (await response.json()) as {
    result: { structuredContent: Record<string, unknown> };
  };
  return { response, ...body };
}
