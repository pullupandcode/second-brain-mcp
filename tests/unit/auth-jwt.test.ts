import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, test } from "vitest";

import { AuthError, authenticateRequest } from "../../src/auth/jwt.js";
import type { ServerConfig } from "../../src/config.js";

const issuer = new URL("https://idp.example.com/application/o/second-brain-mcp-human/");

describe("authenticateRequest", () => {
  test("validates a trusted RS256 JWT and returns known scopes", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({ scope: "vault:read unknown admin", client_id: "claude" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer.href)
      .setAudience("second-brain-mcp")
      .setSubject("user-123")
      .setExpirationTime("2h")
      .sign(privateKey);

    const result = await authenticateRequest(
      { authorization: `Bearer ${token}` },
      config(),
      async () => ({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] })
    );

    expect(result.subject).toBe("user-123");
    expect(result.clientId).toBe("claude");
    expect([...result.scopes].sort()).toEqual(["admin", "vault:read"]);
  });

  test("rejects missing bearer tokens in jwt mode", async () => {
    await expect(authenticateRequest({}, config())).rejects.toMatchObject({
      code: "missing_token",
      statusCode: 401
    });
  });

  test("rejects wrong issuer tokens", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ scope: "vault:read" })
      .setProtectedHeader({ alg: "RS256", kid: "missing" })
      .setIssuer("https://evil.example.com/")
      .setAudience("second-brain-mcp")
      .setSubject("user-123")
      .setExpirationTime("2h")
      .sign(privateKey);

    await expect(authenticateRequest({ authorization: `Bearer ${token}` }, config())).rejects
      .toBeInstanceOf(AuthError);
  });

  test("supports explicit development mode scope fallback", async () => {
    const result = await authenticateRequest(
      {},
      {
        ...config(),
        auth: {
          ...config().auth,
          mode: "development",
          developmentDefaultScopes: ["vault:read"]
        }
      }
    );

    expect(result.subject).toBe("development");
    expect([...result.scopes]).toEqual(["vault:read"]);
  });
});

function config(): ServerConfig {
  return {
    listen: "127.0.0.1:0",
    publicBaseUrl: new URL("https://second-brain-mcp.example.com"),
    vaultPath: "/vault",
    statePath: "/state",
    auth: {
      mode: "jwt",
      audience: "second-brain-mcp",
      trustedIssuers: [issuer],
      discoveryAuthorizationServer: issuer,
      jwksCacheTtlSeconds: 3600,
      jwtAlgorithms: ["RS256"]
    },
    index: { sqlitePath: ":memory:", watcherPolling: false, ignoredGlobs: [] },
    writes: { cooldownSeconds: 0 },
    dailyNote: { captureDefaultPattern: "B" },
    ocr: { enabled: false },
    logging: { logArgs: false }
  };
}
