import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { VaultWriteAuditStore, rotateWriteAuditIfNeeded } from "../../src/vault/audit.js";

interface DatabaseSyncLike {
  exec(sql: string): void;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string) => DatabaseSyncLike;
};

describe("VaultWriteAuditStore", () => {
  test("records successful writes in descending insertion order", () => {
    const audit = new VaultWriteAuditStore({ sqlitePath: ":memory:" });

    audit.recordWrite({
      operation: "create_note",
      path: "Calendar/Records/Captures/2026-05-06 [Idea].md",
      resultSha256: "result-a",
      metadata: {
        client: "test"
      }
    });
    audit.recordWrite({
      operation: "replace_note",
      path: "Calendar/Records/Captures/2026-05-06 [Idea].md",
      baseSha256: "result-a",
      resultSha256: "result-b"
    });

    expect(audit.listRecentWrites()).toEqual([
      expect.objectContaining({
        operation: "replace_note",
        path: "Calendar/Records/Captures/2026-05-06 [Idea].md",
        baseSha256: "result-a",
        resultSha256: "result-b",
        metadata: {}
      }),
      expect.objectContaining({
        operation: "create_note",
        path: "Calendar/Records/Captures/2026-05-06 [Idea].md",
        resultSha256: "result-a",
        metadata: {
          client: "test"
        }
      })
    ]);

    for (const row of audit.listRecentWrites()) {
      expect(row.id).toBeGreaterThan(0);
      expect(Date.parse(row.createdAt)).not.toBeNaN();
    }

    audit.close();
  });

  test("limits recent write results", () => {
    const audit = new VaultWriteAuditStore({ sqlitePath: ":memory:" });
    audit.recordWrite({
      operation: "create_note",
      path: "one.md",
      resultSha256: "one"
    });
    audit.recordWrite({
      operation: "create_note",
      path: "two.md",
      resultSha256: "two"
    });

    expect(audit.listRecentWrites({ limit: 1 }).map((row) => row.path)).toEqual(["two.md"]);

    audit.close();
  });

  test("clamps invalid limits instead of returning the full audit table", () => {
    const audit = new VaultWriteAuditStore({ sqlitePath: ":memory:" });
    audit.recordWrite({
      operation: "create_note",
      path: "one.md",
      resultSha256: "one"
    });
    audit.recordWrite({
      operation: "create_note",
      path: "two.md",
      resultSha256: "two"
    });

    expect(audit.listRecentWrites({ limit: -1 }).map((row) => row.path)).toEqual(["two.md"]);

    audit.close();
  });

  test("prevents update and delete through SQLite triggers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "second-brain-audit-"));
    const sqlitePath = join(dir, "audit.sqlite");
    const audit = new VaultWriteAuditStore({ sqlitePath });
    audit.recordWrite({
      operation: "create_note",
      path: "one.md",
      resultSha256: "one"
    });
    audit.close();

    const db = new DatabaseSync(sqlitePath);
    expect(() => db.exec("UPDATE write_audit SET path = 'changed.md' WHERE id = 1")).toThrow(
      /write_audit is append-only/
    );
    expect(() => db.exec("DELETE FROM write_audit WHERE id = 1")).toThrow(
      /write_audit is append-only/
    );
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO write_audit (
          id,
          operation,
          path,
          result_sha256,
          metadata_json
        ) VALUES (1, 'create_note', 'changed.md', 'changed', '{}')`
      )
    ).toThrow(/write_audit is append-only/);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("rotates an oversized audit database into an archive directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "second-brain-audit-rotation-"));
    const sqlitePath = join(dir, "write-audit.sqlite");
    const archiveDirectory = join(dir, "audit-archive");
    const audit = new VaultWriteAuditStore({ sqlitePath });
    audit.recordWrite({
      operation: "create_note",
      path: "one.md",
      resultSha256: "one"
    });
    audit.recordWrite({
      operation: "create_note",
      path: "two.md",
      resultSha256: "two"
    });
    audit.close();

    const result = await rotateWriteAuditIfNeeded({
      sqlitePath,
      archiveDirectory,
      retentionMaxRows: 1,
      now: new Date("2026-06-02T12:34:56.789Z")
    });

    expect(result).toEqual({
      rotated: true,
      archivedPath: join(archiveDirectory, "write-audit.20260602T123456789Z.sqlite"),
      rowCount: 2
    });
    expect(await readdir(archiveDirectory)).toEqual([
      "write-audit.20260602T123456789Z.sqlite"
    ]);

    const freshAudit = new VaultWriteAuditStore({ sqlitePath });
    expect(freshAudit.listRecentWrites()).toEqual([]);
    freshAudit.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("does not rotate when retention is disabled or under the row limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "second-brain-audit-retention-"));
    const sqlitePath = join(dir, "write-audit.sqlite");
    const archiveDirectory = join(dir, "audit-archive");
    const audit = new VaultWriteAuditStore({ sqlitePath });
    audit.recordWrite({
      operation: "create_note",
      path: "one.md",
      resultSha256: "one"
    });
    audit.close();

    await expect(
      rotateWriteAuditIfNeeded({ sqlitePath, archiveDirectory, retentionMaxRows: 0 })
    ).resolves.toEqual({ rotated: false, rowCount: 1 });
    await expect(
      rotateWriteAuditIfNeeded({ sqlitePath, archiveDirectory, retentionMaxRows: 1 })
    ).resolves.toEqual({ rotated: false, rowCount: 1 });

    await rm(dir, { recursive: true, force: true });
  });
});
