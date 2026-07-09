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
- **Auth**: an OIDC `Identity provider` issuer URL (**required** — endpoints auto-discovered
  from `/.well-known/openid-configuration`, with PocketID-style fallback paths; leaving this
  empty produces a broken OAuth discovery document with relative-path endpoints and no working
  auth, so the editor won't let you deploy without it), client id/secret (leave the secret
  empty to run as a public/PKCE client — recommended), **required** redirect URIs (defaults to
  Claude.ai's callback), scopes, token audience, an optional local debug token that bypasses
  the IdP entirely for local testing (put any placeholder URL in Identity provider and rely on
  the debug token — it's never contacted when the debug token matches), and a whole-server
  **required claim/value gate** (see below, unrelated despite the similar name).
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

### Reverse proxy

Each `mcp-server` node is its own OAuth resource — unlike a single shared MCP endpoint, every
instance registers **its own** discovery and registration routes, scoped under its `path`. For
a node with `path: docker` and `Server URL: https://mcp.example.com`, these six routes exist:

| Method & path | Purpose |
|---|---|
| `POST /mcp/docker` | The JSON-RPC MCP endpoint (bearer-token protected) |
| `GET /mcp/docker/.well-known/oauth-protected-resource` | Resource metadata (RFC 9728), path-inserted form |
| `GET /.well-known/oauth-protected-resource/mcp/docker` | Resource metadata (RFC 9728), RFC 8414 form |
| `GET /mcp/docker/.well-known/oauth-authorization-server` | Auth-server metadata (RFC 8414), path-inserted form |
| `GET /.well-known/oauth-authorization-server/mcp/docker` | Auth-server metadata (RFC 8414), RFC 8414 form |
| `POST /mcp/docker/oauth/register` | Dynamic client registration shim |

Both well-known forms are advertised because different MCP clients probe different ones —
expose both. Since every instance's routes share the `/mcp/<path>` and `/.well-known/*/mcp/<path>`
shapes, **one set of wildcard rules covers every current and future `mcp-server` node** (as long
as they're all reachable through the same domain/upstream) — no reverse-proxy change needed when
adding a new `path`. Example, using
[Caddy](https://caddyserver.com/) via [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy)
labels:

```yaml
labels:
  caddy_1: mcp.example.com
  caddy_1.reverse_proxy_0: /mcp/* "{{upstreams 1880}}"
  caddy_1.reverse_proxy_1: /.well-known/oauth-protected-resource/mcp/* "{{upstreams 1880}}"
  caddy_1.reverse_proxy_2: /.well-known/oauth-authorization-server/mcp/* "{{upstreams 1880}}"
```

Node-RED itself 404s any path that isn't an actual registered route, so the wildcard doesn't
expose anything beyond what each deployed `mcp-server` node already registers. If a `path`
needs to be reachable on a *different* domain than the others, give it its own `caddy_N` site
block (or combine with [hostname filtering](#hostname-filtering) above).

**What the identity provider needs to support** (same requirements as `lib/mcp-auth.js`):

- An **OIDC provider with discovery** — endpoints are read from
  `‹issuerUrl›/.well-known/openid-configuration`, falling back to PocketID's path layout if
  discovery is unavailable.
- **JWT access tokens** signed with a key published on the provider's **JWKS** (tokens are
  verified locally; opaque/introspection-only access tokens are not supported).
- A client configured with the **redirect URI(s)** from the node's *Redirect URIs* setting,
  grant types `authorization_code` + `refresh_token`, **PKCE (S256)**, and — if a client secret
  is set — `client_secret_post` auth. Leave the secret empty to run as a public/PKCE client
  (recommended).

> Tested with **Caddy** (reverse proxy) + **PocketID** (identity provider) + **Claude.ai** (MCP
> client). Any spec-compliant OIDC provider issuing JWT access tokens, behind any reverse proxy
> that forwards the routes above, should work the same way.

## Examples

See [`examples/`](examples/) for nine ready-to-import flows (Jellyfin, Calibre, Docker,
Music Assistant, Radarr, iRobot/rest980, Overseerr, Sonarr, Spotify), each with its own
`mcp-server` node (server description pre-filled, `Server URL`/`Identity provider` left
blank for you to fill in) and `mcp-in`/`mcp-out` tools — a good reference for wiring up
your own tools.

## Development

```
npm install
npm test
```

## License

ISC
