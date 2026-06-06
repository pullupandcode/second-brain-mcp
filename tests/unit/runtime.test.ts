import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { ServerConfig } from "../../src/config.js";
import { createRuntimeToolHandlers } from "../../src/runtime.js";
import { VaultWriteAuditStore } from "../../src/vault/audit.js";

describe("createRuntimeToolHandlers", () => {
  test("exposes write recovery diagnostics from persisted audit attempts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-runtime-diagnostics-"));
    const vaultPath = join(tempRoot, "vault");
    const statePath = join(tempRoot, "state");
    await mkdir(vaultPath, { recursive: true });
    await mkdir(statePath, { recursive: true });

    const audit = new VaultWriteAuditStore({ sqlitePath: join(statePath, "write-audit.sqlite") });
    const attemptId = audit.recordWriteStarted({
      operation: "replace_note",
      path: "Inbox/Interrupted.md",
      baseSha256: "before"
    });
    audit.close();

    const runtime = await createRuntimeToolHandlers(testConfig(vaultPath, statePath));
    try {
      const result = await runtime.handlers.list_write_recovery_diagnostics?.({});

      expect(result?.structuredContent).toEqual({
        incompleteWrites: [
          expect.objectContaining({
            attemptId,
            operation: "replace_note",
            path: "Inbox/Interrupted.md",
            baseSha256: "before"
          })
        ]
      });
    } finally {
      runtime.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function testConfig(vaultPath: string, statePath: string): ServerConfig {
  return {
    listen: "127.0.0.1:0",
    publicBaseUrl: new URL("https://second-brain-mcp.example.com"),
    vaultPath,
    statePath,
    auth: {
      mode: "development",
      audience: "second-brain-mcp",
      trustedIssuers: [new URL("https://idp.example.com/application/o/second-brain-mcp-human/")],
      discoveryAuthorizationServer: new URL(
        "https://idp.example.com/application/o/second-brain-mcp-human/"
      ),
      jwksCacheTtlSeconds: 3600,
      jwtAlgorithms: ["RS256"],
      developmentDefaultScopes: []
    },
    index: {
      sqlitePath: ":memory:",
      watcherPolling: false,
      ignoredGlobs: []
    },
    writes: {
      cooldownSeconds: 0
    },
    dailyNote: {
      captureDefaultPattern: "A"
    },
    audit: {
      retentionMaxRows: 0
    },
    framework: {
      schemaPath: "_meta/framework.yaml"
    },
    ocr: {
      enabled: false
    },
    logging: {
      logArgs: false
    }
  };
}
