import { describe, expect, test } from "vitest";

import { parseConfig } from "../../src/config.js";

const validConfig = `
listen = "127.0.0.1:8080"
public_base_url = "https://second-brain-mcp.example.com"
vault_path = "/vault"
state_path = "/var/lib/second-brain-mcp"

[auth]
audience = "second-brain-mcp"
trusted_issuers = [
  "https://idp.example.com/application/o/second-brain-mcp-human/",
  "https://idp.example.com/application/o/second-brain-mcp-automation/"
]
discovery_authorization_server = "https://idp.example.com/application/o/second-brain-mcp-human/"
jwks_cache_ttl_seconds = 3600

[index]
watcher_polling = false
ignored_globs = [".second-brain/workspace*", ".trash/**"]

[writes]
cooldown_seconds = 2

[daily_note]
capture_default_pattern = "B"

[logging]
log_args = false
`;

describe("parseConfig", () => {
  test("parses the runtime config shape from the spec", () => {
    const config = parseConfig(validConfig);

    expect(config.listen).toBe("127.0.0.1:8080");
    expect(config.publicBaseUrl.href).toBe("https://second-brain-mcp.example.com/");
    expect(config.vaultPath).toBe("/vault");
    expect(config.statePath).toBe("/var/lib/second-brain-mcp");
    expect(config.auth.audience).toBe("second-brain-mcp");
    expect(config.auth.trustedIssuers.map((issuer) => issuer.href)).toEqual([
      "https://idp.example.com/application/o/second-brain-mcp-human/",
      "https://idp.example.com/application/o/second-brain-mcp-automation/"
    ]);
    expect(config.auth.discoveryAuthorizationServer.href).toBe(
      "https://idp.example.com/application/o/second-brain-mcp-human/"
    );
    expect(config.auth.jwksCacheTtlSeconds).toBe(3600);
    expect(config.index.sqlitePath).toBe("/var/lib/second-brain-mcp/index.sqlite");
    expect(config.index.watcherPolling).toBe(false);
    expect(config.index.ignoredGlobs).toEqual([".second-brain/workspace*", ".trash/**"]);
    expect(config.writes.cooldownSeconds).toBe(2);
    expect(config.dailyNote.captureDefaultPattern).toBe("B");
    expect(config.ocr.enabled).toBe(false);
    expect(config.logging.logArgs).toBe(false);
  });

  test("enables optional OCR tools from config", () => {
    const config = parseConfig(
      validConfig.replace(
        "[logging]\nlog_args = false",
        "[ocr]\nenabled = true\n\n[logging]\nlog_args = false"
      )
    );

    expect(config.ocr.enabled).toBe(true);
  });

  test("allows an explicit index sqlite path", () => {
    const config = parseConfig(
      validConfig.replace(
        `[index]
watcher_polling = false
ignored_globs = [".second-brain/workspace*", ".trash/**"]`,
        `[index]
sqlite_path = "/tmp/custom-index.sqlite"
watcher_polling = true
ignored_globs = []`
      )
    );

    expect(config.index.sqlitePath).toBe("/tmp/custom-index.sqlite");
    expect(config.index.watcherPolling).toBe(true);
  });

  test("parses multiline arrays and dotted table keys used by TOML 1.x configs", () => {
    const config = parseConfig(`
listen = "127.0.0.1:8080"
public_base_url = "https://second-brain-mcp.example.com"
vault_path = "/vault"
state_path = "/var/lib/second-brain-mcp"

auth.audience = "second-brain-mcp"
auth.trusted_issuers = [
  "https://idp.example.com/application/o/second-brain-mcp-human/",
]
auth.discovery_authorization_server = "https://idp.example.com/application/o/second-brain-mcp-human/"
auth.jwks_cache_ttl_seconds = 3600

index.watcher_polling = false
index.ignored_globs = [
  ".second-brain/workspace*",
  ".trash/**",
]

writes.cooldown_seconds = 2
daily_note.capture_default_pattern = "B"
logging.log_args = false
`);

    expect(config.auth.trustedIssuers.map((issuer) => issuer.href)).toEqual([
      "https://idp.example.com/application/o/second-brain-mcp-human/"
    ]);
    expect(config.index.ignoredGlobs).toEqual([".second-brain/workspace*", ".trash/**"]);
  });

  test("rejects invalid public URLs", () => {
    expect(() =>
      parseConfig(validConfig.replace("https://second-brain-mcp.example.com", "not a url"))
    ).toThrow(/public_base_url must be a valid http\(s\) URL/);
  });

  test("rejects configs without trusted issuers", () => {
    const withoutIssuers = validConfig.replace(
      /trusted_issuers = \[[\s\S]*?\]\n/,
      "trusted_issuers = []\n"
    );

    expect(() => parseConfig(withoutIssuers)).toThrow(/auth.trusted_issuers must not be empty/);
  });
});
