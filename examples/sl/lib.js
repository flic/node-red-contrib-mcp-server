'use strict';
// SL tools, pure logic. Bundled verbatim into each function node by build.js and
// tested in lib.test.js; I/O arrives through `deps`:
//   deps.get(url)        -> Promise<{ status, body }>   (the shared http subroutine)
//   deps.cache           -> { get(key), set(key, value, ttlMs) }
//   deps.now()           -> Date
// Every tool resolves to a plain object; failures are `{ error }` for the model to read.

const TRANSPORT = 'https://transport.integration.sl.se/v1';
const DEVIATIONS = 'https://deviations.integration.sl.se/v1/messages';
const JOURNEY = 'https://journeyplanner.integration.sl.se/v2';

const TZ = 'Europe/Stockholm';
const MODES = ['BUS', 'METRO', 'TRAM', 'TRAIN', 'SHIP', 'FERRY', 'TAXI'];
// Journey planner ids for SL stops are the Transport API site id under this prefix:
// 9091001000009117 <-> site 9117 (measured 2026-10-05, same as /sites `gid`).
// Built as strings: the number is past Number.MAX_SAFE_INTEGER.
const GID_PREFIX = '9091001';
const gidOf = (site) => GID_PREFIX + String(site).padStart(9, '0');
// Below this stop-finder matchQuality (1000 = exact) a hit is a guess, not a match:
// "odenplann" scores 841, "slusen" 990, gibberish ~325.
const MIN_QUALITY = 500;

const TTL = { stop: 24 * 3600e3, departures: 20e3, deviations: 60e3 };

class InputError extends Error {}
const fail = (m) => { throw new InputError(m); };

// ── time ────────────────────────────────────────────────────────────────────

const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, hourCycle: 'h23', timeZoneName: 'longOffset',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(date) {
    const p = {};
    for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
    const off = (p.timeZoneName.replace('GMT', '') || '+00:00');
    return { ...p, off };
}

// Date -> "2026-10-05T08:28:48+02:00" in Swedish time.
function localIso(date) {
    if (!(date instanceof Date) || isNaN(date)) return null;
    const p = parts(date);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.off}`;
}

// "2026-10-05T08:27:00" (Swedish wall clock, no zone, as Transport answers) -> Date.
function fromLocal(s) {
    if (!s) return null;
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
    const asUtc = new Date(s + 'Z');
    if (isNaN(asUtc)) return null;
    const off = parts(asUtc).off;              // offset at (roughly) that instant
    return new Date(s + off);
}

const toIso = (s) => localIso(fromLocal(s));
const minutesBetween = (a, b) => (a && b ? Math.round((b - a) / 60000) : null);

// ── input validation (msg.payload is untrusted caller input) ─────────────────

const str = (v, name, max = 200) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' && typeof v !== 'number') fail(`${name} must be a string`);
    const s = String(v).trim();
    if (!s || s.length > max) fail(`${name} must be 1–${max} characters`);
    return s;
};

const int = (v, name, min, max, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be an integer ${min}–${max}`);
    return n;
};

const bool = (v, name, dflt = false) => {
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'boolean') fail(`${name} must be true or false`);
    return v;
};

const mode = (v, name = 'transport_mode') => {
    const s = str(v, name, 10);
    if (s === undefined) return undefined;
    const m = s.toUpperCase();
    if (!MODES.includes(m)) fail(`${name} must be one of ${MODES.join(', ')}`);
    return m;
};

const LINE_RE = /^[0-9A-Za-zÅÄÖåäö]{1,6}$/;
const line = (v, name = 'line') => {
    const s = str(v, name, 6);
    if (s === undefined) return undefined;
    if (!LINE_RE.test(s)) fail(`${name} must be a line designation like "19" or "13X"`);
    return s.toUpperCase();
};

const lines = (v) => {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : [v];
    if (arr.length > 20) fail('line accepts at most 20 lines');
    return arr.map((x) => line(x));
};

function date(v) {
    const s = str(v, 'date', 10);
    if (s === undefined) return undefined;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m || isNaN(new Date(`${s}T12:00:00Z`))) fail('date must be YYYY-MM-DD');
    return m[1] + m[2] + m[3];
}

