// The back door into this Node-RED's own MCP tools. Despite the name, nothing here speaks MCP:
// no protocol, no connection, no reaching a server elsewhere. It calls the mcp-in nodes deployed
// in this process directly, through the mcp-server config node's flow-side surface, starting
// where the HTTP route's auth has already run — which is to say, past it. See the node's help
// text for why that is deliberate and where it stops (admin tools keep the route's rule).

module.exports = function(RED) {
    function mcpCall(config) {
        RED.nodes.createNode(this, config);
        // The server whose tools this node calls. Required: unlike hal2, this package has no
        // implicit endpoint to fall back on — every tool belongs to one mcp-server node.
        this.mcpServer       = RED.nodes.getNode(config.mcpServer);
        this.allowAdminTools = config.allowAdminTools === true;
        this.field           = config.field || "payload";
        this.fieldType       = config.fieldType || "msg";
        var node = this;

        node.status({});

        node.on('input', async function(msg, send, done) {
            // Node-RED >=1.0 always provides send/done; keep a guard for safety.
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            // Write the response envelope to the configured output property — msg.<field>
            // by default, or a flow/global context key — and forward the message.
            const deliver = (value) => {
                if (node.fieldType === 'msg') {
                    RED.util.setMessageProperty(msg, node.field, value);
                    send(msg);
                    return done();
                }
                const ctx    = node.context()[node.fieldType];
                const ctxKey = RED.util.parseContextStore(node.field);
                ctx.set(ctxKey.key, value, ctxKey.store, (err) => {
                    if (err) { return done(err); }
                    send(msg);
                    done();
                });
            };

            const fail = (message, code) => {
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                deliver({ ok: false, error: { code: code || -32000, message: message } });
            };

            // One node speaks for one server: its tools and nothing else, exactly as an MCP
            // client on that server's URL sees.
            const target = node.mcpServer;
            if (!target || typeof target.callTool !== 'function') {
                return fail('No MCP server configured (or it failed to start — check its status)');
            }

            // Accept { tool, args } on msg.payload; allow msg.tool / msg.args to override.
            // A JSON string payload is auto-parsed for convenience (e.g. an inject/http node
            // that emitted a string rather than an object).
            let payload = msg.payload;
            if (typeof payload === 'string' && payload.trim().startsWith('{')) {
                try { payload = JSON.parse(payload); } catch (e) { /* handled below */ }
            }
            if (!payload || typeof payload !== 'object') payload = {};
            const tool = msg.tool || payload.tool;
            const args = msg.args || payload.args || {};

            // Ask what is behind this endpoint rather than calling anything. A dedicated field
            // rather than a reserved tool name: nothing validates a registered name beyond
            // refusing the built-ins, so a reserved one could be taken and the clash would be
            // silent.
            if (payload.list === true || msg.list === true) {
                node.status({ fill: 'blue', shape: 'dot', text: 'list' });
                const tools = (typeof target.listTools === 'function') ? target.listTools() : [];
                node.status({ fill: 'green', shape: 'dot', text: tools.length + ' tools' });
                return deliver({ ok: true, result: tools });
            }

            if (!tool || typeof tool !== 'string') {
                const hint = (typeof msg.payload === 'string')
                    ? ' — msg.payload is a string; set the inject node type to JSON (or add a json node before this) so it becomes an object'
                    : '';
                return fail('Missing "tool" — provide msg.payload.tool, or { "list": true } '
                    + 'to see what this server exposes' + hint, -32602);
            }

            node.status({ fill: 'blue', shape: 'dot', text: tool });

            try {
                const out = await target.callTool(
                    tool, args, msg.claims || null, { adminEnabled: node.allowAdminTools }
                );

                if (!out || out.ok !== true) {
                    return fail((out && out.message) || 'Tool call failed', out && out.code);
                }

                let result;
                if (out.content !== undefined) {
                    // MCP content array (images / dynamic tools) — pass through verbatim.
                    result = out.content;
                } else {
                    // Tool results are JSON strings; fall back to raw text (e.g. get_flow markdown).
                    try { result = JSON.parse(out.text); }
                    catch (e) { result = out.text; }
                }

                node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                deliver({ ok: true, result: result });
            } catch (err) {
                node.error('mcp-call error: ' + err.message, msg);
                return fail(err.message);
            }
        });
    }
    RED.nodes.registerType('mcp-call', mcpCall);
};
