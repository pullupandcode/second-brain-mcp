import { dirname, basename } from "node:path";
import { createRequire } from "node:module";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { VaultReader } from "./reader.js";
import { normalizeVaultPath } from "./path.js";

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

interface StatementSyncLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string) => DatabaseSyncLike;
};

export interface SearchFilters {
  folder?: string;
  tag?: string;
}

export interface SearchResult {
  path: string;
  title: string | undefined;
  tags: string[];
  aliases: string[];
  currentSha256: string;
}

export interface VaultConflict {
  canonical: string;
  conflicts: string[];
}

export interface VaultIndexOptions {
  reader: VaultReader;
  sqlitePath: string;
}

interface NoteRow {
  path: string;
  title: string | null;
  tags_json: string;
  aliases_json: string;
  sha256: string;
}

interface PathRow {
  path: string;
}

interface ConflictRow {
  canonical: string;
  conflict: string;
}

export class VaultIndex {
  private readonly db: DatabaseSyncLike;
  private readonly reader: VaultReader;

  constructor(options: VaultIndexOptions) {
    this.reader = options.reader;
    this.db = new DatabaseSync(options.sqlitePath);
    this.initialize();
  }

  async rebuild(): Promise<void> {
    this.db.exec("DELETE FROM note_fts; DELETE FROM links; DELETE FROM conflicts; DELETE FROM notes;");

    const entries = await this.reader.listFolder("", { recursive: true });
    for (const entry of entries) {
      if (entry.type !== "file") {
        continue;
      }
      const note = await this.reader.readNote(entry.path);
      this.insertNote(
        note.path,
        note.parsed.title,
        note.content,
        note.parsed.tags,
        note.parsed.aliases,
        note.parsed.sourceId,
        note.currentSha256
      );
      for (const target of note.parsed.outgoingLinks) {
        this.db.prepare("INSERT INTO links (source_path, target) VALUES (?, ?)").run(note.path, target);
      }
    }

    await this.rebuildConflicts();
  }

  search(query: string, filters: SearchFilters = {}): SearchResult[] {
    const params: unknown[] = [];
    let sql = query.trim().length > 0
      ? `SELECT notes.path, notes.title, notes.tags_json, notes.aliases_json, notes.sha256
         FROM note_fts
         JOIN notes ON notes.path = note_fts.path
         WHERE note_fts MATCH ?`
      : `SELECT path, title, tags_json, aliases_json, sha256 FROM notes WHERE 1 = 1`;

    if (query.trim().length > 0) {
      params.push(query.trim());
    }

    if (filters.folder !== undefined) {
      sql += " AND notes.path LIKE ?";
      params.push(`${filters.folder.replace(/\/$/, "")}/%`);
    }

    const rows = this.db.prepare(sql).all(...params) as NoteRow[];
    return rows
      .map(rowToSearchResult)
      .filter((result) => filters.tag === undefined || result.tags.includes(filters.tag));
  }

  getBacklinks(pathOrAlias: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT source_path AS path FROM links WHERE target = ? ORDER BY source_path")
      .all(pathOrAlias) as PathRow[];
    return rows.map((row) => row.path);
  }

  getOutgoingLinks(path: string): string[] {
    const rows = this.db
      .prepare("SELECT target AS path FROM links WHERE source_path = ? ORDER BY target")
      .all(path) as PathRow[];
    return rows.map((row) => row.path);
  }

  findBySourceId(sourceId: string): string | undefined {
    const row = this.db.prepare("SELECT path FROM notes WHERE source_id = ?").get(sourceId) as
      | PathRow
      | undefined;
    return row?.path;
  }

  listConflicts(): VaultConflict[] {
    const rows = this.db
      .prepare("SELECT canonical, conflict FROM conflicts ORDER BY canonical, conflict")
      .all() as ConflictRow[];
    const byCanonical = new Map<string, string[]>();
    for (const row of rows) {
      byCanonical.set(row.canonical, [...(byCanonical.get(row.canonical) ?? []), row.conflict]);
    }
    return [...byCanonical.entries()].map(([canonical, conflicts]) => ({ canonical, conflicts }));
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        title TEXT,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        source_id TEXT,
        sha256 TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(path UNINDEXED, title, content);
      CREATE TABLE IF NOT EXISTS links (
        source_path TEXT NOT NULL,
        target TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        canonical TEXT NOT NULL,
        conflict TEXT NOT NULL
      );
    `);
  }

  private insertNote(
    path: string,
    title: string | undefined,
    content: string,
    tags: string[],
    aliases: string[],
    sourceId: string | undefined,
    sha256: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO notes (path, title, content, tags_json, aliases_json, source_id, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(path, title ?? null, content, JSON.stringify(tags), JSON.stringify(aliases), sourceId ?? null, sha256);
    this.db
      .prepare("INSERT INTO note_fts (path, title, content) VALUES (?, ?, ?)")
      .run(path, title ?? "", content);
  }

  private async rebuildConflicts(): Promise<void> {
    await this.collectConflictsFromDisk(this.reader.vaultRoot, "");
  }

  private async collectConflictsFromDisk(absolutePath: string, vaultPath: string): Promise<void> {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const childVaultPath = normalizeVaultPath(vaultPath.length === 0 ? entry.name : `${vaultPath}/${entry.name}`);
      if (this.reader.isBlocked(childVaultPath)) {
        continue;
      }
      const childAbsolutePath = path.join(absolutePath, entry.name);
      const childStat = await stat(childAbsolutePath);
      if (childStat.isDirectory()) {
        await this.collectConflictsFromDisk(childAbsolutePath, childVaultPath);
        continue;
      }
      if (!childStat.isFile() || !basename(childVaultPath).includes(".sync-conflict-")) {
        continue;
      }
      const canonical = canonicalConflictPath(childVaultPath);
      this.db.prepare("INSERT INTO conflicts (canonical, conflict) VALUES (?, ?)").run(canonical, childVaultPath);
    }
  }
}

function rowToSearchResult(row: NoteRow): SearchResult {
  return {
    path: row.path,
    title: row.title ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    aliases: JSON.parse(row.aliases_json) as string[],
    currentSha256: row.sha256
  };
}

function canonicalConflictPath(conflictPath: string): string {
  const fileName = basename(conflictPath);
  const dir = dirname(conflictPath);
  const canonicalName = fileName.replace(/\.sync-conflict-[^.]+(?=\.md$)/, "");
  return dir === "." ? canonicalName : `${dir}/${canonicalName}`;
}
