const crypto = require('crypto');
const http   = require('http');
const https  = require('https');

const pkgVersion = require('../package.json').version;

const { createMcpAuth }              = require('../lib/mcp-auth');
const { createHttpGuards, hostFilter } = require('../lib/http-guards');
const { createAdminTools }           = require('../lib/admin-tools');
const { handleRpc }                  = require('../lib/mcp-rpc');
const {
    buildProtectedResourceMetadata,
    buildAuthorizationServerMetadata,
    filterRedirectUris,
    buildDcrRegistration
} = require('../lib/oauth-discovery');

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
        // multiple independent MCP servers (one per integration) can coexist.
        const mcpRoutePath = '/mcp/' + (config.path || 'server').replace(/^\/+/, '');
        const publicBase   = (config.serverUrl || '').replace(/\/$/, '');
        const resourceUrl  = publicBase + mcpRoutePath;
        const serverName   = config.serverName || ('mcp-' + (config.path || 'server'));
        const instructions = config.instructions || '';

        const wellKnownPaths = name => [
            mcpRoutePath + '/.well-known/' + name,
            '/.well-known/' + name + mcpRoutePath
        ];
        const resourceMetadataPaths = wellKnownPaths('oauth-protected-resource');
        const authServerPaths       = wellKnownPaths('oauth-authorization-server');
        const registerPath          = mcpRoutePath + '/oauth/register';
        const registrationEndpoint  = publicBase + registerPath;

        // Optional Host-header filtering. Lets several mcp-server nodes share the same path
        // on one Node-RED instance, split by hostname. Off by default so single-server setups
        // — and anyone behind a proxy that rewrites Host — keep matching on path alone. Fails
        // open (filtering disabled, with a warning) if enabled without a parseable URL, so a
        // typo can't 404 everyone.
        let expectedHost = '';
        if (config.filterHost) {
            try {
                expectedHost = new URL(publicBase).host;
            } catch (e) {
                node.warn('Hostname filtering enabled but Server URL "' + publicBase +
                          '" is not a valid URL — filtering disabled, matching on path only');
            }
        }
        // One shared hostFilter instance, tagged with this node's id so removeRoute (above)
        // can tell this node's routes apart from a sibling's on the same path.
        const ownedHostFilter = hostFilter(expectedHost);
        ownedHostFilter._mcpOwner = node.id;

        // The one claim name every gate on this server matches against — the server-wide list
        // below, each mcp-in node's own list, and the admin-tools list. Everything else is values.
        const requiredClaim = (config.requiredClaim || 'groups').trim();
        // Whole-server gate: a comma-separated any-of list that applies to every tool here.
        // Default '' (allow all) only when never set. Empty string stays "any authenticated user";
        // set a list and others still connect, but see no tools and cannot call any.
        const requiredValue = (config.requiredValue === undefined ? '' : config.requiredValue).trim();

        // ── Auth (OIDC discovery, JWKS, token validation, Bearer middleware) ───────
        const clientId     = ((node.credentials && node.credentials.clientId)     || '').trim();
        const clientSecret = ((node.credentials && node.credentials.clientSecret) || '').trim();
        const issuerUrl    = (config.issuerUrl || '').replace(/\/$/, '');
        const scopesStr    = (config.scopes || 'openid profile email').trim();
        const scopesArr    = scopesStr.split(/\s+/).filter(Boolean);
        const redirectUris = (config.redirectUris || 'https://claude.ai/api/mcp/auth_callback')
                                .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
        // Audience enforcement: explicit config.audience wins, otherwise tokens must carry
        // the client id in `aud`. Only when both are empty is the audience check skipped.
        const tokenAudience = (config.audience || '').trim() || clientId;

        // Groups granted to the local debug token (comma-separated, default 'admin'), so gates
        // with other values can be tested locally. Default only when never set — an explicitly
        // emptied field means a debug user with no groups at all.
        const localDebugGroups = (config.localDebugGroups === undefined ? 'admin' : config.localDebugGroups)
            .split(',').map(s => s.trim()).filter(Boolean);

        const auth = createMcpAuth({
            issuerUrl,
            tokenTTL        : Number(config.tokenCacheTTL || 300) * 1000,
            tokenAudience,
            mcpServerUrl    : resourceUrl,
            localDebugToken : (node.credentials && node.credentials.localDebugToken) || '',
            localDebugGroups,
            httpGet,
            log  : msg => node.log(msg),
            warn : msg => node.warn(msg)
        });
        const { requireBearer, getOidcConfig } = auth;
        if (issuerUrl) { getOidcConfig().catch(() => {}); }   // warm the cache (non-blocking)

        // ── Admin tools (get_flow / deploy_flow via the Node-RED Admin API) ────────
        const adminToolsEnabled  = config.adminToolsEnabled === true;
        // Matched against requiredClaim above, and applied on top of the whole-server list —
        // admin tools are gated exactly like any other tool, just with their own value list.
        // Default 'admin' only when never set (undefined). Empty string is respected
        // as "no restriction beyond the whole-server gate".
        const adminRequiredValue = (config.adminRequiredValue === undefined ? 'admin' : config.adminRequiredValue).trim();
        const adminTools = createAdminTools({
            adminPort     : Number(config.adminPort || 1880),
            getAdminToken : () => (node.credentials && node.credentials.adminToken) || ''
        });

        // ── Dynamic tool registry (populated by mcp-in / drained by mcp-out) ───────
        // Null-prototype objects: tool names arrive from remote callers in tools/call, and a
        // plain {} would resolve names like "__proto__" or "constructor" through the prototype
        // chain — past the "Unknown tool" check and into a listener-less 30s hang.
        node.mcpRegisteredTools = Object.create(null);
        node.mcpPendingCalls    = Object.create(null);

        node.registerMCPTool = function (name, description, schema, timeoutSec, requiredValue, ownerId) {
            // A dynamic tool with an admin tool's name shadows it — tools/call resolves the
            // dynamic registry first — and tools/list carries the name twice. The flow does
            // run, so this is a warning rather than a refusal: renaming is the fix, but an
            // existing flow that (knowingly or not) shadows must not break on upgrade.
            if (adminTools.TOOL_NAMES.has(name)) {
                node.warn('MCP tool "' + name + '" has the same name as a built-in admin tool'
                    + (adminToolsEnabled
                        ? ' — this flow shadows it, the admin tool becomes unreachable, and the name '
                          + 'appears twice in tools/list for admin callers. Rename the tool.'
                        : '. It works while admin tools are disabled, but will shadow the admin tool '
                          + 'the day they are enabled. Rename the tool.'));
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

        node.resolveMCPCall = function (callId, content) {
            const pending = node.mcpPendingCalls[callId];
            if (!pending) return;
            clearTimeout(pending.timer);
            delete node.mcpPendingCalls[callId];
            pending.resolve(content);
        };

        const { rateLimit, maxBody } = createHttpGuards({ warn: msg => node.warn(msg) });

        // ── OAuth: protected-resource metadata (RFC 9728) ──────────────────────────
        const protectedResourceHandler = (_req, res) => {
            res.status(200).json(buildProtectedResourceMetadata({
                resourceUrl, authServerUrl: resourceUrl, scopes: scopesArr
            }));
        };
        for (const p of resourceMetadataPaths) {
            node.log('mcp-server registering route: GET ' + p);
            RED.httpNode.get(p, ownedHostFilter, rateLimit('wk', 120), protectedResourceHandler);
        }

        // ── OAuth: authorization-server metadata (RFC 8414) ────────────────────────
        const authServerHandler = async (_req, res) => {
            const oidc = await getOidcConfig();
            res.status(200).json(buildAuthorizationServerMetadata({
                issuerBase: resourceUrl, oidc, registrationEndpoint,
                scopes: scopesArr, hasClientSecret: !!clientSecret
            }));
        };
        for (const p of authServerPaths) {
            node.log('mcp-server registering route: GET ' + p);
            RED.httpNode.get(p, ownedHostFilter, rateLimit('wk', 120), authServerHandler);
        }

        // ── DCR shim ────────────────────────────────────────────────────────────
        if (clientSecret) {
            node.warn('A client secret is configured, so ' + registerPath + ' hands it out to every '
                + 'caller (legacy confidential-client mode) — the secret is effectively public. '
                + 'Switch the IdP client to public (PKCE) and clear the secret field.');
        }
        node.log('mcp-server registering route: POST ' + registerPath);
        RED.httpNode.post(registerPath, ownedHostFilter, rateLimit('register', 20), (req, res) => {
            const requested = (req.body && req.body.redirect_uris) || [];
            const filtered  = filterRedirectUris(requested, redirectUris);
            if (!filtered.ok) {
                return res.status(400).json({
                    error: 'invalid_redirect_uri',
                    error_description: 'requested redirect_uris are not allowed'
                });
            }
            res.status(201).json(buildDcrRegistration({
                clientId, clientSecret, redirectUris: filtered.uris, scopeStr: scopesStr
            }));
        });

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
            adminToolsEnabled,
            adminRequiredValue,
            adminTools,
            tools  : node.mcpRegisteredTools,
            status : s => node.status(s),
            callTool: (toolName, timeoutMs, args, claims) => new Promise((resolve, reject) => {
                const callId = crypto.randomBytes(16).toString('hex');
                const timer  = setTimeout(() => {
                    delete node.mcpPendingCalls[callId];
                    reject(new Error('timeout'));
                }, timeoutMs);
                node.mcpPendingCalls[callId] = { resolve, reject, timer };
                node.emit('mcp_tool_' + toolName, { args, _mcpCallId: callId, _mcpClaims: claims });
            })
        };

        node.log('mcp-server registering route: POST ' + mcpRoutePath);
        RED.httpNode.post(mcpRoutePath, ownedHostFilter, rateLimit('mcp', 300), maxBody(1024 * 1024), async (req, res) => {
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
            for (const p of authServerPaths)       { removeRoute(RED, 'get', p, node.id); }
            removeRoute(RED, 'post', registerPath, node.id);
            removeRoute(RED, 'post', mcpRoutePath, node.id);
        });
    }

    RED.nodes.registerType('mcp-server', McpServer, {
        credentials: {
            clientId        : { type: 'text' },
            clientSecret    : { type: 'password' },
            adminToken      : { type: 'password' },
            localDebugToken : { type: 'password' }
        }
    });
};
