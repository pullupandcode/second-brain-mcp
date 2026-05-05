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

export function isMarkdownPath(input: string): boolean {
  return input.toLowerCase().endsWith(".md");
}
