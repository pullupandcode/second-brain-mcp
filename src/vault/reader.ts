import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseMarkdown, type ParsedMarkdown } from "./markdown.js";
import { isMarkdownPath, normalizeVaultPath, resolveExistingVaultPath } from "./path.js";
import { matchesVaultPathPattern, pathMatchesAnyPattern } from "./policy.js";

export interface VaultReaderOptions {
  vaultRoot: string;
  ignoredGlobs: string[];
  blockedPaths?: string[];
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
  readonly blockedPaths: string[];

  constructor(options: VaultReaderOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.ignoredGlobs = options.ignoredGlobs;
    this.blockedPaths = options.blockedPaths ?? [];
  }

  async readNote(inputPath: string): Promise<ReadNoteResult> {
    const vaultPath = normalizeVaultPath(inputPath);
    if (this.isBlocked(vaultPath)) {
      throw new Error("Vault path is blocked");
    }
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
    if (this.isBlocked(vaultPath)) {
      throw new Error("Vault path is blocked");
    }
    const absolutePath = await resolveExistingVaultPath(this.vaultRoot, vaultPath);
    const entries: FolderEntry[] = [];
    await this.collectFolderEntries(absolutePath, vaultPath, options.recursive === true, entries);
    return entries;
  }

  isIgnored(vaultPath: string): boolean {
    return pathMatchesAnyPattern(this.ignoredGlobs, vaultPath);
  }

  isBlocked(vaultPath: string): boolean {
    return pathMatchesAnyPattern(this.blockedPaths, vaultPath);
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
      if (this.isBlocked(normalizedChild)) {
        continue;
      }
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

export const matchesGlob = matchesVaultPathPattern;
