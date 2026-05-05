import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { VaultIndex } from "../../src/vault/index.js";
import { VaultReader } from "../../src/vault/reader.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-index-"));
  await mkdir(join(vaultRoot, "Calendar", "Days"), { recursive: true });
  await mkdir(join(vaultRoot, "Atlas", "Maps"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Calendar", "Days", "2026-05-05.md"),
    `---
tags: [daily]
source_id: daily-2026-05-05
aliases: [Today]
---
# Today

The alpaca project links to [[Home]].
`
  );
  await writeFile(
    join(vaultRoot, "Atlas", "Maps", "Home.md"),
    `---
tags: [map]
---
# Home

Back home.
`
  );
  await writeFile(
    join(vaultRoot, "Calendar", "Days", "2026-05-05.sync-conflict-local.md"),
    "# Conflict\n"
  );
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("VaultIndex", () => {
  test("rebuilds and searches markdown notes", async () => {
    const index = await buildIndex();

    expect(index.search("alpaca").map((result) => result.path)).toEqual([
      "Calendar/Days/2026-05-05.md"
    ]);
    expect(index.search("home", { folder: "Atlas" }).map((result) => result.path)).toEqual([
      "Atlas/Maps/Home.md"
    ]);
    expect(index.search("", { tag: "daily" }).map((result) => result.path)).toEqual([
      "Calendar/Days/2026-05-05.md"
    ]);
    expect(index.findBySourceId("daily-2026-05-05")).toBe("Calendar/Days/2026-05-05.md");
    expect(index.getOutgoingLinks("Calendar/Days/2026-05-05.md")).toEqual(["Home"]);
    expect(index.getBacklinks("Home")).toEqual(["Calendar/Days/2026-05-05.md"]);

    index.close();
  });

  test("lists conflict quarantine state", async () => {
    const index = await buildIndex();

    expect(index.listConflicts()).toEqual([
      {
        canonical: "Calendar/Days/2026-05-05.md",
        conflicts: ["Calendar/Days/2026-05-05.sync-conflict-local.md"]
      }
    ]);

    index.close();
  });
});

async function buildIndex(): Promise<VaultIndex> {
  const reader = new VaultReader({
    vaultRoot,
    ignoredGlobs: ["**/*.sync-conflict-*"]
  });
  const index = new VaultIndex({ reader, sqlitePath: ":memory:" });
  await index.rebuild();
  return index;
}
