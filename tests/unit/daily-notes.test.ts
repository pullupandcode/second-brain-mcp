import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDailyNoteTools } from "../../src/framework/daily.js";
import { VaultReader } from "../../src/vault/reader.js";
import { createVaultWriteTools } from "../../src/vault/tools.js";
import { VaultWriter } from "../../src/vault/writer.js";

let vaultRoot: string;
let reader: VaultReader;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-daily-"));
  await mkdir(join(vaultRoot, "Calendar", "Days"), { recursive: true });
  await mkdir(join(vaultRoot, "x", "Templates"), { recursive: true });
  await writeFile(
    join(vaultRoot, "x", "Templates", "Daily.md"),
    [
      "# daily log",
      "<!-- mcp:section daily-captures start -->",
      "<!-- mcp:section daily-captures end -->",
      "",
      "# last light",
      "<!-- mcp:section last-light-summary start -->",
      "<!-- mcp:section last-light-summary end -->",
      ""
    ].join("\n")
  );
  reader = new VaultReader({ vaultRoot, ignoredGlobs: [] });
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("createDailyNoteTools", () => {
  test("gets a daily note and creates it from the template when missing", async () => {
    const tools = dailyTools();

    const result = await tools.daily_note_get({ date: "2026-05-07T12:00:00Z" });

    expect(result.path).toBe("Calendar/Days/2026-05-07.md");
    expect(result.content).toContain("<!-- mcp:section daily-captures start -->");
    expect(await readFile(join(vaultRoot, result.path), "utf8")).toBe(result.content);
  });

  test("appends content inside a writable marker section", async () => {
    const tools = dailyTools();
    const daily = await tools.daily_note_get({ date: "2026-05-07T12:00:00Z" });

    await tools.daily_note_append({
      section: "daily-log",
      content: "- captured from MCP",
      date: "2026-05-07T12:00:00Z",
      baseSha256: daily.currentSha256
    });

    expect(await readFile(join(vaultRoot, daily.path), "utf8")).toContain(
      "<!-- mcp:section daily-captures start -->\n- captured from MCP\n<!-- mcp:section daily-captures end -->"
    );
  });

  test("rejects appending to protected sections", async () => {
    const tools = dailyTools();
    const daily = await tools.daily_note_get({ date: "2026-05-07T12:00:00Z" });

    await expect(
      tools.daily_note_append({
        section: "agenda",
        content: "- unsafe",
        date: "2026-05-07T12:00:00Z",
        baseSha256: daily.currentSha256
      })
    ).rejects.toMatchObject({ code: "section_not_writable" });
  });

  test("repairs missing markers by appending marker blocks from the template", async () => {
    const tools = dailyTools();
    await writeFile(join(vaultRoot, "Calendar", "Days", "2026-05-07.md"), "# daily log\nhuman text\n");
    const daily = await reader.readNote("Calendar/Days/2026-05-07.md");

    await tools.daily_note_repair_markers({
      date: "2026-05-07T12:00:00Z",
      baseSha256: daily.currentSha256
    });

    const repaired = await readFile(join(vaultRoot, "Calendar", "Days", "2026-05-07.md"), "utf8");
    expect(repaired).toContain("# daily log\nhuman text\n");
    expect(repaired).toContain("<!-- mcp:section daily-captures start -->");
    expect(repaired).toContain("<!-- mcp:section last-light-summary start -->");
  });
});

function dailyTools() {
  return createDailyNoteTools({
    reader,
    writeTools: createVaultWriteTools(new VaultWriter({ vaultRoot, cooldownSeconds: 0 })),
    config: {
      path: "Calendar/Days/{date:YYYY-MM-DD}.md",
      template: "x/Templates/Daily.md",
      sections: [
        {
          name: "agenda",
          markerName: "agenda",
          writable: false
        },
        {
          name: "daily-log",
          markerName: "daily-captures",
          writable: true,
          defaultForAppend: true
        },
        {
          name: "last-light",
          markerName: "last-light-summary",
          writable: true
        }
      ]
    }
  });
}
