'use strict';
// Server configuration as the MCP Server node reads it: the route an empty path gives, the
// instructions nodes contribute, and the debug user's claims following the access claim.

const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { handleRpc } = require('../lib/mcp-rpc');
const { createMcpAuth } = require('../lib/mcp-auth');
const { localEndpoint } = require('../lib/admin/api');
const { instructionsFor } = require('../lib/admin/tools');

const SERVER = path.join(__dirname, '..', 'nodes', 'mcp-server.js');

function loadServer(config) {
    let ctor = null;
    const routes = [], warnings = [], handlers = {};
    const RED = {
        nodes: {
            createNode(node, cfg) { node.id = cfg.id; },
            registerType: (name, fn) => { if (name === 'ftb-mcp-server') ctor = fn; }
        },
        httpNode: {
            get : (p) => routes.push('GET ' + p),
            post: (p, ...chain) => { routes.push('POST ' + p); handlers[p] = chain[chain.length - 1]; },
            _router: { stack: [] }
        },
        settings: { httpAdminRoot: '/' }
    };
    delete require.cache[require.resolve(SERVER)];
    require(SERVER)(RED);
    const node = new EventEmitter();
    node.status = () => {}; node.log = () => {}; node.error = () => {};
    node.warn = m => warnings.push(m);
    node.credentials = { localDebugToken: 'dbg' };
    ctor.call(node, Object.assign({ id: 's1', serverUrl: 'https://mcp.example.com' }, config));
    // Calls the server's own MCP route the way Express would, past the middlewares.
    const call = (route, body) => new Promise(resolve => {
        const res = { set() { return res; }, status() { return res; }, json: b => resolve(b), send: () => resolve(undefined) };
        handlers[route]({ headers: { authorization: 'Bearer dbg' }, body }, res);
    });
    return { node, routes, warnings, call };
}

describe('MCP Server path', function () {
    it('serves /mcp/<path>, with both well-known forms', function () {
        const { routes, warnings } = loadServer({ path: 'tools' });
        assert.deepStrictEqual(routes.sort(), [
            'GET /.well-known/oauth-protected-resource/mcp/tools',
            'GET /mcp/tools/.well-known/oauth-protected-resource',
            'POST /mcp/tools']);
        assert.ok(!warnings.some(w => w.includes('hostname filtering')), warnings.join('\n'));
    });

    it('serves /mcp itself when the path is empty, and warns without hostname filtering', function () {
        const { routes, warnings } = loadServer({ path: '' });
        assert.deepStrictEqual(routes.sort(), [
            'GET /.well-known/oauth-protected-resource/mcp',
            'GET /mcp/.well-known/oauth-protected-resource',
            'POST /mcp']);
        assert.ok(warnings.some(w => w.includes('without hostname filtering')), warnings.join('\n'));
    });

    it('does not warn about a bare /mcp that is filtered by hostname', function () {
        const { warnings } = loadServer({ path: '/', filterHost: true });
        assert.ok(!warnings.some(w => w.includes('hostname filtering')), warnings.join('\n'));
    });
});

describe('MCP Servers sharing a path', function () {
    // Two server nodes on one router: an unfiltered one, and a filtered one that is restarted —
    // which puts its routes last, behind the unfiltered one.
    function twoServers() {
        const stack = [];
        const RED = {
            nodes: { createNode(node, cfg) { node.id = cfg.id; }, registerType: (n, fn) => { RED.ctor = fn; } },
            httpNode: { get: (p, ...chain) => stack.push({ m: 'GET', p, chain }),
                        post: (p, ...chain) => stack.push({ m: 'POST', p, chain }), _router: { stack: [] } },
            settings: { httpAdminRoot: '/' }
        };
        delete require.cache[require.resolve(SERVER)];
        require(SERVER)(RED);
        const start = cfg => {
            const node = new EventEmitter();
            node.status = () => {}; node.log = () => {}; node.warn = () => {}; node.error = () => {};
            node.credentials = {};
            RED.ctor.call(node, cfg);
            return node;
        };
        // The first route on POST /mcp whose host filter lets the request through.
        const answers = host => {
            for (const r of stack) {
                if (r.m !== 'POST' || r.p !== '/mcp' || r.dead) continue;
                let arg = 'NOT_CALLED';
                r.chain[0]({ headers: { host }, method: 'POST', route: { path: '/mcp' } }, {}, a => { arg = a; });
                if (arg === undefined) return r.chain[0]._mcpOwner;
            }
            return null;
        };
        return { stack, start, answers };
    }

    it('answers each hostname from the right server, also after the filtered one restarts', function () {
        const { stack, start, answers } = twoServers();
        start({ id: 'admin', path: '', serverUrl: 'https://admin.example.com', filterHost: true });
        const general = start({ id: 'general', path: '', serverUrl: 'https://mcp.example.com', filterHost: false });
        assert.strictEqual(answers('admin.example.com'), 'admin');
        assert.strictEqual(answers('mcp.example.com'), 'general');
        // Restart the filtered server: its old routes go, new ones are added after the unfiltered.
        stack.filter(r => r.chain[0]._mcpOwner === 'admin').forEach(r => { r.dead = true; });
        start({ id: 'admin', path: '', serverUrl: 'https://admin.example.com', filterHost: true });
        assert.strictEqual(answers('admin.example.com'), 'admin');
        assert.strictEqual(answers('mcp.example.com'), 'general');
        assert.ok(general);
    });
});

