import type { IncomingHttpHeaders } from "node:http";

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload
} from "jose";

import type { ServerConfig } from "../config.js";
import { parseScopes, type Scope } from "./scopes.js";

export interface AuthenticatedRequest {
  subject: string;
  issuer: URL;
  audience: string;
  scopes: Set<Scope>;
  tokenId?: string;
  clientId?: string;
}

export type JwksLoader = (issuer: URL) => Promise<JSONWebKeySet>;

export class AuthError extends Error {
  constructor(
    readonly code: "missing_token" | "invalid_token",
    message: string,
    readonly statusCode = 401
  ) {
    super(message);
  }
}

export async function authenticateRequest(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  config: ServerConfig,
  jwksLoader?: JwksLoader
): Promise<AuthenticatedRequest> {
  if (config.auth.mode === "development") {
    return authenticateDevelopment(headers, config);
  }

  const token = extractBearerToken(headers.authorization);
  if (token === undefined) {
    throw new AuthError("missing_token", "Missing bearer token");
  }

  let lastError: unknown;
  for (const issuer of config.auth.trustedIssuers) {
    try {
      const keySource =
        jwksLoader === undefined
          ? createRemoteJWKSet(new URL(".well-known/jwks.json", issuer), {
              cooldownDuration: config.auth.jwksCacheTtlSeconds * 1000
            })
          : createLocalJWKSet(await jwksLoader(issuer));
      const { payload } = await jwtVerify(token, keySource, {
        issuer: issuer.href,
        audience: config.auth.audience,
        algorithms: config.auth.jwtAlgorithms
      });
      return authenticatedFromPayload(payload, issuer, config.auth.audience);
    } catch (error) {
      lastError = error;
    }
  }

  throw new AuthError(
    "invalid_token",
    lastError instanceof Error ? lastError.message : "Invalid bearer token"
  );
}

function authenticateDevelopment(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  config: ServerConfig
): AuthenticatedRequest {
  const explicitScopes = parseScopes(extractDevelopmentScopeClaim(headers.authorization));
  return {
    subject: "development",
    issuer: new URL("urn:second-brain-mcp:development"),
    audience: config.auth.audience,
    scopes:
      explicitScopes.size > 0
        ? explicitScopes
        : new Set(config.auth.developmentDefaultScopes ?? [])
  };
}

function authenticatedFromPayload(
  payload: JWTPayload,
  issuer: URL,
  audience: string
): AuthenticatedRequest {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new AuthError("invalid_token", "JWT subject is required");
  }

  return {
    subject: payload.sub,
    issuer,
    audience,
    scopes: parseScopes(readScopeClaim(payload.scope)),
    ...(typeof payload.jti === "string" ? { tokenId: payload.jti } : {}),
    ...(typeof payload.client_id === "string" ? { clientId: payload.client_id } : {})
  };
}

function readScopeClaim(value: unknown): string | string[] | undefined {
  if (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  ) {
    return value;
  }
  return undefined;
}

function extractBearerToken(authorization: string | string[] | undefined): string | undefined {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const prefix = "Bearer ";
  return value?.startsWith(prefix) === true ? value.slice(prefix.length) : undefined;
}

function extractDevelopmentScopeClaim(
  authorization: string | string[] | undefined
): string | undefined {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const prefix = "Bearer scope=";
  return value?.startsWith(prefix) === true ? value.slice(prefix.length) : undefined;
}
