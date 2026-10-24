# @frtnbach/node-red-contrib-mcp-server

Generic [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server nodes for
Node-RED: expose any flow as an MCP tool behind an OAuth-protected endpoint, and administer
Node-RED itself over MCP with a dedicated admin node. No home-automation or other domain
coupling — this is a bare building block for turning Node-RED flows into MCP tools that AI
assistants (Claude, etc.) can call.

Requires Node-RED 4.0 or later on Node.js 22 or later.

> **Breaking changes in 3.0.0.**
>
> **New type names.** Every node type now carries an `ftb-` prefix (`ftb-mcp-server`,
> `ftb-mcp-in`, `ftb-mcp-out`, `ftb-mcp-call`): the bare `mcp-*` names collide with other
> packages in the flow library, and two packages registering one type cannot be installed side
> by side. The palette labels are unchanged. Flows written for 2.x keep running — the old names
> are still registered, without an editor definition, so the editor shows those nodes as
> unknown and cannot edit them — and the editor offers to **convert** them in one click when it
> finds any. The conversion changes only the type; ids, wires, settings and stored credentials
> carry over. **4.0.0 removes the old names**, so convert before then.
>
> **Admin tools moved.** `get_flow`/`deploy_flow` and the server node's Admin tab are gone, as
> is `Allow admin tools` on `mcp-call`. Node-RED administration is now the
> [**MCP Admin**](#administering-node-red-mcp-admin) node: placed in a flow, with a server of
> its own, and with tools that change flows node by node instead of replacing whole tabs. A
> converted 2.x server that had admin tools enabled logs that they moved.
>
> **Minimum versions.** Node-RED 4.0 and Node.js 22 (it was Node-RED 2.2 and Node.js 20.19).
>
> **Arguments are validated.** A call whose arguments do not match the tool's schema is refused
> before the flow runs, where 2.x passed anything on. A schema that described the arguments loosely
> or wrongly may start refusing calls that used to work; **Validate** on the MCP In node turns it
> off for that tool.
>
> **Smaller changes.** `Access claim` defaults to `sub` on new MCP Server nodes (existing nodes keep
> their value), and `Debug groups` became `Debug claim values`, given to whichever claim that is.
> `Path` may be left empty to serve `/mcp` itself.

> **Breaking change in 2.0.0 — a resource server and nothing else.** This node no longer
> takes part in OAuth. It is not an OIDC client, registers nothing, and holds no
> credentials: the dynamic client registration shim, the authorization-server metadata
> routes and the `Client ID`/`Client secret` fields are all gone, along with the
> `/userinfo` round-trip that used to fetch claims per request. What remains is verifying
> the access token and reading what it says.
>
> **Migration.** Register each MCP client at your identity provider — or point it at a
> [Client ID Metadata Document](#authentication), if the provider resolves those — instead of
> letting it self-register here; clients that self-registered before the upgrade should be
> removed and re-added. Then make sure the claim your gates match on (`Access claim`,
> default `groups`) is in the **access token** and not only in the ID token or userinfo,
> adding whatever scope your provider needs for that under **Additional scopes**. If it
> cannot be — [PocketID, for one, has no way to put custom claims in the access
> token](https://github.com/pocket-id/pocket-id/issues/1389) — leave the claim lists empty.
> `Required scope` still limits which *clients* get in, but it cannot say which *users*:
> that is left to whatever user restriction the provider applies per client, which covers
> every API the client reaches rather than this server alone. There is no per-user gate
> for this server without the claim. A gate whose claim is absent from every token refuses
> everyone, and says so in the log once per client.

## Nodes

Palette names first, with the node type (what flow JSON says) in brackets.

- **MCP Server** (`ftb-mcp-server`, config node) — hosts a standalone MCP JSON-RPC endpoint at
  `POST /mcp/<path>`, protected by a bearer token it verifies itself, and publishes OAuth 2.0
  protected-resource metadata (RFC 9728) pointing OAuth-aware MCP clients (e.g. Claude.ai) at
  the identity provider that issues those tokens. It runs no login and performs no OAuth flow
  of its own. Multiple MCP Server nodes can coexist, each with its own path and its own
  independent auth configuration.
- **MCP In** (`ftb-mcp-in`) — defines one MCP tool (name, description, JSON-Schema parameters, and an
  optional per-tool access gate). When an MCP client calls the tool, the node emits a message
  carrying the call arguments; wire the rest of the flow to do the actual work. Arguments are
  **checked against the JSON schema** before the flow runs — types, `required`, `enum`,
  `minimum`/`maximum`, lengths, `pattern`, `items`, `additionalProperties: false` — and a call
  that does not match is refused with the reason (switchable per node with **Validate**). They
  are still **caller input**: a string the schema allows can hold anything, so escape it before
  use in shell commands, file paths, URLs or queries.
- **MCP Out** (`ftb-mcp-out`) — resolves a pending tool call. Wire the end of your flow here with
  `msg._mcpCallId` intact (from the originating MCP In message) and `msg.payload` set to
  the result.
- **MCP Call** (`ftb-mcp-call`) — the back door into your own tools: calls the MCP In nodes deployed in
  *this* Node-RED directly, from a flow. It is not an MCP client and reaches no server
  elsewhere. Send `{ "tool": "<name>", "args": { ... } }`, or `{ "list": true }` to get the
  configured server's catalogue in the shape `tools/list` returns.
- **MCP Admin** (`ftb-mcp-admin`) — administers this Node-RED over MCP: reads, searches,
  changes and tests flows, and undoes changes. See
  [Administering Node-RED](#administering-node-red-mcp-admin).

A single MCP In → ... → MCP Out chain is one MCP tool. Build as many chains as you want
against the same MCP Server node to expose a whole toolset.

### Calling your own tools from a flow

The name misleads if you read it as a client. MCP Call speaks no protocol and opens no
connection; it reaches into the MCP Server config node you point it at and invokes the MCP In
nodes deployed alongside it, in-process. Everything a real client goes through — the HTTP route,
the bearer token, the gates — is upstream of where it joins in.

It exists for two things. Reusing a flow that already sits behind an MCP In without wiring a
parallel `link in` beside it — for plain flow-to-flow request/response with no MCP tool involved,
Node-RED's built-in `link call` is the simpler answer. And asking a server what it holds: since
every tool here is defined by your own MCP In nodes, `{ "list": true }` is usually the only
index of them there is.

**Tool access does not apply on this path**, and that follows from where the node sits. The claim
and scope gates guard the HTTP route and the token arriving on it, which this node never sees, so
entering behind them means entering past them. That is deliberate: a flow node is already inside
the trust boundary — whoever can edit flows can edit the tool — so a gate here would guard nothing
while implying it guarded something. It does mean MCP Call must not be used to re-expose a gated
tool to an outside caller; that gate is yours to reproduce. The same holds for an **MCP Admin**
node's tools, which are registered like any other: a flow that reaches them can change your flows.

## Administering Node-RED (MCP Admin)

An **MCP Admin** node exposes Node-RED's own Admin API as MCP tools. It is a flow node, not a
server option: whether this Node-RED can be administered over MCP is visible in the flow, and
disabling or deleting the node takes the tools away. Its tools register on the **MCP Server** you
choose exactly like `MCP In` tools and sit behind that server's gates. **Give it a server of its
own** (say `path: nodered`): which clients may administer Node-RED then comes down to one resource
at your identity provider.

The tools come in groups, switched on the node. Read is on by default; everything that changes
something is opt-in, and the optional **Write access** list (values of the server's access claim)
restricts the changing tools further.

| Group | Tools |
|---|---|
| Read | `list_flows`, `get_flow`, `get_node`, `find_nodes`, `get_context`, `get_runtime`, `validate`, `list_snapshots` |
| Flows | `patch_nodes`, `add_nodes`, `remove_nodes`, `create_flow`, `delete_flow`, `set_flow_enabled`, `rollback` |
| Test | `inject`, `get_debug` |
| Context | `delete_context` |

**Writes change nodes, not tabs.** `patch_nodes` sets or unsets properties on the nodes it names,
global config nodes included; everything it does not name is kept. Every write reads the flows
with their revision, changes a copy, **validates** it, snapshots the deployed state and deploys
with that revision (`Node-RED-Deployment-Type: nodes`, so only changed nodes restart). A deploy
that happened in between — from the editor, say — makes the write fail rather than overwrite it.
Reads answer the current `rev`; pass it back as `expected_rev` to have a write refused if anything
changed since you looked, not only when the change itself collides. Every failure answers
`{ ok: false, error }`, with `errors` added for validation and `conflict: true` for a stale revision.
Validation refuses wires and links into nothing, references emptied or left dangling (a config
node removed while still used, a patch that blanked one), nodes outside any flow, duplicate ids
and types the runtime does not know. `dry_run` on any write reports what would change.

**Snapshots and rollback.** The configuration as it was before each write is kept under
`<userDir>/.mcp-admin/<node id>/` (50 by default). `rollback` restores one, after snapshotting the
state it replaces. Snapshots never contain credentials: nodes that still exist keep theirs, a node
recreated by a rollback comes back without them.

**Secrets.** Credentials stay in Node-RED's credential store and are never served. Secrets kept
elsewhere — plain node properties, context values a flow saved, URLs with a password or a token
parameter — are answered as `«masked: N chars»` while **Mask secrets** is on (the default), matched
by name (token, secret, password, api key, credential, cookie …). **Also mask** adds `type.property`
entries no name gives away, such as `ical-config.url`. Writes refuse masked values, so a placeholder
can never replace the real secret. A secret written into function code cannot be told from code;
keep those in credentials or environment variables.

**Testing.** `inject` presses an inject node's button, optionally with message properties of your
own; `get_debug` returns what the debug sidebar received since — debug-node output, and warnings
and errors raised by any node.

**Outputs.** Two, for a flow to turn into a notification, a log or nothing — the node itself
notifies no one. Both carry `msg.topic` `mcp-admin/<tool>`, and `sub` and `client` from the
caller's token.

1. **Changes**: one message per change, refused ones included —
   `{ time, event, tool, instance, sub, client, summary, changed, rev, snapshot }`, with `event` one
   of `deployed`, `rejected` (and a `reason`: `validation`, `conflict` or `own-server`), `injected`
   or `context-deleted`. Reads send nothing here.
2. **Every call**: one message per tool call, reads included —
   `{ time, tool, instance, sub, client, args, ok, error, durationMs }`, with `args` summarized
   (long strings cut, long arrays counted).

**Several instances.** A client may hold these tools for more than one Node-RED. `Instance` and
`Description` on the node say which one this is and what runs there; they open the instructions
sent on connect, `get_runtime` reports them, and every answer that changes something names the
instance it changed. `Instance` defaults to the host in the MCP Server node's `Server URL`.

**Deliberately not offered:** installing or removing node modules; starting and stopping the
flows, since stopping them stops the MCP server serving the tools and nothing could start them
again from there; and changing the **MCP Server** the tools are served by — that would restart it
mid-answer, and a mistake would lock every client out of the tools that could fix it. Do those in
the editor.

**The admin token.** The tools call this Node-RED's own Admin API with the **Admin token** set on
the node, and Node-RED accepts it only if `settings.js` knows it. What the token is allowed to do
there is what the tools can do. To set it up:

1. Make up a long random token (`openssl rand -hex 32`) and give it to Node-RED as an environment
   variable — `NODERED_ADMIN_API_TOKEN` below.
2. In `settings.js`, add a `tokens` function to `adminAuth` that maps that token to a user of its
   own, with only the permissions the groups you enabled need. The user is made up on the spot: it
   needs no entry in `users`, so no one can log in to the editor as it.
3. Restart Node-RED, and paste the same token into **Admin token** on the node.

```js
adminAuth: {
    // ... your editor login ...
    tokens: t => Promise.resolve(t === process.env.NODERED_ADMIN_API_TOKEN
        ? { username: "mcp-admin", permissions: [
            "flows.read", "nodes.read", "settings.read", "diagnostics.read", "context.read",
            "projects.read",                  // Read: get_runtime names the active project
            "flows.write",                    // Flows
            "inject.write", "status.read",    // Test (status.read lets get_debug connect)
            "context.write"                   // Context
          ] }
        : null)
}
```

A token without a permission a tool needs gets an error naming that permission.

## Configuring an MCP Server node

- **General**: name, `path` (→ registers `POST /mcp/<path>`, or `POST /mcp` when empty), the public `Server URL` this
  Node-RED instance is reachable at, optional server name/instructions shown to the model, and
  an optional **hostname filter** (see below).
- **Auth**: an OIDC `Identity provider` issuer URL (**required** — endpoints auto-discovered
  from `/.well-known/openid-configuration`, with PocketID-style fallback paths; leaving this
  empty produces a protected-resource document naming no authorization server, so the editor
  won't let you deploy without it), `Additional scopes` for whatever your provider needs in
  order to put the access claim in the token, token audience, an optional debug token that bypasses
  the IdP entirely for setups where OAuth cannot be set up (put any placeholder URL in Identity
  provider and rely on the debug token — it's never contacted when the debug token matches; the
  token bypasses authentication on the server's route wherever that is reachable from, grants no
  `groups` unless configured, and is named in the log at every start while set), and the
  `Access claim` / `Server access` gate (see below).

### Access control

**One claim name, many value lists.** `Access claim` on the Auth tab names the single JWT claim
every gate matches against. It defaults to `sub`, the user's id: the one claim every JWT access
token carries ([RFC 9068 §2.2](https://www.rfc-editor.org/rfc/rfc9068.html#section-2.2)), where
`groups` and its kind exist only if the provider puts them in the access token — and some, PocketID
among them, cannot. Use `groups` (or a role claim) where your provider supplies it. Every other authorization field is a comma-separated
**any-of** list of that claim's values — `media, ops` passes if the claim contains at least one of
them. An empty list imposes no restriction.

**Nested claims** are addressed with a dotted path, for providers that don't put roles at the top
level of the token: `realm_access.roles` reads Keycloak's realm roles, and any depth works. A key
that exists literally always wins, so a claim genuinely named with a dot in it still resolves to
itself. Only strings and arrays of strings match — pointing the claim at a container object grants
nothing rather than matching by accident.

| Field | Where | Restricts |
|---|---|---|
| `Server access` | MCP Server, Auth tab | every tool on this server |
| `Tool access` | MCP In | that one tool, additionally |
| `Write access` | MCP Admin | that node's changing tools, additionally |

**The lists are combined with AND.** Reaching a tool means clearing the server's list *and* that
tool's own list.

```
Access claim: groups     Server access: staff
tool A: (empty)   tool B: media

groups=[staff]         → A
groups=[staff, media]  → A, B
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

> **Upgrading from before 2.1:** a gate value that literally contains a comma is read as a list
> rather than one literal string, and the gate fields were relabelled (`Required claim`/`Required
> value` → `Access claim`/`Server access`); the underlying settings are unchanged.

### Authentication

**This node is a resource server, and nothing else.** It runs no login, holds no client credentials and performs no OAuth flow. It publishes [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected-resource metadata naming your identity provider, and clients go there directly — with a [Client ID Metadata Document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-01) or a pre-registered client ID. Dynamic client registration is deprecated by MCP 2026-07-28 and, as of 2.0.0, is no longer offered here.

**A request is authenticated by the access token alone.** Signature against the provider's JWKS, issuer pinned to the discovered provider, expiry enforced, and the audience must name this server. There is no second call: nothing is fetched from `/userinfo`, which serves a client asking about its own user rather than a resource server asking about a token. **Everything the access gates read must therefore be in the token** — see [RFC 9068 §2.2.3.1](https://www.rfc-editor.org/rfc/rfc9068.html), which is where an authorization server is told to put `groups`, `roles` and `entitlements`. A provider that keeps them in the ID token or userinfo alone leaves the claim gate with nothing to match, and the log says so, once per client.

**Client ID Metadata Documents (CIMD).** MCP 2026-07-28 deprecates dynamic client registration in favour of [CIMD](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-01), where a client's id is the HTTPS URL of a metadata document it hosts itself. Nothing about it is configured here, and this node advertises nothing: it reads `client_id_metadata_document_supported` from your IdP's discovery document purely to log which clients arrive that way. Resolving the document is the IdP's job, and a resource server is in no position to promise support the IdP doesn't have. Discovery is fetched once and cached for the lifetime of the node, so switching CIMD on or off at the IdP is picked up at the next Node-RED restart or deploy — not live.

A CIMD client's token is held to the same audience check as any other: `aud` must name this server's resource identifier (or the configured Token audience). The client's document URL, in `aud` or `azp`, is never accepted in its place — the same client holds tokens for every server it talks to at the same IdP, and accepting its id would make each of them good here. `MCP CIMD client authenticated: <url>` is logged the first time each such client is seen after a restart, so which clients arrived that way is readable rather than guessed at.

A client whose provider does not resolve metadata documents needs a client id registered at that provider by hand. Self-registration is not an option this server can restore: it never held the credentials that would make one, and since 2.0.0 it does not pretend to.

### Protocol

The endpoint speaks MCP protocol version `2024-11-05` over plain HTTP POST — every request is
one JSON-RPC message, every response one JSON body. `initialize`, `tools/list`, `tools/call` and
`ping` are supported; there is no SSE/streaming `GET` channel and no server-initiated messages.
This is the subset today's OAuth-capable MCP clients (e.g. Claude) actually use against a tools-only
server. The advertised version is intentionally pinned rather than echoing the client's offer.

### Hostname filtering

Off by default. When **Only serve requests for this hostname** is enabled, the node only answers
requests whose `Host` header matches the hostname in its `Server URL`. This lets several
MCP Server nodes share the *same* `path` on one Node-RED instance, each answering only its own
virtual host — useful behind a reverse proxy that fronts multiple hostnames for one Node-RED
backend. Leave it off for a single server, or when a reverse proxy rewrites the `Host` header.

### Reverse proxy

Each MCP Server node is its own OAuth resource — unlike a single shared MCP endpoint, every
instance registers **its own** discovery routes, scoped under its `path`. For a node with
`path: docker` and `Server URL: https://mcp.example.com`, these three routes exist:

| Method & path | Purpose |
|---|---|
| `POST /mcp/docker` | The JSON-RPC MCP endpoint (bearer-token protected) |
| `GET /mcp/docker/.well-known/oauth-protected-resource` | Resource metadata (RFC 9728), path-inserted form |
| `GET /.well-known/oauth-protected-resource/mcp/docker` | Resource metadata (RFC 9728), RFC 8414 form |

Authorization-server metadata is **not** among them. A client reads the issuer out of the
resource metadata and fetches that provider's own `/.well-known/openid-configuration` directly,
rather than a copy proxied through here.

Both well-known forms are advertised because different MCP clients probe different ones —
expose both. Since every instance's routes share the `/mcp/<path>` and `/.well-known/*/mcp/<path>`
shapes, **one set of wildcard rules covers every current and future MCP Server node** (as long
as they're all reachable through the same domain/upstream) — no reverse-proxy change needed when
adding a new `path`. Example, using
[Caddy](https://caddyserver.com/) via [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy)
labels:

```yaml
labels:
  caddy_1: mcp.example.com
  caddy_1.reverse_proxy_0: /mcp/* "{{upstreams 1880}}"
  caddy_1.reverse_proxy_1: /.well-known/oauth-protected-resource/mcp/* "{{upstreams 1880}}"
```

Upgrading from 1.x: a third rule for `/.well-known/oauth-authorization-server/mcp/*` can be
dropped, since nothing answers there any more. Leaving it in place is harmless — it forwards to
a 404 — but it no longer forwards to anything.


A server with an empty `path` lives at `/mcp` itself — typical when it has a hostname of its own —
and needs the bare forms as well: `/mcp`, `/mcp/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. Turn on hostname filtering for it, so it does not
answer `/mcp` for every hostname the Node-RED serves.

Node-RED itself 404s any path that isn't an actual registered route, so the wildcard doesn't
expose anything beyond what each deployed MCP Server node already registers. If a `path`
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
  `https://claude.ai/api/mcp/auth_callback`) — or CIMD support, which supplies all of that
  from the client's own metadata document. Clients, redirect URIs and secrets are entirely
  the provider's business; this node has no fields for any of them and never sees a redirect.
- The **access claim in the access token**, if you use the claim gate — the token is all this
  server reads. See [RFC 9068 §2.2.3.1](https://www.rfc-editor.org/rfc/rfc9068.html). Not every
  provider can: PocketID currently cannot ([#1389](https://github.com/pocket-id/pocket-id/issues/1389)), and without the claim
  there is no per-user gate — `Required scope` restricts clients, not users.

> Tested with **Caddy** (reverse proxy) + **PocketID** (identity provider) + **Claude.ai** and
> **Hermes** (MCP clients). Any spec-compliant OIDC provider issuing JWT access tokens, behind
> any reverse proxy that forwards the routes above, should work the same way. The claim gate
> is the exception with PocketID, which does not yet put it in the access token.

## Examples

See [`examples/`](examples/) for ready-to-import flows (Jellyfin, Calibre, Docker,
Music Assistant, Radarr, iRobot/rest980, Overseerr, Sonarr, SL, Spotify), each with its own
**MCP Server** node (server description pre-filled, `Server URL`/`Identity provider` left
blank for you to fill in) and `MCP In`/`MCP Out` tools — a good reference for wiring up
your own tools — plus one with an **MCP Admin** node and an **MCP Call**.

## Development

```
npm install
npm test
```

## License

ISC
