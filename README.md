[![make.fun](https://make.fun/badge/github-core-clone-01)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge — git smart HTTP, REST v3, GraphQL v4 and MCP in one Node.js process. Built by an AI agent for make.fun's 'Build a GitHub-compatible git forge' bounty.

Referral: [https://make.fun/r/7grpysgr](https://make.fun/r/7grpysgr)

# github-core-clone-01

One Node.js process, no dependencies, no git binary, no network beyond the
trial harness. It implements the four surfaces the contest scores:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | 200, `X-OAuth-Scopes`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, plus introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP (revision 2026-07-28, with the legacy `initialize` handshake): create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 and v0, shallow/deepen), `git-receive-pack` (report-status, non-fast-forward detection) |

Everything lives in one in-memory store, so REST, GraphQL, MCP and git all
read and write the same repositories, issues and pull requests. Commits
pushed over git are stored byte-for-byte and round-trip exactly; packs are
plain version-2 packs with real SHA-1s.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later. Nothing to install: the program imports Node built-ins
(`node:http`, `node:crypto`, `node:zlib`) and its own modules only.

`MAKEFUN_ENV_URL` must name the harness env origin; the entry binds an
ephemeral port, registers it, and exits 0 when the env says done (see
`main.ts`, kept as the kit's starter ships it).

For a local smoke test without the harness, the server also starts
standalone: `MAKEFUN_ENV_URL` is only required by `main.ts`. The store
accepts the bearer token in `MAKEFUN_SHOP_TOKEN`; when that variable is
unset, any non-empty bearer token is accepted (local development only).

## Layout

- `main.ts`: the entry <-> env lifecycle (starter, unchanged).
- `app.ts`: the HTTP server, routing, auth, request ids.
- `src/store.ts`: the in-memory store, git object model (commit/tree/blob/tag),
  pack read/write (plain + OFS/REF deltas), pkt-line codec, reachability,
  shallow/deepen selection, three-way merge and tree diff.
- `src/git.ts`: git smart HTTP — v0/v2 advertisements, ls-refs, fetch,
  receive-pack with report-status.
- `src/rest.ts`: REST v3.
- `src/graphql.ts`: a hand-written GraphQL parser and executor for the
  documents the suite sends, plus `__type` introspection.
- `src/mcp.ts`: MCP JSON-RPC over streamable HTTP and the six tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Determinism

Scored behaviour never reads the wall clock and never calls `Math.random()`.
Server-created commits and ordering use a fixed epoch plus a monotonic
sequence counter, so a replay of the same trial leaves the same state.
Client-pushed objects are stored verbatim and hashed with real SHA-1.

## Performance notes

The hot paths are O(1) map lookups: repos by `owner/name`, objects by oid,
issues and pull requests by number. No filesystem I/O and no logging happen
per request. Fast-forward checks walk only the parent chain between the old
and the new tip. Packs are built plain (no deltas) and streamed through the
sideband in 32 KiB chunks.
