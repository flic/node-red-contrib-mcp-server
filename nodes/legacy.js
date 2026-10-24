// Keeps flows written for 2.x running under 3.x. 3.0.0 renamed every type to an `ftb-` prefix
// (the bare `mcp-*` names collide with other packages in the flow library), and Node-RED has no
// type aliases: a flow naming a type nobody registers does not start at all — no flow does.
//
// So this set registers the old names on the very same constructors, by loading each node file
// with a RED whose registerType swaps in the legacy name and adds a warning. It deliberately has
// no .html: the runtime accepts a set without one, and the editor then shows these nodes as
// unknown but keeps them on deploy — reason enough to convert, which the editor plugin
// (plugins/migrate.html) offers in one click. If another installed package already owns one of
// these names, only this set fails to load; the ftb- set is unaffected.
//
// Removed in 4.0.0.

const { LEGACY_TYPES } = require('../resources/migrate');

module.exports = function (RED) {
    // Each legacy name is also its node file's name: nodes/mcp-server.js registers ftb-mcp-server.
    for (const legacyType of Object.keys(LEGACY_TYPES)) {
        const file = './' + legacyType;
        const nodes = Object.create(RED.nodes);
        nodes.registerType = (type, ctor, opts) => {
            function Legacy(config) {
                ctor.call(this, config);
                this.warn('Uses the 2.x type name "' + legacyType + '". Convert this flow to "'
                    + LEGACY_TYPES[legacyType] + '" — the editor offers it — before 4.0.0 drops the old names.');
            }
            RED.nodes.registerType(legacyType, Legacy, opts);
        };
        require(file)(Object.assign(Object.create(RED), { nodes }));
    }
};
