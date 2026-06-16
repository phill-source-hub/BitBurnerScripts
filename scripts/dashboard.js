/**
 * dashboard.js
 * Version: 1.6.0
 *
 * Interactive React operations dashboard for PhlanxOS.
 *
 * Behaviour:
 *   Renders a single React component into the tail window. Game state is
 *   collected by the main script loop (valid NS async context) and stored
 *   in a shared data object. The React component reads from that object on
 *   a pure-JS setInterval tick — no NS calls inside React at all.
 *
 *   Scripts panel: running scripts shown with full row + STOP button.
 *   Non-running scripts collapsed to a compact dim row (name + START only).
 *
 *   Sections:
 *     Header      — title, timestamp, tier, hacking level, money, $/s
 *     Home RAM    — bar + GB used/max
 *     Farm RAM    — cloud server pool bar + GB + slot count
 *     Scripts     — all managed scripts, active expanded / inactive compact
 *     HWGW        — active targets from port 1
 *     Hacknet     — from port 3 (node or server mode)
 *     Share       — current sharePower
 *     Corporation — funds, revenue, division count
 *     Bladeburner — rank, current action
 *
 * Changelog:
 *   v1.8.0 - Darknet section: visible/cracked/stasis/instability from dnet API + port 6.
 *            Added Dnet Orch + Dnet Watch to MANAGED scripts list.
 *   v1.7.0 - Stocks section: realised/unrealised/total P&L from port 4 (stocks.js).
 *   v1.6.0 - Faction section (current faction, rep, favour via singularity API).
 *            LOG button per active script: queues tail open via cmdQueue.
 *            HWGW: show all 5 targets with mode + thread counts (H/WH/G/WG).
 *            Requires orchestrate v1.7.0+ port 1 format for thread data.
 *   v1.5.0 - Fix button clicks: NS can't be called from React event handlers either.
 *            cmdQueue (module-level array) collects click intents; main loop drains
 *            it with ns.scriptKill / ns.exec each iteration.
 *            Add CURRENCY constant (default '£'). fmtMoney() wraps fmtNum with it.
 *   v1.4.0 - Architectural fix: all NS calls moved to main() loop (valid async
 *            context). React component reads a shared data object via pure-JS
 *            setInterval — no NS calls in React at all. NS functions throw when
 *            called from setInterval callbacks in Bitburner's React context.
 *   v1.3.0 - Replace ns.format.number with pure-JS fmtNum. gatherData try/catch.
 *   v1.2.0 - Fix ns.format.number arg type.
 *   v1.1.0 - Compact non-running scripts. Corp + bladeburner sections.
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --help    Show usage and exit
 *   --force   Skip tier check and run regardless of home RAM
 *
 * Ports:
 *   Reads port 1: orchestrate HWGW cycle data (peek, non-consuming)
 *   Reads port 3: hacknet stats (peek, non-consuming)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~4.5 GB
 */

const VERSION    = '1.8.0';
const POLL_MS    = 2000;
const STALE_MS   = 2 * 60 * 1000;
const TIER_MIN   = 2;

// Currency symbol — no NS API to read game setting; change here to match yours
const CURRENCY    = '£';

const TAIL_W      = 680;
const TAIL_H      = 820;
const TAIL_MARGIN = 10;