describe('MCP Server instructions', function () {
    const deps = instructions => ({
        serverName: 's', serverVersion: '1', instructions, requiredClaim: 'sub', requiredValue: '',
        tools: {}, callTool: async () => ''
    });

    it('takes a function, read at initialize, so contributions after start count', async function () {
        let text = 'first';
        const d = deps(() => text);
        assert.strictEqual((await handleRpc({ id: 1, method: 'initialize' }, {}, d)).body.result.instructions, 'first ');
        text = 'second';
        assert.strictEqual((await handleRpc({ id: 1, method: 'initialize' }, {}, d)).body.result.instructions, 'second ');
    });

    it('joins its own text with what nodes contribute, each owner replacing or withdrawing its own', async function () {
        const { node, call } = loadServer({ path: 'x', instructions: 'Server text.' });
        node.setInstructions('admin1', 'Admin text.');
        node.setInstructions('admin1', 'Admin text, revised.');
        node.setInstructions('other', 'Other text.');
        node.setInstructions('other', '');
        const out = await call('/mcp/x', { jsonrpc: '2.0', id: 1, method: 'initialize' });
        assert.strictEqual(out.result.instructions, 'Server text.\n\nAdmin text, revised. ');
    });

    it('sends only what nodes contribute when the server has no text of its own', async function () {
        const { node, call } = loadServer({ path: 'x' });
        node.setInstructions('admin1', instructionsFor({ read: true }));
        const out = await call('/mcp/x', { jsonrpc: '2.0', id: 1, method: 'initialize' });
        assert.ok(out.result.instructions.startsWith('These tools administer a Node-RED instance.'));
    });

    it('opens with the instance and its description when given', function () {
        const text = instructionsFor({ read: true }, { name: 'Hemma', description: 'Home automation: Zigbee, music.' });
        assert.ok(text.startsWith('These tools administer the Node-RED instance "Hemma" — Home automation: Zigbee, music. '), text);
        assert.ok(text.includes('names the instance'));
        assert.ok(instructionsFor({ read: true }, { name: '', description: 'x' }).startsWith('These tools administer a Node-RED instance.'));
    });

    it('describes only the admin groups that are on', function () {
        const readOnly = instructionsFor({ read: true });
        assert.ok(readOnly.includes('list_flows'));
        assert.ok(!readOnly.includes('patch_nodes') && !readOnly.includes('get_debug'));
        const all = instructionsFor({ read: true, flows: true, test: true });
        assert.ok(all.includes('patch_nodes') && all.includes('rollback') && all.includes('get_debug'));
    });
});

describe('debug token claims follow the access claim', function () {
    const build = (gateClaim, groups) => createMcpAuth({
        localDebugToken: 'dbg', localDebugGroups: groups, gateClaim, httpGet: async () => ({ status: 404 })
    });

    it('gives sub the first value', async function () {
        const c = await build('sub', ['user-1', 'user-2']).validateToken('dbg');
        assert.strictEqual(c.sub, 'user-1');
        assert.strictEqual((await build('sub', []).validateToken('dbg')).sub, 'debug');
    });

    it('gives a list claim every value, nested for a dotted name, and keeps groups', async function () {
        const roles = await build('realm_access.roles', ['ops']).validateToken('dbg');
        assert.deepStrictEqual(roles.realm_access, { roles: ['ops'] });
        assert.deepStrictEqual(roles.groups, ['ops']);
        assert.deepStrictEqual((await build('groups', ['a']).validateToken('dbg')).groups, ['a']);
    });
});

describe('lib/admin/api localEndpoint', function () {
    it('uses uiPort on loopback over http by default', function () {
        assert.deepStrictEqual(localEndpoint({ uiPort: 1881 }),
            { protocol: 'http', host: '127.0.0.1', port: 1881, urlHost: '127.0.0.1' });
        assert.strictEqual(localEndpoint({}).port, 1880);
    });

    it('treats wildcard binds as loopback, and uses a specific bind address', function () {
        assert.strictEqual(localEndpoint({ uiHost: '::' }).host, '127.0.0.1');
        assert.strictEqual(localEndpoint({ uiHost: '0.0.0.0' }).host, '127.0.0.1');
        assert.strictEqual(localEndpoint({ uiHost: '192.168.1.5' }).host, '192.168.1.5');
        assert.strictEqual(localEndpoint({ uiHost: '::1' }).urlHost, '[::1]');
    });

    it('follows Node-RED onto https', function () {
        assert.strictEqual(localEndpoint({ https: { key: 'k', cert: 'c' } }).protocol, 'https');
    });
});