function time(v) {
    const s = str(v, 'time', 5);
    if (s === undefined) return undefined;
    const m = /^([01]\d|2[0-3]):?([0-5]\d)$/.exec(s);
    if (!m) fail('time must be HH:MM');
    return m[1] + m[2];
}

// "59.3429,18.0491" -> { lat, lon } or null.
function coord(s) {
    const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s);
    if (!m) return null;
    const lat = Number(m[1]), lon = Number(m[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) fail('coordinates must be "lat,lon" in decimal degrees');
    return { lat, lon };
}

// site id or journey-planner stop id, if the string is one.
function stopId(s) {
    if (/^\d{1,7}$/.test(s)) return { site_id: Number(s), journey_id: gidOf(s) };
    if (/^\d{16}$/.test(s)) return { site_id: siteOf(s), journey_id: s };
    return null;
}

function siteOf(journeyId) {
    const s = String(journeyId);
    return /^\d{16}$/.test(s) && s.startsWith(GID_PREFIX) ? parseInt(s.slice(GID_PREFIX.length), 10) : null;
}

// ── http + cache ─────────────────────────────────────────────────────────────

function qs(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}=${encodeURIComponent(x)}`))
        .join('&');
}

async function getJson(deps, url, ttl) {
    if (ttl) {
        const hit = deps.cache.get(url);
        if (hit !== undefined) return hit;
    }
    const r = await deps.get(url);
    if (!r || typeof r.status !== 'number' || r.status < 200 || r.status >= 300) {
        throw new Error(`SL answered ${r && r.status !== undefined ? 'HTTP ' + r.status : 'nothing'} for ${url.split('?')[0]}`);
    }
    if (typeof r.body !== 'object' || r.body === null) throw new Error(`SL sent non-JSON for ${url.split('?')[0]}`);
    if (ttl) deps.cache.set(url, r.body, ttl);
    return r.body;
}

// ── stop lookup (journey planner stop-finder) ────────────────────────────────

const TYPE_FILTER = { stop: 2, address: 12, poi: 32 };

async function stopFinder(deps, query, types) {
    const filter = types.reduce((a, t) => a | TYPE_FILTER[t], 0);
    const url = `${JOURNEY}/stop-finder?${qs({ name_sf: query, type_sf: 'any', any_obj_filter_sf: filter })}`;
    const body = await getJson(deps, url, TTL.stop);
    return (body.locations || [])
        .sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0) || (b.matchQuality || 0) - (a.matchQuality || 0))
        .map((l) => ({
            name: l.disassembledName && l.type === 'stop' ? l.disassembledName : l.name,
            full_name: l.name,
            type: l.type,
            journey_id: l.id,
            site_id: l.type === 'stop' ? siteOf(l.id) : null,
            best: !!l.isBest,
            quality: l.matchQuality || 0,
        }))
        .filter((h) => h.quality >= MIN_QUALITY);
}

// Name, site id or journey id -> one SL stop (+ alternatives) for Transport/Deviations.
async function resolveStop(deps, input) {
    const id = stopId(input);
    if (id) return { stop: { name: null, ...id }, alternatives: [] };
    const hits = (await stopFinder(deps, input, ['stop'])).filter((h) => h.site_id);
    if (!hits.length) fail(`No SL stop matches "${input}". Try sl_find_stop with another spelling.`);
    const [best, ...rest] = hits;
    return {
        stop: { name: best.name, site_id: best.site_id, journey_id: best.journey_id },
        alternatives: rest.slice(0, 3).map((h) => ({ name: h.name, site_id: h.site_id })),
    };
}

// Name, id or "lat,lon" -> journey planner { type, name } (+ what it resolved to).
async function resolvePlace(deps, input, field) {
    const c = coord(input);
    if (c) return { type: 'coord', name: `${c.lon}:${c.lat}:WGS84[dd.ddddd]`, label: `${c.lat},${c.lon}` };
    const id = stopId(input);
    if (id) return { type: 'any', name: id.journey_id, label: input };
    const hits = await stopFinder(deps, input, ['stop', 'address', 'poi']);
    if (!hits.length) fail(`${field}: nothing in SL's journey planner matches "${input}"`);
    // Addresses repeat across municipalities ("Sveavägen 50" exists in Danderyd,
    // Sollentuna and Stockholm), so the runners-up go back with the answer.
    const others = hits.slice(1).filter((h) => h.type === hits[0].type).slice(0, 2).map((h) => h.full_name);
    return { type: 'any', name: hits[0].journey_id, label: hits[0].full_name, others };
}

