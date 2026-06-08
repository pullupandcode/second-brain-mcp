import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { VaultIndex } from "../../src/vault/index.js";
import { VaultWriteAuditStore } from "../../src/vault/audit.js";
import { VaultReader } from "../../src/vault/reader.js";
import { createVaultReadTools, createVaultWriteTools } from "../../src/vault/tools.js";
import { VaultWriteError, VaultWriter } from "../../src/vault/writer.js";

let vaultRoot: string;
let index: VaultIndex;
let reader: VaultReader;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-tools-"));
  await mkdir(join(vaultRoot, "Atlas", "Maps"), { recursive: true });
  await mkdir(join(vaultRoot, "Calendar", "Days"), { recursive: true });
  await mkdir(join(vaultRoot, "rm", "Notebook"), { recursive: true });
  await writeFile(join(vaultRoot, "Atlas", "Maps", "Home.md"), "# Home\n");
  await writeFile(join(vaultRoot, "Calendar", "Days", "Today.md"), "# Today\n[[Home]] alpaca\n");
  await writeFile(join(vaultRoot, "Calendar", "Days", "Today.sync-conflict-local.md"), "# Conflict\n");
  await writeFile(
    join(vaultRoot, "rm", "Notebook", "p1-def-page.md"),
    `---
source: remarkable
source_id: rmpage:abc-notebook:def-page-uuid
aliases: [def-page, Page 1]
---
# Page 1
`
  );

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
      "Calendar/Days/Today.md",
      "rm/Notebook/p1-def-page.md"
    ]);
    expect(tools.search("alpaca").map((result) => result.path)).toEqual([
      "Calendar/Days/Today.md"
    ]);
    expect(tools.get_outgoing_links("Calendar/Days/Today.md")).toEqual(["Home"]);
    expect(tools.get_backlinks("Home")).toEqual(["Calendar/Days/Today.md"]);
    expect(tools.link_to_page("rmnotebook:abc-notebook", "def-page-uuid")).toBe(
      "[[rm/Notebook/p1-def-page.md|def-page-uuid]]"
    );
    expect(tools.link_to_page("rmnotebook:abc-notebook", "missing-page")).toBeUndefined();
    expect(tools.list_vault_conflicts()).toEqual([
      {
        canonical: "Calendar/Days/Today.md",
        conflicts: ["Calendar/Days/Today.sync-conflict-local.md"]
      }
    ]);
  });
});

describe("createVaultWriteTools", () => {
  test("adapts primitive write operations and records audit rows", async () => {
    const writer = new VaultWriter({ vaultRoot, cooldownSeconds: 0 });
    const audit = new VaultWriteAuditStore({ sqlitePath: ":memory:" });
    const tools = createVaultWriteTools(writer, audit);

    const created = await tools.create_note("Inbox/New.md", "Hello", { tags: ["capture"] });
    expect(await readFile(join(vaultRoot, "Inbox", "New.md"), "utf8")).toBe(
      '---\ntags: ["capture"]\n---\nHello'
    );

    const replaced = await tools.replace_note("Inbox/New.md", "Updated", created.resultSha256);
    expect(await readFile(join(vaultRoot, "Inbox", "New.md"), "utf8")).toBe("Updated");

    const frontmatterUpdated = await tools.update_frontmatter(
      "Inbox/New.md",
      { status: "processed" },
      replaced.resultSha256
    );
    expect(await readFile(join(vaultRoot, "Inbox", "New.md"), "utf8")).toBe(
      '---\nstatus: "processed"\n---\nUpdated'
    );

    await writeFile(
      join(vaultRoot, "Inbox", "Marked.md"),
      "Before\n<!-- mcp:section capture start -->\nold\n<!-- mcp:section capture end -->\nAfter"
    );
    const markerBase = await new VaultReader({ vaultRoot, ignoredGlobs: [] }).readNote("Inbox/Marked.md");
    await tools.replace_section_by_marker(
      "Inbox/Marked.md",
      "capture",
      "new",
      markerBase.currentSha256
    );
    const markedAfterReplace = await new VaultReader({
      vaultRoot,
      ignoredGlobs: []
    }).readNote("Inbox/Marked.md");
    await tools.delete_note("Inbox/Marked.md", markedAfterReplace.currentSha256);
    await tools.hard_delete_note("Inbox/New.md", frontmatterUpdated.resultSha256);

    expect(audit.listRecentWrites().map((row) => row.operation)).toEqual([
      "hard_delete_note",
      "delete_note",
      "replace_section_by_marker",
      "update_frontmatter",
      "replace_note",
      "create_note"
    ]);
    expect(audit.listRecentWrites().map((row) => row.path)).toEqual([
      "Inbox/New.md",
      "Inbox/Marked.md",
      "Inbox/Marked.md",
      "Inbox/New.md",
      "Inbox/New.md",
      "Inbox/New.md"
    ]);

    audit.close();
  });

  test("does not record failed writes and treats audit failures as best effort", async () => {
    const writer = new VaultWriter({ vaultRoot, cooldownSeconds: 0 });
    const audit = new VaultWriteAuditStore({ sqlitePath: ":memory:" });
    const tools = createVaultWriteTools(writer, audit);

    const created = await tools.create_note("Inbox/Failure.md", "Hello");
    await expect(tools.replace_note("Inbox/Failure.md", "Updated", "stale")).rejects.toMatchObject({
      code: "retryable_conflict"
    } satisfies Partial<VaultWriteError>);
    expect(audit.listRecentWrites().map((row) => row.operation)).toEqual(["create_note"]);
    expect(audit.listIncompleteWrites()).toEqual([]);
    audit.close();

    const closedAudit = new VaultWriteAuditStore({ sqlitePath: ":memory:" });
    closedAudit.close();
    const bestEffortTools = createVaultWriteTools(writer, closedAudit);

    await expect(bestEffortTools.replace_note("Inbox/Failure.md", "Updated", created.resultSha256)).resolves.toEqual(
      expect.objectContaining({
        path: "Inbox/Failure.md"
      })
    );
    expect(await readFile(join(vaultRoot, "Inbox", "Failure.md"), "utf8")).toBe("Updated");
  });
});
