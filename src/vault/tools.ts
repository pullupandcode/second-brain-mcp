import type { SearchFilters, SearchResult, VaultConflict, VaultIndex } from "./index.js";
import type { FolderEntry, ReadNoteResult, VaultReader } from "./reader.js";

export interface VaultReadTools {
  read_note(path: string): Promise<ReadNoteResult>;
  list_folder(path: string, recursive?: boolean): Promise<FolderEntry[]>;
  search(query: string, filters?: SearchFilters): SearchResult[];
  get_backlinks(path: string): string[];
  get_outgoing_links(path: string): string[];
  list_vault_conflicts(): VaultConflict[];
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
