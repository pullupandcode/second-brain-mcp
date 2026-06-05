import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { VaultReader } from "../../src/vault/reader.js";

let vaultRoot: string;
let outsideRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-reader-"));
  outsideRoot = await mkdtemp(join(tmpdir(), "second-brain-reader-outside-"));
  await mkdir(join(vaultRoot, "Calendar", "Days"), { recursive: true });
  await mkdir(join(vaultRoot, "Atlas", "Maps"), { recursive: true });
  await mkdir(join(vaultRoot, ".second-brain"), { recursive: true });
  await mkdir(join(vaultRoot, ".trash"), { recursive: true });

  await writeFile(
    join(vaultRoot, "Calendar", "Days", "2026-05-05.md"),
    `---
tags: [daily]
---
# Today

Linked to [[Home]].
`
  );
  await writeFile(join(vaultRoot, "Atlas", "Maps", "Home.md"), "# Home\n");
  await writeFile(join(vaultRoot, ".second-brain", "workspace.json"), "{}");
  await writeFile(join(vaultRoot, ".trash", "Deleted.md"), "# Deleted\n");
  await writeFile(join(vaultRoot, "Calendar", "Days", "conflict.sync-conflict-abc.md"), "# Conflict\n");
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

describe("VaultReader", () => {
  test("reads notes with parsed markdown and SHA-256", async () => {
    const reader = new VaultReader({
      vaultRoot,
      ignoredGlobs: [".second-brain/**", ".trash/**", "**/*.sync-conflict-*"]
    });

    const result = await reader.readNote("Calendar/Days/2026-05-05.md");

    expect(result.path).toBe("Calendar/Days/2026-05-05.md");
    expect(result.content).toContain("# Today");
    expect(result.currentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.parsed.title).toBe("Today");
    expect(result.parsed.tags).toEqual(["daily"]);
  });

  test("lists folders recursively while skipping ignored paths", async () => {
    const reader = new VaultReader({
      vaultRoot,
      ignoredGlobs: [".second-brain/**", ".trash/**", "**/*.sync-conflict-*"]
    });

    const entries = await reader.listFolder("", { recursive: true });
    const paths = entries.map((entry) => entry.path).sort();

    expect(paths).toEqual(["Atlas/Maps/Home.md", "Calendar/Days/2026-05-05.md"]);
  });

  test("rejects traversal reads", async () => {
    const reader = new VaultReader({ vaultRoot, ignoredGlobs: [] });

    await expect(reader.readNote("../outside.md")).rejects.toThrow(/traversal/);
  });

  test("rejects reads through symlinks outside the vault", async () => {
    await writeFile(join(outsideRoot, "Secret.md"), "# Secret\n");
    await symlink(join(outsideRoot, "Secret.md"), join(vaultRoot, "Leak.md"));
    const reader = new VaultReader({ vaultRoot, ignoredGlobs: [] });

    await expect(reader.readNote("Leak.md")).rejects.toThrow(/outside the vault root/);
  });
});
