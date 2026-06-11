# Security Policy

`second-brain-mcp` gives AI clients controlled access to a local markdown vault. Security reports are taken seriously because a misconfiguration or vulnerability could expose private notes, allow unintended writes, or weaken deployment boundaries.

## Supported Versions

Security fixes are provided for the current public release line.

| Version | Supported |
|---|---|
| `1.x` | Yes |
| `< 1.0` | No |

## Reporting a Vulnerability

Please do not report security vulnerabilities in public GitHub issues, discussions, pull requests, or social channels.

Use GitHub private vulnerability reporting:

```text
https://github.com/pullupandcode/second-brain-mcp/security/advisories/new
```

Include as much of the following as you can:

- A short description of the issue and likely impact
- Affected version or commit SHA
- Relevant configuration, with secrets removed
- Reproduction steps or proof of concept
- Whether the issue affects confidentiality, integrity, availability, or deployment safety
- Any known workarounds or mitigations

Do not include private vault content, bearer tokens, signing keys, production URLs, or other secrets in the report. If a reproduction requires sensitive material, describe the shape of the data instead.

## Response Expectations

After a report is received, maintainers will aim to:

- Acknowledge receipt within 5 business days
- Triage severity and reproducibility as quickly as practical
- Coordinate on a fix, mitigation, or disclosure plan before public discussion
- Credit reporters when requested and appropriate

This project is currently maintained without a formal security response SLA. Responsible disclosure is still appreciated, and reports that protect users will be prioritized.

## Security Boundaries

The intended production security model is:

- The MCP server runs behind HTTPS.
- `auth.mode = "jwt"` is used for any remote deployment.
- Bearer tokens are issued by an external OAuth/OIDC identity provider or service-token issuer.
- JWT issuer, audience, expiration, allowed algorithms, and scope claims are validated by the server.
- Tool visibility and tool calls are constrained by explicit scopes.
- Vault paths are constrained to configured vault boundaries and denylist rules.
- Mutating tools use optimistic concurrency with `base_sha256`.
- Operational logs hash tool arguments by default.
- Successful writes and write attempts are recorded in the write audit database.
- In-vault skills are exposed only when linked from configured Skills Maps/MOCs and requested by authorized clients.

The following are outside the intended trust boundary:

- Exposing `auth.mode = "development"` on a network
- Running the service without HTTPS in production
- Granting broad scopes to untrusted clients
- Treating `vault:delete:hard` or `admin` as low-risk scopes
- Enabling raw argument logging in normal operation
- Sharing a vault directory with untrusted local users or processes

## Operational Guidance

For production deployments:

- Keep `auth.mode = "jwt"`.
- Bind development deployments to `127.0.0.1`.
- Set `public_base_url` to the externally reachable HTTPS origin.
- Forward the `Authorization` header through the reverse proxy.
- Grant each client the smallest scope set it needs.
- Use `security.blocked_paths` for private folders and sensitive note patterns.
- Keep `[logging].log_args = false` unless debugging locally.
- Store `state_path` on durable storage with appropriate filesystem permissions.
- Review write-audit diagnostics after crashes or forced restarts.

See [docs/deployment.md](docs/deployment.md) and [docs/user-guide.md](docs/user-guide.md) for setup and auditing details.

## Scope Risk Summary

| Scope | Risk |
|---|---|
| `vault:read` | Can expose readable note content and metadata. |
| `vault:write` | Can create or modify notes and frontmatter. |
| `vault:delete` | Can move notes into the configured MCP trash path. |
| `vault:delete:hard` | Can permanently remove notes from disk. |
| `vault:capture` | Can add or replace capture records. |
| `daily:append` | Can append content to writable daily-note sections. |
| `admin` | Can manage framework schemas, in-vault skill diagnostics/reload, diagnostics, recovery tooling, and optional OCR tools. |

## Non-Security Issues

For ordinary bugs, documentation fixes, feature requests, or support questions, use public GitHub issues once this project opens a formal contribution and issue triage model.
