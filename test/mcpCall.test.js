'use strict';
// mcp-call reaches one server's tools from a flow. These drive nodes/mcp-server.js and
// nodes/mcp-call.js against a stub RED, because what is being tested is the wiring — which
// registry a call lands in, and what the gates do or do not apply there — and that is invisible
// to a unit test of either file's exports.
//
// Mirrors node-red-contrib-hal2's test/apiEndpoint.test.js, which covers the same surface there.

const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const SERVER = path.join(__dirname, '..', 'nodes', 'mcp-server.js');
const CALL   = path.join(__dirname, '..', 'nodes', 'mcp-call.js');

// A node with a real emitter: the dispatch hands the call to the flow with emit() and waits for
// resolveMCPCall, so a stubbed emitter would test nothing.
function makeNode(config) {
    const node = new EventEmitter();
    node.id = config.id;
    node.status = s => { node._status = s; };
    node.log = () => {}; node.warn = () => {}; node.error = () => {}; node.debug = () => {};
    return node;
}

function loadServer(config) {
    let registered = null;
    const RED = {
        nodes: {
            createNode(node, cfg) { node.id = cfg.id; },
            registerType: (name, fn) => { if (name === 'mcp-server') registered = fn; }
        },
        httpNode: { get: () => {}, post: () => {}, _router: { stack: [] } }
    };
    delete require.cache[require.resolve(SERVER)];
    require(SERVER)(RED);
    const node = makeNode(config);
    node.credentials = {};
    registered.call(node, Object.assign({ id: 's1', path: 'demo', serverUrl: 'https://x.example.com' }, config));
    return node;
}

// Answers a dispatched call the way an mcp-out node would.
function answerWith(node, tool, content) {
    node.on('mcp_tool_' + tool, ev =>
        setImmediate(() => node.resolveMCPCall(ev._mcpCallId, content)));
}

describe('mcp-server callTool', function () {
    it('dispatches a registered tool to the flow and returns the MCP envelope', async function () {
        const node = loadServer({});
        node.registerMCPTool('search', 'Search', {}, 30, '', 'in1');
        answerWith(node, 'search', [{ type: 'text', text: 'hit' }]);

        const out = await node.callTool('search', { q: 'x' }, null, {});
        // Asserted field by field: mcp-call reads exactly these.
        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(out.content, [{ type: 'text', text: 'hit' }]);
    });

    it('answers an unknown name with -32601 rather than hanging', async function () {
        const out = await loadServer({}).callTool('nope', {}, null, {});
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.code, -32601);
        assert.ok(out.message.includes('nope'), out.message);
    });

    it('resolves a timeout instead of rejecting', async function () {
        // A tool result carrying an error, not a thrown promise, so the caller reports a tool
        // answer rather than a node crash.
        const node = loadServer({});
        node.registerMCPTool('slow', 'Never answers', {}, 0.01, '', 'in1');
        const out = await node.callTool('slow', {}, null, {});
        assert.strictEqual(out.ok, true);
        assert.ok(JSON.parse(out.text).error.includes('timed out'), out.text);
    });

    it('calls a tool restricted over MCP, because the flow path is ungated', async function () {
        // Deliberate, and pinned so that changing it has to break a test that says why: the claim
        // and scope gates run on the HTTP route where the token was verified, and a flow node is
        // already inside the trust boundary. Tool access restricts MCP clients, not flows.
        const node = loadServer({});
        node.registerMCPTool('gated', 'Restricted over MCP', {}, 30, 'ops', 'in1');
        answerWith(node, 'gated', [{ type: 'text', text: 'ran' }]);
        const out = await node.callTool('gated', {}, null, {});
        assert.strictEqual(out.ok, true);
    });

    it('lists the registry, gated tools included, admin tools excluded', async function () {
        const node = loadServer({ adminToolsEnabled: true });
        node.registerMCPTool('open',  'Open',       { q: { type: 'string' } }, 30, '',    'in1');
        node.registerMCPTool('gated', 'Restricted', {},                        30, 'ops', 'in2');
        const names = node.listTools().map(t => t.name).sort();
        assert.deepStrictEqual(names, ['gated', 'open']);
        assert.deepStrictEqual(node.listTools().find(t => t.name === 'open').inputSchema,
                               { type: 'object', properties: { q: { type: 'string' } } });
    });
});

describe('mcp-server callTool — admin tools', function () {
    // Three cases, because "the flag alone was enough" is the failure that matters.
    it('is unreachable when the server has them disabled', async function () {
        const node = loadServer({ adminToolsEnabled: false });
        const out = await node.callTool('get_flow', {}, { groups: ['admin'] }, { adminEnabled: true });
        assert.strictEqual(out.code, -32601);
    });

    it('is unreachable when the calling node has not opted in', async function () {
        const node = loadServer({ adminToolsEnabled: true });
        const out = await node.callTool('get_flow', {}, { groups: ['admin'] }, { adminEnabled: false });
        assert.strictEqual(out.code, -32601);
    });

    it('is refused without an admin claim, even with both opt-ins', async function () {
        const node = loadServer({ adminToolsEnabled: true });
        const out = await node.callTool('get_flow', {}, { groups: ['staff'] }, { adminEnabled: true });
        assert.strictEqual(out.ok, false);
        assert.ok(out.message.includes('admin'), out.message);
    });
});

describe('mcp-call', function () {
    function loadCall(config, server) {
        let registered = null;
        const RED = {
            nodes: {
                createNode(node, cfg) { node.id = cfg.id; },
                getNode: () => server,
                registerType: (name, fn) => { registered = fn; }
            },
            util: {
                setMessageProperty: (msg, prop, val) => { msg[prop] = val; },
                parseContextStore: k => ({ key: k })
            }
        };
        delete require.cache[require.resolve(CALL)];
        require(CALL)(RED);
        const node = makeNode(config);
        let input = null;
        node.on = (ev, fn) => { if (ev === 'input') input = fn; };
        node.context = () => ({});
        registered.call(node, config);
        return payload => new Promise(resolve => {
            const msg = { payload };
            input(msg, () => {}, () => resolve(msg.payload));
        });
    }

    const server = {
        callTool: async name => (name === 'search'
            ? { ok: true, content: [{ type: 'text', text: 'hit' }] }
            : { ok: false, code: -32601, message: 'Unknown tool: ' + name }),
        listTools: () => [{ name: 'search', description: 's', inputSchema: {} }]
    };

    it('calls a tool on the configured server', async function () {
        const call = loadCall({ id: 'c1', server: 's1' }, server);
        const out = await call({ tool: 'search' });
        assert.deepStrictEqual(out, { ok: true, result: [{ type: 'text', text: 'hit' }] });
    });

    it('reports an unknown tool as an error envelope', async function () {
        const call = loadCall({ id: 'c2', server: 's1' }, server);
        const out = await call({ tool: 'nope' });
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.error.code, -32601);
    });

    it('answers { list: true } with the server catalogue', async function () {
        const call = loadCall({ id: 'c3', server: 's1' }, server);
        assert.deepStrictEqual((await call({ list: true })).result.map(t => t.name), ['search']);
    });

    it('fails clearly when the server is missing rather than throwing', async function () {
        const call = loadCall({ id: 'c4', server: 'gone' }, undefined);
        const out = await call({ tool: 'search' });
        assert.strictEqual(out.ok, false);
        assert.ok(out.error.message.includes('No MCP server configured'), out.error.message);
    });
});
