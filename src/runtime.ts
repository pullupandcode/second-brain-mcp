import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ServerConfig } from "./config.js";
import { createDailyNoteTools } from "./framework/daily.js";
import type {
  DailyNoteAppendInput,
  DailyNoteConfig,
  DailyNoteRepairMarkersInput
} from "./framework/daily.js";
import { createFrameworkRecordTools } from "./framework/records.js";
import type {
  CaptureForDateInput,
  CreateRecordInput,
  InboxCaptureInput
} from "./framework/records.js";
import { FrameworkRegistryStore } from "./framework/registry.js";
import type { EffectiveFrameworkSchema } from "./framework/schema.js";
import { createFrameworkManagementTools } from "./framework/tools.js";
import type {
  FrameworkInitInput,
  FrameworkRegisterInput,
  FrameworkUnregisterInput
} from "./framework/tools.js";
import { createOcrTools, OcrJobQueue } from "./ocr/jobs.js";
import type { OcrNotebookInput } from "./ocr/jobs.js";
import { loadVaultSkills, type LoadVaultSkillsResult } from "./skills/loader.js";
import type { PromptProvider, ToolHandlerMap } from "./server.js";
import type { SearchResult } from "./vault/index.js";
import type { FrontmatterValue } from "./vault/markdown.js";
import { VaultWriteAuditStore, rotateWriteAuditIfNeeded } from "./vault/audit.js";
import { VaultIndex } from "./vault/index.js";
import { VaultReader } from "./vault/reader.js";
import { createVaultReadTools, createVaultWriteTools } from "./vault/tools.js";
import { VaultWriter } from "./vault/writer.js";

export interface RuntimeToolHandlers {
  handlers: ToolHandlerMap;
  promptProvider: PromptProvider;
  close(): void;
}

