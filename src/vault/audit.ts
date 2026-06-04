import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

interface StatementSyncLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string) => DatabaseSyncLike;
};

export type WriteAuditOperation =
  | "create_note"
  | "replace_note"
  | "update_frontmatter"
  | "replace_section_by_marker";

export type WriteAuditMetadata = Record<string, string | number | boolean | null>;

export interface VaultWriteAuditStoreOptions {
  sqlitePath: string;
}

export interface WriteAuditRotationOptions {
  sqlitePath: string;
  archiveDirectory: string;
  retentionMaxRows: number;
  now?: Date;
}

export type WriteAuditRotationResult =
  | {
      rotated: false;
      rowCount: number;
    }
  | {
      rotated: true;
      rowCount: number;
      archivedPath: string;
    };

export interface WriteAuditInput {
  operation: WriteAuditOperation;
  path: string;
  baseSha256?: string;
  resultSha256: string;
  metadata?: WriteAuditMetadata;
}

export interface WriteAuditAttemptInput {
  operation: WriteAuditOperation;
  path: string;
  baseSha256?: string;
  metadata?: WriteAuditMetadata;
}

export interface WriteAuditRow extends WriteAuditInput {
  id: number;
  createdAt: string;
  metadata: WriteAuditMetadata;
}

export interface IncompleteWriteAuditAttempt extends WriteAuditAttemptInput {
  attemptId: string;
  startedAt: string;
  metadata: WriteAuditMetadata;
}

interface AuditRow {
  id: number;
  operation: WriteAuditOperation;
  path: string;
  base_sha256: string | null;
  result_sha256: string;
  metadata_json: string;
  created_at: string;
}

interface AuditAttemptRow {
  attempt_id: string;
  operation: WriteAuditOperation;
  path: string;
  base_sha256: string | null;
  metadata_json: string;
  created_at: string;
}

export class VaultWriteAuditStore {
  private readonly db: DatabaseSyncLike;

  constructor(options: VaultWriteAuditStoreOptions) {
    this.db = new DatabaseSync(options.sqlitePath);
    this.initialize();
  }

  recordWrite(input: WriteAuditInput): void {
    this.db
      .prepare(
        `INSERT INTO write_audit (
          operation,
          path,
          base_sha256,
          result_sha256,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.operation,
        input.path,
        input.baseSha256 ?? null,
        input.resultSha256,
        JSON.stringify(input.metadata ?? {})
      );
  }

  recordWriteStarted(input: WriteAuditAttemptInput): string {
    const attemptId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO write_audit_attempts (
          attempt_id,
          event_type,
          operation,
          path,
          base_sha256,
          metadata_json
        ) VALUES (?, 'started', ?, ?, ?, ?)`
      )
      .run(
        attemptId,
        input.operation,
        input.path,
        input.baseSha256 ?? null,
        JSON.stringify(input.metadata ?? {})
      );
    return attemptId;
  }

  recordWriteSucceeded(attemptId: string, resultSha256: string): void {
    this.db
      .prepare(
        `INSERT INTO write_audit_attempts (
          attempt_id,
          event_type,
          result_sha256
        ) VALUES (?, 'succeeded', ?)`
      )
      .run(attemptId, resultSha256);
  }

  recordWriteFailed(attemptId: string, errorMessage: string): void {
    this.db
      .prepare(
        `INSERT INTO write_audit_attempts (
          attempt_id,
          event_type,
          error_message
        ) VALUES (?, 'failed', ?)`
      )
      .run(attemptId, errorMessage);
  }

