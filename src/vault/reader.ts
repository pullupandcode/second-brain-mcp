import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseMarkdown, type ParsedMarkdown } from "./markdown.js";
import { isMarkdownPath, normalizeVaultPath, resolveExistingVaultPath } from "./path.js";

export interface VaultReaderOptions {
  vaultRoot: string;
  ignoredGlobs: string[];
}

export interface ReadNoteResult {
  path: string;
  content: string;
  currentSha256: string;
  parsed: ParsedMarkdown;
}

export interface FolderEntry {
  path: string;
  type: "file" | "directory";
}

export class VaultReader {
  readonly vaultRoot: string;
  readonly ignoredGlobs: string[];

  constructor(options: VaultReaderOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.ignoredGlobs = options.ignoredGlobs;
  }

  async readNote(inputPath: string): Promise<ReadNoteResult> {
    const vaultPath = normalizeVaultPath(inputPath);
    if (this.isIgnored(vaultPath)) {
      throw new Error(`Vault path is ignored: ${vaultPath}`);
    }
    if (!isMarkdownPath(vaultPath)) {
      throw new Error(`Vault path is not a markdown note: ${vaultPath}`);
    }

    const content = await readFile(await resolveExistingVaultPath(this.vaultRoot, vaultPath), "utf8");
    return {
      path: vaultPath,
      content,
      currentSha256: sha256(content),
      parsed: parseMarkdown(content)
    };
  }

  async listFolder(
    inputPath: string,
    options: { recursive?: boolean } = {}
  ): Promise<FolderEntry[]> {
    const vaultPath = normalizeVaultPath(inputPath);
    const absolutePath = await resolveExistingVaultPath(this.vaultRoot, vaultPath);
    const entries: FolderEntry[] = [];
    await this.collectFolderEntries(absolutePath, vaultPath, options.recursive === true, entries);
    return entries;
  }

  isIgnored(vaultPath: string): boolean {
    return this.ignoredGlobs.some((pattern) => matchesGlob(pattern, vaultPath));
  }

  private async collectFolderEntries(
    absolutePath: string,
    vaultPath: string,
    recursive: boolean,
    output: FolderEntry[]
  ): Promise<void> {
    const dirEntries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of dirEntries) {
      const childVaultPath = vaultPath.length === 0 ? entry.name : `${vaultPath}/${entry.name}`;
      const normalizedChild = normalizeVaultPath(childVaultPath);
      if (this.isIgnored(normalizedChild)) {
        continue;
      }

      const childAbsolutePath = path.join(absolutePath, entry.name);
      const childStat = await lstat(childAbsolutePath);
      if (childStat.isDirectory()) {
        if (recursive) {
          await this.collectFolderEntries(childAbsolutePath, normalizedChild, recursive, output);
        } else {
          output.push({ path: normalizedChild, type: "directory" });
        }
      } else if (childStat.isFile() && isMarkdownPath(normalizedChild)) {
        output.push({ path: normalizedChild, type: "file" });
      }
    }
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function matchesGlob(pattern: string, vaultPath: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -"/**".length);
    return vaultPath === prefix || vaultPath.startsWith(`${prefix}/`);
  }
  if (pattern === "**/*.sync-conflict-*") {
    return path.basename(vaultPath).includes(".sync-conflict-");
  }
  if (pattern.startsWith("**/*")) {
    const suffix = pattern.slice("**/*".length);
    return vaultPath.endsWith(suffix);
  }
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(vaultPath);
  }
  return vaultPath === pattern;
}