export async function createRuntimeToolHandlers(config: ServerConfig): Promise<RuntimeToolHandlers> {
  if (config.index.sqlitePath !== ":memory:") {
    await mkdir(path.dirname(config.index.sqlitePath), { recursive: true });
  }
  await mkdir(config.statePath, { recursive: true });

  const skillReader = new VaultReader({
    vaultRoot: config.vaultPath,
    ignoredGlobs: [...config.index.ignoredGlobs, ...config.index.blockedPaths]
  });
  let skillLoad = await loadVaultSkills({
    reader: skillReader,
    mapPaths: config.skills.mapPaths
  });
  const effectiveBlockedPaths = buildEffectiveBlockedPaths(config, skillLoad);
  const reader = new VaultReader({
    vaultRoot: config.vaultPath,
    ignoredGlobs: [...config.index.ignoredGlobs, ...config.index.blockedPaths],
    blockedPaths: effectiveBlockedPaths
  });
  const index = new VaultIndex({ reader, sqlitePath: config.index.sqlitePath });
  await index.rebuild();
  const readTools = createVaultReadTools(reader, index);
  const writer = new VaultWriter({
    vaultRoot: config.vaultPath,
    cooldownSeconds: config.writes.cooldownSeconds,
    blockedPaths: effectiveBlockedPaths,
    trashPath: config.deletes.trashPath
  });
  const writeAuditPath = path.join(config.statePath, "write-audit.sqlite");
  await rotateWriteAuditIfNeeded({
    sqlitePath: writeAuditPath,
    retentionMaxRows: config.audit.retentionMaxRows,
    archiveDirectory: config.audit.archivePath ?? path.join(config.statePath, "audit-archive")
  });
  const auditStore = new VaultWriteAuditStore({
    sqlitePath: writeAuditPath
  });
  const writeTools = createVaultWriteTools(writer, auditStore);
  const dailyNoteTools = createDailyNoteTools({
    reader,
    writeTools,
    config: defaultDailyNoteConfig()
  });
  const frameworkRegistry = new FrameworkRegistryStore({ vaultRoot: config.vaultPath });
  const frameworkManagementTools = createFrameworkManagementTools({
    reader,
    registry: frameworkRegistry,
    baseSchemaPath: config.framework.schemaPath
  });
  const frameworkRecordTools = async () =>
    createFrameworkRecordTools({
      schema: await frameworkManagementTools.framework_compose(),
      reader,
      index,
      writeTools
    });
  const reloadSkills = async (): Promise<LoadVaultSkillsResult> => {
    skillLoad = await loadVaultSkills({
      reader: skillReader,
      mapPaths: config.skills.mapPaths
    });
    replaceEffectiveBlockedPaths(effectiveBlockedPaths, config, skillLoad);
    return skillLoad;
  };
  const ocrTools = config.ocr.enabled ? createOcrTools(new OcrJobQueue()) : undefined;

  return {
    promptProvider: {
      listPrompts: () =>
        skillLoad.skills.map((skill) => ({
          name: skill.name,
          description: skill.description
        })),
      getPrompt: (name) => {
        const skill = skillLoad.skills.find((candidate) => candidate.name === name);
        if (skill === undefined) {
          return undefined;
        }
        return {
          description: skill.description,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: skill.content
              }
            }
          ]
        };
      }
    },
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
      daily_note_get: async (arguments_) => {
        const date = optionalString(arguments_, "date");
        return structuredResult(
          await dailyNoteTools.daily_note_get(date === undefined ? {} : { date })
        );
      },
      daily_note_append: async (arguments_) => {
        const input: DailyNoteAppendInput = {
          content: requireString(arguments_, "content"),
          baseSha256: requireString(arguments_, "base_sha256")
        };
        assignOptionalString(input, "date", optionalString(arguments_, "date"));
        assignOptionalString(input, "section", optionalString(arguments_, "section"));
        return structuredResult(await dailyNoteTools.daily_note_append(input));
      },
      daily_note_repair_markers: async (arguments_) => {
        const input: DailyNoteRepairMarkersInput = {
          baseSha256: requireString(arguments_, "base_sha256")
        };
        assignOptionalString(input, "date", optionalString(arguments_, "date"));
        return structuredResult(await dailyNoteTools.daily_note_repair_markers(input));
      },
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
      delete_note: async (arguments_) =>
        structuredResult(
          await writeTools.delete_note(
            requireString(arguments_, "path"),
            requireString(arguments_, "base_sha256")
          )
        ),
      hard_delete_note: async (arguments_) =>
        structuredResult(
          await writeTools.hard_delete_note(
            requireString(arguments_, "path"),
            requireString(arguments_, "base_sha256")
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
        }),
      find_maps: async (arguments_) =>
        structuredResult({
          maps: findMaps(
            index,
            await frameworkManagementTools.framework_compose(),
            optionalString(arguments_, "topic")
          )
        }),
      get_vault_structure: async () =>
        structuredResult({
          folders: (await readTools.list_folder("", false)).sort((left, right) =>
            left.path.localeCompare(right.path)
          ),
          recordTypes: (await frameworkRecordTools()).list_record_types()
        }),
      list_write_recovery_diagnostics: () =>
        structuredResult({ incompleteWrites: auditStore.listIncompleteWrites() }),
      skills_list: () =>
        structuredResult({
          mapPaths: config.skills.mapPaths,
          skills: skillLoad.statuses
        }),
      skills_reload: async () => {
        const result = await reloadSkills();
        return structuredResult({
          mapPaths: config.skills.mapPaths,
          skills: result.statuses
        });
      },
      framework_init: async (arguments_) => {
        const input: FrameworkInitInput = {
          framework: requireFrameworkPreset(arguments_, "framework")
        };
        assignOptionalString(input, "outputPath", optionalString(arguments_, "output_path"));
        const mode = optionalFrameworkInitMode(arguments_, "mode");
        if (mode !== undefined) {
          input.mode = mode;
        }
        return structuredResult(await frameworkManagementTools.framework_init(input));
      },
      framework_register: async (arguments_) => {
        const input: FrameworkRegisterInput = {
          name: requireString(arguments_, "name"),
          path: requireString(arguments_, "path")
        };
        const priority = optionalInteger(arguments_, "priority");
        if (priority !== undefined) {
          input.priority = priority;
        }
        return structuredResult(await frameworkManagementTools.framework_register(input));
      },
      framework_unregister: async (arguments_) => {
        const input: FrameworkUnregisterInput = {
          name: requireString(arguments_, "name")
        };
        return structuredResult(await frameworkManagementTools.framework_unregister(input));
      },
      framework_list: async () => structuredResult(await frameworkManagementTools.framework_list()),
      framework_reload: async () =>
        structuredResult(await frameworkManagementTools.framework_reload()),
      framework_compose: async () =>
        structuredResult(await frameworkManagementTools.framework_compose()),
      ...(ocrTools === undefined
        ? {}
        : {
            ocr_notebook: (arguments_) => {
              const input: OcrNotebookInput = {
                identifier: requireString(arguments_, "identifier")
              };
              const pages = optionalIntegerArray(arguments_, "pages");
              if (pages !== undefined) {
                input.pages = pages;
              }
              const force = optionalBoolean(arguments_, "force");
              if (force !== undefined) {
                input.force = force;
              }
              return structuredResult(ocrTools.ocr_notebook(input));
            },
            ocr_status: (arguments_) =>
              structuredResult(ocrTools.ocr_status(requireString(arguments_, "job_id"))),
            ocr_renumber_notebook: (arguments_) =>
              structuredResult(
                ocrTools.ocr_renumber_notebook(requireString(arguments_, "notebook_id"))
              )
          })
    },
    close: () => {
      index.close();
      auditStore.close();
    }
  };
}