// ── tools ────────────────────────────────────────────────────────────────────

async function findStop(args, deps) {
    const query = str(args.query, 'query') || fail('query is required');
    let types = args.types === undefined ? ['stop'] : (Array.isArray(args.types) ? args.types : [args.types]);
    if (!types.length || types.some((t) => !TYPE_FILTER[t])) fail('types must contain stop, address and/or poi');
    const limit = int(args.limit, 'limit', 1, 20, 5);
    const hits = await stopFinder(deps, query, types);
    return {
        results: hits.slice(0, limit).map((h) => ({
            name: h.full_name, type: h.type, site_id: h.site_id, journey_id: h.journey_id, best: h.best,
        })),
    };
}

async function departures(args, deps) {
    const stopIn = str(args.stop, 'stop') || fail('stop is required (name or site_id)');
    const m = mode(args.transport_mode);
    const ln = line(args.line);
    const dir = int(args.direction, 'direction', 1, 2);
    const ahead = int(args.minutes_ahead, 'minutes_ahead', 5, 1200, 60);
    const limit = int(args.limit, 'limit', 1, 50, 12);

    const { stop, alternatives } = await resolveStop(deps, stopIn);
    const body = await getJson(deps, `${TRANSPORT}/sites/${stop.site_id}/departures?${qs({ forecast: ahead })}`, TTL.departures);
    const now = deps.now();
    const all = body.departures || [];
    if (!stop.name && all[0]) stop.name = all[0].stop_area && all[0].stop_area.name;

    const rows = all
        .filter((d) => !m || (d.line && d.line.transport_mode === m))
        .filter((d) => !ln || (d.line && String(d.line.designation).toUpperCase() === ln))
        .filter((d) => !dir || d.direction_code === dir)
        .map((d) => {
            const sched = fromLocal(d.scheduled), exp = fromLocal(d.expected || d.scheduled);
            return {
                line: d.line && d.line.designation,
                mode: d.line && d.line.transport_mode,
                group: (d.line && d.line.group_of_lines) || undefined,
                destination: d.destination,
                direction: d.direction_code,
                display: d.display,
                scheduled: localIso(sched),
                expected: localIso(exp),
                in_min: Math.max(0, minutesBetween(now, exp)),
                delay_min: minutesBetween(sched, exp),
                platform: (d.stop_point && d.stop_point.designation) || undefined,
                state: d.state,
                deviations: (d.deviations || []).map((x) => x.message).filter(Boolean),
            };
        })
        // Transport keeps a departure listed for a while after it left (and cancelled
        // ones at their old time); anything more than a minute gone is noise.
        .filter((d) => minutesBetween(now, fromLocal(d.expected)) >= -1)
        .sort((a, b) => a.expected < b.expected ? -1 : 1)
        .slice(0, limit);

    for (const d of rows) {
        if (!d.deviations.length) delete d.deviations;
        if (!d.delay_min) delete d.delay_min;
    }
    const out = { stop, now: localIso(now), departures: rows };
    const stopDev = (body.stop_deviations || []).map((x) => x.message).filter(Boolean);
    if (stopDev.length) out.stop_deviations = stopDev;
    if (alternatives.length) out.alternatives = alternatives;
    if (!rows.length) out.note = `No departures matching the filters in the next ${ahead} minutes.`;
    return out;
}

const prio = (x, k) => (x.priority && x.priority[k]) || 0;

