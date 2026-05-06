import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseMarkdown, type FrontmatterValue } from "./markdown.js";
import { normalizeVaultPath, resolveVaultPath } from "./path.js";

export type VaultWriteErrorCode =
  | "path_exists"
  | "path_missing"
  | "retryable_conflict"
  | "markers_missing";

export class VaultWriteError extends Error {
  readonly code: VaultWriteErrorCode;
  readonly currentSha256?: string;

  constructor(code: VaultWriteErrorCode, message: string, currentSha256?: string) {
    super(message);
    this.name = "VaultWriteError";
    this.code = code;
    if (currentSha256 !== undefined) {
      this.currentSha256 = currentSha256;
    }
  }
}

export interface VaultWriterOptions {
  vaultRoot: string;
  cooldownSeconds: number;
}

export interface WriteResult {
  path: string;
  baseSha256?: string;
  resultSha256: string;
}

export class VaultWriter {
  private readonly vaultRoot: string;
  private readonly cooldownMs: number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: VaultWriterOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.cooldownMs = options.cooldownSeconds * 1000;
  }

  async createNote(
    vaultPath: string,
    content: string,
    frontmatter?: Record<string, FrontmatterValue>
  ): Promise<WriteResult> {
    return this.withPathLock(vaultPath, async (normalizedPath) => {
      const absolutePath = resolveVaultPath(this.vaultRoot, normalizedPath);
      if (await exists(absolutePath)) {
        throw new VaultWriteError("path_exists", `Path already exists: ${normalizedPath}`);
      }

      const nextContent = withFrontmatter(content, frontmatter);
      await atomicWrite(absolutePath, nextContent);
      return {
        path: normalizedPath,
        resultSha256: sha256(nextContent)
      };
    });
  }

  async replaceNote(
    vaultPath: string,
    content: string,
    baseSha256: string,
    frontmatter?: Record<string, FrontmatterValue>
  ): Promise<WriteResult> {
    return this.updateExisting(vaultPath, baseSha256, () => withFrontmatter(content, frontmatter));
  }

  async updateFrontmatter(
    vaultPath: string,
    patch: Record<string, FrontmatterValue>,
    baseSha256: string
  ): Promise<WriteResult> {
    return this.updateExisting(vaultPath, baseSha256, (currentContent) => {
      const parsed = parseMarkdown(currentContent);
      return withFrontmatter(parsed.body, { ...parsed.frontmatter, ...patch });
    });
  }

  async replaceSectionByMarker(
    vaultPath: string,
    markerName: string,
    content: string,
    baseSha256: string
  ): Promise<WriteResult> {
    return this.updateExisting(vaultPath, baseSha256, (currentContent) => {
      const startMarker = `<!-- mcp:section ${markerName} start -->`;
      const endMarker = `<!-- mcp:section ${markerName} end -->`;
      const start = currentContent.indexOf(startMarker);
      const end = currentContent.indexOf(endMarker);
      if (start === -1 || end === -1 || end < start) {
        throw new VaultWriteError("markers_missing", `Markers missing for section: ${markerName}`);
      }

      const before = currentContent.slice(0, start + startMarker.length);
      const after = currentContent.slice(end);
      return `${before}\n${content}\n${after}`;
    });
  }

  private async updateExisting(
    vaultPath: string,
    baseSha256: string,
    buildNextContent: (currentContent: string) => string
  ): Promise<WriteResult> {
    return this.withPathLock(vaultPath, async (normalizedPath) => {
      const absolutePath = resolveVaultPath(this.vaultRoot, normalizedPath);
      if (!(await exists(absolutePath))) {
        throw new VaultWriteError("path_missing", `Path does not exist: ${normalizedPath}`);
      }

      await this.assertCooldownElapsed(absolutePath);
      const currentContent = await readFile(absolutePath, "utf8");
      const currentSha256 = sha256(currentContent);
      if (currentSha256 !== baseSha256) {
        throw new VaultWriteError(
          "retryable_conflict",
          `Stale base_sha256 for path: ${normalizedPath}`,
          currentSha256
        );
      }

      const nextContent = buildNextContent(currentContent);
      await atomicWrite(absolutePath, nextContent);
      return {
        path: normalizedPath,
        baseSha256,
        resultSha256: sha256(nextContent)
      };
    });
  }

  private async assertCooldownElapsed(absolutePath: string): Promise<void> {
    if (this.cooldownMs <= 0) {
      return;
    }
    const currentStat = await stat(absolutePath);
    if (Date.now() - currentStat.mtimeMs < this.cooldownMs) {
      throw new VaultWriteError("retryable_conflict", "Path is inside write cooldown window");
    }
  }

  private async withPathLock<T>(
    vaultPath: string,
    operation: (normalizedPath: string) => Promise<T>
  ): Promise<T> {
    const normalizedPath = normalizeVaultPath(vaultPath);
    const previous = this.locks.get(normalizedPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(normalizedPath, previous.then(() => current));

    await previous;
    try {
      return await operation(normalizedPath);
    } finally {
      release();
      if (this.locks.get(normalizedPath) === current) {
        this.locks.delete(normalizedPath);
      }
    }
  }
}

function withFrontmatter(
  content: string,
  frontmatter: Record<string, FrontmatterValue> | undefined
): string {
  if (frontmatter === undefined || Object.keys(frontmatter).length === 0) {
    return content;
  }
  return `---\n${serializeFrontmatter(frontmatter)}---\n${content}`;
}

function serializeFrontmatter(frontmatter: Record<string, FrontmatterValue>): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${serializeFrontmatterValue(value)}\n`)
    .join("");
}

function serializeFrontmatterValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return `[${value.join(", ")}]`;
  }
  return String(value);
}

async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, absolutePath);
}

async function exists(absolutePath: string): Promise<boolean> {
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
