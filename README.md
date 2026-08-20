# @frtnbach/node-red-contrib-mcp-server

Generic [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server nodes for
Node-RED: expose any flow as an MCP tool behind an OAuth-protected endpoint, with optional
Node-RED admin (flow read/deploy) tools. No home-automation or other domain coupling — this
is a bare building block for turning Node-RED flows into MCP tools that AI assistants
(Claude, etc.) can call.

> **Breaking change in 0.5.0 — public client (PKCE) only.** Client secrets and the
> node-side redirect URI allowlist are gone: the open client-registration endpoint handed
> any configured secret to every caller, and redirect URIs are validated by the identity
> provider at `/authorize` anyway. **Migration:** switch the IdP client to **public with
> PKCE** (a still-confidential client fails token exchange with `invalid_client`), make
> sure the MCP client callback URLs are whitelisted at the IdP, and if the node warns
> about a stored secret, open its config, click **Done**, and deploy to delete it. MCP
> clients connected before the upgrade may have cached the old registration — remove and
> re-add the server in the client if sign-in misbehaves.

## Nodes

- **`mcp-server`** (config node) — hosts a standalone MCP JSON-RPC endpoint at
  `POST /mcp/<path>`, OAuth 2.0 protected-resource discovery (RFC 9728), authorization-server
  discovery (RFC 8414) proxying a real OIDC identity provider, and a dynamic client
  registration shim, so OAuth-aware MCP clients (e.g. Claude.ai) can self-register and
  authenticate. Multiple `mcp-server` nodes can coexist, each with its own path and its own
  independent auth configuration.
- **`mcp-in`** — defines one MCP tool (name, description, JSON-Schema parameters, and an
  optional per-tool access gate). When an MCP client calls the tool, the node emits a message
  carrying the call arguments; wire the rest of the flow to do the actual work. The arguments
  in `msg.payload` are **untrusted caller input** — the JSON schema is documentation for the
  model, not validation — so the flow must validate and escape them before use in shell
  commands, file paths, URLs or queries.
- **`mcp-out`** — resolves a pending tool call. Wire the end of your flow here with
  `msg._mcpCallId` intact (from the originating `mcp-in` message) and `msg.payload` set to
  the result.

- **`mcp-call`** — the back door into your own tools: calls the `mcp-in` nodes deployed in
  *this* Node-RED directly, from a flow. It is not an MCP client and reaches no server
  elsewhere. Send `{ "tool": "<name>", "args": { ... } }`, or `{ "list": true }` to get the
  configured server's catalogue in the shape `tools/list` returns.

A single `mcp-in` → ... → `mcp-out` chain is one MCP tool. Build as many chains as you want
against the same `mcp-server` node to expose a whole toolset.

### Calling your own tools from a flow

The name misleads if you read it as a client. `mcp-call` speaks no protocol and opens no
connection; it reaches into the `mcp-server` config node you point it at and invokes the `mcp-in`
nodes deployed alongside it, in-process. Everything a real client goes through — the HTTP route,
the bearer token, the gates — is upstream of where it joins in.

It exists for two things. Reusing a flow that already sits behind an `mcp-in` without wiring a
parallel `link in` beside it — for plain flow-to-flow request/response with no MCP tool involved,
Node-RED's built-in `link call` is the simpler answer. And asking a server what it holds: since
every tool here is defined by your own `mcp-in` nodes, `{ "list": true }` is usually the only
index of them there is.

**Tool access does not apply on this path**, and that follows from where the node sits. The claim
and scope gates guard the HTTP route and the token arriving on it, which this node never sees, so
entering behind them means entering past them. That is deliberate: a flow node is already inside
the trust boundary — whoever can edit flows can edit the tool — so a gate here would guard nothing
while implying it guarded something. It does mean `mcp-call` must not be used to re-expose a gated
tool to an outside caller; that gate is yours to reproduce. Admin tools are the exception and keep
the route's rule: enabled on the server, enabled on the `mcp-call` node, **and** an admin claim on
`msg.claims`.

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
  auth, so the editor won't let you deploy without it), a client id (the IdP client must be
  **public with PKCE** — client secrets are no longer supported, and redirect URIs are
  configured and validated at the IdP only), scopes, token audience, an optional local debug token that bypasses
  the IdP entirely for local testing (put any placeholder URL in Identity provider and rely on
  the debug token — it's never contacted when the debug token matches; the `groups` claim the
  debug user gets is configurable so the access gates can be tested locally too), and the
  `Access claim` / `Server access` gate (see below).
