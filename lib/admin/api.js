'use strict';
// The one client of Node-RED's own Admin HTTP API that the admin node uses. Everything goes to
// this process over loopback with the node's admin token, whose permissions decide what works:
// a token without flows.write gets a 403 here and the tool says which permission it lacked.
// httpRequest is injectable so the tools are testable without a running Node-RED.

const http = require('http');
const https = require('https');

// Node-RED's own id charset. Ids go into URL paths, so anything else is refused before a request
// is built rather than escaped into one.
const ID_RE = /^[A-Za-z0-9._-]+$/;

class AdminApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function defaultHttpRequest({ method, protocol, host, port, path, headers, body }) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const hdrs = Object.assign({}, headers);
        if (data !== null) {
            hdrs['Content-Type'] = 'application/json';
            hdrs['Content-Length'] = Buffer.byteLength(data);
        }
        // Over https the certificate names the public host, never the loopback address this
        // connects to, so it cannot be verified here; the connection never leaves the machine.
        const lib = protocol === 'https' ? https : http;
        const opts = { method, host, port, path, headers: hdrs };
        if (protocol === 'https') opts.rejectUnauthorized = false;
        const req = lib.request(opts, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', c => raw += c);
            res.on('end', () => {
                let parsed = raw;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { /* plain text answer */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.setTimeout(15000, () => req.destroy(new Error('admin API request timed out')));
        req.on('error', reject);
        if (data !== null) req.write(data);
        req.end();
    });
}

// The permission each endpoint needs, named in the error when the token lacks it — a 403 alone
// tells the caller nothing about what to grant.
function permissionFor(method, path) {
    if (path.startsWith('/flows') || path.startsWith('/flow/')) return method === 'GET' ? 'flows.read' : 'flows.write';
    if (path.startsWith('/context')) return method === 'GET' ? 'context.read' : 'context.write';
    if (path.startsWith('/nodes')) return 'nodes.read';
    if (path.startsWith('/settings')) return 'settings.read';
    if (path.startsWith('/diagnostics')) return 'diagnostics.read';
    if (path.startsWith('/inject')) return 'inject.write';
    if (path.startsWith('/projects')) return 'projects.read';
    return 'the matching permission';
}

function createAdminApi({ port, root = '/', getToken, host = '127.0.0.1', protocol = 'http', httpRequest = defaultHttpRequest }) {
    // httpAdminRoot false means the admin API is switched off in settings.js.
    const prefix = root === false ? null : String(root || '/').replace(/\/+$/, '');

    async function request(method, path, { body, headers } = {}) {
        if (prefix === null) {
            throw new AdminApiError(0, 'The Node-RED admin API is disabled (httpAdminRoot is false).');
        }
        const token = (getToken && getToken()) || '';
        const hdrs = Object.assign({ 'Node-RED-API-Version': 'v2' },
            token ? { Authorization: 'Bearer ' + token } : {}, headers);
        let r;
        try {
            r = await httpRequest({ method, protocol, host, port, path: prefix + path, headers: hdrs, body });
        } catch (e) {
            throw new AdminApiError(0, 'Could not reach the admin API on ' + host + ':' + port + ': ' + e.message);
        }
        if (r.status >= 200 && r.status < 300) return r.body;
        // Node-RED answers 401 both for a token it does not know and for one lacking the
        // permission (needsPermission), so the message names the permission either way.
        if (r.status === 401 || r.status === 403) {
            throw new AdminApiError(r.status, 'The admin token was refused for this: it is either unknown or '
                + 'lacks the "' + permissionFor(method, path) + '" permission. Check the token on the MCP Admin '
                + 'node and its user\'s permissions in settings.js.');
        }
        if (r.status === 409) throw new AdminApiError(409, 'The flows changed since they were read.');
        const detail = r.body && typeof r.body === 'object' ? (r.body.message || r.body.error || JSON.stringify(r.body)) : r.body;
        throw new AdminApiError(r.status, 'Admin API ' + method + ' ' + path + ' answered ' + r.status
            + (detail ? ': ' + String(detail).slice(0, 300) : ''));
    }

    function checkId(id, what) {
        if (typeof id !== 'string' || !ID_RE.test(id)) {
            throw new AdminApiError(400, 'Invalid ' + (what || 'id') + ': ' + JSON.stringify(id));
        }
        return id;
    }

    // Context keys are paths the runtime resolves (a.b[0]); each segment is URL-encoded rather than
    // restricted, since keys may legitimately hold anything a flow chose.
    const contextPath = (scope, id, key) => '/context/' + scope
        + (scope === 'global' ? '' : '/' + checkId(id, scope + ' id'))
        + (key ? '/' + encodeURIComponent(key) : '');

    return {
        request,
        checkId,
        // GET /flows (v2): { rev, flows }. Credentials are never part of it.
        getFlows: async () => {
            const b = await request('GET', '/flows');
            return Array.isArray(b) ? { rev: undefined, flows: b } : { rev: b.rev, flows: b.flows || [] };
        },
        // POST /flows (v2) with the revision the change was based on, so a deploy that happened
        // in between is a 409 rather than silently overwritten.
        postFlows: async (rev, flows, deploymentType) => {
            const b = await request('POST', '/flows', {
                body   : rev === undefined ? { flows } : { rev, flows },
                headers: { 'Node-RED-Deployment-Type': deploymentType || 'nodes' }
            });
            return { rev: b && b.rev };
        },
        getNodes      : () => request('GET', '/nodes', { headers: { Accept: 'application/json' } }),
        getSettings   : () => request('GET', '/settings'),
        getDiagnostics: () => request('GET', '/diagnostics'),
        getFlowsState : () => request('GET', '/flows/state'),
        getContext    : async (scope, id, key, store) => request('GET', contextPath(scope, id, key)
            + (key && store ? '?store=' + encodeURIComponent(store) : '')),
        deleteContext : async (scope, id, key, store) => request('DELETE', contextPath(scope, id, key)
            + (store ? '?store=' + encodeURIComponent(store) : '')),
        inject        : async (id, body) => request('POST', '/inject/' + checkId(id, 'inject node id'), { body: body || {} })
    };
}

// Where this process's own Admin API answers, from the runtime settings: the port Node-RED
// listens on (uiPort, whatever set it), over https when Node-RED serves https, on loopback unless
// uiHost binds one specific address — then that address, the only one that answers.
function localEndpoint(settings) {
    const s = settings || {};
    const bound = typeof s.uiHost === 'string' ? s.uiHost.trim() : '';
    const host = !bound || bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound;
    return {
        protocol: s.https ? 'https' : 'http',
        host,
        port    : Number(s.uiPort) || 1880,
        // For URLs: an IPv6 literal goes in brackets.
        urlHost : host.includes(':') ? '[' + host + ']' : host
    };
}

module.exports = { createAdminApi, AdminApiError, ID_RE, localEndpoint };
