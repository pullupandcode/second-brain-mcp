# second-brain-mcp

Typed MCP core for a Second Brain markdown vault.

## Current Slice

This implementation currently includes:

- Strict TypeScript project scaffold
- TOML runtime config parsing and validation
- OAuth protected-resource discovery metadata builder
- Scope parsing for `vault:read`, `vault:write`, `vault:capture`, `daily:append`, and `admin`
- Typed tool registry with scope-filtered listing
- Framework-neutral record tool names and built-in presets for LYT, PARA, and Zettel
- Framework schema parsing/composition, including `framework: custom` for non-preset systems
- Framework-aware record creation with schema-driven paths, templates, and frontmatter
- Dated capture records as files through `capture_for_date`, avoiding direct daily-note edits
- Safe vault path normalization and traversal protection
- Markdown/frontmatter parsing with tags, aliases, source IDs, and wikilink extraction
- Local vault reader for note reads, SHA-256 hashes, and folder listing
- Vault writer foundation for atomic creates/replaces, `base_sha256` checks, cooldown conflicts, frontmatter patching, and marker-scoped replacement
- Primitive write tool adapter with append-only SQLite write audit rows for successful writes
- Rebuildable SQLite FTS index for search, backlinks, outgoing links, source ID lookup, and conflict listing
- Minimal HTTP server routes:
  - `GET /healthz`
  - `GET /.well-known/oauth-protected-resource`
  - `GET /tools`

`GET /tools` currently uses a development bearer token shape for the first vertical slice:

```http
Authorization: Bearer scope=vault:read daily:append
```

Real JWT validation is a later implementation slice.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Development

```bash
pnpm dev
```