- **Admin**: enable/disable admin tools, admin token (for the Node-RED Admin API), admin API
  port, and the `Admin access` gate that additionally restricts just the admin tools.

### Access control

**One claim name, many value lists.** `Access claim` on the Auth tab (default `groups`) names the
single JWT claim every gate matches against. Every other authorization field is a comma-separated
**any-of** list of that claim's values — `media, ops` passes if the claim contains at least one of
them. An empty list imposes no restriction.

**Nested claims** are addressed with a dotted path, for providers that don't put roles at the top
level of the token: `realm_access.roles` reads Keycloak's realm roles, and any depth works. A key
that exists literally always wins, so a claim genuinely named with a dot in it still resolves to
itself. Only strings and arrays of strings match — pointing the claim at a container object grants
nothing rather than matching by accident.

| Field | Where | Restricts |
|---|---|---|
| `Server access` | mcp-server, Auth tab | every tool on this server |
| `Tool access` | mcp-in | that one tool, additionally |
| `Admin access` | mcp-server, Admin tab | `get_flow`/`deploy_flow`, additionally |

**The lists are combined with AND.** Reaching a tool means clearing the server's list *and* that
tool's own list. Admin tools are not a special case — their field is simply the tool list for
`get_flow`/`deploy_flow`.

```
Access claim: groups     Server access: staff
tool A: (empty)   tool B: media   Admin access: admin

groups=[staff]         → A
groups=[staff, media]  → A, B
groups=[staff, admin]  → A + get_flow, deploy_flow
groups=[media]         → nothing            (server list not cleared)
groups=[guest]         → nothing

Server access empty:
groups=[media]         → A, B
groups=[guest]         → A
```

Everyone with a valid token still connects — `initialize` always succeeds — but tools a caller
can't reach are hidden from `tools/list` and from the `initialize` instructions. A direct
`tools/call` on one of them is refused as an MCP tool result with `isError: true` and an
explanatory message (not a raw JSON-RPC protocol error), so the reason reaches the calling model
instead of being collapsed into a generic "tool execution failed".

### The client axis: required scope

The lists above answer *what may this user do*. `Required scope` answers a
different question — *what is this client authorized to do on the user's behalf* — and the two
are checked with **AND**.

They are not interchangeable. A group says who is at the keyboard; a scope says how much of that
person's authority was delegated to the software holding the token. Collapse them into one field
and only one gets consulted: a client granted a read-only scope, driven by someone who may write,
would write. The client's grant has to bound the user's rights, not be ignored.

The required scope is added to `scopes_supported` automatically, so there is nothing to repeat in the scopes field, and it is named in the `WWW-Authenticate` challenge on a 401.

The scope claim is read the way OAuth defines it
([RFC 6749 §3.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.3)): a space-delimited
string, or an array if your provider sends one. The claim name is not configurable because it is standardised; `scp` is read as a fallback for
Microsoft Entra and Okta. The field itself is a comma-separated any-of list. Empty means no constraint, so an install that
never fills it in is unaffected; a configured scope the token does not carry is refused,
including when the token has no scope claim at all.

> **Upgrading:** the admin gate no longer has its own claim-name field — it matches against the
> Auth tab's `Access claim` like everything else. If you had set a *different* claim name for
> admin tools, move that value to the Auth tab or adjust the admin list accordingly. A value that
> literally contains a comma is now read as a list rather than one literal string. The gate fields
> were also relabelled (`Required claim`/`Required value` → `Access claim`/`Server access`/`Admin
> access`); the underlying settings are unchanged, so existing flows keep working untouched.

