# @frtnbach/node-red-contrib-mcp-server

Generic [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server nodes for
Node-RED: expose any flow as an MCP tool behind an OAuth-protected endpoint, with optional
Node-RED admin (flow read/deploy) tools. No home-automation or other domain coupling — this
is a bare building block for turning Node-RED flows into MCP tools that AI assistants
(Claude, etc.) can call.

## Nodes

- **`mcp-server`** (config node) — hosts a standalone MCP JSON-RPC endpoint at
  `POST /mcp/<path>`, OAuth 2.0 protected-resource discovery (RFC 9728), authorization-server
  discovery (RFC 8414) proxying a real OIDC identity provider, and a dynamic client
  registration shim, so OAuth-aware MCP clients (e.g. Claude.ai) can self-register and
  authenticate. Multiple `mcp-server` nodes can coexist, each with its own path and its own
  independent auth configuration.
- **`mcp-in`** — defines one MCP tool (name, description, JSON-Schema parameters). When an
  MCP client calls the tool, the node emits a message carrying the call arguments; wire the
  rest of the flow to do the actual work.
- **`mcp-out`** — resolves a pending tool call. Wire the end of your flow here with
  `msg._mcpCallId` intact (from the originating `mcp-in` message) and `msg.payload` set to
  the result.

A single `mcp-in` → ... → `mcp-out` chain is one MCP tool. Build as many chains as you want
against the same `mcp-server` node to expose a whole toolset.

## Admin tools

Enable **Admin tools** on an `mcp-server` node to additionally expose two tools that operate
on Node-RED's own Admin HTTP API, gated by a configurable JWT claim (default: `groups`
contains `admin`):

- **`get_flow`** — lists all flow tabs (id, label, node count), or returns the full JSON of
  one tab when called with an `id`.
- **`deploy_flow`** — creates or updates a flow tab.

## Configuring an `mcp-server` node

- **General**: name, `path` (→ registers `POST /mcp/<path>`), the public `Server URL` this
  Node-RED instance is reachable at, optional server name/instructions shown to the model, and
  an optional **hostname filter** (see below).
- **Auth**: an OIDC `Identity provider` issuer URL (endpoints auto-discovered from
  `/.well-known/openid-configuration`, with PocketID-style fallback paths), client
  id/secret (leave the secret empty to run as a public/PKCE client — recommended), allowed
  redirect URIs, scopes, token audience, an optional local debug token that bypasses the
  IdP entirely for local testing, and a whole-server **required claim/value gate** (see below).
- **Admin**: enable/disable admin tools, admin token (for the Node-RED Admin API), admin API
  port, and the required claim/value gate that additionally restricts just the admin tools.

### Access control

Two independent, optional gates:

- **Whole-server gate** (Auth tab, `Required claim`/`Required value`): when a value is set, the
  validated token's claim must contain it for *any* of this server's tools — including admin
  tools — to be usable. Callers who fail the check still connect (`initialize` succeeds) but see
  no tools and any `tools/call` is refused with a human-readable reason. Leave the value empty
  (the default) to allow all authenticated users.
- **Admin-only gate** (Admin tab): the same shape, but only gates `get_flow`/`deploy_flow` —
  ordinary tools defined by `mcp-in`/`mcp-out` remain usable by anyone who passes the
  whole-server gate above.

Both denials are returned as an MCP tool result with `isError: true` and an explanatory message
(not a raw JSON-RPC protocol error), so the reason reaches the calling model instead of being
collapsed into a generic "tool execution failed".

### Hostname filtering

Off by default. When **Only serve requests for this hostname** is enabled, the node only answers
requests whose `Host` header matches the hostname in its `Server URL`. This lets several
`mcp-server` nodes share the *same* `path` on one Node-RED instance, each answering only its own
virtual host — useful behind a reverse proxy that fronts multiple hostnames for one Node-RED
backend. Leave it off for a single server, or when a reverse proxy rewrites the `Host` header.

## Examples

See [`examples/`](examples/) for nine ready-to-import flows (Jellyfin, Calibre, Docker,
Music Assistant, Radarr, iRobot/rest980, Overseerr, Sonarr, Spotify) built purely from
`mcp-in`/`mcp-out` — a good reference for wiring up your own tools.

## Development

```
npm install
npm test
```

## License

ISC
