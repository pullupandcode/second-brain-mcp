import type { VaultWriteAuditStore, WriteAuditInput, WriteAuditOperation } from "./audit.js";
import type { SearchFilters, SearchResult, VaultConflict, VaultIndex } from "./index.js";
import type { FrontmatterValue } from "./markdown.js";
import type { FolderEntry, ReadNoteResult, VaultReader } from "./reader.js";
import type { VaultWriter, WriteResult } from "./writer.js";

export interface VaultReadTools {
  read_note(path: string): Promise<ReadNoteResult>;
  list_folder(path: string, recursive?: boolean): Promise<FolderEntry[]>;
  search(query: string, filters?: SearchFilters): SearchResult[];
  get_backlinks(path: string): string[];
  get_outgoing_links(path: string): string[];
  link_to_page(notebook: string, pageUuid: string): string | undefined;
  list_vault_conflicts(): VaultConflict[];
}

export interface VaultWriteTools {
  create_note(
    path: string,
    content: string,
    frontmatter?: Record<string, FrontmatterValue>
  ): Promise<WriteResult>;
  replace_note(
    path: string,
    content: string,
    baseSha256: string,
    frontmatter?: Record<string, FrontmatterValue>
  ): Promise<WriteResult>;
  delete_note(path: string, baseSha256: string): Promise<WriteResult>;
  update_frontmatter(
    path: string,
    patch: Record<string, FrontmatterValue>,
    baseSha256: string
  ): Promise<WriteResult>;
  replace_section_by_marker(
    path: string,
    markerName: string,
    content: string,
    baseSha256: string
  ): Promise<WriteResult>;
}

export function createVaultReadTools(reader: VaultReader, index: VaultIndex): VaultReadTools {
  return {
    read_note: (path) => reader.readNote(path),
    list_folder: (path, recursive = false) => reader.listFolder(path, { recursive }),
    search: (query, filters) => index.search(query, filters),
    get_backlinks: (path) => index.getBacklinks(path),
    get_outgoing_links: (path) => index.getOutgoingLinks(path),
    link_to_page: (notebook, pageUuid) => linkToPage(index, notebook, pageUuid),
    list_vault_conflicts: () => index.listConflicts()
  };
}

export function createVaultWriteTools(
  writer: VaultWriter,
  auditStore?: VaultWriteAuditStore
): VaultWriteTools {
  return {
    create_note: (path, content, frontmatter) =>
      auditedWrite(auditStore, "create_note", { path }, () =>
        writer.createNote(path, content, frontmatter)
      ),
    replace_note: (path, content, baseSha256, frontmatter) =>
      auditedWrite(auditStore, "replace_note", { path, baseSha256 }, () =>
        writer.replaceNote(path, content, baseSha256, frontmatter)
      ),
    delete_note: (path, baseSha256) =>
      auditedWrite(auditStore, "delete_note", { path, baseSha256 }, () =>
        writer.deleteNote(path, baseSha256)
      ),
    update_frontmatter: (path, patch, baseSha256) =>
      auditedWrite(auditStore, "update_frontmatter", { path, baseSha256 }, () =>
        writer.updateFrontmatter(path, patch, baseSha256)
      ),
    replace_section_by_marker: (path, markerName, content, baseSha256) =>
      auditedWrite(
        auditStore,
        "replace_section_by_marker",
        { path, baseSha256, metadata: { markerName } },
        () => writer.replaceSectionByMarker(path, markerName, content, baseSha256)
      )
  };
}

async function auditedWrite(
  auditStore: VaultWriteAuditStore | undefined,
  operation: WriteAuditOperation,
  attempt: { path: string; baseSha256?: string; metadata?: Record<string, string> },
  write: () => Promise<WriteResult>
): Promise<WriteResult> {
  const attemptId = recordWriteStarted(auditStore, operation, attempt);
  try {
    const result = await write();
    recordWriteSucceeded(auditStore, attemptId, result.resultSha256);
    recordWrite(auditStore, operation, result, attempt.metadata);
    return result;
  } catch (error) {
    recordWriteFailed(auditStore, attemptId, errorMessage(error));
    throw error;
  }
}

function recordWriteStarted(
  auditStore: VaultWriteAuditStore | undefined,
  operation: WriteAuditOperation,
  attempt: { path: string; baseSha256?: string; metadata?: Record<string, string> }
): string | undefined {
  try {
    const input = {
      operation,
      path: attempt.path,
      ...(attempt.baseSha256 === undefined ? {} : { baseSha256: attempt.baseSha256 }),
      ...(attempt.metadata === undefined ? {} : { metadata: attempt.metadata })
    };
    return auditStore?.recordWriteStarted(input);
  } catch {
    return undefined;
  }
}

function recordWriteSucceeded(
  auditStore: VaultWriteAuditStore | undefined,
  attemptId: string | undefined,
  resultSha256: string
): void {
  if (attemptId === undefined) {
    return;
  }
  try {
    auditStore?.recordWriteSucceeded(attemptId, resultSha256);
  } catch {
    // Best effort only; the successful write audit row below is recorded independently.
  }
}

function recordWriteFailed(
  auditStore: VaultWriteAuditStore | undefined,
  attemptId: string | undefined,
  message: string
): void {
  if (attemptId === undefined) {
    return;
  }
  try {
    auditStore?.recordWriteFailed(attemptId, message);
  } catch {
    // Best effort only; preserve the original write error for the caller.
  }
}

function recordWrite(
  auditStore: VaultWriteAuditStore | undefined,
  operation: WriteAuditOperation,
  result: WriteResult,
  metadata?: Record<string, string>
): void {
  const input: WriteAuditInput = {
    operation,
    path: result.path,
    resultSha256: result.resultSha256
  };
  if (result.baseSha256 !== undefined) {
    input.baseSha256 = result.baseSha256;
  }
  if (metadata !== undefined) {
    input.metadata = metadata;
  }
  try {
    auditStore?.recordWrite(input);
  } catch {
    // The vault write has already succeeded. Treat audit persistence as best effort
    // so callers do not retry a completed mutation and create duplicate/conflict writes.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function linkToPage(index: VaultIndex, notebook: string, pageUuid: string): string | undefined {
  const notebookUuid = notebook.replace(/^rmnotebook:/, "");
  const path = index.findBySourceId(`rmpage:${notebookUuid}:${pageUuid}`);
  return path === undefined ? undefined : `[[${path}|${pageUuid}]]`;
}