async function deviations(args, deps) {
    const stopIn = str(args.stop, 'stop');
    const lns = lines(args.line);
    const m = mode(args.transport_mode);
    const future = bool(args.include_future, 'include_future');
    const limit = int(args.limit, 'limit', 1, 50, 10);

    let stop = null;
    if (stopIn) stop = (await resolveStop(deps, stopIn)).stop;
    // Without a stop the unfiltered list is fetched once and filtered here, so every
    // line/mode question shares one cached request — SL asks for at most one a minute.
    const url = `${DEVIATIONS}?${qs({ future: future || undefined, site: stop ? stop.site_id : undefined })}`;
    const body = await getJson(deps, url, TTL.deviations);
    const msgs = (Array.isArray(body) ? body : [])
        .filter((x) => !m || ((x.scope && x.scope.lines) || []).some((l) => l.transport_mode === m))
        .filter((x) => !lns.length || ((x.scope && x.scope.lines) || []).some((l) => lns.includes(String(l.designation).toUpperCase())))
        .sort((a, b) => (prio(b, 'importance_level') - prio(a, 'importance_level'))
            || (prio(b, 'influence_level') - prio(a, 'influence_level'))
            || (((a.publish || {}).from || '') < ((b.publish || {}).from || '') ? 1 : -1));

    const out = {
        total: msgs.length,
        deviations: msgs.slice(0, limit).map((x) => {
            const v = (x.message_variants || []).find((mv) => mv.language === 'sv') || (x.message_variants || [])[0] || {};
            const scope = x.scope || {};
            return {
                header: v.header,
                details: v.details,
                scope_alias: v.scope_alias,
                lines: (scope.lines || []).map((l) => `${l.transport_mode} ${l.designation}`),
                stops: [...new Set((scope.stop_areas || []).map((s) => s.name))],
                from: toIso(x.publish && x.publish.from),
                upto: toIso(x.publish && x.publish.upto),
                importance: x.priority && x.priority.importance_level,
            };
        }),
    };
    if (stop) out.stop = stop;
    return out;
}

const PRODUCT = { 0: 'TRAIN', 1: 'TRAIN', 2: 'METRO', 4: 'TRAM', 5: 'BUS', 9: 'SHIP', 99: 'WALK', 100: 'WALK' };
// incl_mot_* is an allowlist in practice: `incl_mot_2=false` alone changes nothing, but
// once any incl_mot_N=true is present only the true ones are used (measured 2026-10-05).
// Excluding a mode therefore means sending true for every other one.
const MOT = { TRAIN: [0, 14], METRO: [2], TRAM: [4], BUS: [5, 10, 19], SHIP: [9] };
const ROUTE = ['leasttime', 'leastinterchange', 'leastwalking'];

function formatLeg(l) {
    const t = l.transportation || {}, p = t.product || {}, o = l.origin || {}, d = l.destination || {};
    const kind = PRODUCT[p.class] || (p.name === 'footpath' ? 'WALK' : String(p.name || 'OTHER').toUpperCase());
    const minutes = Math.round((l.duration || 0) / 60);
    if (kind === 'WALK') return { mode: 'WALK', minutes, from: o.name, to: d.name };
    const leg = {
        mode: kind,
        line: t.disassembledName || t.number,
        direction: t.destination && t.destination.name,
        from: o.parent && o.parent.disassembledName ? o.parent.name : o.name,
        platform: o.disassembledName,
        depart_planned: toIso(o.departureTimePlanned),
        depart_expected: toIso(o.departureTimeEstimated),
        to: d.name,
        arrive_planned: toIso(d.arrivalTimePlanned),
        arrive_expected: toIso(d.arrivalTimeEstimated),
        minutes,
    };
    const infos = (l.infos || []).map((i) => i.subtitle || i.title || i.content).filter(Boolean);
    if (infos.length) leg.infos = [...new Set(infos)];
    if (leg.depart_expected === leg.depart_planned) delete leg.depart_expected;
    if (leg.arrive_expected === leg.arrive_planned) delete leg.arrive_expected;
    return leg;
}

// Consecutive walking legs (99 = transfer, 100 = walk) collapse into one.
function mergeWalks(legs) {
    const out = [];
    for (const l of legs) {
        const prev = out[out.length - 1];
        if (l.mode === 'WALK' && prev && prev.mode === 'WALK') { prev.minutes += l.minutes; prev.to = l.to; }
        else out.push(l);
    }
    return out.filter((l) => l.mode !== 'WALK' || l.minutes > 0);
}

function legTime(raw, which) {
    const n = raw[which === 'dep' ? 'origin' : 'destination'] || {};
    const k = which === 'dep' ? 'departureTime' : 'arrivalTime';
    return toIso(n[`${k}Estimated`] || n[`${k}Planned`]);
}

