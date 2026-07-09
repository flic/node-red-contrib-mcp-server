const crypto = require('crypto');
const http   = require('http');
const https  = require('https');

const { createMcpAuth }              = require('../lib/mcp-auth');
const { createHttpGuards, hostFilter } = require('../lib/http-guards');
const { createAdminTools }           = require('../lib/admin-tools');
const {
    isAdmin,
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

function removeRoute(RED, method, path) {
    if (!RED.httpNode || !RED.httpNode._router) return;
    RED.httpNode._router.stack = RED.httpNode._router.stack.filter(layer => {
        if (!layer.route) return true;
        return !(layer.route.path === path && layer.route.methods[method]);
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

        // Optional whole-server claim/value gate — same shape as the admin-tools gate below,
        // but applies to every tool on this server (dynamic and admin alike). Empty
        // requiredValue → any authenticated user may use this server's tools (the default).
        // Set a value to restrict the whole server to callers whose validated token carries
        // that claim; others connect but see no tools and cannot call any.
        const requiredClaim = (config.requiredClaim || 'groups').trim();
        // Default '' (allow all) only when never set. Empty string stays "any authenticated user".
        const requiredValue = (config.requiredValue === undefined ? '' : config.requiredValue).trim();

        function hasAccess(claims) {
            if (!requiredValue) return true;
            if (!claims) return false;
            const v = claims[requiredClaim];
            if (Array.isArray(v)) return v.includes(requiredValue);
            return v === requiredValue;
        }

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

        const auth = createMcpAuth({
            issuerUrl,
            tokenTTL        : Number(config.tokenCacheTTL || 300) * 1000,
            tokenAudience,
            mcpServerUrl    : resourceUrl,
            localDebugToken : (node.credentials && node.credentials.localDebugToken) || '',
            httpGet,
            log  : msg => node.log(msg),
            warn : msg => node.warn(msg)
        });
        const { requireBearer, getOidcConfig } = auth;
        if (issuerUrl) { getOidcConfig().catch(() => {}); }   // warm the cache (non-blocking)

        // ── Admin tools (get_flow / deploy_flow via the Node-RED Admin API) ────────
        const adminToolsEnabled  = config.adminToolsEnabled === true;
        const adminRequiredClaim = (config.adminRequiredClaim || 'groups').trim();
        // Default 'admin' only when never set (undefined). Empty string is respected
        // as "allow any authenticated user".
        const adminRequiredValue = (config.adminRequiredValue === undefined ? 'admin' : config.adminRequiredValue).trim();
        const adminTools = createAdminTools({
            adminPort     : Number(config.adminPort || 1880),
            getAdminToken : () => (node.credentials && node.credentials.adminToken) || ''
        });

        // ── Dynamic tool registry (populated by mcp-in / drained by mcp-out) ───────
        node.mcpRegisteredTools = {};
        node.mcpPendingCalls    = {};

        node.registerMCPTool = function (name, description, schema, timeoutSec) {
            node.mcpRegisteredTools[name] = { description, schema, timeoutMs: timeoutSec * 1000 };
        };

        node.unregisterMCPTool = function (name) {
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
            RED.httpNode.get(p, hostFilter(expectedHost), rateLimit('wk', 120), protectedResourceHandler);
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
            RED.httpNode.get(p, hostFilter(expectedHost), rateLimit('wk', 120), authServerHandler);
        }

        // ── DCR shim ────────────────────────────────────────────────────────────
        node.log('mcp-server registering route: POST ' + registerPath);
        RED.httpNode.post(registerPath, hostFilter(expectedHost), rateLimit('register', 20), (req, res) => {
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
        node.log('mcp-server registering route: POST ' + mcpRoutePath);
        RED.httpNode.post(mcpRoutePath, hostFilter(expectedHost), rateLimit('mcp', 300), maxBody(1024 * 1024), async (req, res) => {
            const claims = await requireBearer(req, res);
            if (!claims) return;

            const allowed = hasAccess(claims);

            const body   = req.body || {};
            const id     = body.id     !== undefined ? body.id : null;
            const method = body.method || null;
            const params = body.params || {};

            const respond = result => res.status(200).json({ jsonrpc: '2.0', id, result });
            const rpcErr  = (c, m)  => res.status(200).json({ jsonrpc: '2.0', id, error: { code: c, message: m } });
            const toolOk  = text    => respond({ content: [{ type: 'text', text }] });
            // Denials surfaced as a tool result (isError) rather than a JSON-RPC protocol error —
            // clients show a result's text to the model, but collapse a protocol error into a
            // generic "tool execution failed" with no reason.
            const denied  = text    => respond({ content: [{ type: 'text', text }], isError: true });

            const adminAllowed = allowed && adminToolsEnabled && isAdmin(claims, adminRequiredClaim, adminRequiredValue);

            if (method === 'initialize') {
                node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                res.set('Cache-Control', 'no-store');
                // Don't leak tool names to callers who lack the required claim.
                const toolNames = allowed ? [
                    ...Object.keys(node.mcpRegisteredTools),
                    ...(adminAllowed ? [...adminTools.TOOL_NAMES] : [])
                ] : [];
                return respond({
                    protocolVersion : '2024-11-05',
                    capabilities    : { tools: {} },
                    serverInfo      : { name: serverName, version: '1.0.0' },
                    instructions    : (instructions ? instructions + ' ' : '') +
                                      (toolNames.length ? 'Available tools: ' + toolNames.join(', ') + '.' : '')
                });
            }

            if (method === 'notifications/initialized') {
                return res.status(204).send('');
            }

            if (method === 'tools/list') {
                if (!allowed) return respond({ tools: [] });
                const tools = [];
                for (const [name, t] of Object.entries(node.mcpRegisteredTools)) {
                    const s = t.schema;
                    const inputSchema = (s && s.type === 'object') ? s : { type: 'object', properties: s || {} };
                    tools.push({ name, description: t.description, inputSchema });
                }
                if (adminAllowed) tools.push(...adminTools.TOOLS);
                return respond({ tools });
            }

            if (method === 'tools/call') {
                if (!allowed) {
                    return denied('Access denied: your account lacks the required permission to use this server.');
                }
                const toolName = params.name;
                const args     = params.arguments || {};
                node.status({ fill: 'blue', shape: 'dot', text: toolName });

                if (node.mcpRegisteredTools[toolName]) {
                    try {
                        const callId    = crypto.randomBytes(16).toString('hex');
                        const timeoutMs = node.mcpRegisteredTools[toolName].timeoutMs || 30000;
                        const result    = await new Promise((resolve, reject) => {
                            const timer = setTimeout(() => {
                                delete node.mcpPendingCalls[callId];
                                reject(new Error('timeout'));
                            }, timeoutMs);
                            node.mcpPendingCalls[callId] = { resolve, reject, timer };
                            node.emit('mcp_tool_' + toolName, { args, _mcpCallId: callId, _mcpClaims: claims });
                        });
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return Array.isArray(result)
                            ? respond({ content: result })
                            : toolOk(result);
                    } catch (e) {
                        node.status({ fill: 'red', shape: 'dot', text: 'timeout' });
                        return toolOk(JSON.stringify({ error: e.message === 'timeout' ? 'Tool timed out: ' + toolName : e.message }));
                    }
                }

                if (adminTools.TOOL_NAMES.has(toolName)) {
                    if (!adminToolsEnabled) return rpcErr(-32601, 'Unknown tool: ' + toolName);
                    // Admin tools require a verified admin claim on every call — the
                    // adminToolsEnabled flag alone is never sufficient to reach them.
                    if (!claims || !isAdmin(claims, adminRequiredClaim, adminRequiredValue)) {
                        node.status({ fill: 'red', shape: 'ring', text: 'forbidden' });
                        return denied('Access denied: the "' + toolName + '" tool requires admin privileges, '
                            + 'which your token does not have. This is a permission restriction, not a tool error.');
                    }
                    try {
                        const result = await adminTools.callTool(toolName, args);
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(result);
                    } catch (e) {
                        if (e.rpcCode) return rpcErr(e.rpcCode, e.message);
                        node.status({ fill: 'red', shape: 'ring', text: 'admin error' });
                        return toolOk('Admin call error: ' + e.message);
                    }
                }

                return rpcErr(-32601, 'Unknown tool: ' + toolName);
            }

            return rpcErr(-32601, 'Unknown method: ' + (method || 'null'));
        });

        node.status({ fill: 'green', shape: 'dot', text: mcpRoutePath });

        node.on('close', function () {
            for (const [, pending] of Object.entries(node.mcpPendingCalls)) {
                clearTimeout(pending.timer);
                pending.reject(new Error('MCP server closing'));
            }
            node.mcpPendingCalls = {};
            auth.clearCache();
            for (const p of resourceMetadataPaths) { removeRoute(RED, 'get', p); }
            for (const p of authServerPaths)       { removeRoute(RED, 'get', p); }
            removeRoute(RED, 'post', registerPath);
            removeRoute(RED, 'post', mcpRoutePath);
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
