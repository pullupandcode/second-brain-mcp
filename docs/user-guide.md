# User Guide

This guide explains how to run `second-brain-mcp`, grant client access, set vault boundaries, enable optional OCR tools, and inspect logging and audit evidence.

For production deployment and client integration notes, see [deployment.md](deployment.md).

## 1. Enable the Server

### Install and Build

```bash
pnpm install
pnpm build
```

Create a local config from the example:

```bash
cp config.example.toml config.local.toml
```

Edit these values first:

```toml
listen = "127.0.0.1:3000"
public_base_url = "http://127.0.0.1:3000"
vault_path = "/absolute/path/to/your/Obsidian/vault"
state_path = "/absolute/path/to/persistent/mcp-state"
```

Run the built server:

```bash
node dist/server.js --config config.local.toml
```

The MCP endpoint is:

```text
{public_base_url}/mcp
```

For the example above:

```text
http://127.0.0.1:3000/mcp
```

### Development Auth

For local-only testing, use:

```toml
[auth]
mode = "development"
development_default_scopes = [
  "vault:read",
  "skills:read",
  "vault:write",
  "vault:capture",
  "daily:append",
  "admin"
]
```

Clients can also send explicit development scopes:

```http
Authorization: Bearer scope=vault:read skills:read vault:write
```

Do not expose development mode outside localhost or a private development tunnel.

### Production Auth and Key Setup

Production mode validates JWT bearer tokens against issuer JWKS:

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

The server does not mint tokens or manage signing keys. Your identity provider or service-token issuer owns that key setup.

Minimum key and token requirements:

- The issuer must publish a JWKS endpoint.
- Access tokens must be signed with an allowed algorithm, normally `RS256`.
- Token `iss` must exactly match one of `trusted_issuers`.
- Token `aud` must include `auth.audience`.
- Token must include `exp`, `sub`, and `scope`.
- Token `scope` must include the scope required by the tool being called.

Typical identity-provider setup:

1. Create an application/API resource for `second-brain-mcp`.
2. Set its audience to the value in `auth.audience`.
3. Configure the IdP to issue RS256 access tokens.
4. Ensure the IdP exposes a JWKS for the issuer URL.
5. Grant users or service clients the minimal scopes they need.
6. Set `trusted_issuers` and `discovery_authorization_server` to the issuer/authorization server URLs.
7. Put the MCP server behind HTTPS and forward the `Authorization` header through your reverse proxy.

Invalid or missing JWTs return HTTP `401` with `WWW-Authenticate: Bearer`. Valid tokens without the required scope receive JSON-RPC `forbidden_scope`.

## 2. Configure Vault Boundaries

Use `security.blocked_paths` for vault areas that must be guaranteed off-limits to MCP clients:

```toml
[security]
blocked_paths = [
  "Private/**",
  "Journal/Raw/**",
  "**/*.secret.md"
]
```

Matching paths are denied for reads, folder listings, search/index results, backlinks/outgoing links, conflict listings, primitive writes, and framework record creation.

Use `index.blocked_paths` for softer read/list/search exclusions such as caches or sync noise:

```toml
[index]
blocked_paths = [
  ".obsidian/workspace*",
  ".obsidian/cache*",
  ".trash/**"
]
```

`index.ignored_globs` remains supported for existing configs. Prefer `security.blocked_paths` for privacy boundaries because it also blocks writes.

## 3. Configure a Framework Schema

The server reads the active vault framework schema from:

```toml
[framework]
schema_path = "_meta/framework.yaml"
```

For a Linking Your Thinking starter schema, copy [../examples/vault/_meta/framework.lyt.yaml](../examples/vault/_meta/framework.lyt.yaml) into your vault as:

```text
_meta/framework.yaml
```

You can also initialize a starter schema through the admin-scoped MCP tool:

```text
framework_init
```

with `framework` set to `lyt`, `para`, or `zettel`.

The generated or copied schema is just a vault file. Edit folders, filenames, templates, frontmatter defaults, and record types to match your system, then run `framework_reload` or restart the server.

## 4. Enable In-Vault Skills

In-vault skills let you keep reusable client instructions as ordinary markdown files in your vault. The server only exposes skills linked from configured Skills Map/MOC files:

```toml
[skills]
map_paths = [
  "Atlas/Maps/Skills.md",
  "_meta/skills.md"
]
```

Each configured map is read as a vault note. The map format is intentionally flexible: it may include frontmatter, callouts, navigation links, grouped sections, compact bullet lists, or expanded entries with descriptions, triggers, dependencies, and paths. Markdown links and wikilinks from that map are treated as candidate skills, and expanded entries may include an optional `Path:` hint when the skill file lives somewhere other than the link text implies:

```markdown
# Skill Map

## Research System

- [[source-checker]]: Checks claims against linked source notes.

### [[source-checker]]

- **Description**: Checks claims against linked source notes.
- **Triggers**: `check sources`, `verify this`
- **Dependencies**: [[citation-style]]
- **Path**: `/AIOS/Skills/source-checker`
```

