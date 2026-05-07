import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FrameworkRegistryStore } from "../../src/framework/registry.js";

let vaultRoot: string;
let store: FrameworkRegistryStore;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-framework-registry-"));
  store = new FrameworkRegistryStore({ vaultRoot });
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("FrameworkRegistryStore", () => {
  test("lists no overlays when registry file is missing", async () => {
    await expect(store.list()).resolves.toEqual([]);
  });

  test("registers overlays sorted by priority then name", async () => {
    await store.register({ name: "work", path: "_meta/overlays/work.yaml", priority: 20 });
    await store.register({ name: "home", path: "_meta/overlays/home.yaml", priority: 10 });

    expect(await store.list()).toEqual([
      { name: "home", path: "_meta/overlays/home.yaml", priority: 10 },
      { name: "work", path: "_meta/overlays/work.yaml", priority: 20 }
    ]);
    expect(JSON.parse(await readFile(join(vaultRoot, "_meta", "schemas.json"), "utf8"))).toEqual({
      overlays: [
        { name: "home", path: "_meta/overlays/home.yaml", priority: 10 },
        { name: "work", path: "_meta/overlays/work.yaml", priority: 20 }
      ]
    });
  });

  test("updates an existing overlay registration by name", async () => {
    await store.register({ name: "work", path: "_meta/overlays/work.yaml", priority: 20 });
    await store.register({ name: "work", path: "_meta/overlays/work-v2.yaml", priority: 5 });

    expect(await store.list()).toEqual([
      { name: "work", path: "_meta/overlays/work-v2.yaml", priority: 5 }
    ]);
  });

  test("unregisters overlays by name", async () => {
    await store.register({ name: "work", path: "_meta/overlays/work.yaml", priority: 20 });

    await expect(store.unregister("work")).resolves.toBe(true);
    await expect(store.unregister("missing")).resolves.toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  test("rejects unsafe overlay paths", async () => {
    await expect(
      store.register({ name: "escape", path: "../outside.yaml", priority: 1 })
    ).rejects.toThrow(/traversal/);
  });
});
