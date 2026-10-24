// Node-RED administration over MCP. A flow node rather than a server option: whether this
// Node-RED can be administered over MCP is visible in the flow, and disabling or deleting the
// node takes the tools away. Its tools register on the chosen mcp-server like any mcp-in, so
// they sit behind that server's gates — give it a server of its own, which makes "which clients
// may administer Node-RED" one resource at the identity provider.
//
// Everything that decides anything lives in lib/admin/; this file wires it to the server, the
// node's credentials and its output.

const path = require('path');

const { createAdminApi, localEndpoint } = require('../lib/admin/api');
const { createSnapshotStore } = require('../lib/admin/snapshots');
const { createDebugBuffer }   = require('../lib/admin/comms');
const { createMasker }        = require('../lib/admin/mask');
const { GROUPS, runTool, instructionsFor, summarizeArgs, outcome, caller } = require('../lib/admin/tools');

// What a tool may hand back in one answer. Past this the caller is told to narrow the request
// rather than given a truncated JSON document it cannot parse.
const ANSWER_MAX = 100000;

function answer(result) {
    const text = JSON.stringify(result);
    if (text.length <= ANSWER_MAX) return text;
    return JSON.stringify({ error: 'The answer is ' + text.length + ' characters, over the '
        + ANSWER_MAX + ' limit. Narrow the request (offset/limit, a single id, a filter).' });
}

module.exports = function (RED) {
    function McpAdmin(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const server = RED.nodes.getNode(config.mcpServer);
        if (!server || typeof server.registerMCPTool !== 'function') {
            node.error('No MCP server configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no MCP server' });
            return;
        }

        // Read is on unless switched off; everything that changes something is opt-in.
        const groups = {
            read   : config.groupRead !== false,
            flows  : config.groupFlows === true,
            test   : config.groupTest === true,
            context: config.groupContext === true
        };
        // Which Node-RED this is, for a client holding the same tools for several. Named on the
        // node, or else the host in the MCP Server node's Server URL.
        let fallbackName = '';
        try { fallbackName = new URL(server.resourceUrl).host; } catch { /* no usable Server URL */ }
        const instance = {
            name       : (config.instanceName || '').trim() || fallbackName,
            description: (config.instanceDescription || '').trim()
        };

        // On unless switched off: secrets kept as plain properties or context values are answered
        // masked. `maskExtra` adds type.property entries no name pattern catches (ical-config.url).
        const masker = createMasker({ enabled: config.maskSecrets !== false, extra: config.maskExtra || '' });

        // Matched against the server's access claim, on top of the server's own list, for every
        // tool that changes something. Empty adds nothing beyond the server gate.
        const writeValue = (config.writeRequiredValue || '').trim();

        // This process's own Admin API, wherever settings.js put it — not configured on the node,
        // since it can be nowhere else.
        const local = localEndpoint(RED.settings);
        const root = RED.settings.httpAdminRoot;
        const getToken = () => (node.credentials && node.credentials.adminToken) || '';
        const api = createAdminApi({ port: local.port, host: local.host, protocol: local.protocol, root, getToken });
        const snapshots = createSnapshotStore({
            dir : path.join(RED.settings.userDir || '.', '.mcp-admin', node.id),
            keep: Math.max(1, Number(config.snapshots) || 50)
        });

        let debug = null;
        if (groups.test && root !== false) {
            const prefix = String(root || '/').replace(/\/+$/, '');
            debug = createDebugBuffer({ url: (local.protocol === 'https' ? 'wss' : 'ws') + '://' + local.urlHost
                + ':' + local.port + prefix + '/comms', getToken,
                log: m => node.warn(m) });
            debug.start();
        }

        // Two outputs, for whatever the flow wants to do with them. The first carries one message
        // per change (a notification, say); the second one per call, reads included (a log). The
        // node itself notifies no one.
        const emit = ev => node.send([{ topic: 'mcp-admin/' + ev.tool,
            payload: Object.assign({ time: new Date().toISOString() }, ev) }, null]);
        const logCall = (tool, args, claims, result, started) => node.send([null, {
            topic: 'mcp-admin/' + tool,
            payload: Object.assign({ time: new Date(started).toISOString(), tool, instance: instance.name },
                caller(claims), { args: summarizeArgs(args || {}) }, outcome(result),
                { durationMs: Date.now() - started })
        }]);

        const registered = [];
        function register(tool) {
            server.registerMCPTool(tool.name, tool.description, tool.inputSchema, 60,
                tool.write ? writeValue : '', node.id);
            const listener = async ({ args, _mcpCallId, _mcpClaims }) => {
                node.status({ fill: 'blue', shape: 'dot', text: tool.name });
                const started = Date.now();
                const result = await runTool(tool, args,
                    { api, snapshots, debug, masker, claims: _mcpClaims || null, emit, serverId: server.id, instance });
                server.resolveMCPCall(_mcpCallId, answer(result));
                logCall(tool.name, args, _mcpClaims, result, started);
                node.status({ fill: result && result.error ? 'red' : 'green', shape: 'dot',
                    text: tool.name + (result && result.error ? ': error' : '') });
            };
            server.on('mcp_tool_' + tool.name, listener);
            registered.push({ name: tool.name, listener });
        }

        for (const group of ['read', 'flows', 'test', 'context']) {
            if (groups[group]) GROUPS[group].forEach(register);
        }
        node.status({ fill: 'green', shape: 'dot', text: registered.length + ' tools' });

        // How these tools fit together, told on connect. A server holding only these needs no
        // instructions of its own.
        if (typeof server.setInstructions === 'function') server.setInstructions(node.id, instructionsFor(groups, instance));

        node.on('close', function (done) {
            for (const r of registered) {
                server.unregisterMCPTool(r.name, node.id);
                server.removeListener('mcp_tool_' + r.name, r.listener);
            }
            if (debug) debug.stop();
            if (typeof server.setInstructions === 'function') server.setInstructions(node.id, '');
            done();
        });
    }

    RED.nodes.registerType('ftb-mcp-admin', McpAdmin, {
        credentials: { adminToken: { type: 'password' } }
    });
};