Only candidate files that validate as skills are exposed. A candidate skill must be a markdown note with frontmatter like:

```markdown
---
name: research_assistant
description: Research with my vault conventions.
---

Use careful sourcing and preserve my note style.
```

Valid skills are exposed as MCP prompts through `prompts/list` and `prompts/get` for clients with `skills:read`. You can put skill maps and skill files under `security.blocked_paths` to keep ordinary vault-read tools such as `read_note`, `list_folder`, and `search` from accessing them. The skill loader still reads only configured maps and their linked or path-hinted candidate skill files.

Admin-scoped diagnostics:

- `skills_list` returns configured map paths and skill load statuses.
- `skills_reload` reloads configured skills without restarting the server.

## 5. Enable OCR Tools

OCR tools are disabled by default:

```toml
[ocr]
enabled = false
```

Enable them with:

```toml
[ocr]
enabled = true
```

When enabled, three additional admin-scoped tools are advertised:

- `ocr_notebook`
- `ocr_status`
- `ocr_renumber_notebook`

OCR jobs currently expose provider-neutral job contracts. The server can queue and track OCR work, but the actual OCR provider/runtime integration is deployment-specific.

## 6. Tool List and Scopes

Tool visibility is scope-filtered. If a tool is missing from `tools/list`, the token probably lacks the required scope or the tool's optional feature is disabled.

| Tool | Scope | Description |
|---|---|---|
| `read_note` | `vault:read` | Read note content plus parsed frontmatter. |
| `list_folder` | `vault:read` | List notes under a vault path. |
| `search` | `vault:read` | Search indexed notes. |
| `get_backlinks` | `vault:read` | List notes linking to a path. |
| `get_outgoing_links` | `vault:read` | List links from a note. |
| `daily_note_get` | `vault:read` | Read a daily note. |
| `find_maps` | `vault:read` | Find framework map or index notes. |
| `list_record_types` | `vault:read` | List effective framework record types. |
| `get_vault_structure` | `vault:read` | Return folder map and framework type list. |
| `link_to_page` | `vault:read` | Return a stable OCR page wikilink. |
| `prompts/list` | `skills:read` | List approved in-vault skills as MCP prompts. |
| `prompts/get` | `skills:read` | Get an approved in-vault skill prompt. |
| `create_note` | `vault:write` | Create a note and fail if the path already exists. |
| `replace_note` | `vault:write` | Replace a full note with optimistic concurrency. |
| `update_frontmatter` | `vault:write` | Merge frontmatter keys. |
| `replace_section_by_marker` | `vault:write` | Replace an MCP-owned marker section. |
| `create_record` | `vault:write` | Create a type-driven framework record. |
| `delete_note` | `vault:delete` | Move a note into the configured MCP trash path. |
| `hard_delete_note` | `vault:delete:hard` | Remove a note from disk with optimistic concurrency. |
| `inbox_capture` | `vault:capture` | Create or update inbox capture content. |
| `capture_for_date` | `vault:capture` | Create a capture record for a date. |
| `daily_note_append` | `daily:append` | Append inside a writable daily note marker. |
| `list_vault_conflicts` | `admin` | List active conflict quarantine state. |
| `daily_note_repair_markers` | `admin` | Repair missing daily note markers. |
| `list_write_recovery_diagnostics` | `admin` | List write attempts without terminal audit events. |
| `skills_list` | `admin` | List configured in-vault skill load diagnostics. |
| `skills_reload` | `admin` | Reload configured in-vault skills from skills maps. |
| `framework_init` | `admin` | Create a starter framework schema. |
| `framework_reload` | `admin` | Reload framework schema files. |
| `framework_register` | `admin` | Register a framework overlay. |
| `framework_unregister` | `admin` | Unregister a framework overlay. |
| `framework_list` | `admin` | List registered framework schemas. |
| `framework_compose` | `admin` | Return the effective framework schema. |
| `ocr_notebook` | `admin` | Queue OCR for a notebook. Requires `[ocr].enabled = true`. |
| `ocr_status` | `admin` | Poll OCR job state. Requires `[ocr].enabled = true`. |
| `ocr_renumber_notebook` | `admin` | Force notebook page renumbering. Requires `[ocr].enabled = true`. |

## 7. Enable Logging and Auditing

### Operational Logs

Every authenticated tool call writes one structured JSON line to stdout. Arguments are hashed by default:

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

`result` can be:

- `ok`
- `error`
- `forbidden_scope`

Keep raw argument logging disabled for normal use:

```toml
[logging]
log_args = false
```

For local debugging only:

```toml
[logging]
log_args = true
```

Raw tool arguments can contain private vault text, note paths, capture content, and frontmatter.

### Soft Delete

The `delete_note` tool requires `vault:delete` and `base_sha256`. It moves the note into a vault-relative trash folder instead of removing it from disk:

```toml
[deletes]
trash_path = ".trash/mcp"
```

Keep the trash path in `index.ignored_globs` or `index.blocked_paths` if you do not want deleted notes to appear in search or folder listings.

