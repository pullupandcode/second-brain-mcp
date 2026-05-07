import { readFile } from "node:fs/promises";

import { composeFrameworkSchemas, parseFrameworkSchema, type EffectiveFrameworkSchema } from "./schema.js";
import { type FrameworkOverlayRegistration, type FrameworkRegistryStore } from "./registry.js";
import type { VaultReader } from "../vault/reader.js";
import { resolveVaultPath } from "../vault/path.js";

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

function readVaultText(reader: VaultReader, vaultPath: string): Promise<string> {
  return readFile(resolveVaultPath(reader.vaultRoot, vaultPath), "utf8");
}

function toRegisteredStatuses(
  registrations: FrameworkOverlayRegistration[]
): FrameworkOverlayStatus[] {
  return registrations.map((registration) => ({
    ...registration,
    status: "registered"
  }));
}
