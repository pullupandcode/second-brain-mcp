import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { EffectiveFrameworkSchema } from "../../src/framework/schema.js";
import { createFrameworkRecordTools } from "../../src/framework/records.js";
import { VaultWriteAuditStore } from "../../src/vault/audit.js";
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
        attendees: ["[[Ada]]", "[[Grace]]"]
      },
      body: "Decision log"
    });

    expect(result.path).toBe("Calendar/Records/Meetings/2026-05-07 [Planning].md");
    expect(await readFile(join(vaultRoot, result.path), "utf8")).toBe(
      [
        "---",
        "type: meeting",
        "title: Planning",
        "date: 2026-05-07",
        "scheduled: 2026-05-07 03:30 PM",
        "attendees: [[[Ada]], [[Grace]]]",
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
