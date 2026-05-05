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
  tool("create_lyt_record", "vault:write", "Create a type-driven LYT record."),
  tool("find_mocs", "vault:read", "Find maps of content."),
  tool("list_lyt_types", "vault:read", "List effective LYT schema types."),
  tool("get_vault_structure", "vault:read", "Return folder map and LYT type list."),
  tool("link_to_page", "vault:read", "Return a stable OCR page wikilink."),
  tool("schema_init", "admin", "Create a starter schema."),
  tool("schema_reload", "admin", "Reload schema files."),
  tool("schema_register", "admin", "Register a schema overlay."),
  tool("schema_unregister", "admin", "Unregister a schema overlay."),
  tool("schema_list", "admin", "List registered schemas."),
  tool("schema_compose", "admin", "Return the effective schema.")
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