const MANAGED = [
    { label: 'Orchestrate',   script: 'scripts/orchestrate.js',       args: [] },
    { label: 'Auto-Root',     script: 'scripts/auto-root.js',         args: ['--watch'] },
    { label: 'Buy Servers',   script: 'scripts/buy-servers.js',       args: [] },
    { label: 'Upg Servers',   script: 'scripts/upgrade-servers.js',   args: [] },
    { label: 'Hacknet',       script: 'scripts/hacknet-manager.js',   args: [] },
    { label: 'Share Mgr',     script: 'scripts/share-manager.js',     args: [] },
    { label: 'Contracts',     script: 'scripts/contracts.js',         args: [] },
    { label: 'Singularity',   script: 'scripts/singularity.js',       args: [] },
    { label: 'Stocks',        script: 'scripts/stocks.js',            args: [] },
    { label: 'Gang',          script: 'scripts/gang.js',              args: [] },
    { label: 'Sleeve',        script: 'scripts/sleeve.js',            args: [] },
    { label: 'Bladeburner',   script: 'scripts/bladeburner.js',       args: [] },
    { label: 'Corporation',   script: 'scripts/corporation.js',       args: [] },
    { label: 'Grafting',      script: 'scripts/grafting.js',          args: [] },
    { label: 'Go',            script: 'scripts/go.js',                args: [] },
    { label: 'Stanek',        script: 'scripts/stanek.js',            args: [] },
    { label: 'Dnet Orch',     script: 'scripts/dnet-orchestrate.js',  args: [] },
    { label: 'Dnet Watch',    script: 'scripts/dnet-watch.js',        args: [] },
];

const C = {
    bg:      '#0d1117',
    surface: '#161b22',
    border:  '#30363d',
    text:    '#c9d1d9',
    dim:     '#484f58',
    green:   '#3fb950',
    yellow:  '#d29922',
    red:     '#f85149',
    cyan:    '#39c5cf',
    blue:    '#58a6ff',
    purple:  '#bc8cff',
    white:   '#ffffff',
};

const e = React.createElement;


// =============================================================================
// Pure-JS number formatter — no NS calls
// =============================================================================

function fmtNum(n, decimals) {
    if (decimals === undefined) decimals = 2;
    if (n === undefined || n === null || isNaN(n)) return '0';
    const suffixes = ['', 'k', 'm', 'b', 't', 'q'];
    let i = 0;
    let v = n;
    while (Math.abs(v) >= 1000 && i < suffixes.length - 1) { v /= 1000; i++; }
    return v.toFixed(decimals) + suffixes[i];
}

function fmtMoney(n, decimals) {
    return CURRENCY + fmtNum(n, decimals);
}

function safeParse(raw) {
    try { return JSON.parse(raw); } catch (_) { return null; }
}


// =============================================================================
// Shared data object — written by main() loop, read by React component
// =============================================================================

const INIT_DATA = {
    player: null, homeMax: 0, homeUsed: 0, running: new Set(),
    sharePow: 1, hwgwData: null, hacknetData: null, stale: true,
    farmMax: 0, farmUsed: 0, farmCount: 0, farmLimit: 0,
    targets: {}, cycleStart: 0, corpData: null, bbData: null,
    now: Date.now(), income: [0, 0], factionData: null, stockData: null,
    dnetData: null,
};

// Single shared reference; main() mutates this each poll cycle.
// React reads it on its own tick — no NS calls in React context.
let sharedData = Object.assign({}, INIT_DATA);

// Command queue — onClick pushes pure-JS objects, main() drains with NS calls.
// NS functions can't be called from React event handlers (same restriction as timers).
const cmdQueue = [];

/**
 * Collects all game state via NS. Called only from main()'s async loop —
 * valid NS execution context. Updates sharedData in place.
 * @param {NS} ns
 */
