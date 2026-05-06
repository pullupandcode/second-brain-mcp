import { createRequire } from "node:module";

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

export interface WriteAuditInput {
  operation: WriteAuditOperation;
  path: string;
  baseSha256?: string;
  resultSha256: string;
  metadata?: WriteAuditMetadata;
}

export interface WriteAuditRow extends WriteAuditInput {
  id: number;
  createdAt: string;
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
    `);
  }
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

function withoutUndefined<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