### Protocol

The endpoint speaks MCP protocol version `2024-11-05` over plain HTTP POST — every request is
one JSON-RPC message, every response one JSON body. `initialize`, `tools/list`, `tools/call` and
`ping` are supported; there is no SSE/streaming `GET` channel and no server-initiated messages.
This is the subset today's OAuth-capable MCP clients (e.g. Claude) actually use against a tools-only
server. The advertised version is intentionally pinned rather than echoing the client's offer.

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

**Client ID Metadata Documents (CIMD).** MCP 2026-07-28 deprecates dynamic client registration in favour of [CIMD](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-01), where a client's id is the HTTPS URL of a metadata document it hosts itself. This node advertises `client_id_metadata_document_supported` by mirroring what your IdP's discovery document says — it is never configured here, because it is the IdP that resolves the client id, and this server is in no position to promise support the IdP doesn't have. Discovery is fetched once and cached for the lifetime of the node, so enabling or disabling CIMD on the IdP is picked up at the next Node-RED restart or deploy — not live.

**This node is a resource server, and nothing else.** It runs no login, holds no client credentials and performs no OAuth flow. It publishes [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected-resource metadata naming your identity provider, and clients go there directly — with a [Client ID Metadata Document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-01) or a pre-registered client ID. Dynamic client registration is deprecated by MCP 2026-07-28 and, as of 2.0.0, is no longer offered here.

**A request is authenticated by the access token alone.** Signature against the provider's JWKS, issuer pinned to the discovered provider, expiry enforced, and the audience must name this server. There is no second call: nothing is fetched from `/userinfo`, which serves a client asking about its own user rather than a resource server asking about a token. **Everything the access gates read must therefore be in the token** — see [RFC 9068 §2.2.3.1](https://www.rfc-editor.org/rfc/rfc9068.html), which is where an authorization server is told to put `groups`, `roles` and `entitlements`. A provider that keeps them in the ID token or userinfo alone leaves the claim gate with nothing to match, and the log says so, once per client.

Both mechanisms stay available on purpose. Clients pick in the spec's order — pre-registered, then CIMD, then DCR — so a client without CIMD support keeps using the registration shim exactly as before. Which mechanism each client took is readable from the log: `MCP CIMD client authenticated: <url>` the first time a CIMD client is seen after a restart, and `MCP DCR fallback` for a client that registered even though the IdP advertises CIMD. Between them the two lines account for every client that reaches the server.

Tokens from a CIMD client carry that document URL as their audience rather than your pre-registered client id, and they are accepted whenever the IdP advertises CIMD. This node keeps no second allowlist of its own, so the IdP's list of accepted metadata documents is the boundary — any CIMD client on it can reach this server, with the claim gate as the remaining check.

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
- A **public client** with **PKCE (S256)**, grant types `authorization_code` +
  `refresh_token`, and the MCP client's **redirect URI(s)** whitelisted (for Claude.ai:
  `https://claude.ai/api/mcp/auth_callback`). Redirect URIs are configured and validated at
  the identity provider only — the node no longer keeps its own allowlist, so IdP wildcard
  support (e.g. PocketID's) works as-is. Client secrets are no longer supported: the open
  client-registration endpoint handed any configured secret to every caller, so it could
  never actually be secret. If a secret is still stored from an earlier version it is
  ignored with a warning — switch the IdP client to public, then open the node's config,
  click Done, and deploy to delete the stored secret and clear the warning.

> Tested with **Caddy** (reverse proxy) + **PocketID** (identity provider) + **Claude.ai** and
> **Hermes** (MCP clients). Any spec-compliant OIDC provider issuing JWT access tokens, behind
> any reverse proxy that forwards the routes above, should work the same way.

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
