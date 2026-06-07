import path from "node:path";

export function pathMatchesAnyPattern(patterns: readonly string[], vaultPath: string): boolean {
  return patterns.some((pattern) => matchesVaultPathPattern(pattern, vaultPath));
}

export function matchesVaultPathPattern(pattern: string, vaultPath: string): boolean {
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
