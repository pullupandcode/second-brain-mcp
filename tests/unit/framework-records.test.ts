import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { EffectiveFrameworkSchema } from "../../src/framework/schema.js";
import { createFrameworkRecordTools } from "../../src/framework/records.js";
import { VaultWriteAuditStore } from "../../src/vault/audit.js";
import { VaultIndex } from "../../src/vault/index.js";
import { VaultReader } from "../../src/vault/reader.js";
import { createVaultWriteTools } from "../../src/vault/tools.js";
import { VaultWriter } from "../../src/vault/writer.js";

let vaultRoot: string;
let audit: VaultWriteAuditStore;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "second-brain-records-"));
  await mkdir(join(vaultRoot, "x", "Templates"), { recursive: true });
  await writeFile(
    join(vaultRoot, "x", "Templates", "Meeting.md"),
    "# Meeting Notes\n\nAttendees:\n"
  );
  audit = new VaultWriteAuditStore({ sqlitePath: ":memory:" });
});

afterEach(async () => {
  audit.close();
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("createFrameworkRecordTools", () => {
  test("creates a schema-driven record with expanded path, template body, and frontmatter", async () => {
    const schema = effectiveSchema({
      meeting: {
        description: "A meeting record.",
        folder: "Calendar/Records/Meetings",
        filename: "{date:YYYY-MM-DD} [{title}].md",
        template: "x/Templates/Meeting.md"
      }
    });
    const tools = createFrameworkRecordTools({
      schema,
      reader: new VaultReader({ vaultRoot, ignoredGlobs: [] }),
      writeTools: createVaultWriteTools(new VaultWriter({ vaultRoot, cooldownSeconds: 0 }), audit)
    });

    const result = await tools.create_record({
      type: "meeting",
      title: "Planning",
      date: "2026-05-07T15:30:00Z",
      fields: {
        scheduled: "2026-05-07 03:30 PM",
        attendees: ["Ada", "[[Grace]]"]
      },
      body: "Decision log"
    });

    expect(result.path).toBe("Calendar/Records/Meetings/2026-05-07 [Planning].md");
    expect(await readFile(join(vaultRoot, result.path), "utf8")).toBe(
      [
        "---",
        'type: "meeting"',
        'title: "Planning"',
        'date: "2026-05-07"',
        'scheduled: "2026-05-07 03:30 PM"',
        'attendees: ["[[Ada]]", "[[Grace]]"]',
        "---",
        "# Meeting Notes",
        "",
        "Attendees:",
        "",
        "Decision log"
      ].join("\n")
    );
    expect(audit.listRecentWrites().map((row) => row.operation)).toEqual(["create_note"]);
  });

  test("lists schema record types with descriptions and folders", () => {
    const schema = effectiveSchema({
      meeting: {
        description: "A meeting record.",
        folder: "Calendar/Records/Meetings"
      },
      capture: {
        folder: "Calendar/Records/Captures"
      }
    });
    const tools = createFrameworkRecordTools({
      schema,
      reader: new VaultReader({ vaultRoot, ignoredGlobs: [] }),
      writeTools: createVaultWriteTools(new VaultWriter({ vaultRoot, cooldownSeconds: 0 }))
    });

    expect(tools.list_record_types()).toEqual([
      {
        name: "capture",
        folder: "Calendar/Records/Captures",
        description: undefined
      },
      {
        name: "meeting",
        folder: "Calendar/Records/Meetings",
        description: "A meeting record."
      }
    ]);
  });

  test("creates a dated capture record without touching the daily note", async () => {
    const schema = effectiveSchema({
      capture: {
        description: "Agent capture.",
        folder: "Calendar/Records/Captures",
        filename: "{date:YYYY-MM-DD HH-mm} [{title}].md"
      }
    });
    const tools = createFrameworkRecordTools({
      schema,
      reader: new VaultReader({ vaultRoot, ignoredGlobs: [] }),
      writeTools: createVaultWriteTools(new VaultWriter({ vaultRoot, cooldownSeconds: 0 }), audit)
    });

    const result = await tools.capture_for_date({
      content: "Remember to review the MCP schema.",
      date: "2026-05-07T16:45:00Z",
      sourceClient: "codex",
      sourceId: "msg-123",
      captureType: "idea",
      title: "Schema review"
    });

    expect(result.path).toBe("Calendar/Records/Captures/2026-05-07 16-45 [Schema review].md");
    expect(await readFile(join(vaultRoot, result.path), "utf8")).toBe(
      [
        "---",
        'type: "capture"',
        'title: "Schema review"',
        'date: "2026-05-07"',
        'source_client: "codex"',
        'source_id: "msg-123"',
        'capture_type: "idea"',
        "---",
        "Remember to review the MCP schema."
      ].join("\n")
    );
    await expect(readFile(join(vaultRoot, "Calendar", "Days", "2026-05-07.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(audit.listRecentWrites().map((row) => row.operation)).toEqual(["create_note"]);
  });

  test("replaces an existing inbox capture by source id with hash checks", async () => {
    const schema = effectiveSchema({
      capture: {
        description: "Agent capture.",
        folder: "Calendar/Records/Captures",
        filename: "{date:YYYY-MM-DD HH-mm} [{title}].md"
      }
    });
    const reader = new VaultReader({ vaultRoot, ignoredGlobs: [] });
    const index = new VaultIndex({ reader, sqlitePath: ":memory:" });
    const tools = createFrameworkRecordTools({
      schema,
      reader,
      index,
      writeTools: createVaultWriteTools(new VaultWriter({ vaultRoot, cooldownSeconds: 0 }), audit)
    });

    const created = await tools.inbox_capture({
      content: "First OCR text",
      date: "2026-05-07T16:45:00Z",
      sourceClient: "rmocr",
      sourceId: "rmpage:notebook:page",
      strategy: "replace_by_source_id",
      title: "Page 1"
    });
    await index.rebuild();
    const replaced = await tools.inbox_capture({
      content: "Updated OCR text",
      date: "2026-05-07T17:10:00Z",
      sourceClient: "rmocr",
      sourceId: "rmpage:notebook:page",
      strategy: "replace_by_source_id",
      title: "Page 1 revised"
    });

    expect(replaced.path).toBe(created.path);
    expect(replaced.baseSha256).toBe(created.resultSha256);
    expect(await readFile(join(vaultRoot, created.path), "utf8")).toBe(
      [
        "---",
        'type: "capture"',
        'title: "Page 1 revised"',
        'date: "2026-05-07"',
        'source_client: "rmocr"',
        'source_id: "rmpage:notebook:page"',
        "---",
        "Updated OCR text"
      ].join("\n")
    );
    expect(audit.listRecentWrites().map((row) => row.operation)).toEqual([
      "replace_note",
      "create_note"
    ]);

    index.close();
  });
});

function effectiveSchema(types: EffectiveFrameworkSchema["types"]): EffectiveFrameworkSchema {
  return {
    version: 1,
    schemaKind: "base",
    framework: "custom",
    override: false,
    types
  };
}
