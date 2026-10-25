const crypto = require('crypto');
const http   = require('http');
const https  = require('https');

const pkgVersion = require('../package.json').version;

const { createMcpAuth }              = require('../lib/mcp-auth');
const { createHttpGuards, hostFilter, hostRegistry } = require('../lib/http-guards');
const { toolOk, respond, unknownTool } = require('../lib/tool-result');
const { handleRpc }                  = require('../lib/mcp-rpc');
const { requiredScopeChallenge, advertisedScopes,
        visibleTools,
        gateReadsClaim }             = require('../lib/claim-gate');
const { buildProtectedResourceMetadata } = require('../lib/oauth-discovery');
const { unsupportedKeywords, invalidPatterns } = require('../lib/schema');

function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const u    = new URL(url);
        const lib  = u.protocol === 'https:' ? https : http;
        const opts = {
            hostname : u.hostname,
            port     : u.port || (u.protocol === 'https:' ? 443 : 80),
            path     : u.pathname + (u.search || ''),
            method   : 'GET',
            headers  : headers || {}
        };
        const req = lib.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Remove only THIS node's registration for path+method. Several mcp-server nodes may share
// the same path (hostname filtering), so matching on path alone would let a partial deploy
// of one node silently strip its siblings' routes too. Ownership is read off the tagged
// hostFilter middleware each route chain starts with; an untagged or foreign layer is kept.
function removeRoute(RED, method, path, ownerId) {
    if (!RED.httpNode || !RED.httpNode._router) return;
    RED.httpNode._router.stack = RED.httpNode._router.stack.filter(layer => {
        if (!layer.route) return true;
        if (layer.route.path !== path || !layer.route.methods[method]) return true;
        return !(layer.route.stack || []).some(l =>
            l.handle && l.handle._mcpOwner !== undefined && l.handle._mcpOwner === ownerId);
    });
}

