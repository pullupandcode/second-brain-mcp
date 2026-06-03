import { describe, expect, test } from "vitest";

import { buildProtectedResourceMetadata } from "../../src/auth/discovery.js";
import type { ServerConfig } from "../../src/config.js";

const config: ServerConfig = {
  listen: "127.0.0.1:8080",
  publicBaseUrl: new URL("https://second-brain-mcp.example.com"),
  vaultPath: "/vault",
  statePath: "/state",
  auth: {
    mode: "development",
    audience: "second-brain-mcp",
    trustedIssuers: [new URL("https://idp.example.com/application/o/second-brain-mcp-human/")],
    discoveryAuthorizationServer: new URL(
      "https://idp.example.com/application/o/second-brain-mcp-human/"
    ),
    jwksCacheTtlSeconds: 3600,
    jwtAlgorithms: ["RS256"]
  },
  index: {
    sqlitePath: "/state/index.sqlite",
    watcherPolling: false,
    ignoredGlobs: []
  },
  writes: {
    cooldownSeconds: 2
  },
  audit: {
    retentionMaxRows: 0
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

describe("buildProtectedResourceMetadata", () => {
  test("builds OAuth protected-resource metadata from config", () => {
    expect(buildProtectedResourceMetadata(config)).toEqual({
      resource: "https://second-brain-mcp.example.com",
      authorization_servers: ["https://idp.example.com/application/o/second-brain-mcp-human/"],
      scopes_supported: ["vault:read", "vault:write", "vault:capture", "daily:append", "admin"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://second-brain-mcp.example.com/docs"
    });
  });
});
