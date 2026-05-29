import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { VaultReader } from "../../src/vault/reader.js";
import { VaultWriteError, VaultWriter } from "../../src/vault/writer.js";

let vaultRoot: string;
let reader: VaultReader;
let writer: VaultWriter;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-writer-"));
  await mkdir(join(vaultRoot, "Notes"), { recursive: true });
  reader = new VaultReader({ vaultRoot, ignoredGlobs: [] });
  writer = new VaultWriter({ vaultRoot, cooldownSeconds: 0 });
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("VaultWriter", () => {
  test("creates a new note with frontmatter", async () => {
    const result = await writer.createNote("Notes/New.md", "Hello", { tags: ["test"], rank: 1 });

    expect(result.path).toBe("Notes/New.md");
    expect(result.resultSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(vaultRoot, "Notes", "New.md"), "utf8")).toBe(
      '---\ntags: ["test"]\nrank: 1\n---\nHello'
    );
  });

  test("rejects creating an existing note", async () => {
    await writer.createNote("Notes/New.md", "Hello");

    await expect(writer.createNote("Notes/New.md", "Again")).rejects.toMatchObject({
      code: "path_exists"
    });
  });

  test("rejects writes to quarantined canonical paths", async () => {
    const quarantinedWriter = new VaultWriter({
      vaultRoot,
      cooldownSeconds: 0,
      quarantinedPaths: new Set(["Notes/Conflict.md"])
    });

    await expect(quarantinedWriter.createNote("Notes/Conflict.md", "blocked")).rejects.toMatchObject({
      code: "path_quarantined"
    });

    await writeFile(join(vaultRoot, "Notes", "Conflict.md"), "existing");
    const base = await reader.readNote("Notes/Conflict.md");
    await expect(
      quarantinedWriter.replaceNote("Notes/Conflict.md", "blocked", base.currentSha256)
    ).rejects.toMatchObject({
      code: "path_quarantined"
    });
  });

  test("replaces a note when base hash matches", async () => {
    await writer.createNote("Notes/New.md", "Hello");
    const base = await reader.readNote("Notes/New.md");

    const result = await writer.replaceNote("Notes/New.md", "Updated", base.currentSha256);

    expect(result.baseSha256).toBe(base.currentSha256);
    expect((await reader.readNote("Notes/New.md")).content).toBe("Updated");
  });

  test("rejects stale base hashes", async () => {
    await writer.createNote("Notes/New.md", "Hello");

    await expect(writer.replaceNote("Notes/New.md", "Updated", "deadbeef")).rejects.toMatchObject({
      code: "retryable_conflict"
    });
  });

  test("rejects writes inside the cooldown window", async () => {
    const cooldownWriter = new VaultWriter({ vaultRoot, cooldownSeconds: 60 });
    await writeFile(join(vaultRoot, "Notes", "New.md"), "Hello");
    const base = await reader.readNote("Notes/New.md");

    await expect(cooldownWriter.replaceNote("Notes/New.md", "Updated", base.currentSha256)).rejects
      .toMatchObject({ code: "retryable_conflict" });
  });

  test("merges frontmatter while preserving the body", async () => {
    await writeFile(join(vaultRoot, "Notes", "New.md"), "---\ntags: [old]\n---\n# Body\n");
    const base = await reader.readNote("Notes/New.md");

    await writer.updateFrontmatter("Notes/New.md", { tags: ["new"], status: "active" }, base.currentSha256);

    expect(await readFile(join(vaultRoot, "Notes", "New.md"), "utf8")).toBe(
      '---\ntags: ["new"]\nstatus: active\n---\n# Body\n'
    );
  });

  test("replaces content between MCP section markers", async () => {
    await writeFile(
      join(vaultRoot, "Notes", "Daily.md"),
      "# Daily\n<!-- mcp:section daily start -->\nold\n<!-- mcp:section daily end -->\nkeep\n"
    );
    const base = await reader.readNote("Notes/Daily.md");

    await writer.replaceSectionByMarker("Notes/Daily.md", "daily", "new", base.currentSha256);

    expect(await readFile(join(vaultRoot, "Notes", "Daily.md"), "utf8")).toBe(
      "# Daily\n<!-- mcp:section daily start -->\nnew\n<!-- mcp:section daily end -->\nkeep\n"
    );
  });

  test("rejects missing MCP markers", async () => {
    await writeFile(join(vaultRoot, "Notes", "Daily.md"), "# Daily\n");
    const base = await reader.readNote("Notes/Daily.md");

    await expect(writer.replaceSectionByMarker("Notes/Daily.md", "daily", "new", base.currentSha256))
      .rejects.toMatchObject({ code: "markers_missing" });
  });

  test("uses typed write errors", async () => {
    await writer.createNote("Notes/New.md", "Hello");

    await expect(writer.createNote("Notes/New.md", "Again")).rejects.toBeInstanceOf(VaultWriteError);
  });
});
