// Runtime half of the 2.x → 3.x conversion: nothing but the registration. The work happens in the
// editor (plugins/migrate.html), whose own requests already carry the signed-in user's session,
// so the conversion runs with exactly that user's permissions and needs no port, scheme or token
// of its own. Removed in 4.0.0, with nodes/legacy.js.
module.exports = function (RED) {
    RED.plugins.registerPlugin('ftb-mcp-migrate', { type: 'ftb-mcp-migrate' });
};
