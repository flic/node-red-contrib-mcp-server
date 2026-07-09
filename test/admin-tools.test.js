'use strict';

const assert = require('node:assert');
const { createAdminTools } = require('../lib/admin-tools');

function build(handlers) {
    const calls = [];
    const httpRequest = async (method, hostname, port, path, headers, body) => {
        calls.push({ method, hostname, port, path, headers, body });
        const key = method + ' ' + path.replace(/^(\/flow)\/.+$/, '$1/:id');
        const handler = handlers[key] || handlers[method + ' ' + path];
        if (!handler) throw new Error('unmocked request: ' + method + ' ' + path);
        return handler({ method, path, body });
    };
    const tools = createAdminTools({ adminPort: 1880, getAdminToken: () => 'tok', httpRequest });
    return { tools, calls };
}

describe('lib/admin-tools TOOLS', function () {
    it('exposes get_flow and deploy_flow with object schemas', function () {
        const { tools } = build({});
        const names = tools.TOOLS.map(t => t.name);
        assert.deepStrictEqual(names.sort(), ['deploy_flow', 'get_flow']);
        for (const t of tools.TOOLS) assert.strictEqual(t.inputSchema.type, 'object');
        assert.ok(tools.TOOL_NAMES.has('get_flow'));
        assert.ok(tools.TOOL_NAMES.has('deploy_flow'));
    });
});

describe('lib/admin-tools get_flow', function () {
    it('lists all tabs with node counts when called without an id', async function () {
        const { tools } = build({
            'GET /flows': () => ({
                status: 200,
                body: [
                    { id: 'tab1', type: 'tab', label: 'Flow One' },
                    { id: 'tab2', type: 'tab', label: 'Flow Two', disabled: true },
                    { id: 'n1', type: 'function', z: 'tab1' },
                    { id: 'n2', type: 'function', z: 'tab1' },
                    { id: 'n3', type: 'function', z: 'tab2' }
                ]
            })
        });
        const result = await tools.callTool('get_flow', {});
        assert.match(result, /Node-RED flow tabs/);
        assert.match(result, /Flow One/);
        assert.match(result, /Nodes: 2/);
        assert.match(result, /Flow Two\*\* \[disabled\]/);
    });

    it('returns full JSON for a specific flow id', async function () {
        const { tools } = build({
            'GET /flow/:id': ({ path }) => {
                assert.strictEqual(path, '/flow/abc123');
                return { status: 200, body: { id: 'abc123', label: 'My Flow', nodes: [] } };
            }
        });
        const result = await tools.callTool('get_flow', { id: 'abc123' });
        assert.deepStrictEqual(JSON.parse(result), { id: 'abc123', label: 'My Flow', nodes: [] });
    });

    it('returns a not-found message for a missing flow id', async function () {
        const { tools } = build({ 'GET /flow/:id': () => ({ status: 404, body: {} }) });
        const result = await tools.callTool('get_flow', { id: 'missing' });
        assert.match(result, /not found/);
    });

    it('rejects a flow id outside the allowed charset', async function () {
        const { tools } = build({});
        await assert.rejects(
            () => tools.callTool('get_flow', { id: '../etc/passwd' }),
            (err) => { assert.strictEqual(err.rpcCode, -32602); return true; }
        );
    });
});

describe('lib/admin-tools deploy_flow', function () {
    it('creates a new flow (POST) when no id is given', async function () {
        const { tools, calls } = build({
            'POST /flow': () => ({ status: 200, body: { id: 'newid' } })
        });
        const result = await tools.callTool('deploy_flow', { label: 'New Flow', nodes: [{ id: 'n1', type: 'function' }] });
        assert.match(result, /deployed/);
        assert.strictEqual(calls[0].method, 'POST');
        assert.strictEqual(calls[0].path, '/flow');
        assert.strictEqual(calls[0].body.nodes[0].z, calls[0].body.id); // node z stamped with tab id
    });

    it('updates an existing flow (PUT) when an id is given', async function () {
        const { tools, calls } = build({
            'PUT /flow/:id': ({ path }) => { assert.strictEqual(path, '/flow/existing'); return { status: 204, body: {} }; }
        });
        const result = await tools.callTool('deploy_flow', { id: 'existing', label: 'Updated', nodes: [] });
        assert.match(result, /deployed/);
        assert.strictEqual(calls[0].method, 'PUT');
    });

    it('surfaces a failure response', async function () {
        const { tools } = build({
            'POST /flow': () => ({ status: 400, body: { message: 'bad request' } })
        });
        const result = await tools.callTool('deploy_flow', { label: 'X', nodes: [] });
        assert.match(result, /Deploy failed \(400\)/);
    });

    it('sends the admin token as a bearer header', async function () {
        const inspected = [];
        const httpRequest = async (method, hostname, port, path, headers) => {
            inspected.push(headers);
            return { status: 200, body: {} };
        };
        const tools = createAdminTools({ adminPort: 1880, getAdminToken: () => 'sekret', httpRequest });
        await tools.callTool('deploy_flow', { label: 'X', nodes: [] });
        assert.strictEqual(inspected[0].Authorization, 'Bearer sekret');
    });
});
