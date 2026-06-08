export const KNOWN_SCOPES = [
  "vault:read",
  "vault:write",
  "vault:delete",
  "vault:capture",
  "daily:append",
  "admin"
] as const;

export type Scope = (typeof KNOWN_SCOPES)[number];

const knownScopeSet = new Set<string>(KNOWN_SCOPES);

export function parseScopes(scopeClaim: string | string[] | undefined): Set<Scope> {
  const rawScopes =
    typeof scopeClaim === "string"
      ? scopeClaim.split(/\s+/)
      : Array.isArray(scopeClaim)
        ? scopeClaim
        : [];

  const scopes = new Set<Scope>();
  for (const scope of rawScopes) {
    if (isScope(scope)) {
      scopes.add(scope);
    }
  }
  return scopes;
}

function isScope(value: string): value is Scope {
  return knownScopeSet.has(value);
}
