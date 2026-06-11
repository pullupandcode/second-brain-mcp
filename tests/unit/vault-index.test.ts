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

  test("excludes security blocked paths from search, links, source lookup, and conflicts", async () => {
    await mkdir(join(vaultRoot, "Private"), { recursive: true });
    await writeFile(
      join(vaultRoot, "Private", "Secret.md"),
      `---
tags: [secret]
source_id: private-secret
---
# Secret

The private alpaca plan links to [[Home]].
`
    );
    await writeFile(
      join(vaultRoot, "Private", "Secret.sync-conflict-local.md"),
      "# Private conflict\n"
    );
    const index = await buildIndex(["Private/**"]);

    expect(index.search("private").map((result) => result.path)).toEqual([]);
    expect(index.search("", { tag: "secret" }).map((result) => result.path)).toEqual([]);
    expect(index.findBySourceId("private-secret")).toBeUndefined();
    expect(index.getBacklinks("Home")).toEqual(["Calendar/Days/2026-05-05.md"]);
    expect(index.listConflicts()).toEqual([
      {
        canonical: "Calendar/Days/2026-05-05.md",
        conflicts: ["Calendar/Days/2026-05-05.sync-conflict-local.md"]
      }
    ]);

    index.close();
  });

  test("filters blocked paths at query time even if stale rows exist", async () => {
    const index = await buildIndex(["AIOS/**"]);
    seedIndexedNote(index, {
      path: "AIOS/Maps/Skill Map.md",
      title: "Skill Map",
      content: "Approved skills include [[AIOS/Skills/Coach]].",
      tags: ["skills"],
      aliases: [],
      sourceId: "skill-map",
      sha256: "stale-map"
    });
    seedIndexedLink(index, "AIOS/Maps/Skill Map.md", "Home");

    expect(index.search("Approved").map((result) => result.path)).toEqual([]);
    expect(index.search("", { tag: "skills" }).map((result) => result.path)).toEqual([]);
    expect(index.findBySourceId("skill-map")).toBeUndefined();
    expect(index.getBacklinks("Home")).toEqual(["Calendar/Days/2026-05-05.md"]);

    index.close();
  });
});

async function buildIndex(blockedPaths: string[] = []): Promise<VaultIndex> {
  const reader = new VaultReader({
    vaultRoot,
    ignoredGlobs: ["**/*.sync-conflict-*"],
    blockedPaths
  });
  const index = new VaultIndex({ reader, sqlitePath: ":memory:" });
  await index.rebuild();
  return index;
}

function seedIndexedNote(
  index: VaultIndex,
  note: {
    path: string;
    title: string;
    content: string;
    tags: string[];
    aliases: string[];
    sourceId: string;
    sha256: string;
  }
): void {
  (
    index as unknown as {
      insertNote(
        path: string,
        title: string,
        content: string,
        tags: string[],
        aliases: string[],
        sourceId: string,
        sha256: string
      ): void;
    }
  ).insertNote(
    note.path,
    note.title,
    note.content,
    note.tags,
    note.aliases,
    note.sourceId,
    note.sha256
  );
}

function seedIndexedLink(index: VaultIndex, sourcePath: string, target: string): void {
  (
    index as unknown as {
      db: {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
        };
      };
    }
  ).db.prepare("INSERT INTO links (source_path, target) VALUES (?, ?)").run(sourcePath, target);
}
