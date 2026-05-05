import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { VaultIndex } from "../../src/vault/index.js";
import { VaultReader } from "../../src/vault/reader.js";
import { createVaultReadTools } from "../../src/vault/tools.js";

let vaultRoot: string;
let index: VaultIndex;
let reader: VaultReader;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-tools-"));
  await mkdir(join(vaultRoot, "Atlas", "Maps"), { recursive: true });
  await mkdir(join(vaultRoot, "Calendar", "Days"), { recursive: true });
  await writeFile(join(vaultRoot, "Atlas", "Maps", "Home.md"), "# Home\n");
  await writeFile(join(vaultRoot, "Calendar", "Days", "Today.md"), "# Today\n[[Home]] alpaca\n");
  await writeFile(join(vaultRoot, "Calendar", "Days", "Today.sync-conflict-local.md"), "# Conflict\n");

  reader = new VaultReader({ vaultRoot, ignoredGlobs: ["**/*.sync-conflict-*"] });
  index = new VaultIndex({ reader, sqlitePath: ":memory:" });
  await index.rebuild();
});

afterEach(async () => {
  index.close();
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("createVaultReadTools", () => {
  test("adapts reader and index operations to read tools", async () => {
    const tools = createVaultReadTools(reader, index);

    expect((await tools.read_note("Atlas/Maps/Home.md")).parsed.title).toBe("Home");
    expect((await tools.list_folder("", true)).map((entry) => entry.path).sort()).toEqual([
      "Atlas/Maps/Home.md",
      "Calendar/Days/Today.md"
    ]);
    expect(tools.search("alpaca").map((result) => result.path)).toEqual([
      "Calendar/Days/Today.md"
    ]);
    expect(tools.get_outgoing_links("Calendar/Days/Today.md")).toEqual(["Home"]);
    expect(tools.get_backlinks("Home")).toEqual(["Calendar/Days/Today.md"]);
    expect(tools.list_vault_conflicts()).toEqual([
      {
        canonical: "Calendar/Days/Today.md",
        conflicts: ["Calendar/Days/Today.sync-conflict-local.md"]
      }
    ]);
  });
});
