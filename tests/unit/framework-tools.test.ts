import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFrameworkManagementTools } from "../../src/framework/tools.js";
import { FrameworkRegistryStore } from "../../src/framework/registry.js";
import { VaultReader } from "../../src/vault/reader.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-framework-tools-"));
  await mkdir(join(vaultRoot, "_meta", "overlays"), { recursive: true });
  await writeFile(
    join(vaultRoot, "_meta", "framework.yaml"),
    [
      "version: 1",
      "schema_kind: base",
      "framework: custom",
      "types:",
      "  meeting:",
      "    description: Meeting",
      "    folder: Calendar/Records/Meetings"
    ].join("\n")
  );
  await writeFile(
    join(vaultRoot, "_meta", "overlays", "work.yaml"),
    [
      "version: 1",
      "schema_kind: overlay",
      "name: work",
      "types:",
      "  decision:",
      "    description: Decision",
      "    folder: Calendar/Records/Decisions"
    ].join("\n")
  );
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("createFrameworkManagementTools", () => {
  test("registers, lists, unregisters, and composes framework overlays", async () => {
    const tools = createFrameworkManagementTools({
      reader: new VaultReader({ vaultRoot, ignoredGlobs: [] }),
      registry: new FrameworkRegistryStore({ vaultRoot })
    });

    expect(await tools.framework_register({ name: "work", path: "_meta/overlays/work.yaml", priority: 10 }))
      .toEqual([
        { name: "work", path: "_meta/overlays/work.yaml", priority: 10, status: "registered" }
      ]);
    expect(await tools.framework_list()).toEqual([
      { name: "work", path: "_meta/overlays/work.yaml", priority: 10, status: "registered" }
    ]);
    expect((await tools.framework_compose()).types).toEqual({
      meeting: {
        description: "Meeting",
        folder: "Calendar/Records/Meetings"
      },
      decision: {
        description: "Decision",
        folder: "Calendar/Records/Decisions"
      }
    });
    expect(await tools.framework_unregister({ name: "work" })).toEqual({ removed: true });
    expect(await tools.framework_list()).toEqual([]);
  });

  test("reload reports invalid registered overlays", async () => {
    await writeFile(join(vaultRoot, "_meta", "overlays", "broken.yaml"), "version: 1\nschema_kind: overlay\n");
    const tools = createFrameworkManagementTools({
      reader: new VaultReader({ vaultRoot, ignoredGlobs: [] }),
      registry: new FrameworkRegistryStore({ vaultRoot })
    });
    await tools.framework_register({ name: "broken", path: "_meta/overlays/broken.yaml", priority: 1 });

    expect(await tools.framework_reload()).toEqual({
      ok: false,
      overlays: [
        expect.objectContaining({
          name: "broken",
          status: "error",
          error: expect.stringMatching(/types must be an object/)
        })
      ]
    });
  });
});
