import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { composeFrameworkSchemas, parseFrameworkSchema, type EffectiveFrameworkSchema } from "./schema.js";
import { type FrameworkOverlayRegistration, type FrameworkRegistryStore } from "./registry.js";
import { getFrameworkPreset, type FrameworkPresetId } from "./presets.js";
import type { VaultReader } from "../vault/reader.js";
import { resolveExistingVaultPath, resolveVaultPathForWrite } from "../vault/path.js";
import { VaultWriteError } from "../vault/writer.js";

export interface FrameworkManagementToolsOptions {
  reader: VaultReader;
  registry: FrameworkRegistryStore;
  baseSchemaPath?: string;
}

export interface FrameworkRegisterInput {
  name: string;
  path: string;
  priority?: number;
}

export interface FrameworkUnregisterInput {
  name: string;
}

export interface FrameworkInitInput {
  framework: FrameworkPresetId;
  outputPath?: string;
  mode?: "create" | "overwrite";
}

export interface FrameworkInitResult {
  path: string;
  framework: FrameworkPresetId;
  created: boolean;
  overwritten: boolean;
}

export interface FrameworkOverlayStatus extends FrameworkOverlayRegistration {
  status: "registered" | "loaded" | "error";
  error?: string;
}

export interface FrameworkReloadResult {
  ok: boolean;
  overlays: FrameworkOverlayStatus[];
}

export interface FrameworkUnregisterResult {
  removed: boolean;
}

export interface FrameworkManagementTools {
  framework_init(input: FrameworkInitInput): Promise<FrameworkInitResult>;
  framework_register(input: FrameworkRegisterInput): Promise<FrameworkOverlayStatus[]>;
  framework_unregister(input: FrameworkUnregisterInput): Promise<FrameworkUnregisterResult>;
  framework_list(): Promise<FrameworkOverlayStatus[]>;
  framework_reload(): Promise<FrameworkReloadResult>;
  framework_compose(): Promise<EffectiveFrameworkSchema>;
}

export function createFrameworkManagementTools(
  options: FrameworkManagementToolsOptions
): FrameworkManagementTools {
  return {
    framework_init: (input) => frameworkInit(options, input),
    framework_register: async (input) =>
      toRegisteredStatuses(
        await options.registry.register({
          name: input.name,
          path: input.path,
          priority: input.priority ?? 100
        })
      ),
    framework_unregister: async (input) => ({
      removed: await options.registry.unregister(input.name)
    }),
    framework_list: async () => toRegisteredStatuses(await options.registry.list()),
    framework_reload: () => reloadFramework(options),
    framework_compose: () => composeFramework(options)
  };
}

async function frameworkInit(
  options: FrameworkManagementToolsOptions,
  input: FrameworkInitInput
): Promise<FrameworkInitResult> {
  const outputPath = input.outputPath ?? "_meta/framework.yaml";
  const absolutePath = await resolveVaultPathForWrite(options.reader.vaultRoot, outputPath);
  const source = materializePresetSchema(input.framework);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  if (input.mode !== "overwrite") {
    try {
      await writeFile(absolutePath, source, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new VaultWriteError("path_exists", `Path already exists: ${outputPath}`);
      }
      throw error;
    }
    return {
      path: outputPath,
      framework: input.framework,
      created: true,
      overwritten: false
    };
  }

  const exists = await fileExists(absolutePath);
  await writeFile(absolutePath, source, "utf8");
  return {
    path: outputPath,
    framework: input.framework,
    created: !exists,
    overwritten: exists
  };
}

async function composeFramework(
  options: FrameworkManagementToolsOptions
): Promise<EffectiveFrameworkSchema> {
  const base = parseFrameworkSchema(
    await readVaultText(options.reader, options.baseSchemaPath ?? "_meta/framework.yaml")
  );
  const overlays = [];
  for (const registration of await options.registry.list()) {
    overlays.push(parseFrameworkSchema(await readVaultText(options.reader, registration.path)));
  }
  return composeFrameworkSchemas(base, overlays);
}

async function reloadFramework(
  options: FrameworkManagementToolsOptions
): Promise<FrameworkReloadResult> {
  const statuses: FrameworkOverlayStatus[] = [];
  for (const registration of await options.registry.list()) {
    try {
      parseFrameworkSchema(await readVaultText(options.reader, registration.path));
      statuses.push({ ...registration, status: "loaded" });
    } catch (error) {
      statuses.push({
        ...registration,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    ok: statuses.every((status) => status.status !== "error"),
    overlays: statuses
  };
}

async function readVaultText(reader: VaultReader, vaultPath: string): Promise<string> {
  return readFile(await resolveExistingVaultPath(reader.vaultRoot, vaultPath), "utf8");
}

function materializePresetSchema(framework: FrameworkPresetId): string {
  const preset = getFrameworkPreset(framework);
  if (preset === undefined) {
    throw new Error(`Unknown framework preset: ${framework}`);
  }
  const lines = [
    "version: 1",
    "schema_kind: base",
    `framework: ${preset.id}`,
    `description: "${preset.name} starter schema"`,
    "",
    "types:"
  ];
  for (const type of preset.types) {
    lines.push(
      `  ${type.name}:`,
      `    description: "${type.description}"`,
      `    folder: ${type.defaultFolder}`,
      `    filename: "{title}.md"`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function toRegisteredStatuses(
  registrations: FrameworkOverlayRegistration[]
): FrameworkOverlayStatus[] {
  return registrations.map((registration) => ({
    ...registration,
    status: "registered"
  }));
}