The `hard_delete_note` tool requires `vault:delete:hard` and also requires `base_sha256`. It removes the note from disk, so grant this scope separately from `vault:delete`.

### Write Audit

The server stores write audit data under:

```text
{state_path}/write-audit.sqlite
```

Successful primitive writes are recorded in `write_audit`. Write attempts are recorded in `write_audit_attempts` with append-only events:

- `started`
- `succeeded`
- `failed`

Audit rotation is configured with:

```toml
[audit]
retention_max_rows = 0
# archive_path = "/absolute/path/to/audit-archive"
```

When `retention_max_rows` is greater than `0`, startup checks `write_audit.sqlite`. If the successful-write row count is above the limit, the server archives the database to:

```text
{state_path}/audit-archive/write-audit.YYYYMMDDTHHMMSSmmmZ.sqlite
```

Then it starts a fresh audit database.

## 7. Audit Good and Bad Events

You can audit through MCP tools, stdout logs, or direct SQLite inspection.

### Confirm Good Tool Calls

Operational logs show successful authenticated tool calls:

```bash
jq 'select(.result == "ok")' server.log
```

Useful filters:

```bash
jq 'select(.tool == "create_note" and .result == "ok")' server.log
jq 'select(.sub == "user-123")' server.log
jq 'select(.result == "forbidden_scope")' server.log
jq 'select(.result == "error")' server.log
```

If you do not pipe stdout to a file, configure your process manager or container runtime to retain stdout logs.

### Confirm Good Writes

Use SQLite to inspect successful primitive writes:

```bash
sqlite3 "$STATE_PATH/write-audit.sqlite" \
  "SELECT id, created_at, operation, path, base_sha256, result_sha256, metadata_json FROM write_audit ORDER BY id DESC LIMIT 20;"
```

Look up successful writes to one path:

```bash
sqlite3 "$STATE_PATH/write-audit.sqlite" \
  "SELECT id, created_at, operation, result_sha256 FROM write_audit WHERE path = 'Inbox/Example.md' ORDER BY id DESC;"
```

Confirm marker-section writes:

```bash
sqlite3 "$STATE_PATH/write-audit.sqlite" \
  "SELECT id, created_at, path, metadata_json FROM write_audit WHERE operation = 'replace_section_by_marker' ORDER BY id DESC LIMIT 20;"
```

### Find Failed or Forbidden Tool Calls

Operational logs are the first place to look for failed tool calls:

```bash
jq 'select(.result == "error" or .result == "forbidden_scope")' server.log
```

`forbidden_scope` means the bearer token was valid but did not contain the tool's required scope.

`error` means the handler ran but returned a JSON-RPC error, commonly from validation, stale `base_sha256`, cooldown conflicts, invalid paths, missing marker sections, or framework/schema errors.

### Find Interrupted Writes

Use the admin MCP tool:

```text
list_write_recovery_diagnostics
```

It returns `incompleteWrites`, which are write attempts that have a `started` event but no `succeeded` or `failed` event. These are the attempts most likely to indicate a process crash, host restart, forced shutdown, or audit storage interruption during a write.

Direct SQLite query:

```bash
sqlite3 "$STATE_PATH/write-audit.sqlite" "
SELECT
  started.attempt_id,
  started.created_at,
  started.operation,
  started.path,
  started.base_sha256,
  started.metadata_json
FROM write_audit_attempts started
WHERE started.event_type = 'started'
  AND NOT EXISTS (
    SELECT 1
    FROM write_audit_attempts terminal
    WHERE terminal.attempt_id = started.attempt_id
      AND terminal.event_type IN ('succeeded', 'failed')
  )
ORDER BY started.created_at DESC;
"
```

### Confirm Failed Writes Were Not Retried Blindly

Failed write attempts have terminal `failed` events:

```bash
sqlite3 "$STATE_PATH/write-audit.sqlite" "
SELECT attempt_id, created_at, error_message
FROM write_audit_attempts
WHERE event_type = 'failed'
ORDER BY created_at DESC
LIMIT 20;
"
```

For one attempt, inspect the full event trail:

```bash
sqlite3 "$STATE_PATH/write-audit.sqlite" "
SELECT event_type, created_at, operation, path, result_sha256, error_message, metadata_json
FROM write_audit_attempts
WHERE attempt_id = 'ATTEMPT_ID_HERE'
ORDER BY id ASC;
"
```

If an attempt has `started` followed by `failed`, the server observed and recorded the failure. If it has only `started`, use `list_write_recovery_diagnostics` and inspect the target note before retrying.

## 8. Recovery Workflow

When `list_write_recovery_diagnostics` returns rows:

1. Open the reported `path` in the vault.
2. Compare the current note hash/content against the caller's last known state if available.
3. Check operational logs around `startedAt`.
4. Check `write_audit` for a later successful write to the same path.
5. If the file is correct, treat the diagnostic as historical and document the decision.
6. If the file is incomplete or stale, repair it manually or retry with a fresh `base_sha256`.

Do not blindly retry a write after a crash. A filesystem mutation may have succeeded even if the terminal audit event was not recorded.
