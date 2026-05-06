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
    list_vault_conflicts: () => index.listConflicts()
  };
}

export function createVaultWriteTools(
  writer: VaultWriter,
  auditStore?: VaultWriteAuditStore
): VaultWriteTools {
  return {
    create_note: async (path, content, frontmatter) => {
      const result = await writer.createNote(path, content, frontmatter);
      recordWrite(auditStore, "create_note", result);
      return result;
    },
    replace_note: async (path, content, baseSha256, frontmatter) => {
      const result = await writer.replaceNote(path, content, baseSha256, frontmatter);
      recordWrite(auditStore, "replace_note", result);
      return result;
    },
    update_frontmatter: async (path, patch, baseSha256) => {
      const result = await writer.updateFrontmatter(path, patch, baseSha256);
      recordWrite(auditStore, "update_frontmatter", result);
      return result;
    },
    replace_section_by_marker: async (path, markerName, content, baseSha256) => {
      const result = await writer.replaceSectionByMarker(path, markerName, content, baseSha256);
      recordWrite(auditStore, "replace_section_by_marker", result, { markerName });
      return result;
    }
  };
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
