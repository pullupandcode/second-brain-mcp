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
- In-vault skills are exposed only when linked from configured Skills Maps/MOCs and requested by clients with `skills:read`.

## Privacy and Security Posture

`second-brain-mcp` is designed for a high-trust but high-sensitivity environment: a personal or team knowledge vault. The server assumes vault contents may include private thoughts, work product, identities, credentials accidentally pasted into notes, unpublished plans, and other material that should not be exposed merely because an AI client can connect.

The current posture is therefore privacy-first:

- **Vault ownership stays local.** The server reads and writes local markdown files. It does not copy the vault to a hosted service or require a remote indexing provider.
- **Clients get scoped capabilities, not ambient filesystem access.** A client can only list or call tools allowed by its bearer-token scopes.
- **Vault paths are always vault-relative.** Absolute paths and traversal segments such as `../` are rejected before filesystem access.
- **Symlink escapes are blocked.** Existing paths are resolved with `realpath` and must still live under the configured vault root.
- **Private path rules are enforced across surfaces.** `security.blocked_paths` denies matching paths for direct reads, folder listings, search/index results, link lookups, primitive writes, and framework record creation.
- **Discovery is filtered.** Broad discovery tools such as folder listing, search, backlinks, outgoing links, and source-ID lookup omit blocked paths instead of revealing them.
- **Skill instructions have their own boundary.** Approved in-vault skills require `skills:read`; ordinary `vault:read` is not enough. Configured skill maps and candidate skill files are hidden from ordinary vault tools.
- **Write safety is explicit.** Mutating tools require write scopes, use optimistic concurrency where applicable, and record write-audit evidence.
- **Logs avoid raw private text by default.** Operational logs hash arguments unless `[logging].log_args = true` is intentionally enabled for local debugging.

This is not a claim that the project is finished or formally audited. It is a design commitment from the current release line: new features should preserve scoped access, vault-relative paths, denylist enforcement, low-leakage discovery, auditable writes, and conservative logging.

## Out-of-Bounds Access Behavior

When a client tries to access a path outside its allowed vault boundary, the server fails closed.

Direct path attempts are rejected:

- Absolute paths return `Vault path must be relative`.
- Traversal attempts return `Vault path must not contain traversal segments`.
- Symlink or realpath escapes return `Vault path resolves outside the vault root`.
- Configured denied paths return `Vault path is blocked`.
- Ordinary reads of ignored paths return `Vault path is ignored: ...`.

Discovery tools behave more quietly:

- `list_folder` skips blocked and ignored children.
- `search` filters blocked results, including stale SQLite index rows.
- backlink, outgoing-link, conflict, and source-ID surfaces avoid returning blocked paths.

The goal is that a client asking for a specific forbidden path receives a clear denial, while a client browsing broadly does not learn private paths by enumeration.

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
| `skills:read` | Can expose approved in-vault skill instructions, preferences, workflows, and interaction rules. |
| `vault:write` | Can create or modify notes and frontmatter. |
| `vault:delete` | Can move notes into the configured MCP trash path. |
| `vault:delete:hard` | Can permanently remove notes from disk. |
| `vault:capture` | Can add or replace capture records. |
| `daily:append` | Can append content to writable daily-note sections. |
| `admin` | Can manage framework schemas, in-vault skill diagnostics/reload, diagnostics, recovery tooling, and optional OCR tools. |

## Non-Security Issues

For ordinary bugs, documentation fixes, feature requests, or support questions, use public GitHub issues once this project opens a formal contribution and issue triage model.
