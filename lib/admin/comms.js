'use strict';
// What the editor's debug sidebar sees, kept for get_debug: debug-node output plus the warnings
// and errors nodes raise, which reach the editor on the same topic. Read off the editor's own
// comms websocket — there is no HTTP endpoint for it — into a ring buffer, so a test call can
// inject and then ask what came out.
//
// The protocol is the editor's: send { auth: <token> } (needs status.read), get { auth: "ok" },
// send { subscribe: "debug" }, then receive JSON arrays of { topic, data } batches.

const MSG_MAX = 2000;

function createDebugBuffer({ url, getToken, size = 200, WebSocketImpl = globalThis.WebSocket,
                             log = () => {}, reconnectMs = 5000 }) {
    const entries = [];
    let ws = null, stopped = true, timer = null, lastError = null, authed = false, listeningSince = null;

    function push(data) {
        if (!data || typeof data !== 'object') return;
        const msg = typeof data.msg === 'string' && data.msg.length > MSG_MAX
            ? data.msg.slice(0, MSG_MAX) + '… (' + data.msg.length + ' chars)' : data.msg;
        entries.push({
            time    : new Date().toISOString(),
            id      : data.id,
            flow    : data.z,
            name    : data.name || undefined,
            // node.warn/node.error carry a level (30 warn, 20 error); debug-node output has none.
            level   : data.level === 20 ? 'error' : data.level === 30 ? 'warn' : data.level === 40 ? 'info' : 'debug',
            topic   : data.topic,
            property: data.property,
            format  : data.format,
            msg
        });
        if (entries.length > size) entries.splice(0, entries.length - size);
    }

    function schedule() {
        if (stopped || timer) return;
        timer = setTimeout(() => { timer = null; connect(); }, reconnectMs);
    }

    function connect() {
        if (stopped || typeof WebSocketImpl !== 'function') {
            if (typeof WebSocketImpl !== 'function') lastError = 'No WebSocket implementation (Node.js 22 or later is required).';
            return;
        }
        authed = false;
        try { ws = new WebSocketImpl(url); } catch (e) { lastError = e.message; schedule(); return; }
        ws.onopen = () => {
            const token = (getToken && getToken()) || '';
            if (token) ws.send(JSON.stringify({ auth: token }));
            else {
                authed = true;
                if (!listeningSince) listeningSince = new Date().toISOString();
                ws.send(JSON.stringify({ subscribe: 'debug' }));
            }
        };
        ws.onmessage = ev => {
            let msg;
            try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
            if (msg && msg.auth === 'ok') {
                authed = true; lastError = null;
                if (!listeningSince) listeningSince = new Date().toISOString();
                ws.send(JSON.stringify({ subscribe: 'debug' }));
                return;
            }
            if (msg && msg.auth === 'fail') {
                lastError = 'The admin token was refused by the editor\'s comms (it needs status.read).';
                log(lastError);
                return;
            }
            for (const item of Array.isArray(msg) ? msg : [msg]) {
                if (item && item.topic === 'debug') push(item.data);
            }
        };
        ws.onerror = ev => { lastError = (ev && ev.message) || 'websocket error'; };
        ws.onclose = () => { ws = null; schedule(); };
    }

    return {
        start() { if (!stopped) return; stopped = false; connect(); },
        stop() {
            stopped = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (ws) { try { ws.close(); } catch { /* closing anyway */ } ws = null; }
        },
        // Newest last, filtered; `since` is an ISO time.
        query({ node, flow, level, since, limit = 20 } = {}) {
            const out = entries.filter(e =>
                (!node || e.id === node) && (!flow || e.flow === flow)
                && (!level || e.level === level) && (!since || e.time > since));
            return out.slice(-Math.max(1, Math.min(200, limit)));
        },
        // listeningSince: when the buffer first heard the runtime — nothing older can be in it.
        status: () => ({ connected: !!ws && authed, listeningSince: listeningSince || undefined,
            buffered: entries.length, capacity: size, oldest: entries.length ? entries[0].time : undefined,
            error: lastError || undefined }),
        _push: push   // for tests
    };
}

module.exports = { createDebugBuffer };
