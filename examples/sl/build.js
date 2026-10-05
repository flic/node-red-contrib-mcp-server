#!/usr/bin/env node
'use strict';
// Builds ../sl-mcp.json from lib.js. The code tested in lib.test.js is embedded in
// the function nodes as-is — edit lib.js and rebuild, never the JSON.
//   node examples/sl/build.js
const fs = require('fs');
const path = require('path');

const lib = fs.readFileSync(path.join(__dirname, 'lib.js'), 'utf8');
const bundle = 'const L = (function () { const module = { exports: {} };\n'
    + lib + '\nreturn module.exports; })();\n';

const Z = 'sl-tab';
const SERVER = 'sl-server';
const HTTP_LINK = 'sl-http-get';

const instructions = [
    'Stockholm public transport (SL): real-time departures, disruptions and journey planning. No API key, read-only.',
    'Stop names work everywhere a stop is asked for ("Odenplan", "T-Centralen") — the tools look them up, so one call is enough.',
    'Use sl_find_stop only when a name is ambiguous or you need the site_id; it also finds addresses and places.',
    'All times are ISO 8601 in Swedish time (Europe/Stockholm). in_min counts from now.',
    'Check memory for the household\'s usual stops ("home", "work") before asking the user which stop they mean.',
].join(' ');

const tools = [
    {
        id: 'find-stop', name: 'Find stop', tool: 'sl_find_stop',
        description: 'Search SL stops, and optionally addresses and places, by name. Returns site_id (for departures and disruptions) and journey_id (for trip planning). Only needed when a name is ambiguous — the other tools accept names directly.',
        schema: {
            type: 'object', required: ['query'],
            properties: {
                query: { type: 'string', description: 'Name to search for, e.g. "Odenplan" or "Sveavägen 50, Stockholm"' },
                types: { type: 'array', items: { type: 'string', enum: ['stop', 'address', 'poi'] }, description: 'What to search for (default ["stop"])' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 5)' },
            },
        },
    },
    {
        id: 'departures', name: 'Departures', tool: 'sl_departures',
        description: 'Upcoming departures from an SL stop, in real time: line, destination, expected time, minutes until departure, delay, platform, and any disruption on that departure. A stop covers every mode there (metro, bus, commuter train …) unless filtered. If the name matched several stops the others come back as alternatives.',
        schema: {
            type: 'object', required: ['stop'],
            properties: {
                stop: { type: 'string', description: 'Stop name ("Odenplan") or site_id ("9117")' },
                transport_mode: { type: 'string', enum: ['BUS', 'METRO', 'TRAM', 'TRAIN', 'SHIP', 'FERRY', 'TAXI'], description: 'Only this mode' },
                line: { type: 'string', description: 'Only this line, e.g. "19" or "4"' },
                direction: { type: 'integer', enum: [1, 2], description: 'Only this direction_code (as returned in earlier results)' },
                minutes_ahead: { type: 'integer', minimum: 5, maximum: 1200, description: 'How far ahead to look (default 60)' },
                limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max departures (default 12)' },
            },
        },
    },
    {
        id: 'deviations', name: 'Deviations', tool: 'sl_deviations',
        description: 'Current SL disruptions and planned changes (track work, closed lifts, cancelled trips, moved stops), most important first. Filter by stop, line or mode; without filters returns network-wide messages.',
        schema: {
            type: 'object',
            properties: {
                stop: { type: 'string', description: 'Stop name or site_id' },
                line: { type: 'array', items: { type: 'string' }, description: 'Line designations, e.g. ["19", "17"]' },
                transport_mode: { type: 'string', enum: ['BUS', 'METRO', 'TRAM', 'TRAIN', 'SHIP', 'FERRY', 'TAXI'], description: 'Only lines of this mode' },
                include_future: { type: 'boolean', description: 'Also include announced future disruptions (default false)' },
                limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max messages (default 10)' },
            },
        },
    },
    {
        id: 'plan-trip', name: 'Plan trip', tool: 'sl_plan_trip',
        description: 'Plan a journey with SL between two places: departure and arrival times, changes, and each leg (line, platform, walking). Places can be stop names, addresses ("Sveavägen 50, Stockholm" — include the municipality, street names repeat), site_id, or "lat,lon". Without date/time it plans from now. also_matched lists other places a name could have meant.',
        schema: {
            type: 'object', required: ['from', 'to'],
            properties: {
                from: { type: 'string', description: 'Start: stop name, address, site_id or "lat,lon"' },
                to: { type: 'string', description: 'Destination: stop name, address, site_id or "lat,lon"' },
                via: { type: 'string', description: 'Travel via this stop' },
                date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
                time: { type: 'string', description: 'HH:MM, Swedish time (default now)' },
                arrive_by: { type: 'boolean', description: 'time is the latest arrival instead of earliest departure (needs time)' },
                max_changes: { type: 'integer', minimum: 0, maximum: 9, description: 'Max number of changes' },
                route_type: { type: 'string', enum: ['leasttime', 'leastinterchange', 'leastwalking'], description: 'Optimise for (default leasttime)' },
                exclude_modes: { type: 'array', items: { type: 'string', enum: ['TRAIN', 'METRO', 'TRAM', 'BUS', 'SHIP'] }, description: 'Modes to avoid' },
                num_trips: { type: 'integer', minimum: 1, maximum: 3, description: 'Number of alternatives (default 3)' },
            },
        },
    },
];

