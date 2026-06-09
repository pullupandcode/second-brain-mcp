# second-brain-mcp

`second-brain-mcp` is a production-ready Model Context Protocol server for a markdown Second Brain vault. It gives AI clients scoped, auditable tools for reading, searching, capturing, organizing, and carefully writing notes while keeping the vault as plain files that remain owned by the user.

The server is designed for Obsidian-style markdown vaults, but the core filesystem, frontmatter, wikilink, and schema behavior is framework-neutral. It includes presets for LYT, PARA, and Zettelkasten, plus custom schemas for teams or individuals with their own knowledge system.

## What It Provides

- Streamable HTTP MCP endpoint at `POST /mcp`
- OAuth protected-resource metadata at `/.well-known/oauth-protected-resource`
- Production JWT bearer-token validation against trusted issuer JWKS
- Scope-filtered tool discovery and tool-call authorization
- Safe vault path normalization with traversal protection
- Hard denylist support for private vault paths
- Markdown/frontmatter parsing with tags, aliases, source IDs, and wikilinks
- SQLite-backed search, backlinks, outgoing links, source ID lookup, and conflict listing
- Atomic note creation, replacement, frontmatter updates, marker-scoped section replacement, and soft/hard delete tools
- Optimistic concurrency through `base_sha256` on mutating tools
- Structured operational logs with hashed tool arguments by default
- SQLite write audit records and recovery diagnostics for interrupted writes
- Framework-aware record creation for LYT, PARA, Zettelkasten, or custom schemas
- Inbox and date-based capture flows, including stable `source_id` replacement
- Daily note read, append, and marker repair tools
- Optional OCR job-contract tools for notebook workflows

## Status

This project is ready for real deployment behind HTTPS with JWT authentication and a carefully scoped identity-provider setup. Development mode exists for localhost testing only and should not be exposed on a network.

The package is currently private in `package.json`, so the supported installation path is cloning the repository and running the Node service directly.

## Requirements

- Node.js `>=24.0.0`
- pnpm
- A markdown vault directory
- A persistent state directory for SQLite index and audit files
- For production: an OAuth/OIDC identity provider or service-token issuer that publishes JWKS

## Quick Start

Install dependencies and build the server:

```bash
pnpm install
pnpm build
```

Create a local config:

```bash
cp config.example.toml config.local.toml
```

Edit at least these values:

```toml
listen = "127.0.0.1:3000"
public_base_url = "http://127.0.0.1:3000"
vault_path = "/absolute/path/to/your/markdown/vault"
state_path = "/absolute/path/to/persistent/mcp-state"
```

For local-only testing, set:

```toml
[auth]
mode = "development"
```

Run the built server:

```bash
node dist/server.js --config config.local.toml
```

The MCP endpoint is:

```text
http://127.0.0.1:3000/mcp
```

Development clients can send scopes with:

```http
Authorization: Bearer scope=vault:read vault:write daily:append
```

Do not use development auth outside localhost or a private development tunnel.

## Production Deployment

Production deployments should run the Node process behind HTTPS and use JWT auth:

```toml
[auth]
mode = "jwt"
audience = "second-brain-mcp"
trusted_issuers = [
  "https://idp.example.com/application/o/second-brain-mcp-human/"
]
discovery_authorization_server = "https://idp.example.com/application/o/second-brain-mcp-human/"
jwks_cache_ttl_seconds = 3600
jwt_algorithms = ["RS256"]
```

The server validates issuer, audience, expiration, allowed algorithms, and scopes. It does not mint tokens or manage signing keys; your identity provider or service-token issuer owns that lifecycle.

See [docs/deployment.md](docs/deployment.md) for HTTPS, auth, client integration, scope boundaries, logging, and audit guidance.

## User Guide

See [docs/user-guide.md](docs/user-guide.md) for end-user setup, vault boundary configuration, OCR enablement, the full tool list, logging, soft delete behavior, write audit inspection, and recovery workflows.

## Tool Scopes

Tools are only listed and callable when the bearer token contains the required scope.

| Scope | Capability class |
|---|---|
| `vault:read` | Read notes, list folders, search, backlinks, outgoing links, structure discovery |
| `vault:write` | Create and replace notes, update frontmatter, replace marker sections, create framework records |
| `vault:delete` | Move notes into the configured MCP trash path |
| `vault:delete:hard` | Permanently remove notes from disk with optimistic concurrency |
| `vault:capture` | Inbox and date-based capture workflows |
| `daily:append` | Append to writable daily-note marker sections |
| `admin` | Framework management, conflict diagnostics, OCR admin tools, write recovery diagnostics |

## HTTP Surface

| Route | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Process liveness check | No bearer token required |
| `GET /.well-known/oauth-protected-resource` | OAuth protected-resource metadata | No bearer token required |
| `GET /tools` | Compatibility tool listing | Bearer token required |
| `POST /mcp` | MCP JSON-RPC endpoint | Bearer token required for `tools/list` and `tools/call` |

`GET /mcp` intentionally returns `405` with `Allow: POST`; this server does not expose an SSE stream.

## Configuration

Start from [config.example.toml](config.example.toml). The most important production controls are:

- `auth.mode = "jwt"` for production bearer-token validation
- `public_base_url` set to the externally reachable HTTPS origin
- `vault_path` set to the markdown vault root
- `state_path` set to durable storage for index and audit databases
- `security.blocked_paths` for private paths that must be denied to read and write tools
- `index.blocked_paths` or `index.ignored_globs` for softer index/list/search exclusions
- `[logging].log_args = false` unless debugging locally

## Development

```bash
pnpm dev -- --config config.local.toml
pnpm typecheck
pnpm test
pnpm build
```

## Security Notes

- Keep production deployments behind HTTPS.
- Use `auth.mode = "jwt"` for any remote deployment.
- Grant the smallest set of scopes each client needs.
- Treat `vault:delete:hard` and `admin` as high-trust scopes.
- Use `security.blocked_paths` for folders or patterns that should never be exposed to MCP clients.
- Keep raw argument logging disabled in normal operation because arguments can contain private note paths and vault text.

## License

Licensed under the [Apache License 2.0](LICENSE).

## Contributing

This project is not ready for broad external contribution yet. We will soon create a path for establishing a proper contribution model, including contribution guidelines, issue triage expectations, and review practices.
