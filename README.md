# second-brain-mcp

Typed MCP core for a Second Brain markdown vault.

## Current Slice

This implementation currently includes:

- Strict TypeScript project scaffold
- TOML runtime config parsing and validation
- OAuth protected-resource discovery metadata builder
- Scope parsing for `vault:read`, `vault:write`, `vault:capture`, `daily:append`, and `admin`
- Typed tool registry with scope-filtered listing
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
