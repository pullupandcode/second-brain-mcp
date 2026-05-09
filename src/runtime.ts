import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ServerConfig } from "./config.js";
import { createFrameworkRecordTools } from "./framework/records.js";
import type {
  CaptureForDateInput,
  CreateRecordInput,
  InboxCaptureInput
} from "./framework/records.js";
import { FrameworkRegistryStore } from "./framework/registry.js";
import { createFrameworkManagementTools } from "./framework/tools.js";
import type { ToolHandlerMap } from "./server.js";
import type { FrontmatterValue } from "./vault/markdown.js";
import { VaultWriteAuditStore } from "./vault/audit.js";
import { VaultIndex } from "./vault/index.js";
import { VaultReader } from "./vault/reader.js";
import { createVaultReadTools, createVaultWriteTools } from "./vault/tools.js";
import { VaultWriter } from "./vault/writer.js";

export interface RuntimeToolHandlers {
  handlers: ToolHandlerMap;
  close(): void;
}

export async function createRuntimeToolHandlers(config: ServerConfig): Promise<RuntimeToolHandlers> {
  if (config.index.sqlitePath !== ":memory:") {
    await mkdir(path.dirname(config.index.sqlitePath), { recursive: true });
  }
  await mkdir(config.statePath, { recursive: true });

  const reader = new VaultReader({
    vaultRoot: config.vaultPath,
    ignoredGlobs: config.index.ignoredGlobs
  });
  const index = new VaultIndex({ reader, sqlitePath: config.index.sqlitePath });
  await index.rebuild();
  const readTools = createVaultReadTools(reader, index);
  const writer = new VaultWriter({
    vaultRoot: config.vaultPath,
    cooldownSeconds: config.writes.cooldownSeconds
  });
  const auditStore = new VaultWriteAuditStore({
    sqlitePath: path.join(config.statePath, "write-audit.sqlite")
  });
  const writeTools = createVaultWriteTools(writer, auditStore);
  const frameworkRegistry = new FrameworkRegistryStore({ vaultRoot: config.vaultPath });
  const frameworkManagementTools = createFrameworkManagementTools({
    reader,
    registry: frameworkRegistry
  });
  const frameworkRecordTools = async () =>
    createFrameworkRecordTools({
      schema: await frameworkManagementTools.framework_compose(),
      reader,
      index,
      writeTools
    });

  return {
    handlers: {
      read_note: async (arguments_) =>
        structuredResult(await readTools.read_note(requireString(arguments_, "path"))),
      list_folder: async (arguments_) =>
        structuredResult(
          await readTools.list_folder(
            requireString(arguments_, "path"),
            optionalBoolean(arguments_, "recursive")
          )
        ),
      search: (arguments_) =>
        structuredResult(
          readTools.search(requireString(arguments_, "query"), optionalRecord(arguments_, "filters"))
        ),
      get_backlinks: (arguments_) =>
        structuredResult({ backlinks: readTools.get_backlinks(requireString(arguments_, "path")) }),
      get_outgoing_links: (arguments_) =>
        structuredResult({
          outgoingLinks: readTools.get_outgoing_links(requireString(arguments_, "path"))
        }),
      list_vault_conflicts: () => structuredResult({ conflicts: readTools.list_vault_conflicts() }),
      link_to_page: (arguments_) =>
        structuredResult({
          link: readTools.link_to_page(
            requireString(arguments_, "notebook"),
            requireString(arguments_, "page_uuid")
          )
        }),
      create_note: async (arguments_) =>
        structuredResult(
          await writeTools.create_note(
            requireString(arguments_, "path"),
            requireString(arguments_, "content"),
            optionalFrontmatter(arguments_, "frontmatter")
          )
        ),
      replace_note: async (arguments_) =>
        structuredResult(
          await writeTools.replace_note(
            requireString(arguments_, "path"),
            requireString(arguments_, "content"),
            requireString(arguments_, "base_sha256"),
            optionalFrontmatter(arguments_, "frontmatter")
          )
        ),
      update_frontmatter: async (arguments_) =>
        structuredResult(
          await writeTools.update_frontmatter(
            requireString(arguments_, "path"),
            requireFrontmatter(arguments_, "patch"),
            requireString(arguments_, "base_sha256")
          )
        ),
      replace_section_by_marker: async (arguments_) =>
        structuredResult(
          await writeTools.replace_section_by_marker(
            requireString(arguments_, "path"),
            requireString(arguments_, "marker_name"),
            requireString(arguments_, "content"),
            requireString(arguments_, "base_sha256")
          )
        ),
      create_record: async (arguments_) => {
        const input: CreateRecordInput = {
          type: requireString(arguments_, "type"),
          title: requireString(arguments_, "title")
        };
        assignOptionalString(input, "date", optionalString(arguments_, "date"));
        assignOptionalString(input, "body", optionalString(arguments_, "body"));
        assignOptionalRecord(input, "fields", optionalFrontmatter(arguments_, "fields"));
        return structuredResult(await (await frameworkRecordTools()).create_record(input));
      },
      inbox_capture: async (arguments_) => {
        const input: InboxCaptureInput = {
          content: requireString(arguments_, "content"),
          sourceClient: requireString(arguments_, "source_client")
        };
        assignOptionalString(input, "date", optionalString(arguments_, "date"));
        assignOptionalString(input, "sourceId", optionalString(arguments_, "source_id"));
        assignOptionalString(input, "captureType", optionalString(arguments_, "capture_type"));
        assignOptionalString(input, "title", optionalString(arguments_, "title"));
        const strategy = optionalCaptureStrategy(arguments_, "strategy");
        if (strategy !== undefined) {
          input.strategy = strategy;
        }
        return structuredResult(await (await frameworkRecordTools()).inbox_capture(input));
      },
      capture_for_date: async (arguments_) => {
        const input: CaptureForDateInput = {
          content: requireString(arguments_, "content"),
          sourceClient: requireString(arguments_, "source_client")
        };
        assignOptionalString(input, "date", optionalString(arguments_, "date"));
        assignOptionalString(input, "sourceId", optionalString(arguments_, "source_id"));
        assignOptionalString(input, "captureType", optionalString(arguments_, "capture_type"));
        assignOptionalString(input, "title", optionalString(arguments_, "title"));
        return structuredResult(await (await frameworkRecordTools()).capture_for_date(input));
      },
      list_record_types: async () =>
        structuredResult({
          recordTypes: (await frameworkRecordTools()).list_record_types()
        })
    },
    close: () => {
      index.close();
      auditStore.close();
    }
  };
}

