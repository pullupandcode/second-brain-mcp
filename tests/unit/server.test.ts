import { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { createHttpServer, startHttpServerFromConfigFile } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";

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

  test("starts an HTTP server from a TOML config file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-server-"));
    try {
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
});

async function startServer(): Promise<string> {
  const server = createHttpServer({ config });
  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
