import path from "node:path";

import { parseMarkdown } from "../vault/markdown.js";
import { isMarkdownPath, normalizeVaultPath } from "../vault/path.js";
import type { VaultReader } from "../vault/reader.js";

export interface LoadVaultSkillsOptions {
  reader: VaultReader;
  mapPaths: string[];
}

export interface LoadedVaultSkill {
  name: string;
  description: string;
  path: string;
  content: string;
}

export interface VaultSkillStatus {
  path: string;
  status: "loaded" | "error";
  name?: string;
  description?: string;
  error?: string;
}

export interface LoadVaultSkillsResult {
  skills: LoadedVaultSkill[];
  statuses: VaultSkillStatus[];
}

export async function loadVaultSkills(
  options: LoadVaultSkillsOptions
): Promise<LoadVaultSkillsResult> {
  const normalizedMapPaths = new Set(options.mapPaths.map(normalizeVaultPath));
  const mapResult = await readLinkedSkillPaths(options.reader, options.mapPaths);
  const statuses: VaultSkillStatus[] = [];
  const byName = new Map<string, LoadedVaultSkill>();

  statuses.push(...mapResult.statuses);
  for (const skillPath of mapResult.linkedPaths) {
    if (normalizedMapPaths.has(skillPath)) {
      continue;
    }
    try {
      const note = await options.reader.readNote(skillPath);
      const skill = parseSkillNote(note.path, note.content);
      statuses.push({
        path: skill.path,
        status: "loaded",
        name: skill.name,
        description: skill.description
      });
      byName.set(skill.name, skill);
    } catch (error) {
      statuses.push({
        path: skillPath,
        status: "error",
        error: skillLoadErrorMessage(error)
      });
    }
  }

  return {
    skills: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    statuses
  };
}

async function readLinkedSkillPaths(
  reader: VaultReader,
  mapPaths: string[]
): Promise<{ linkedPaths: string[]; statuses: VaultSkillStatus[] }> {
  const linkedPaths = new Set<string>();
  const statuses: VaultSkillStatus[] = [];
  for (const mapPath of mapPaths) {
    const normalizedMapPath = normalizeVaultPath(mapPath);
    let map;
    try {
      map = await reader.readNote(normalizedMapPath);
    } catch (error) {
      statuses.push({
        path: normalizedMapPath,
        status: "error",
        error: skillLoadErrorMessage(error)
      });
      continue;
    }
    const mapDir = path.posix.dirname(normalizedMapPath);
    for (const linkPath of extractSkillLinks(map.content, mapDir === "." ? "" : mapDir)) {
      linkedPaths.add(linkPath);
    }
  }
  return { linkedPaths: [...linkedPaths].sort(), statuses };
}

function parseSkillNote(skillPath: string, source: string): LoadedVaultSkill {
  const parsed = parseMarkdown(source);
  const name = stringField(parsed.frontmatter.name);
  const description = stringField(parsed.frontmatter.description);
  const content = parsed.body.trim();

  if (name === undefined || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("skill frontmatter name must be a slug");
  }
  if (description === undefined) {
    throw new Error("skill frontmatter description must be a non-empty string");
  }
  if (content.length === 0) {
    throw new Error("skill body must not be empty");
  }

  return {
    name,
    description,
    path: skillPath,
    content
  };
}

function extractSkillLinks(source: string, mapDir: string): string[] {
  const links = new Set<string>();
  for (const target of extractExplicitPathHints(source)) {
    links.add(target);
  }

  for (const match of source.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const target = match[1]?.trim();
    if (target !== undefined && target.length > 0) {
      links.add(normalizeVaultPath(isMarkdownPath(target) ? target : `${target}.md`));
    }
  }

  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]?.trim();
    if (target === undefined || !shouldLoadMarkdownLink(target)) {
      continue;
    }
    const withoutFragment = target.split("#")[0] ?? "";
    const resolvedPath = path.posix.normalize(path.posix.join(mapDir, withoutFragment));
    links.add(normalizeVaultPath(resolvedPath));
  }

  return [...links].filter(isMarkdownPath).sort();
}

function extractExplicitPathHints(source: string): string[] {
  const paths = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const match = /(?:^|\s)(?:\*\*)?Path(?:\*\*)?\s*:\s*(.+)$/i.exec(line);
    const rawPath = match?.[1]?.trim();
    if (rawPath === undefined || rawPath.length === 0) {
      continue;
    }
    const pathValue = stripPathHintMarkup(rawPath);
    if (pathValue.length === 0) {
      continue;
    }
    paths.add(normalizeVaultPath(isMarkdownPath(pathValue) ? pathValue : `${pathValue}.md`));
  }
  return [...paths];
}

function stripPathHintMarkup(value: string): string {
  const firstToken = value.split(/\s+/)[0] ?? "";
  return firstToken
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\/+/, "")
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .trim();
}

function shouldLoadMarkdownLink(target: string): boolean {
  if (target.startsWith("#") || target.startsWith("/")) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    return false;
  }
  return isMarkdownPath(target.split("#")[0] ?? "");
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "|" || trimmed === ">") {
    return undefined;
  }
  return trimmed;
}

function skillLoadErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "Vault path does not exist";
    }
    if (typeof code === "string") {
      return "Vault path could not be read";
    }
    return error.message.includes("outside the vault root") ? "Vault path is invalid" : error.message;
  }
  return "Skill load failed";
}