function structuredResult(value: unknown): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
} {
  const structuredContent =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent
  };
}

function requireString(arguments_: Record<string, unknown>, name: string): string {
  const value = arguments_[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function assignOptionalString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: string | undefined
): void {
  if (value !== undefined) {
    target[key] = value as T[K];
  }
}

function assignOptionalRecord<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: Record<string, FrontmatterValue> | undefined
): void {
  if (value !== undefined) {
    target[key] = value as T[K];
  }
}

function optionalString(arguments_: Record<string, unknown>, name: string): string | undefined {
  const value = arguments_[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function optionalBoolean(arguments_: Record<string, unknown>, name: string): boolean | undefined {
  const value = arguments_[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function optionalRecord(
  arguments_: Record<string, unknown>,
  name: string
): Record<string, unknown> | undefined {
  const value = arguments_[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalCaptureStrategy(
  arguments_: Record<string, unknown>,
  name: string
): "create" | "replace_by_source_id" | undefined {
  const value = optionalString(arguments_, name);
  if (value === undefined || value === "create" || value === "replace_by_source_id") {
    return value;
  }
  throw new Error(`${name} must be create or replace_by_source_id`);
}

function optionalFrontmatter(
  arguments_: Record<string, unknown>,
  name: string
): Record<string, FrontmatterValue> | undefined {
  const record = optionalRecord(arguments_, name);
  if (record === undefined) {
    return undefined;
  }
  return toFrontmatterRecord(record, name);
}

function requireFrontmatter(
  arguments_: Record<string, unknown>,
  name: string
): Record<string, FrontmatterValue> {
  return toFrontmatterRecord(requireRecord(arguments_, name), name);
}

function requireRecord(arguments_: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = arguments_[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toFrontmatterRecord(
  record: Record<string, unknown>,
  name: string
): Record<string, FrontmatterValue> {
  const frontmatter: Record<string, FrontmatterValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isFrontmatterValue(value)) {
      frontmatter[key] = value;
      continue;
    }
    throw new Error(`${name}.${key} must be a frontmatter value`);
  }
  return frontmatter;
}

function isFrontmatterValue(value: unknown): value is FrontmatterValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}