function collectData(ns) {
    const player   = ns.getPlayer();
    const homeMax  = ns.getServerMaxRam('home');
    const homeUsed = ns.getServerUsedRam('home');

    const homeProcs = ns.ps('home');
    const running   = new Set(homeProcs.map(function(p) {
        return p.filename.replace(/^\//, '');
    }));

    let sharePow = 1;
    try { sharePow = ns.getSharePower(); } catch (_) {}

    const p1Raw    = ns.peek(1);
    const hwgwData = (p1Raw === 'NULL PORT DATA') ? null : safeParse(p1Raw);

    const p3Raw       = ns.peek(3);
    const hacknetData = (p3Raw === 'NULL PORT DATA') ? null : safeParse(p3Raw);

    const p4Raw    = ns.peek(4);
    const stockData = (p4Raw === 'NULL PORT DATA') ? null : safeParse(p4Raw);

    let farmMax = 0, farmUsed = 0, farmCount = 0, farmLimit = 0;
    try {
        const names = ns.cloud.getServerNames();
        farmLimit   = ns.cloud.getServerLimit();
        farmCount   = names.length;
        for (let i = 0; i < names.length; i++) {
            farmMax  += ns.getServerMaxRam(names[i]);
            farmUsed += ns.getServerUsedRam(names[i]);
        }
    } catch (_) {}

    const targets    = (hwgwData && hwgwData.targets) ? hwgwData.targets : {};
    const cycleStart = (hwgwData && hwgwData.cycleStart) ? hwgwData.cycleStart : 0;
    const stale      = (Date.now() - cycleStart) > STALE_MS;

    let corpData = null;
    try {
        const corp = ns['corporation'];
        if (corp['hasCorporation']()) {
            const cd = corp['getCorporation']();
            corpData = { funds: cd.funds, revenue: cd.revenue, divs: cd.divisions.length };
        }
    } catch (_) {}

    let bbData = null;
    try {
        const bb = ns['bladeburner'];
        if (bb['inBladeburner']()) {
            const action = bb['getCurrentAction']();
            bbData = { rank: bb['getRank'](), action: action ? action.name : 'idle', sp: bb['getSkillPoints']() };
        }
    } catch (_) {}

    let income = [0, 0];
    try { income = ns.getTotalScriptIncome(); } catch (_) {}

    // Faction name from player object — no singularity API needed.
    // Rep + favour come from port 5 (written by singularity.js each cycle).
    let factionData = null;
    const joined = player.factions || [];
    if (joined.length > 0) {
        const work = player.currentWork;
        const fac  = (work && work.factionName) ? work.factionName : joined[joined.length - 1];
        let rep = null, favour = null;
        try {
            const p5Raw = ns.peek(5);
            if (p5Raw !== 'NULL PORT DATA') {
                const p5 = JSON.parse(p5Raw);
                if (p5 && p5.faction === fac) { rep = p5.rep; favour = p5.favour; }
            }
        } catch (_) {}
        factionData = { name: fac, rep, favour };
    }

    // Darknet stats — probe() + instability + stasis + port 6 cracked count
    let dnetData = null;
    try {
        const dnet        = ns.dnet;
        const visible     = dnet.probe().length;
        const instab      = dnet.getDarknetInstability();
        const stasisUsed  = dnet.getStasisLinkedServers().length;
        const stasisLimit = dnet.getStasisLinkLimit();
        const p6Raw       = ns.peek(6);
        const crackedList = (p6Raw === 'NULL PORT DATA') ? [] : JSON.parse(p6Raw);
        dnetData = {
            visible,
            cracked:      crackedList.length,
            stasisUsed,
            stasisLimit,
            instability:  instab.authenticationDurationMultiplier,
            timeoutChance: instab.authenticationTimeoutChance,
        };
    } catch (_) {}

    // Mutate sharedData in place so React's getData() always reads current values
    sharedData = {
        player, homeMax, homeUsed, running,
        sharePow, hwgwData, hacknetData, stale,
        farmMax, farmUsed, farmCount, farmLimit,
        targets, cycleStart, corpData, bbData,
        now: Date.now(), income, factionData, stockData,
        dnetData,
    };
}


// =============================================================================
// React component — reads sharedData, no NS calls
// =============================================================================

function Dashboard(props) {
    var ns       = props.ns;
    var getData  = props.getData;

    var stateArr = React.useState(0);
    var tick     = stateArr[0];
    var setTick  = stateArr[1];

    React.useEffect(function() {
        var id = window.setInterval(function() {
            setTick(function(t) { return t + 1; });  // pure React state update — no NS
        }, POLL_MS);
        return function() { window.clearInterval(id); };
    }, []);

    var d = getData();

    if (!d.player) {
        return e('div', { style: { color: C.dim, padding: '12px', fontFamily: 'monospace' } }, 'Initialising...');
    }

    return e('div', {
        style: {
            fontFamily: 'monospace', fontSize: '12px', color: C.text,
            background: C.bg, padding: '8px', minHeight: '100%', boxSizing: 'border-box',
        },
    }, [
        renderHeader(d, ns),
        renderFaction(d),
        renderRamRow(d),
        renderScripts(d),
        renderHWGW(d),
        renderHacknet(d),
        renderStocks(d),
        renderShare(d),
        d.dnetData ? renderDarknet(d)     : null,
        d.corpData ? renderCorp(d)        : null,
        d.bbData   ? renderBladeburner(d) : null,
        renderFooter(),
    ]);
}


// =============================================================================
// Header
// =============================================================================

function renderHeader(d, ns) {
    var tier   = d.homeMax >= 64 ? 3 : d.homeMax >= 32 ? 2 : d.homeMax >= 16 ? 1 : 0;
    var money  = d.player ? d.player.money : 0;
    var income = d.income ? d.income[0] : 0;
    var hack   = d.player && d.player.skills ? d.player.skills.hacking : 0;
    var ts     = new Date().toLocaleTimeString();

    return e('div', { key: 'hdr', style: { marginBottom: '6px' } }, [
        e('div', {
            key: 'title',
            style: {
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: '1px solid ' + C.border, paddingBottom: '4px', marginBottom: '4px',
            },
        }, [
            e('span', { key: 'l', style: { color: C.cyan, fontWeight: 'bold', fontSize: '13px' } }, 'PHLANXOS DASHBOARD'),
            e('span', { key: 'r', style: { color: C.dim } }, ts),
        ]),
        e('div', { key: 'stats', style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } }, [
            statChip('tier', 'T' + tier,          C.cyan),
            statChip('hack', hack,                 C.blue),
            statChip(CURRENCY,      fmtNum(money,  2), C.green),
            statChip(CURRENCY + '/s', fmtNum(income, 2), C.green),
        ]),
    ]);
}

