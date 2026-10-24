'use strict';
// The MCP Admin node wired to a stub server: what it registers, what it tells clients, and what
// its two outputs carry. The tools themselves are covered in admin-tools.test.js.

const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { summarizeArgs, outcome } = require('../lib/admin/tools');

const ADMIN = path.join(__dirname, '..', 'nodes', 'mcp-admin.js');

function load(config) {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-node-'));
    const server = new EventEmitter();
    server.id = 'srv';
    server.resourceUrl = 'https://mcp-nodered.example.com/mcp';
    server.tools = {}; server.answers = {}; server.instructions = {};
    server.registerMCPTool = (name, description, schema, timeout, requiredValue) => { server.tools[name] = { requiredValue }; };
    server.unregisterMCPTool = name => { delete server.tools[name]; };
    server.resolveMCPCall = (id, content) => { server.answers[id] = JSON.parse(content); };
    server.setInstructions = (owner, text) => { server.instructions[owner] = text; };
    let ctor = null;
    const RED = {
        nodes: { createNode(node, cfg) { node.id = cfg.id; }, getNode: () => server,
            registerType: (name, fn) => { ctor = fn; } },
        settings: { httpAdminRoot: '/editor', uiPort: 1880, userDir }
    };
    delete require.cache[require.resolve(ADMIN)];
    require(ADMIN)(RED);
    const node = new EventEmitter();
    node.sent = [];
    node.send = m => node.sent.push(m);
    node.status = () => {}; node.warn = () => {}; node.error = () => {};
    node.credentials = { adminToken: 't' };
    ctor.call(node, Object.assign({ id: 'adm', mcpServer: 'srv', groupRead: true }, config));
    return { node, server, cleanup: () => fs.rmSync(userDir, { recursive: true, force: true }) };
}

const call = (server, tool, args, claims) => new Promise(resolve => {
    server.emit('mcp_tool_' + tool, { args, _mcpCallId: 'c1', _mcpClaims: claims });
    const wait = () => server.answers.c1 ? resolve(server.answers.c1) : setImmediate(wait);
    wait();
});

describe('MCP Admin node', function () {
    it('registers the read group by default, gates writes with Write access, and names the instance', function () {
        const { server, cleanup } = load({ groupFlows: true, writeRequiredValue: 'ops', instanceName: 'Hemma' });
        assert.ok(server.tools.list_flows && server.tools.patch_nodes);
        assert.ok(!server.tools.inject && !server.tools.delete_context);
        assert.strictEqual(server.tools.list_flows.requiredValue, '');
        assert.strictEqual(server.tools.patch_nodes.requiredValue, 'ops');
        assert.ok(server.instructions.adm.startsWith('These tools administer the Node-RED instance "Hemma"'));
        cleanup();
    });

    it('falls back to the host in the server URL for the instance name', function () {
        const { server, cleanup } = load({});
        assert.ok(server.instructions.adm.includes('"mcp-nodered.example.com"'), server.instructions.adm);
        cleanup();
    });

    it('logs every call on the second output and nothing on the first for a read', async function () {
        const { node, server, cleanup } = load({ instanceName: 'Hemma' });
        // No admin API is listening: the read fails, which is still a call to log.
        const answer = await call(server, 'list_flows', {}, { sub: 'u1', azp: 'claude' });
        assert.ok(answer.error);
        assert.strictEqual(node.sent.length, 1);
        const [changes, log] = node.sent[0];
        assert.strictEqual(changes, null);
        assert.strictEqual(log.topic, 'mcp-admin/list_flows');
        assert.strictEqual(log.payload.instance, 'Hemma');
        assert.strictEqual(log.payload.sub, 'u1');
        assert.strictEqual(log.payload.client, 'claude');
        assert.strictEqual(log.payload.ok, false);
        assert.ok(log.payload.error && typeof log.payload.durationMs === 'number');
        cleanup();
    });

    it('withdraws its tools and instructions on close', function (done) {
        const { node, server, cleanup } = load({});
        node.emit('close', () => {
            assert.deepStrictEqual(server.tools, {});
            assert.strictEqual(server.instructions.adm, '');
            cleanup(); done();
        });
    });
});

describe('call log helpers', function () {
    it('summarizes long strings, long arrays and deep objects', function () {
        const s = summarizeArgs({ patches: [{ id: 'f1', set: { func: 'x'.repeat(500) } }], ids: Array.from({ length: 12 }, (_, i) => 'n' + i) });
        assert.ok(s.patches[0].set.func.includes('500 chars'));
        assert.strictEqual(s.ids.length, 11);
        assert.strictEqual(s.ids[10], '… 2 more');
        assert.strictEqual(summarizeArgs({ a: { b: { c: { d: { e: { f: 1 } } } } } }).a.b.c.d.e, '{…}');
    });

    it('reads success, errors, refusals and conflicts out of an answer', function () {
        assert.deepStrictEqual(outcome({ tabs: [] }), { ok: true });
        assert.deepStrictEqual(outcome({ error: 'boom' }), { ok: false, error: 'boom' });
        assert.deepStrictEqual(outcome({ ok: false, errors: ['bad wire'] }), { ok: false, error: 'bad wire' });
        assert.deepStrictEqual(outcome({ ok: false, conflict: true, error: 'The flows changed' }), { ok: false, error: 'The flows changed' });
    });
});
