# Deployment and Client Integration

For complete end-user setup, tool, logging, and audit workflows, see [user-guide.md](user-guide.md).

This service exposes a Streamable HTTP MCP endpoint at:

```text
{public_base_url}/mcp
```

Production deployments should put the Node process behind HTTPS and configure:

- `auth.mode = "jwt"`
- `public_base_url` to the externally reachable HTTPS origin
- `auth.audience` to the resource/audience expected in access tokens
- `auth.trusted_issuers` to every issuer allowed to call the MCP server
- `auth.discovery_authorization_server` to the human-facing OAuth authorization server
- `auth.jwt_algorithms` to the accepted signing algorithms, usually `["RS256"]`

Local-only testing can use `auth.mode = "development"` with:

```http
Authorization: Bearer scope=vault:read vault:write
```

Do not expose development mode outside localhost or a private development tunnel.

## HTTP Surface

| Route | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Process liveness check | No bearer token required |
| `GET /.well-known/oauth-protected-resource` | OAuth protected-resource metadata | No bearer token required |
| `GET /tools` | Compatibility tool listing | Bearer token required |
| `POST /mcp` | MCP JSON-RPC endpoint | Bearer token required for `tools/list` and `tools/call` |

`GET /mcp` intentionally returns `405` with `Allow: POST`; this server does not expose an SSE stream.

## Client Notes

| Client | Transport | Auth Shape | Typical Scopes |
|---|---|---|---|
| ChatGPT custom connector | Streamable HTTPS | OAuth bearer token for this MCP resource | `vault:read`, optionally `vault:write`, `daily:append` |
| Claude Desktop | Streamable HTTP through `mcp-remote` or native remote MCP support | OAuth bearer token, or development bearer token for localhost testing | `vault:read`, `vault:write`, `daily:append`, optionally `admin` |
| Claude Code remote MCP | Streamable HTTPS | OAuth bearer token | `vault:read`, `vault:write`, `daily:append`, optionally `admin` |
| OpenFang | Streamable HTTPS or direct HTTPS client | Service-issued bearer token | `vault:read`, `vault:capture`, `daily:append` |
| n8n | HTTPS JSON-RPC calls | Service-issued bearer token | `vault:capture` |
| Cowork | Streamable HTTPS | OAuth bearer token | `vault:read`, `vault:capture`, `daily:append` |

Clients should call `initialize`, then `tools/list`, then `tools/call`. Tool listings are filtered by bearer-token scopes, so absence from `tools/list` usually means the token lacks the required scope.

## Scope Boundaries

| Scope | Capability Class |
|---|---|
| `vault:read` | Read notes, list folders, search, backlinks, outgoing links, structure discovery |
| `vault:write` | Create and replace notes, update frontmatter, create framework records |
| `vault:capture` | Inbox and date-based capture flows |
| `daily:append` | Append to writable daily-note marker sections |
| `admin` | Framework management, conflict diagnostics, OCR admin tools, write recovery diagnostics |

Missing or invalid JWTs return HTTP `401` with `WWW-Authenticate: Bearer`. Authenticated calls without the required scope return JSON-RPC `forbidden_scope`.

## Logging and Audit

Every authenticated tool call writes one structured JSON log line to stdout. Tool arguments are hashed by default:

```json
{
  "ts": "2026-05-05T13:01:23Z",
  "sub": "user-123",
  "client_id": "claude-desktop",
  "tool": "daily_note_append",
  "args_hash": "sha256:...",
  "result": "ok",
  "duration_ms": 47
}
```

Set `[logging].log_args = true` only during local debugging; arguments can contain private vault content.

Successful primitive writes are recorded in `write-audit.sqlite`. Write attempts also emit append-only start and terminal events, allowing `list_write_recovery_diagnostics` to identify attempts that started but did not reach success or failure before a crash or process exit.
