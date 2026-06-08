import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

  test("enforces configured security blocked paths across runtime tools", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "second-brain-runtime-blocked-"));
    const vaultPath = join(tempRoot, "vault");
    const statePath = join(tempRoot, "state");
    await mkdir(join(vaultPath, "Private"), { recursive: true });
    await mkdir(statePath, { recursive: true });
    await writeFile(join(vaultPath, "Private", "Secret.md"), "# Secret\n\nprivate runtime text\n");

    const config = testConfig(vaultPath, statePath);
    config.security.blockedPaths = ["Private/**"];
    const runtime = await createRuntimeToolHandlers(config);
    try {
      await expect(runtime.handlers.read_note?.({ path: "Private/Secret.md" })).rejects.toThrow(
        /Vault path is blocked/
      );
      await expect(
        runtime.handlers.create_note?.({ path: "Private/New.md", content: "blocked" })
      ).rejects.toMatchObject({ code: "path_blocked" });
      expect((await runtime.handlers.search?.({ query: "private" }))?.structuredContent).toEqual({
        result: []
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
      ignoredGlobs: [],
      blockedPaths: []
    },
    security: {
      blockedPaths: []
    },
    deletes: {
      trashPath: ".trash/mcp"
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
