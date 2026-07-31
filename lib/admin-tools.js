'use strict';
// Generic Node-RED admin tools exposed over MCP: get_flow (read one or list all flow tabs)
// and deploy_flow (create/update a flow tab), implemented against Node-RED's own Admin
// HTTP API. Pure Node-RED-admin-API usage, no domain-specific logic. httpRequest is
// injectable so this is unit-testable without a running Node-RED admin API.

const http = require('http');

function defaultHttpRequest(method, hostname, port, path, headers, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const hdrs = Object.assign({ 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2' }, headers);
        if (data) hdrs['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ method, hostname, port, path, headers: hdrs }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const TOOLS = [
    {
        name        : 'get_flow',
        description : 'Lists all Node-RED tabs (ID and node count) when called without arguments. ' +
                      'Returns full JSON configuration for a specific tab when called with an id.',
        inputSchema : {
            type       : 'object',
            properties : {
                id : { type: 'string', description: 'Flow/tab ID — omit to list all flows' }
            }
        }
    },
    {
        name        : 'deploy_flow',
        description : 'Creates or updates a Node-RED flow tab. Omit id to create new.',
        inputSchema : {
            type       : 'object',
            required   : ['label', 'nodes'],
            properties : {
                id    : { type: 'string', description: 'Existing flow ID (omit for new flow)' },
                label : { type: 'string', description: 'Flow tab label/name' },
                nodes : { type: 'array',  description: 'Array of node objects' }
            }
        }
    }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

function createAdminTools({ adminPort, getAdminToken, httpRequest = defaultHttpRequest }) {

    function adminApi(method, path, body) {
        const token = (getAdminToken && getAdminToken()) || '';
        const hdrs  = token ? { Authorization: 'Bearer ' + token } : {};
        return httpRequest(method, 'localhost', adminPort, path, hdrs, body);
    }

    async function callTool(toolName, args) {
        // Flow IDs go straight into the admin HTTP path; constrain to the Node-RED id
        // charset so a crafted id can't traverse or inject into it.
        if (args.id !== undefined && !/^[A-Za-z0-9._-]+$/.test(String(args.id))) {
            const err = new Error('Invalid flow id');
            err.rpcCode = -32602;
            throw err;
        }

        if (toolName === 'get_flow') {
            if (!args.id) {
                const r        = await adminApi('GET', '/flows');
                const allNodes = Array.isArray(r.body) ? r.body
                    : (Array.isArray(r.body && r.body.flows) ? r.body.flows : []);
                const tabs  = allNodes.filter(n => n.type === 'tab');
                // Labels are interpolated into markdown shown to the calling model as-is.
                // They come from the flow author (via the editor or deploy_flow), who is
                // already trusted with far more than formatting — so no escaping here.
                const lines = ['**Node-RED flow tabs:**', ''];
                tabs.forEach(tab => {
                    const count = allNodes.filter(n => n.z === tab.id).length;
                    lines.push('- **' + tab.label + '**' + (tab.disabled ? ' [disabled]' : ''));
                    lines.push('  ID: `' + tab.id + '`  |  Nodes: ' + count);
                });
                return lines.join('\n');
            }
            const r = await adminApi('GET', '/flow/' + args.id);
            if (r.status === 404) return 'Flow \'' + args.id + '\' not found.';
            return JSON.stringify(r.body, null, 2);
        }

        if (toolName === 'deploy_flow') {
            const tabId    = args.id || require('crypto').randomBytes(8).toString('hex');
            const nodes    = (args.nodes || []).map(n => Object.assign({}, n, { z: n.z || tabId }));
            const flowBody = { id: tabId, label: args.label, nodes };
            const r = args.id
                ? await adminApi('PUT',  '/flow/' + args.id, flowBody)
                : await adminApi('POST', '/flow',             flowBody);
            if (r.status === 200 || r.status === 204) {
                return 'Flow \'' + args.label + '\' deployed. ID: ' + (r.body.id || tabId);
            }
            return 'Deploy failed (' + r.status + '): ' + JSON.stringify(r.body);
        }

        return undefined;
    }

    return { TOOLS, TOOL_NAMES, callTool };
}

module.exports = { createAdminTools, TOOLS, TOOL_NAMES };