function statChip(label, value, col) {
    return e('span', { key: label }, [
        e('span', { key: 'l', style: { color: C.dim } }, label + ' '),
        e('span', { key: 'v', style: { color: col } }, String(value)),
    ]);
}

function renderFaction(d) {
    var fd = d.factionData;
    if (!fd) return null;
    return e('div', {
        key: 'faction',
        style: {
            margin: '4px 0', background: C.surface,
            border: '1px solid ' + C.border, borderRadius: '4px', padding: '4px 6px',
            display: 'flex', gap: '16px', alignItems: 'center', fontSize: '11px', flexWrap: 'wrap',
        },
    }, [
        e('span', { key: 'n', style: { color: C.purple, fontWeight: 'bold', minWidth: '100px' } }, fd.name),
        statChip('rep',    fd.rep    !== null ? fmtNum(fd.rep, 0)      : '—', C.blue),
        statChip('favour', fd.favour !== null ? Math.floor(fd.favour)  : '—', C.cyan),
    ]);
}


// =============================================================================
// RAM bars
// =============================================================================

function renderRamRow(d) {
    var homePct = d.homeMax > 0 ? d.homeUsed / d.homeMax : 0;
    var farmPct = d.farmMax > 0 ? d.farmUsed / d.farmMax : 0;

    return e('div', {
        key: 'ram',
        style: {
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px',
            margin: '6px 0', background: C.surface,
            border: '1px solid ' + C.border, borderRadius: '4px', padding: '6px',
        },
    }, [
        ramPanel('HOME', d.homeUsed, d.homeMax, homePct, null),
        ramPanel('FARM', d.farmUsed, d.farmMax, farmPct, d.farmCount + '/' + d.farmLimit + ' svr'),
    ]);
}

