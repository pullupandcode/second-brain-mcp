import type { ServerConfig } from "../config.js";
import { KNOWN_SCOPES } from "./scopes.js";

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
  resource_documentation: string;
}

export function buildProtectedResourceMetadata(
  config: ServerConfig
): OAuthProtectedResourceMetadata {
  return {
    resource: trimTrailingSlash(config.publicBaseUrl.href),
    authorization_servers: [config.auth.discoveryAuthorizationServer.href],
    scopes_supported: [...KNOWN_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${trimTrailingSlash(config.publicBaseUrl.href)}/docs`
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
