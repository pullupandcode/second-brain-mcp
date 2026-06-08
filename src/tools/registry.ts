import type { Scope } from "../auth/scopes.js";

export interface ToolDefinition {
  name: string;
  requiredScope: Scope;
  description: string;
  optionalFeature?: "ocr";
}

const BASE_TOOLS = [
  tool("read_note", "vault:read", "Read content plus parsed frontmatter."),
  tool("create_note", "vault:write", "Create a note and fail if the path exists."),
  tool("replace_note", "vault:write", "Replace a full note body with optimistic concurrency."),
  tool("delete_note", "vault:delete", "Move a note into the configured MCP trash path."),
  tool("list_folder", "vault:read", "List notes under a vault path."),
  tool("search", "vault:read", "Search indexed notes."),
  tool("get_backlinks", "vault:read", "List notes linking to a path."),
  tool("get_outgoing_links", "vault:read", "List links from a path."),
  tool("update_frontmatter", "vault:write", "Merge frontmatter keys."),
  tool("replace_section_by_marker", "vault:write", "Replace an MCP-owned marker section."),
  tool("list_vault_conflicts", "admin", "List active conflict quarantine state."),
  tool("inbox_capture", "vault:capture", "Create or update inbox capture content."),
  tool("capture_for_date", "vault:capture", "Create a capture record for a date."),
  tool("daily_note_get", "vault:read", "Read a daily note."),
  tool("daily_note_append", "daily:append", "Append inside a writable daily note marker."),
  tool("daily_note_repair_markers", "admin", "Repair missing daily note markers."),
  tool("create_record", "vault:write", "Create a type-driven framework record."),
  tool("find_maps", "vault:read", "Find framework map or index notes."),
  tool("list_record_types", "vault:read", "List effective framework record types."),
  tool("get_vault_structure", "vault:read", "Return folder map and framework type list."),
  tool("link_to_page", "vault:read", "Return a stable OCR page wikilink."),
  tool("list_write_recovery_diagnostics", "admin", "List write attempts without terminal audit events."),
  tool("framework_init", "admin", "Create a starter framework schema."),
  tool("framework_reload", "admin", "Reload framework schema files."),
  tool("framework_register", "admin", "Register a framework overlay."),
  tool("framework_unregister", "admin", "Unregister a framework overlay."),
  tool("framework_list", "admin", "List registered framework schemas."),
  tool("framework_compose", "admin", "Return the effective framework schema.")
] satisfies ToolDefinition[];

const OCR_TOOLS = [
  tool("ocr_notebook", "admin", "Queue OCR for a notebook.", "ocr"),
  tool("ocr_status", "admin", "Poll OCR job state.", "ocr"),
  tool("ocr_renumber_notebook", "admin", "Force notebook page renumbering.", "ocr")
] satisfies ToolDefinition[];

export function createToolRegistry(options: { ocrEnabled?: boolean } = {}): ToolDefinition[] {
  return options.ocrEnabled === true ? [...BASE_TOOLS, ...OCR_TOOLS] : [...BASE_TOOLS];
}

export function listToolsForScopes(
  scopes: ReadonlySet<Scope>,
  tools: readonly ToolDefinition[] = createToolRegistry()
): ToolDefinition[] {
  return tools.filter((toolDefinition) => scopes.has(toolDefinition.requiredScope));
}

function tool(
  name: string,
  requiredScope: Scope,
  description: string,
  optionalFeature?: ToolDefinition["optionalFeature"]
): ToolDefinition {
  return optionalFeature === undefined
    ? { name, requiredScope, description }
    : { name, requiredScope, description, optionalFeature };
}