function ramPanel(label, used, max, pct, sub) {
    var col  = pct > 0.90 ? C.red : pct > 0.65 ? C.yellow : C.blue;
    var pctS = (pct * 100).toFixed(0) + '%';
    return e('div', { key: label }, [
        e('div', {
            key: 'row',
            style: { display: 'flex', justifyContent: 'space-between', marginBottom: '3px' },
        }, [
            e('span', { key: 'lbl', style: { color: C.dim, fontSize: '11px' } }, label),
            e('span', { key: 'val', style: { color: col } },
                (used || 0).toFixed(0) + '/' + (max || 0).toFixed(0) + 'GB  ' + pctS + (sub ? '  ' + sub : '')),
        ]),
        e('div', {
            key: 'bar',
            style: { height: '5px', borderRadius: '2px', overflow: 'hidden', background: C.border },
        }, [
            e('div', { key: 'f', style: { width: (pct * 100) + '%', height: '100%', background: col, transition: 'width 0.3s' } }),
        ]),
    ]);
}


// =============================================================================
// Script controls
// =============================================================================

function renderScripts(d) {
    var active   = MANAGED.filter(function(m) { return  d.running.has(m.script); });
    var inactive = MANAGED.filter(function(m) { return !d.running.has(m.script); });

    var activeRows = active.map(function(m) { return scriptRowActive(m); });

    var inactiveGrid = inactive.length === 0 ? null :
        e('div', {
            key: 'inactive-grid',
            style: {
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '1px 4px',
                marginTop: active.length > 0 ? '5px' : '0',
                paddingTop: active.length > 0 ? '5px' : '0',
                borderTop: active.length > 0 ? '1px solid ' + C.border : 'none',
            },
        }, inactive.map(function(m) { return scriptChipInactive(m); }));

    return e('div', {
        key: 'scripts', style: panel(),
    }, [
        sectionHead('SCRIPTS  ' + active.length + ' running / ' + inactive.length + ' stopped'),
        e('div', { key: 'active-rows' }, activeRows),
        inactiveGrid,
    ]);
}

function scriptRowActive(m) {
    var onStop = function() { cmdQueue.push({ action: 'kill', script: m.script }); };
    var onLog  = function() { cmdQueue.push({ action: 'tail', script: m.script }); };
    return e('div', {
        key: m.script,
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' },
    }, [
        e('span', { key: 'dot',  style: { color: C.green, marginRight: '5px', fontSize: '10px' } }, '●'),
        e('span', { key: 'name', style: { flex: 1, color: C.text, fontSize: '11px' } }, m.label),
        e('button', { key: 'log',  onClick: onLog,  style: Object.assign({}, btnStyle(C.dim),  { marginRight: '3px' }) }, 'LOG'),
        e('button', { key: 'stop', onClick: onStop, style: btnStyle(C.red) }, 'STOP'),
    ]);
}

