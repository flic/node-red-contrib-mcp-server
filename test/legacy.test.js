'use strict';
// nodes/legacy.js keeps 2.x flows running by registering the old type names on the same
// constructors. Driven against a stub RED: what matters is which names get registered and that a
// legacy node is the real node plus a warning, not a copy that could drift.

const assert = require('node:assert');
const path = require('node:path');

const LEGACY = path.join(__dirname, '..', 'nodes', 'legacy.js');

function load() {
    const registered = {};
    const RED = {
        nodes: {
            createNode(node, cfg) { node.id = cfg.id; },
            // An unresolved config reference, as at runtime: nodes report it rather than throw.
            getNode: () => null,
            registerType: (name, fn, opts) => { registered[name] = { fn, opts }; }
        },
        httpNode: { get: () => {}, post: () => {}, _router: { stack: [] } },
        settings: { httpAdminRoot: '/' }
    };
    delete require.cache[require.resolve(LEGACY)];
    require(LEGACY)(RED);
    return registered;
}

describe('nodes/legacy', function () {
    it('registers exactly the four 2.x names, and none of the ftb- names', function () {
        assert.deepStrictEqual(Object.keys(load()).sort(),
            ['mcp-call', 'mcp-in', 'mcp-out', 'mcp-server']);
    });

    it('keeps the registration options, so the legacy server still stores its credentials', function () {
        const { opts } = load()['mcp-server'];
        assert.ok(opts && opts.credentials && opts.credentials.localDebugToken);
    });

    it('builds the real node and warns that it uses a 2.x name', function () {
        const { fn } = load()['mcp-out'];
        const warnings = [];
        const node = {
            on() {}, status() {}, error() {}, log() {},
            warn: m => warnings.push(m)
        };
        fn.call(node, { id: 'o1', mcpServer: 's1' });
        assert.strictEqual(node.id, 'o1');
        assert.ok(warnings.some(w => w.includes('"mcp-out"') && w.includes('"ftb-mcp-out"')), warnings.join('\n'));
    });
});
