import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadVaultSkills } from "../../src/skills/loader.js";
import { VaultReader } from "../../src/vault/reader.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-skills-"));
  await mkdir(join(vaultRoot, "Atlas", "Maps"), { recursive: true });
  await mkdir(join(vaultRoot, "Skills"), { recursive: true });
  await mkdir(join(vaultRoot, "Private"), { recursive: true });
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("loadVaultSkills", () => {
  test("loads valid skills linked from configured maps", async () => {
    await writeFile(
      join(vaultRoot, "Atlas", "Maps", "Skills.md"),
      [
        "# Skills",
        "",
        "- [[Skills/Research Assistant]]",
        "- [Planning](../../Skills/Planning.md)",
        "- [[Skills/Not A Skill]]",
        "- [[Private/Hidden Skill]]"
      ].join("\n")
    );
    await writeFile(
      join(vaultRoot, "Skills", "Research Assistant.md"),
      [
        "---",
        "name: research_assistant",
        "description: Research with the user's vault conventions.",
        "---",
        "Use careful sourcing and preserve the user's note style."
      ].join("\n")
    );
    await writeFile(
      join(vaultRoot, "Skills", "Planning.md"),
      [
        "---",
        "name: planning",
        "description: Turn rough goals into sequenced plans.",
        "---",
        "Ask for constraints, then produce a concise plan."
      ].join("\n")
    );
    await writeFile(join(vaultRoot, "Skills", "Not A Skill.md"), "# Just a note\n");
    await writeFile(
      join(vaultRoot, "Private", "Hidden Skill.md"),
      [
        "---",
        "name: hidden",
        "description: This should stay blocked.",
        "---",
        "private"
      ].join("\n")
    );
    const reader = new VaultReader({
      vaultRoot,
      ignoredGlobs: [],
      blockedPaths: ["Private/**"]
    });

    const result = await loadVaultSkills({
      reader,
      mapPaths: ["Atlas/Maps/Skills.md"]
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["planning", "research_assistant"]);
    expect(result.skills.find((skill) => skill.name === "research_assistant")).toMatchObject({
      path: "Skills/Research Assistant.md",
      description: "Research with the user's vault conventions.",
      content: "Use careful sourcing and preserve the user's note style."
    });
    expect(result.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Skills/Not A Skill.md", status: "error" }),
        expect.objectContaining({ path: "Private/Hidden Skill.md", status: "error" })
      ])
    );
  });

  test("reports configured map read errors without throwing", async () => {
    const reader = new VaultReader({
      vaultRoot,
      ignoredGlobs: [],
      blockedPaths: []
    });

    const result = await loadVaultSkills({
      reader,
      mapPaths: ["Atlas/Maps/Missing Skills.md"]
    });

    expect(result.skills).toEqual([]);
    expect(result.statuses).toEqual([
      expect.objectContaining({
        path: "Atlas/Maps/Missing Skills.md",
        status: "error"
      })
    ]);
    expect(JSON.stringify(result.statuses)).not.toContain(vaultRoot);
  });

  test("loads skills from flexible grouped maps with explicit path hints", async () => {
    await mkdir(join(vaultRoot, "AIOS", "Maps"), { recursive: true });
    await mkdir(join(vaultRoot, "AIOS", "Skills"), { recursive: true });
    await writeFile(
      join(vaultRoot, "AIOS", "Maps", "Skill Map.md"),
      [
        "---",
        "related:",
        "  - \"[[Vault Map]]\"",
        "---",
        "This map groups approved skills for clients.",
        "",
        "> [!note] [[me]] | [[Vault Map]] | **[[Skill Map]]**",
        "",
        "# Skills grouped by system",
        "##### [[Builder System]]",
        "- [[map-maker]]: Builds a topic map from a short interview.",
        "",
        "# Expanded skill entries",
        "### [[Builder System]]",
        "- [[map-maker]]:",
        "  - **Description**: Builds a topic map from a short interview.",
        "  - **Triggers**: `map this`, `build a map`",
        "  - **Dependencies**: [[style-guide-map]]",
        "  - **Path**: `/AIOS/Skills/map-maker`"
      ].join("\n")
    );
    await writeFile(
      join(vaultRoot, "AIOS", "Skills", "map-maker.md"),
      [
        "---",
        "name: map_maker",
        "description: Build topic maps using the user's conventions.",
        "---",
        "Interview briefly, then draft a useful map."
      ].join("\n")
    );
    const reader = new VaultReader({
      vaultRoot,
      ignoredGlobs: [],
      blockedPaths: []
    });

    const result = await loadVaultSkills({
      reader,
      mapPaths: ["AIOS/Maps/Skill Map.md"]
    });

    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "map_maker",
        path: "AIOS/Skills/map-maker.md"
      })
    ]);
  });
});
