import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export function normalizeVaultPath(input: string): string {
  const normalizedSeparators = input.replaceAll("\\", "/");
  if (normalizedSeparators.startsWith("/")) {
    throw new Error("Vault path must be relative");
  }

  const parts = normalizedSeparators.split("/");
  if (parts.includes("..")) {
    throw new Error("Vault path must not contain traversal segments");
  }

  const normalized = path.posix.normalize(normalizedSeparators);
  if (normalized === ".") {
    return "";
  }

  return normalized;
}

export function resolveVaultPath(vaultRoot: string, input: string): string {
  const normalized = normalizeVaultPath(input);
  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedPath = path.resolve(resolvedRoot, normalized);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Vault path resolves outside the vault root");
  }

  return resolvedPath;
}

export async function resolveExistingVaultPath(vaultRoot: string, input: string): Promise<string> {
  const resolvedPath = resolveVaultPath(vaultRoot, input);
  const [realRoot, realPath] = await Promise.all([realpath(vaultRoot), realpath(resolvedPath)]);
  assertWithinVaultRoot(realRoot, realPath);
  return realPath;
}

export async function resolveVaultPathForWrite(vaultRoot: string, input: string): Promise<string> {
  const resolvedPath = resolveVaultPath(vaultRoot, input);
  const realRoot = await realpath(vaultRoot);
  const realParent = await realpath(await findExistingAncestor(path.dirname(resolvedPath)));
  assertWithinVaultRoot(realRoot, realParent);
  return resolvedPath;
}

export function isMarkdownPath(input: string): boolean {
  return input.toLowerCase().endsWith(".md");
}

async function findExistingAncestor(input: string): Promise<string> {
  let current = path.resolve(input);
  while (true) {
    if (await exists(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

async function exists(input: string): Promise<boolean> {
  try {
    await stat(input);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertWithinVaultRoot(realRoot: string, realPath: string): void {
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Vault path resolves outside the vault root");
  }
}