function scriptChipInactive(m) {
    var onClick = function() { cmdQueue.push({ action: 'run', script: m.script, args: m.args }); };
    return e('div', {
        key: m.script,
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1px 0' },
    }, [
        e('span', { key: 'name', style: { color: C.dim, fontSize: '10px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.label),
        e('button', { key: 'btn', onClick: onClick, style: btnStyle(C.dim) }, 'START'),
    ]);
}

function btnStyle(col) {
    return {
        background: 'transparent', color: col, border: '1px solid ' + col,
        borderRadius: '3px', padding: '0 4px', fontSize: '9px',
        cursor: 'pointer', lineHeight: '14px', minWidth: '34px', flexShrink: 0,
    };
}


// =============================================================================
// HWGW targets
// =============================================================================

function hwgwModeColor(mode) {
    if (mode === 'HACK') return C.green;
    if (mode === 'PREP') return C.yellow;
    if (mode === 'SKIP') return C.blue;
    if (mode === 'WAIT') return C.purple;
    return C.dim;
}

function hwgwThreadStr(entry) {
    var mode = entry.mode || '';
    if (mode === 'HACK' || mode === 'SKIP') {
        var parts = [];
        if (entry.H  ) parts.push('H:'  + entry.H);
        if (entry.WH ) parts.push('WH:' + entry.WH);
        if (entry.G  ) parts.push('G:'  + entry.G);
        if (entry.WG ) parts.push('WG:' + entry.WG);
        return parts.join(' ');
    }
    if (mode === 'PREP') {
        var parts = [];
        if (entry.G) parts.push('G:' + entry.G);
        if (entry.W) parts.push('W:' + entry.W);
        return parts.join(' ');
    }
    return '';
}

function hwgwRemain(entry, now) {
    var cycleEnd = entry.cycleEnd || 0;
    if (!cycleEnd) return '';
    var rem = Math.max(0, cycleEnd - now);
    if (rem < 1000) return 'done';
    return Math.floor(rem / 60000) + 'm' + Math.floor((rem % 60000) / 1000) + 's';
}

function renderHWGW(d) {
    var targetKeys = Object.keys(d.targets);

    var rows = targetKeys.length === 0
        ? [e('div', { key: 'none', style: { color: C.dim, fontSize: '11px' } },
            d.stale ? 'Port 1 stale — orchestrate not running?' : 'No active targets')]
        : targetKeys.map(function(host) {
            var entry   = d.targets[host];
            var mode    = entry.mode || 'PREP';
            var modeCol = hwgwModeColor(mode);
            var threads = hwgwThreadStr(entry);
            var remain  = hwgwRemain(entry, d.now);

            return e('div', {
                key: host,
                style: {
                    display: 'grid', gridTemplateColumns: '120px 1fr auto',
                    alignItems: 'center', gap: '6px', padding: '2px 0',
                    borderBottom: '1px solid ' + C.border, fontSize: '10px',
                },
            }, [
                e('span', { key: 'h',  style: { color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, host),
                e('span', { key: 'th', style: { color: C.dim } }, threads),
                e('div',  { key: 'r',  style: { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end' } }, [
                    e('span', { key: 'm', style: { color: modeCol, minWidth: '42px', textAlign: 'right', fontSize: '10px' } }, '[' + mode + ']'),
                    e('span', { key: 't', style: { color: C.dim, minWidth: '50px', textAlign: 'right' } }, remain),
                ]),
            ]);
        });

    return e('div', { key: 'hwgw', style: panel() }, [sectionHead('HWGW TARGETS  ' + targetKeys.length)].concat(rows));
}


// =============================================================================
// Hacknet
// =============================================================================

function renderHacknet(d) {
    var hn = d.hacknetData;
    var content;

    if (!hn) {
        content = e('span', { key: 'none', style: { color: C.dim, fontSize: '11px' } }, 'No data — hacknet-manager not running');
    } else if (hn.isServerMode) {
        content = e('div', { key: 'row', style: { display: 'flex', gap: '16px', fontSize: '11px', flexWrap: 'wrap' } }, [
            statChip('servers', hn.nodes,                                                          C.yellow),
            statChip('H/s',     fmtNum(hn.totalIncome, 1),                                        C.yellow),
            statChip('hashes',  (hn.hashes || 0).toFixed(0) + '/' + (hn.hashCapacity || 0).toFixed(0), C.purple),
        ]);
    } else {
        content = e('div', { key: 'row', style: { display: 'flex', gap: '16px', fontSize: '11px' } }, [
            statChip('nodes', hn.nodes,                  C.yellow),
            statChip('$/s',   fmtNum(hn.totalIncome, 2), C.yellow),
        ]);
    }

    return e('div', { key: 'hn', style: panel() }, [sectionHead('HACKNET'), content]);
}


// =============================================================================
// Share power
// =============================================================================

function renderShare(d) {
    var pow    = d.sharePow || 1;
    var pctStr = ((pow - 1) * 100).toFixed(1) + '% rep bonus';
    var col    = pow > 1.1 ? C.purple : pow > 1.01 ? C.blue : C.dim;

    return e('div', {
        key: 'share',
        style: Object.assign({}, panel(), { display: 'flex', gap: '16px', alignItems: 'center', fontSize: '11px' }),
    }, [
        sectionHead('SHARE'),
        e('span', { key: 'p', style: { color: col } }, pow.toFixed(3) + 'x'),
        e('span', { key: 's', style: { color: C.dim } }, pctStr),
    ]);
}


// =============================================================================
// Stocks
// =============================================================================

function renderStocks(d) {
    var sd = d.stockData;
    if (!sd) return null;
    if (sd.mode === 'NO_WSE' || sd.mode === 'NO_TIX') return null;

    var realisedCol   = sd.realised   >= 0 ? C.green : C.red;
    var unrealisedCol = sd.unrealised >= 0 ? C.green : C.red;
    var realisedStr   = (sd.realised   >= 0 ? '+' : '') + fmtMoney(sd.realised,   2);
    var unrealisedStr = (sd.unrealised >= 0 ? '+' : '') + fmtMoney(sd.unrealised, 2);

    return e('div', { key: 'stocks', style: panel() }, [
        sectionHead('STOCKS  ' + sd.mode + '  ' + sd.buys + 'B/' + sd.sells + 'S  open:' + sd.positions),
        e('div', { key: 'row', style: { display: 'flex', gap: '16px', fontSize: '11px', flexWrap: 'wrap' } }, [
            e('span', { key: 'r' }, [
                e('span', { key: 'l', style: { color: C.dim } }, 'realised '),
                e('span', { key: 'v', style: { color: realisedCol } }, realisedStr),
            ]),
            e('span', { key: 'u' }, [
                e('span', { key: 'l', style: { color: C.dim } }, 'unrealised '),
                e('span', { key: 'v', style: { color: unrealisedCol } }, unrealisedStr),
            ]),
            e('span', { key: 't' }, [
                e('span', { key: 'l', style: { color: C.dim } }, 'total '),
                e('span', { key: 'v', style: { color: (sd.realised + sd.unrealised) >= 0 ? C.green : C.red } },
                    ((sd.realised + sd.unrealised) >= 0 ? '+' : '') + fmtMoney(sd.realised + sd.unrealised, 2)),
            ]),
        ]),
    ]);
}


// =============================================================================
// Darknet
// =============================================================================

function renderDarknet(d) {
    var dn = d.dnetData;
    if (!dn) return null;

    var instabCol = dn.instability > 2.0 ? C.red : dn.instability > 1.2 ? C.yellow : C.green;
    var stasisCol = dn.stasisUsed >= dn.stasisLimit ? C.yellow : C.cyan;

    return e('div', { key: 'dnet', style: panel() }, [
        sectionHead('DARKNET'),
        e('div', { key: 'row', style: { display: 'flex', gap: '16px', fontSize: '11px', flexWrap: 'wrap' } }, [
            statChip('visible',  dn.visible,                                               C.blue),
            statChip('cracked',  dn.cracked,                                               C.green),
            statChip('stasis',   dn.stasisUsed + '/' + dn.stasisLimit,                    stasisCol),
            statChip('instab',   dn.instability.toFixed(2) + 'x',                         instabCol),
            statChip('timeout',  (dn.timeoutChance * 100).toFixed(1) + '%',               instabCol),
        ]),
    ]);
}


// =============================================================================
// Corporation
// =============================================================================

function renderCorp(d) {
    var cd = d.corpData;
    return e('div', { key: 'corp', style: panel() }, [
        sectionHead('CORPORATION'),
        e('div', { key: 'row', style: { display: 'flex', gap: '16px', fontSize: '11px', flexWrap: 'wrap' } }, [
            statChip('funds',  fmtMoney(cd.funds,   2), C.green),
            statChip('rev/s',  fmtMoney(cd.revenue, 2), C.green),
            statChip('divs',   cd.divs,                      C.cyan),
        ]),
    ]);
}


// =============================================================================
// Bladeburner
// =============================================================================

function renderBladeburner(d) {
    var bb = d.bbData;
    return e('div', { key: 'bb', style: panel() }, [
        sectionHead('BLADEBURNER'),
        e('div', { key: 'row', style: { display: 'flex', gap: '16px', fontSize: '11px', flexWrap: 'wrap' } }, [
            statChip('rank',   Math.floor(bb.rank), C.blue),
            statChip('SP',     bb.sp,               C.cyan),
            statChip('action', bb.action,           C.text),
        ]),
    ]);
}


// =============================================================================
// Footer
// =============================================================================

function renderFooter() {
    return e('div', {
        key: 'foot',
        style: {
            marginTop: '6px', paddingTop: '4px',
            borderTop: '1px solid ' + C.border,
            color: C.dim, fontSize: '10px',
            display: 'flex', justifyContent: 'space-between',
        },
    }, [
        e('span', { key: 'v' }, 'dashboard.js v' + VERSION),
        e('span', { key: 'h' }, 'bootstrap.js to restart all'),
    ]);
}


// =============================================================================
// Shared UI atoms
// =============================================================================

function sectionHead(title) {
    return e('div', {
        key: 'sh-' + title,
        style: { color: C.dim, fontSize: '10px', letterSpacing: '1px', marginBottom: '4px' },
    }, title);
}

function panel() {
    return {
        margin: '6px 0', background: C.surface,
        border: '1px solid ' + C.border, borderRadius: '4px', padding: '6px',
    };
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',  false],
        ['force', false],
    ]);

    if (flags.help) {
        ns.tprint('=== dashboard.js v' + VERSION + ' ===');
        ns.tprint('Purpose: Interactive React dashboard — live stats + START/STOP script controls.');
        ns.tprint('         Requires tier 2 (32GB home) unless --force is passed.');
        ns.tprint('Usage:   run /scripts/dashboard.js [--force]');
        return;
    }

    const homeRam = ns.getServerMaxRam('home');
    const tier    = homeRam >= 64 ? 3 : homeRam >= 32 ? 2 : homeRam >= 16 ? 1 : 0;

    if (!flags.force && tier < TIER_MIN) {
        ns.tprint('[DASHBOARD] Tier ' + tier + ' < ' + TIER_MIN + ' — run with --force to override');
        return;
    }

    ns.disableLog('ALL');
    ns.tprint('=== dashboard.js v' + VERSION + ' | tier ' + tier + ' ===');

    ns.ui.openTail();
    await ns.sleep(80);

    const [winW] = ns.ui.windowSize();
    ns.ui.resizeTail(TAIL_W, TAIL_H);
    ns.ui.moveTail(winW - TAIL_W - TAIL_MARGIN, TAIL_MARGIN);
    ns.ui.setTailTitle('PhlanxOS  |  v' + VERSION);

    // getData closure over sharedData — React reads this, no NS involved
    function getData() { return sharedData; }

    ns.printRaw(e(Dashboard, { ns, getData }));

    // Main poll loop — the ONLY place NS functions are called.
    // All NS calls here are in a valid async script context.
    while (true) {
        // Drain command queue from button clicks before collecting data
        while (cmdQueue.length > 0) {
            const cmd = cmdQueue.shift();
            try {
                if (cmd.action === 'kill') ns.scriptKill(cmd.script, 'home');
                if (cmd.action === 'run')  ns.exec(cmd.script, 'home', 1, ...(cmd.args || []));
                if (cmd.action === 'tail') ns.ui.openTail(cmd.script, 'home');
            } catch (_) {}
        }
        try { collectData(ns); } catch (_) {}
        await ns.sleep(POLL_MS);
    }
}
