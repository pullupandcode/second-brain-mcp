import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeVaultPath, resolveVaultPath } from "../vault/path.js";

export interface FrameworkRegistryStoreOptions {
  vaultRoot: string;
  registryPath?: string;
}

export interface FrameworkOverlayRegistration {
  name: string;
  path: string;
  priority: number;
}

interface RegistryFile {
  overlays?: unknown;
}

export class FrameworkRegistryStore {
  private readonly vaultRoot: string;
  private readonly registryPath: string;

  constructor(options: FrameworkRegistryStoreOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.registryPath = normalizeVaultPath(options.registryPath ?? "_meta/schemas.json");
  }

  async list(): Promise<FrameworkOverlayRegistration[]> {
    return sortRegistrations(await this.readRegistry());
  }

  async register(registration: FrameworkOverlayRegistration): Promise<FrameworkOverlayRegistration[]> {
    const normalized = normalizeRegistration(registration);
    resolveVaultPath(this.vaultRoot, normalized.path);
    const existing = await this.readRegistry();
    const withoutExisting = existing.filter((candidate) => candidate.name !== normalized.name);
    const next = sortRegistrations([...withoutExisting, normalized]);
    await this.writeRegistry(next);
    return next;
  }

  async unregister(name: string): Promise<boolean> {
    const existing = await this.readRegistry();
    const next = existing.filter((candidate) => candidate.name !== name);
    if (next.length === existing.length) {
      return false;
    }
    await this.writeRegistry(next);
    return true;
  }

  private async readRegistry(): Promise<FrameworkOverlayRegistration[]> {
    const absolutePath = resolveVaultPath(this.vaultRoot, this.registryPath);
    if (!(await exists(absolutePath))) {
      return [];
    }
    const raw = JSON.parse(await readFile(absolutePath, "utf8")) as RegistryFile;
    if (!Array.isArray(raw.overlays)) {
      return [];
    }
    return raw.overlays.map(readRegistration);
  }

  private async writeRegistry(overlays: FrameworkOverlayRegistration[]): Promise<void> {
    const absolutePath = resolveVaultPath(this.vaultRoot, this.registryPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
    await writeFile(`${tempPath}`, `${JSON.stringify({ overlays }, null, 2)}\n`, "utf8");
    await rename(tempPath, absolutePath);
  }
}

function readRegistration(value: unknown): FrameworkOverlayRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("overlay registration must be an object");
  }
  const raw = value as Record<string, unknown>;
  return normalizeRegistration({
    name: readString(raw.name, "overlay.name"),
    path: readString(raw.path, "overlay.path"),
    priority: readPriority(raw.priority)
  });
}

function normalizeRegistration(
  registration: FrameworkOverlayRegistration
): FrameworkOverlayRegistration {
  return {
    name: readString(registration.name, "overlay.name"),
    path: normalizeVaultPath(readString(registration.path, "overlay.path")),
    priority: readPriority(registration.priority)
  };
}

function sortRegistrations(
  registrations: FrameworkOverlayRegistration[]
): FrameworkOverlayRegistration[] {
  return [...registrations].sort(
    (left, right) => left.priority - right.priority || left.name.localeCompare(right.name)
  );
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function readPriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("overlay.priority must be an integer");
  }
  return value;
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