async function planTrip(args, deps) {
    const fromIn = str(args.from, 'from') || fail('from is required');
    const toIn = str(args.to, 'to') || fail('to is required');
    const viaIn = str(args.via, 'via');
    const d = date(args.date);
    const t = time(args.time);
    const arriveBy = bool(args.arrive_by, 'arrive_by');
    const maxChanges = int(args.max_changes, 'max_changes', 0, 9);
    const n = int(args.num_trips, 'num_trips', 1, 3, 3);
    const route = str(args.route_type, 'route_type', 20);
    if (route && !ROUTE.includes(route)) fail(`route_type must be one of ${ROUTE.join(', ')}`);
    const exclude = (args.exclude_modes === undefined ? [] : (Array.isArray(args.exclude_modes) ? args.exclude_modes : [args.exclude_modes]))
        .map((x) => mode(x, 'exclude_modes'));
    if (exclude.some((x) => !MOT[x])) fail(`exclude_modes may contain ${Object.keys(MOT).join(', ')}`);
    if (arriveBy && !t) fail('arrive_by needs a time');
    // Bad coordinates must fail before the lookups below start in parallel.
    for (const x of [fromIn, toIn, viaIn]) if (x) coord(x);

    const [from, to, via] = await Promise.all([
        resolvePlace(deps, fromIn, 'from'),
        resolvePlace(deps, toIn, 'to'),
        viaIn ? resolvePlace(deps, viaIn, 'via') : null,
    ]);
    const now = deps.now();
    const p = {
        type_origin: from.type, name_origin: from.name,
        type_destination: to.type, name_destination: to.name,
        calc_number_of_trips: n,
        max_changes: maxChanges,
        route_type: route,
        gen_c: 'false',
    };
    if (via) { p.type_via = via.type; p.name_via = via.name; }
    if (d || t) {
        const today = localIso(now).slice(0, 10).replace(/-/g, '');
        p.itd_date = d || today;
        p.itd_time = t || localIso(now).slice(11, 16).replace(':', '');
        if (arriveBy) p.itd_trip_date_time_dep_arr = 'arr';
    }
    if (exclude.length) {
        if (exclude.length === Object.keys(MOT).length) fail('exclude_modes cannot exclude every mode');
        for (const [m, nums] of Object.entries(MOT)) if (!exclude.includes(m)) for (const k of nums) p[`incl_mot_${k}`] = 'true';
    }

    // Trips are not cached: the answer moves with every minute and real-time state.
    const body = await getJson(deps, `${JOURNEY}/trips?${qs(p)}`);
    const journeys = (body.journeys || []).map((j) => {
        const raw = j.legs || [];
        return {
            depart: legTime(raw[0] || {}, 'dep'),
            arrive: legTime(raw[raw.length - 1] || {}, 'arr'),
            duration_min: Math.round((j.tripRtDuration || j.tripDuration || 0) / 60),
            changes: j.interchanges,
            legs: mergeWalks(raw.map(formatLeg)),
        };
    });
    const out = { from: from.label, to: to.label, journeys };
    if (via) out.via = via.label;
    const alts = {};
    for (const [k, v] of [['from', from], ['to', to], ['via', via]]) if (v && v.others && v.others.length) alts[k] = v.others;
    if (Object.keys(alts).length) out.also_matched = alts;
    const sys = (body.systemMessages || []).filter((s) => s.type === 'error').map((s) => s.text || s.code);
    if (!journeys.length) out.note = sys.length ? `No journeys: ${sys.join('; ')}` : 'No journeys found.';
    return out;
}

const TOOLS = {
    sl_find_stop: findStop,
    sl_departures: departures,
    sl_deviations: deviations,
    sl_plan_trip: planTrip,
};

async function run(tool, args, deps) {
    try {
        return await TOOLS[tool](args && typeof args === 'object' ? args : {}, deps);
    } catch (e) {
        return { error: e.message };
    }
}

// Flow-context cache: one object, expired entries pruned on every write.
function contextCache(ctx, key = 'slCache') {
    return {
        get(k) {
            const c = ctx.get(key) || {};
            const e = c[k];
            return e && e.exp > Date.now() ? e.val : undefined;
        },
        set(k, val, ttl) {
            const c = ctx.get(key) || {};
            const now = Date.now();
            for (const [kk, e] of Object.entries(c)) if (e.exp <= now) delete c[kk];
            c[k] = { exp: now + ttl, val };
            ctx.set(key, c);
        },
    };
}

module.exports = {
    run, TOOLS, contextCache, InputError,
    // exported for tests
    localIso, fromLocal, siteOf, stopId, coord, date, time, line, qs, mergeWalks, formatLeg,
};
