import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ServerConfig } from "./config.js";
import type { ToolHandlerMap } from "./server.js";
import { VaultIndex } from "./vault/index.js";
import { VaultReader } from "./vault/reader.js";
import { createVaultReadTools } from "./vault/tools.js";

export interface RuntimeToolHandlers {
  handlers: ToolHandlerMap;
  close(): void;
}

export async function createRuntimeToolHandlers(config: ServerConfig): Promise<RuntimeToolHandlers> {
  if (config.index.sqlitePath !== ":memory:") {
    await mkdir(path.dirname(config.index.sqlitePath), { recursive: true });
  }

  const reader = new VaultReader({
    vaultRoot: config.vaultPath,
    ignoredGlobs: config.index.ignoredGlobs
  });
  const index = new VaultIndex({ reader, sqlitePath: config.index.sqlitePath });
  await index.rebuild();
  const readTools = createVaultReadTools(reader, index);

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
        })
    },
    close: () => index.close()
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