  listRecentWrites(options: { limit?: number } = {}): WriteAuditRow[] {
    const limit = clampLimit(options.limit);
    const rows = this.db
      .prepare(
        `SELECT id, operation, path, base_sha256, result_sha256, metadata_json, created_at
         FROM write_audit
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as AuditRow[];
    return rows.map(rowToWriteAuditRow);
  }

  listIncompleteWrites(options: { limit?: number } = {}): IncompleteWriteAuditAttempt[] {
    const limit = clampLimit(options.limit);
    const rows = this.db
      .prepare(
        `SELECT
           started.attempt_id,
           started.operation,
           started.path,
           started.base_sha256,
           started.metadata_json,
           started.created_at
         FROM write_audit_attempts started
         WHERE started.event_type = 'started'
           AND NOT EXISTS (
             SELECT 1
             FROM write_audit_attempts terminal
             WHERE terminal.attempt_id = started.attempt_id
               AND terminal.event_type IN ('succeeded', 'failed')
           )
         ORDER BY started.created_at DESC
         LIMIT ?`
      )
      .all(limit) as AuditAttemptRow[];
    return rows.map(rowToIncompleteWriteAttempt);
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS write_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL CHECK (
          operation IN (
            'create_note',
            'replace_note',
            'update_frontmatter',
            'replace_section_by_marker'
          )
        ),
        path TEXT NOT NULL,
        base_sha256 TEXT,
        result_sha256 TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TRIGGER IF NOT EXISTS write_audit_no_update
      BEFORE UPDATE ON write_audit
      BEGIN
        SELECT RAISE(ABORT, 'write_audit is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS write_audit_no_delete
      BEFORE DELETE ON write_audit
      BEGIN
        SELECT RAISE(ABORT, 'write_audit is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS write_audit_no_existing_id_insert
      BEFORE INSERT ON write_audit
      WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM write_audit WHERE id = NEW.id)
      BEGIN
        SELECT RAISE(ABORT, 'write_audit is append-only');
      END;
      CREATE TABLE IF NOT EXISTS write_audit_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('started', 'succeeded', 'failed')),
        operation TEXT CHECK (
          operation IN (
            'create_note',
            'replace_note',
            'update_frontmatter',
            'replace_section_by_marker'
          )
        ),
        path TEXT,
        base_sha256 TEXT,
        result_sha256 TEXT,
        error_message TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CHECK (
          (event_type = 'started' AND operation IS NOT NULL AND path IS NOT NULL)
          OR (event_type = 'succeeded' AND result_sha256 IS NOT NULL)
          OR (event_type = 'failed' AND error_message IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS write_audit_attempts_attempt_id_idx
        ON write_audit_attempts (attempt_id);
      CREATE TRIGGER IF NOT EXISTS write_audit_attempts_no_update
      BEFORE UPDATE ON write_audit_attempts
      BEGIN
        SELECT RAISE(ABORT, 'write_audit_attempts is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS write_audit_attempts_no_delete
      BEFORE DELETE ON write_audit_attempts
      BEGIN
        SELECT RAISE(ABORT, 'write_audit_attempts is append-only');
      END;
    `);
  }
}

export async function rotateWriteAuditIfNeeded(
  options: WriteAuditRotationOptions
): Promise<WriteAuditRotationResult> {
  if (options.sqlitePath === ":memory:" || !existsSync(options.sqlitePath)) {
    return { rotated: false, rowCount: 0 };
  }

  const rowCount = countAuditRows(options.sqlitePath);
  if (options.retentionMaxRows <= 0 || rowCount <= options.retentionMaxRows) {
    return { rotated: false, rowCount };
  }

  await mkdir(options.archiveDirectory, { recursive: true });
  const archivedPath = path.join(
    options.archiveDirectory,
    `write-audit.${formatArchiveTimestamp(options.now ?? new Date())}.sqlite`
  );
  await rename(options.sqlitePath, archivedPath);
  return { rotated: true, rowCount, archivedPath };
}

function countAuditRows(sqlitePath: string): number {
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db.prepare("SELECT COUNT(*) AS count FROM write_audit").all() as Array<{
      count: number;
    }>;
    return rows[0]?.count ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function formatArchiveTimestamp(date: Date): string {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

function rowToWriteAuditRow(row: AuditRow): WriteAuditRow {
  return withoutUndefined({
    id: row.id,
    operation: row.operation,
    path: row.path,
    baseSha256: row.base_sha256 ?? undefined,
    resultSha256: row.result_sha256,
    metadata: JSON.parse(row.metadata_json) as WriteAuditMetadata,
    createdAt: row.created_at
  }) as WriteAuditRow;
}

function rowToIncompleteWriteAttempt(row: AuditAttemptRow): IncompleteWriteAuditAttempt {
  return withoutUndefined({
    attemptId: row.attempt_id,
    operation: row.operation,
    path: row.path,
    baseSha256: row.base_sha256 ?? undefined,
    metadata: JSON.parse(row.metadata_json) as WriteAuditMetadata,
    startedAt: row.created_at
  }) as IncompleteWriteAuditAttempt;
}

function withoutUndefined<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
