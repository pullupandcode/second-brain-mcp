import { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { createHttpServer } from "../../src/server.js";
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
