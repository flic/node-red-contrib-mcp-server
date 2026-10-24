// The 2.x → 3.x type rename, as one table and one pure function. Loaded both by the editor
// plugin (plugins/migrate.html, as a <script> from this module's resources) and by the tests, so
// it is written to run unchanged in a browser and under Node — no require, no exports object
// assumed.
//
// 3.0.0 prefixed every type with `ftb-` because the bare `mcp-*` names collide with other
// packages in the flow library (scorecard N01). Node-RED has no type aliases, so the old names
// stay registered by nodes/legacy.js until 4.0.0; this is what moves a flow off them.
(function (root) {
    'use strict';

    var LEGACY_TYPES = {
        'mcp-server': 'ftb-mcp-server',
        'mcp-in'    : 'ftb-mcp-in',
        'mcp-out'   : 'ftb-mcp-out',
        'mcp-call'  : 'ftb-mcp-call'
    };

    // Returns a new flows array with every legacy type renamed, plus the ids that changed. Only
    // `type` changes: ids stay, so wires, config-node references and stored credentials (keyed by
    // id) all carry over. Fields that 3.0.0 dropped are left in place — Node-RED ignores them, and
    // a conversion that also deleted settings would be harder to trust.
    function migrateFlows(flows) {
        var changed = [];
        var out = (flows || []).map(function (n) {
            if (!n || !Object.prototype.hasOwnProperty.call(LEGACY_TYPES, n.type)) { return n; }
            changed.push(n.id);
            var copy = {};
            for (var k in n) { if (Object.prototype.hasOwnProperty.call(n, k)) { copy[k] = n[k]; } }
            copy.type = LEGACY_TYPES[n.type];
            return copy;
        });
        return { flows: out, changed: changed };
    }

    // 2.x servers that had admin tools switched on. 3.0.0 has no such option — administration is
    // the MCP Admin node — so their get_flow/deploy_flow go with the conversion. Named to the user
    // at the moment they convert, where it can be acted on; the flag itself does not survive the
    // editor's next deploy, which keeps only the fields a node type declares.
    function adminServers(flows) {
        return (flows || []).filter(function (n) {
            return n && n.type === 'mcp-server' && n.adminToolsEnabled === true;
        }).map(function (n) { return n.name || ('/mcp/' + (n.path || '')); });
    }

    var api = { LEGACY_TYPES: LEGACY_TYPES, migrateFlows: migrateFlows, adminServers: adminServers };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    else { root.ftbMcpMigrate = api; }
})(typeof window !== 'undefined' ? window : this);