function buildEffectiveBlockedPaths(
  config: ServerConfig,
  skillLoad: LoadVaultSkillsResult
): string[] {
  const paths = new Set<string>(config.security.blockedPaths);
  for (const mapPath of config.skills.mapPaths) {
    paths.add(mapPath);
  }
  for (const status of skillLoad.statuses) {
    paths.add(status.path);
  }
  return [...paths];
}

function replaceEffectiveBlockedPaths(
  effectiveBlockedPaths: string[],
  config: ServerConfig,
  skillLoad: LoadVaultSkillsResult
): void {
  effectiveBlockedPaths.splice(
    0,
    effectiveBlockedPaths.length,
    ...buildEffectiveBlockedPaths(config, skillLoad)
  );
}

function findMaps(
  index: VaultIndex,
  schema: EffectiveFrameworkSchema,
  topic: string | undefined
): SearchResult[] {
  const query = topic ?? "";
  const byPath = new Map<string, SearchResult>();
  for (const folder of mapFolders(schema)) {
    for (const result of index.search(query, { folder })) {
      byPath.set(result.path, result);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function mapFolders(schema: EffectiveFrameworkSchema): string[] {
  const folders = new Set<string>();
  for (const [name, definition] of Object.entries(schema.types)) {
    const searchable = `${name} ${definition.description ?? ""} ${definition.folder}`.toLowerCase();
    if (searchable.includes("map") || searchable.includes("index")) {
      folders.add(definition.folder);
    }
  }
  return [...folders];
}

function defaultDailyNoteConfig(): DailyNoteConfig {
  return {
    path: "Calendar/Days/{date:YYYY-MM-DD}.md",
    template: "x/Templates/Daily Template.md",
    sections: [
      {
        name: "agenda",
        markerName: "agenda",
        writable: false
      },
      {
        name: "daily-log",
        markerName: "daily-captures",
        writable: true,
        defaultForAppend: true
      },
      {
        name: "last-light",
        markerName: "last-light-summary",
        writable: true
      }
    ]
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

function optionalInteger(arguments_: Record<string, unknown>, name: string): number | undefined {
  const value = arguments_[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function optionalIntegerArray(
  arguments_: Record<string, unknown>,
  name: string
): number[] | undefined {
  const value = arguments_[name];
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isInteger(item))
  ) {
    throw new Error(`${name} must be an array of integers`);
  }
  return value;
}

function requireFrameworkPreset(
  arguments_: Record<string, unknown>,
  name: string
): "lyt" | "para" | "zettel" {
  const value = requireString(arguments_, name);
  if (value === "lyt" || value === "para" || value === "zettel") {
    return value;
  }
  throw new Error(`${name} must be lyt, para, or zettel`);
}

function optionalFrameworkInitMode(
  arguments_: Record<string, unknown>,
  name: string
): "create" | "overwrite" | undefined {
  const value = optionalString(arguments_, name);
  if (value === undefined || value === "create" || value === "overwrite") {
    return value;
  }
  throw new Error(`${name} must be create or overwrite`);
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
