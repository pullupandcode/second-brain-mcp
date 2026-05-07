import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

export type CaptureDefaultPattern = "A" | "B";

export interface ServerConfig {
  listen: string;
  publicBaseUrl: URL;
  vaultPath: string;
  statePath: string;
  auth: {
    audience: string;
    trustedIssuers: URL[];
    discoveryAuthorizationServer: URL;
    jwksCacheTtlSeconds: number;
  };
  index: {
    sqlitePath: string;
    watcherPolling: boolean;
    ignoredGlobs: string[];
  };
  writes: {
    cooldownSeconds: number;
  };
  dailyNote: {
    captureDefaultPattern: CaptureDefaultPattern;
  };
  logging: {
    logArgs: boolean;
  };
}

interface RawConfig {
  listen?: unknown;
  public_base_url?: unknown;
  vault_path?: unknown;
  state_path?: unknown;
  auth?: {
    audience?: unknown;
    trusted_issuers?: unknown;
    discovery_authorization_server?: unknown;
    jwks_cache_ttl_seconds?: unknown;
  };
  index?: {
    sqlite_path?: unknown;
    watcher_polling?: unknown;
    ignored_globs?: unknown;
  };
  writes?: {
    cooldown_seconds?: unknown;
  };
  daily_note?: {
    capture_default_pattern?: unknown;
  };
  logging?: {
    log_args?: unknown;
  };
}

export async function loadConfig(path: string): Promise<ServerConfig> {
  return parseConfig(await readFile(path, "utf8"));
}

export function parseConfig(source: string): ServerConfig {
  const raw = parseToml(source) as RawConfig;
  const listen = requireString(raw.listen, "listen");
  const publicBaseUrl = requireHttpUrl(raw.public_base_url, "public_base_url");
  const vaultPath = requireString(raw.vault_path, "vault_path");
  const statePath = requireString(raw.state_path, "state_path");
  const auth = requireObject(raw.auth, "auth");
  const index = requireObject(raw.index, "index");
  const writes = requireObject(raw.writes, "writes");
  const dailyNote = requireObject(raw.daily_note, "daily_note");
  const logging = requireObject(raw.logging, "logging");

  const trustedIssuers = requireUrlArray(auth.trusted_issuers, "auth.trusted_issuers");
  if (trustedIssuers.length === 0) {
    throw new Error("auth.trusted_issuers must not be empty");
  }

  const captureDefaultPattern = requireString(
    dailyNote.capture_default_pattern,
    "daily_note.capture_default_pattern"
  );
  if (captureDefaultPattern !== "A" && captureDefaultPattern !== "B") {
    throw new Error("daily_note.capture_default_pattern must be A or B");
  }

  return {
    listen,
    publicBaseUrl,
    vaultPath,
    statePath,
    auth: {
      audience: requireString(auth.audience, "auth.audience"),
      trustedIssuers,
      discoveryAuthorizationServer: requireHttpUrl(
        auth.discovery_authorization_server,
        "auth.discovery_authorization_server"
      ),
      jwksCacheTtlSeconds: requireInteger(
        auth.jwks_cache_ttl_seconds,
        "auth.jwks_cache_ttl_seconds"
      )
    },
    index: {
      sqlitePath:
        typeof index.sqlite_path === "string"
          ? index.sqlite_path
          : join(statePath, "index.sqlite"),
      watcherPolling: requireBoolean(index.watcher_polling, "index.watcher_polling"),
      ignoredGlobs: requireStringArray(index.ignored_globs, "index.ignored_globs")
    },
    writes: {
      cooldownSeconds: requireInteger(writes.cooldown_seconds, "writes.cooldown_seconds")
    },
    dailyNote: {
      captureDefaultPattern
    },
    logging: {
      logArgs: requireBoolean(logging.log_args, "logging.log_args")
    }
  };
}

function requireObject<T extends object>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function requireInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function requireUrlArray(value: unknown, name: string): URL[] {
  return requireStringArray(value, name).map((url, index) =>
    requireHttpUrl(url, `${name}[${index}]`)
  );
}

function requireHttpUrl(value: unknown, name: string): URL {
  const raw = requireString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid http(s) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid http(s) URL`);
  }
  return parsed;
}
