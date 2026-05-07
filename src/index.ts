export { buildProtectedResourceMetadata } from "./auth/discovery.js";
export { KNOWN_SCOPES, parseScopes } from "./auth/scopes.js";
export { loadConfig, parseConfig } from "./config.js";
export { FRAMEWORK_PRESET_IDS, getFrameworkPreset, listFrameworkPresets } from "./framework/presets.js";
export { createFrameworkRecordTools } from "./framework/records.js";
export { composeFrameworkSchemas, parseFrameworkSchema } from "./framework/schema.js";
export { createHttpServer } from "./server.js";
export { createToolRegistry, listToolsForScopes } from "./tools/registry.js";
export { parseMarkdown } from "./vault/markdown.js";
export { isMarkdownPath, normalizeVaultPath, resolveVaultPath } from "./vault/path.js";
export { VaultWriteAuditStore } from "./vault/audit.js";
export { VaultReader } from "./vault/reader.js";
export { VaultWriteError, VaultWriter } from "./vault/writer.js";
export { VaultIndex } from "./vault/index.js";
export { createVaultReadTools, createVaultWriteTools } from "./vault/tools.js";
export type { OAuthProtectedResourceMetadata } from "./auth/discovery.js";
export type { Scope } from "./auth/scopes.js";
export type { ServerConfig } from "./config.js";
export type { FrameworkPreset, FrameworkPresetId, FrameworkRecordType } from "./framework/presets.js";
export type {
  CaptureForDateInput,
  CreateRecordInput,
  FrameworkRecordTools,
  FrameworkRecordToolsOptions,
  RecordTypeSummary
} from "./framework/records.js";
export type {
  EffectiveFrameworkSchema,
  FrameworkKind,
  FrameworkSchema,
  FrameworkTypeDefinition,
  SchemaKind
} from "./framework/schema.js";
export type { CreateServerOptions } from "./server.js";
export type { ToolDefinition } from "./tools/registry.js";
export type {
  VaultWriteAuditStoreOptions,
  WriteAuditInput,
  WriteAuditMetadata,
  WriteAuditOperation,
  WriteAuditRow
} from "./vault/audit.js";
export type { FrontmatterValue, ParsedMarkdown } from "./vault/markdown.js";
export type { FolderEntry, ReadNoteResult, VaultReaderOptions } from "./vault/reader.js";
export type { VaultWriteErrorCode, VaultWriterOptions, WriteResult } from "./vault/writer.js";
export type { SearchFilters, SearchResult, VaultConflict, VaultIndexOptions } from "./vault/index.js";
export type { VaultReadTools, VaultWriteTools } from "./vault/tools.js";
