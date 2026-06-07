import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";
import { KNOWN_SCOPES, type Scope } from "./auth/scopes.js";
import { normalizeVaultPath } from "./vault/path.js";

export type CaptureDefaultPattern = "A" | "B";
export type AuthMode = "jwt" | "development";
export type JwtAlgorithm = "RS256" | "ES256";

export interface ServerConfig {
  listen: string;
  publicBaseUrl: URL;
  vaultPath: string;
  statePath: string;
  auth: {
    mode: AuthMode;
    audience: string;
    trustedIssuers: URL[];
    discoveryAuthorizationServer: URL;
    jwksCacheTtlSeconds: number;
    jwtAlgorithms: JwtAlgorithm[];
    developmentDefaultScopes?: Scope[];
  };
  index: {
    sqlitePath: string;
    watcherPolling: boolean;
    ignoredGlobs: string[];
    blockedPaths: string[];
  };
  security: {
    blockedPaths: string[];
  };
  writes: {
    cooldownSeconds: number;
  };
  audit: {
    retentionMaxRows: number;
    archivePath?: string;
  };
  framework: {
    schemaPath: string;
  };
  dailyNote: {
    captureDefaultPattern: CaptureDefaultPattern;
  };
  ocr: {
    enabled: boolean;
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
    mode?: unknown;
    audience?: unknown;
    trusted_issuers?: unknown;
    discovery_authorization_server?: unknown;
    jwks_cache_ttl_seconds?: unknown;
    jwt_algorithms?: unknown;
    development_default_scopes?: unknown;
  };
  index?: {
    sqlite_path?: unknown;
    watcher_polling?: unknown;
    ignored_globs?: unknown;
    blocked_paths?: unknown;
  };
  security?: {
    blocked_paths?: unknown;
  };
  writes?: {
    cooldown_seconds?: unknown;
  };
  audit?: {
    retention_max_rows?: unknown;
    archive_path?: unknown;
  };
  framework?: {
    schema_path?: unknown;
  };
  daily_note?: {
    capture_default_pattern?: unknown;
  };
  ocr?: {
    enabled?: unknown;
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
  const vaultPath = requireFilesystemPath(raw.vault_path, "vault_path");
  const statePath = requireFilesystemPath(raw.state_path, "state_path");
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
  const authMode = readAuthMode(auth.mode);
  assertDevelopmentAuthIsLocal(listen, authMode);
  const developmentDefaultScopes = readOptionalScopeArray(
    auth.development_default_scopes,
    "auth.development_default_scopes"
  );

  return {
    listen,
    publicBaseUrl,
    vaultPath,
    statePath,
    auth: {
      mode: authMode,
      audience: requireString(auth.audience, "auth.audience"),
      trustedIssuers,
      discoveryAuthorizationServer: requireHttpUrl(
        auth.discovery_authorization_server,
        "auth.discovery_authorization_server"
      ),
      jwksCacheTtlSeconds: requireInteger(
        auth.jwks_cache_ttl_seconds,
        "auth.jwks_cache_ttl_seconds"
      ),
      jwtAlgorithms: readJwtAlgorithms(auth.jwt_algorithms),
      ...(developmentDefaultScopes === undefined ? {} : { developmentDefaultScopes })
    },
    index: {
      sqlitePath:
        typeof index.sqlite_path === "string"
          ? index.sqlite_path
          : join(statePath, "index.sqlite"),
      watcherPolling: requireBoolean(index.watcher_polling, "index.watcher_polling"),
      ignoredGlobs: readVaultPatternArray(index.ignored_globs, "index.ignored_globs"),
      blockedPaths: readOptionalVaultPatternArray(index.blocked_paths, "index.blocked_paths")
    },
    security: readSecurityConfig(raw.security),
    writes: {
      cooldownSeconds: requireInteger(writes.cooldown_seconds, "writes.cooldown_seconds")
    },
    audit: readAuditConfig(raw.audit),
    framework: readFrameworkConfig(raw.framework),
    dailyNote: {
      captureDefaultPattern
    },
    ocr: {
      enabled: raw.ocr === undefined ? false : requireBoolean(raw.ocr.enabled, "ocr.enabled")
    },
    logging: {
      logArgs: requireBoolean(logging.log_args, "logging.log_args")
    }
  };
}

function readSecurityConfig(value: RawConfig["security"]): ServerConfig["security"] {
  if (value === undefined) {
    return { blockedPaths: [] };
  }
  const security = requireObject(value, "security");
  return {
    blockedPaths: readOptionalVaultPatternArray(security.blocked_paths, "security.blocked_paths")
  };
}

function readFrameworkConfig(value: RawConfig["framework"]): ServerConfig["framework"] {
  if (value === undefined) {
    return { schemaPath: "_meta/framework.yaml" };
  }
  const framework = requireObject(value, "framework");
  return {
    schemaPath:
      framework.schema_path === undefined
        ? "_meta/framework.yaml"
        : normalizeVaultPath(requireString(framework.schema_path, "framework.schema_path"))
  };
}

function readOptionalVaultPatternArray(value: unknown, name: string): string[] {
  if (value === undefined) {
    return [];
  }
  return readVaultPatternArray(value, name);
}

function readVaultPatternArray(value: unknown, name: string): string[] {
  return requireStringArray(value, name).map(normalizeVaultPath);
}

function readAuditConfig(value: RawConfig["audit"]): ServerConfig["audit"] {
  if (value === undefined) {
    return { retentionMaxRows: 0 };
  }
  const retentionMaxRows =
    value.retention_max_rows === undefined
      ? 0
      : requireNonNegativeInteger(value.retention_max_rows, "audit.retention_max_rows");
  return withoutUndefined({
    retentionMaxRows,
    archivePath:
      value.archive_path === undefined
        ? undefined
        : requireString(value.archive_path, "audit.archive_path")
  }) as ServerConfig["audit"];
}

function readAuthMode(value: unknown): AuthMode {
  if (value === undefined) {
    return "jwt";
  }
  if (value === "jwt" || value === "development") {
    return value;
  }
  throw new Error("auth.mode must be jwt or development");
}

function assertDevelopmentAuthIsLocal(listen: string, authMode: AuthMode): void {
  if (authMode !== "development" || process.env.SECOND_BRAIN_ALLOW_DEV_AUTH === "1") {
    return;
  }
  const host = readListenHost(listen);
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return;
  }
  throw new Error(
    "development auth requires a loopback listen address or SECOND_BRAIN_ALLOW_DEV_AUTH=1"
  );
}

function readListenHost(listen: string): string {
  const separator = listen.lastIndexOf(":");
  if (separator === -1) {
    return listen;
  }
  return listen.slice(0, separator);
}

function readJwtAlgorithms(value: unknown): JwtAlgorithm[] {
  if (value === undefined) {
    return ["RS256"];
  }
  const algorithms = requireStringArray(value, "auth.jwt_algorithms");
  if (
    algorithms.length === 0 ||
    algorithms.some((algorithm) => algorithm !== "RS256" && algorithm !== "ES256")
  ) {
    throw new Error("auth.jwt_algorithms must contain supported algorithms: RS256, ES256");
  }
  return algorithms as JwtAlgorithm[];
}

function readOptionalScopeArray(value: unknown, name: string): Scope[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireStringArray(value, name).filter((scope): scope is Scope =>
    (KNOWN_SCOPES as readonly string[]).includes(scope)
  );
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

function requireFilesystemPath(value: unknown, name: string): string {
  return expandHomePath(requireString(value, name));
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
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

function requireNonNegativeInteger(value: unknown, name: string): number {
  const integer = requireInteger(value, name);
  if (integer < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return integer;
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

function withoutUndefined<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