module.exports = function (RED) {

    function McpServer(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // ── Routes ───────────────────────────────────────────────────────────────
        // Every mcp-server instance owns its own routes, scoped under /mcp/<path> —
        // multiple independent MCP servers (one per integration) can coexist. An empty path is
        // /mcp itself, for a server with a hostname of its own.
        const routePath    = (config.path || '').trim().replace(/^\/+|\/+$/g, '');
        const mcpRoutePath = '/mcp' + (routePath ? '/' + routePath : '');
        const publicBase   = (config.serverUrl || '').replace(/\/$/, '');
        const resourceUrl  = publicBase + mcpRoutePath;
        // Read by nodes registering tools here that need to name the server, as MCP Admin does.
        node.resourceUrl   = resourceUrl;
        const serverName   = config.serverName || ('mcp-' + (routePath || 'server'));
        // The configured text, then whatever nodes registering tools here add about them — keyed
        // by owner so each one replaces or withdraws only its own.
        const contributedInstructions = new Map();
        const instructions = () => [config.instructions || '', ...contributedInstructions.values()]
            .filter(Boolean).join('\n\n');
        node.setInstructions = (ownerId, text) => {
            if (text) contributedInstructions.set(ownerId, String(text));
            else contributedInstructions.delete(ownerId);
        };

        const wellKnownPaths = name => [
            mcpRoutePath + '/.well-known/' + name,
            '/.well-known/' + name + mcpRoutePath
        ];
        const resourceMetadataPaths = wellKnownPaths('oauth-protected-resource');

        // Optional Host-header filtering. Lets several mcp-server nodes share the same path
        // on one Node-RED instance, split by hostname. Off by default so single-server setups
        // — and anyone behind a proxy that rewrites Host — keep matching on path alone. Fails
        // open (filtering disabled, with a warning) if enabled without a parseable URL, so a
        // typo can't 404 everyone.
        let expectedHost = '';
        if (config.filterHost) {
            try {
                expectedHost = new URL(publicBase).host;
            } catch {
                node.warn('Hostname filtering enabled but Server URL "' + publicBase +
                          '" is not a valid URL — filtering disabled, matching on path only');
            }
        }
        // A bare /mcp answers for every hostname this Node-RED serves, and is the path other
        // packages' single-endpoint servers use too (hal2's event handler, for one). Allowed, but
        // said: servers here step aside for one filtered on the same path, but a package that does
        // not take part in the host registry below is not stepped aside for.
        if (!routePath && !expectedHost) {
            node.warn('Serving /mcp without hostname filtering: this server answers /mcp for every hostname '
                + 'this Node-RED serves. Turn on "Only serve requests for this hostname" if another '
                + 'MCP endpoint lives at /mcp here.');
        }

        // One shared hostFilter instance, tagged with this node's id so removeRoute (above)
        // can tell this node's routes apart from a sibling's on the same path. The registry makes
        // a filtered server win its hostname whatever the order the routes were registered in;
        // claimed for exactly the routes registered below, and released on close.
        const registry = hostRegistry(RED.httpNode);
        const ownedHostFilter = hostFilter(expectedHost, registry);
        ownedHostFilter._mcpOwner = node.id;
        registry.claim(node.id, expectedHost,
            resourceMetadataPaths.map(p => ['GET', p]).concat([['POST', mcpRoutePath]]));

        // The one claim name every gate on this server matches against — the server-wide list
        // below and each registered tool's own list. Everything else is values.
        // `sub` by default: the one claim every JWT access token carries (RFC 9068 §2.2), where
        // `groups` and its kind exist only if the provider puts them there — and some cannot.
        const requiredClaim = (config.requiredClaim || 'sub').trim();
        // Whole-server gate: a comma-separated any-of list that applies to every tool here.
        // Default '' (allow all) only when never set. Empty string stays "any authenticated user";
        // set a list and others still connect, but see no tools and cannot call any.
        const requiredValue = (config.requiredValue === undefined ? '' : config.requiredValue).trim();
        // The client axis, independent of the claim axis above. The claim it reads is not
        // configurable — see tokenScopes. Empty means no constraint, so an install that never
        // fills this in behaves exactly as it did before the field existed.
        const requiredScope = (config.requiredScope || '').trim();
        // Named in the 401 challenge so a client asks for what the gate requires, and checked
        // against what this server advertises: a required scope missing from the scopes field is
        // invisible to any client that falls back to scopes_supported, and the symptom is every
        // tool hidden with nothing logged. Warned, not silently fixed — the scope also has to
        // exist at the identity provider and be granted there.
        const requiredScopes = requiredScopeChallenge([requiredScope]);

        // ── Auth (OIDC discovery, JWKS, token validation, Bearer middleware) ───────
        // Incoming tokens must carry this in `aud`, so that tokens issued to other apps at the
        // same identity provider are rejected. Empty means the resource identifier is required
        // instead — what MCP mandates a client asks for (RFC 8707) and what a provider puts in
        // `aud` for an API.
        const tokenAudience = (config.audience || '').trim();
        const issuerUrl    = (config.issuerUrl || '').replace(/\/$/, '');
        // A fixed base plus whatever the provider needs to release the claim the gate reads.
        // `openid` is not negotiable — without it the flow is not OIDC at all — and `profile`
        // earns its place because providers commonly attach custom claims to it.
        const BASE_SCOPES  = ['openid', 'profile', 'email'];
        const extraScopes  = (config.extraScopes || '').trim().split(/\s+/).filter(Boolean);
        const scopesArr    = BASE_SCOPES.concat(extraScopes).filter((v, i, a) => a.indexOf(v) === i);
        const advertisedArr = advertisedScopes(scopesArr, requiredScopes);

        // Groups granted to the local debug token (comma-separated), so gates with other values
        // can be tested without an identity provider. None unless written in: the token replaces
        // OAuth on this server's route, public or not, so it carries nothing it was not given.
        const localDebugToken  = (node.credentials && node.credentials.localDebugToken) || '';
        const localDebugGroups = (config.localDebugGroups || '')
            .split(',').map(s => s.trim()).filter(Boolean);

        const auth = createMcpAuth({
            issuerUrl,
            tokenTTL        : Number(config.tokenCacheTTL || 300) * 1000,
            tokenAudience,
            mcpServerUrl    : resourceUrl,
            resourceUrl,
            gateClaim: requiredClaim,
            // Asked per token, not fixed here: each registered tool's own list reads the same
            // claim, and tools register after this runs. Checking only the server list let a
            // token without the claim hide those tools without a word.
            gateClaimRequired: () => gateReadsClaim({
                serverValue: requiredValue, tools: node.mcpRegisteredTools
            }),
            advertisedScopes: advertisedArr.join(' '),
            localDebugToken,
            localDebugGroups,
            httpGet,
            log  : msg => node.log(msg),
            warn : msg => node.warn(msg)
        });
        const { requireBearer, getOidcConfig } = auth;
        if (issuerUrl) { getOidcConfig().catch(() => {}); }   // warm the cache (non-blocking)

        // 2.x served get_flow/deploy_flow from a checkbox here. 3.0.0 moved Node-RED
        // administration to its own node (ftb-mcp-admin), so a converted 2.x server that had them
        // on now simply lacks them — said once, rather than left for the caller to discover.
        if (config.adminToolsEnabled === true) {
            node.warn('Admin tools are no longer part of the MCP server node. Add an "MCP Admin" '
                + '(ftb-mcp-admin) node pointing at a server of its own to administer Node-RED over MCP.');
        }

        // Named at every start, so a token left behind after debugging is visible in the log
        // rather than only in a password field nobody opens.
        if (localDebugToken) {
            node.warn('Local debug token is set — OAuth is bypassed on this MCP server\'s route, '
                + 'public or not, with ' + requiredClaim + '=' + JSON.stringify(localDebugGroups)
                + '. Clear the field when OAuth is available.');
        }

        // ── Dynamic tool registry (populated by mcp-in / drained by mcp-out) ───────
        // Null-prototype objects: tool names arrive from remote callers in tools/call, and a
        // plain {} would resolve names like "__proto__" or "constructor" through the prototype
        // chain — past the "Unknown tool" check and into a listener-less 30s hang.
        node.mcpRegisteredTools = Object.create(null);
        node.mcpPendingCalls    = Object.create(null);

        // opts.validate: false lets a tool take arguments its schema does not describe; every
        // tool's arguments are checked against its schema otherwise (lib/schema.js).
        node.registerMCPTool = function (name, description, schema, timeoutSec, requiredValue, ownerId, opts) {
            const validate = !(opts && opts.validate === false);
            // Said once, at registration: a keyword the validator does not check would otherwise
            // look like a constraint that holds.
            const unchecked = validate ? unsupportedKeywords(schema) : [];
            if (unchecked.length) {
                node.warn('MCP tool "' + name + '": the input schema uses ' + unchecked.join(', ')
                    + ', which argument validation does not check. Everything else in it is checked.');
            }
            const broken = validate ? invalidPatterns(schema) : [];
            if (broken.length) {
                node.warn('MCP tool "' + name + '": the input schema\'s pattern ' + broken.join(', ')
                    + ' is not a valid regular expression, so every call naming that argument is refused. Fix the pattern.');
            }
            // Duplicate tool names are a silent conflict: the registry entry is overwritten but
            // BOTH mcp-in listeners keep firing, so a single call runs two flows and the first
            // mcp-out to answer wins. Surface it loudly instead of debugging it in production.
            const existing = node.mcpRegisteredTools[name];
            if (existing && existing.ownerId !== ownerId) {
                node.warn('MCP tool "' + name + '" is registered by more than one mcp-in node on this server — '
                    + 'each call will run every one of those flows, with unpredictable results. '
                    + 'Rename the tools so each name is unique.');
            }
            node.mcpRegisteredTools[name] = {
                description,
                schema,
                timeoutMs     : (timeoutSec || 30) * 1000,   // NaN/0 → default, not an instant timeout
                requiredValue : requiredValue || '',
                validate,
                ownerId
            };
        };

        node.unregisterMCPTool = function (name, ownerId) {
            // Only the registering node may remove its entry — when two mcp-in nodes collide on
            // a name, deleting the loser must not tear down the survivor's registration.
            const entry = node.mcpRegisteredTools[name];
            if (!entry) return;
            if (ownerId !== undefined && entry.ownerId !== undefined && entry.ownerId !== ownerId) return;
            delete node.mcpRegisteredTools[name];
        };

        // One call in flight, resolved by the matching mcp-out or abandoned on timeout. A node
        // method rather than a closure inside rpcDeps, because mcp-call dispatches through the
        // same path and two copies of this would drift.
        node.dispatchMCPCall = function (name, timeoutMs, args, claims) {
            return new Promise((resolve, reject) => {
                const callId = crypto.randomBytes(16).toString('hex');
                const timer  = setTimeout(() => {
                    delete node.mcpPendingCalls[callId];
                    reject(new Error('timeout'));
                }, timeoutMs);
                node.mcpPendingCalls[callId] = { resolve, reject, timer };
                node.emit('mcp_tool_' + name, { args, _mcpCallId: callId, _mcpClaims: claims });
            });
        };

        // The flow-side surface mcp-call uses. No gate is consulted: the claim and scope gates run
        // on the HTTP route, where the token behind them was verified, and a flow node is already
        // inside the trust boundary since editing flows is full control.
        node.callTool = async function (toolName, args, claims) {
            const entry = node.mcpRegisteredTools[toolName];
            if (!entry) { return unknownTool(toolName); }
            try {
                const content = await node.dispatchMCPCall(
                    toolName, entry.timeoutMs || 30000, args || {}, claims || null);
                // As on the MCP route: mcp-out answers with a content array or with text, which
                // for an object payload is its JSON — mcp-call parses that back.
                return Array.isArray(content) ? respond({ content: content }) : toolOk(content);
            } catch (e) {
                node.status({ fill: 'red', shape: 'dot', text: 'timeout' });
                return toolOk(JSON.stringify({
                    error: e.message === 'timeout' ? 'Tool timed out: ' + toolName : e.message
                }));
            }
        };

        // What this server offers, in the shape tools/list uses. The gate allows everything
        // because the flow path does — listing less than mcp-call can call would be a lie.
        node.listTools = () => visibleTools(node.mcpRegisteredTools, { allows: () => true });

        node.resolveMCPCall = function (callId, content) {
            const pending = node.mcpPendingCalls[callId];
            if (!pending) return;
            clearTimeout(pending.timer);
            delete node.mcpPendingCalls[callId];
            pending.resolve(content);
        };

        const { rateLimit, maxBody, jsonBody } = createHttpGuards({ warn: msg => node.warn(msg) });

        // ── OAuth: protected-resource metadata (RFC 9728) ──────────────────────────
        const protectedResourceHandler = (_req, res) => {
            res.status(200).json(buildProtectedResourceMetadata({
                resourceUrl, scopes: advertisedArr,
                authServerUrl: issuerUrl || resourceUrl
            }));
        };
        for (const p of resourceMetadataPaths) {
            node.log('mcp-server registering route: GET ' + p);
            RED.httpNode.get(p, ownedHostFilter, rateLimit('wk', 120), protectedResourceHandler);
        }

        // ── MCP JSON-RPC endpoint ───────────────────────────────────────────────
        // The dispatch logic lives in lib/mcp-rpc.js (unit-testable); this handler is glue:
        // authenticate, delegate, write the described response. callTool is the one real
        // side effect — the pending-call promise resolved by mcp-out via resolveMCPCall.
        const rpcDeps = {
            serverName,
            serverVersion : pkgVersion,
            instructions,
            requiredClaim,
            requiredValue,
            requiredScope,
            tools  : node.mcpRegisteredTools,
            status : s => node.status(s),
            callTool: (toolName, timeoutMs, args, claims) =>
                node.dispatchMCPCall(toolName, timeoutMs, args, claims)
        };

        node.log('mcp-server registering route: POST ' + mcpRoutePath);
        RED.httpNode.post(mcpRoutePath, ownedHostFilter, rateLimit('mcp', 300), maxBody(1024 * 1024),
            jsonBody(1024 * 1024), async (req, res) => {
            const claims = await requireBearer(req, res);
            if (!claims) return;
            const out = await handleRpc(req.body, claims, rpcDeps);
            if (out.headers) res.set(out.headers);
            res.status(out.status);
            return out.body !== undefined ? res.json(out.body) : res.send('');
        });

        node.status({ fill: 'green', shape: 'dot', text: mcpRoutePath });

        node.on('close', function () {
            for (const [, pending] of Object.entries(node.mcpPendingCalls)) {
                clearTimeout(pending.timer);
                pending.reject(new Error('MCP server closing'));
            }
            node.mcpPendingCalls = Object.create(null);
            auth.clearCache();
            for (const p of resourceMetadataPaths) { removeRoute(RED, 'get', p, node.id); }
            removeRoute(RED, 'post', mcpRoutePath, node.id);
            registry.release(node.id);
        });
    }

    RED.nodes.registerType('ftb-mcp-server', McpServer, {
        credentials: {
            localDebugToken : { type: 'password' }
        }
    });
};