const runner = (tool) => bundle + `
const deps = {
    get: async (url) => {
        const r = await node.linkcall(${JSON.stringify(HTTP_LINK)}, { url, requestTimeout: 10000 }, { timeout: 15000 });
        return { status: r.statusCode, body: r.payload };
    },
    cache: L.contextCache(flow),
    now: () => new Date(),
};
msg.payload = await L.run(${JSON.stringify(tool)}, msg.payload, deps);
node.status({ fill: msg.payload.error ? 'red' : 'green', shape: 'dot', text: msg.payload.error ? 'error' : 'ok' });
return msg;
`;

const nodes = [
    {
        id: Z, type: 'tab', label: 'SL MCP', disabled: false,
        info: 'GENERATED by examples/sl/build.js — edit lib.js and rebuild, not this flow.\n\n'
            + 'SL Transport, Deviations and Journey-planner v2 (trafiklab.se), no API key.\n'
            + 'Requires Node-RED >= 5.0 (function nodes call the shared HTTP subroutine with node.linkcall).',
    },
    {
        id: SERVER, type: 'mcp-server', name: 'SL', path: 'sl', serverUrl: '', filterHost: false,
        serverName: '', instructions, issuerUrl: '', extraScopes: '', audience: '', tokenCacheTTL: 300,
        localDebugGroups: '', requiredClaim: 'groups', requiredValue: '', requiredScope: '',
        adminToolsEnabled: false, adminPort: 1880, adminRequiredValue: 'admin',
    },
];

let y = 60;
for (const t of tools) {
    nodes.push(
        {
            id: `sl-in-${t.id}`, type: 'mcp-in', z: Z, name: t.name, mcpServer: SERVER, toolName: t.tool,
            description: t.description, inputSchema: JSON.stringify(t.schema), topic: '', timeout: 30,
            requiredValue: '', x: 140, y, wires: [[`sl-fn-${t.id}`]],
        },
        {
            id: `sl-fn-${t.id}`, type: 'function', z: Z, name: t.tool, func: runner(t.tool), outputs: 1,
            timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 380, y, wires: [[`sl-out-${t.id}`]],
        },
        { id: `sl-out-${t.id}`, type: 'mcp-out', z: Z, name: '', mcpServer: SERVER, x: 600, y, wires: [] },
    );
    y += 60;
}

// Shared HTTP subroutine: { url, requestTimeout } in, { statusCode, payload } back.
y += 40;
nodes.push(
    {
        id: 'sl-link-in', type: 'link in', z: Z, name: HTTP_LINK, links: [], x: 155, y,
        wires: [['sl-http']],
    },
    {
        id: 'sl-http', type: 'http request', z: Z, name: 'GET SL', method: 'GET', ret: 'obj',
        paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false,
        authType: '', senderr: false, headers: [], x: 380, y, wires: [['sl-link-out']],
    },
    { id: 'sl-link-out', type: 'link out', z: Z, name: 'return', mode: 'return', links: [], x: 575, y, wires: [] },
);

const out = path.join(__dirname, '..', 'sl-mcp.json');
fs.writeFileSync(out, JSON.stringify(nodes, null, 4) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)}: ${nodes.length} nodes`);
