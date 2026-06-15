/**
 * dashboard.js
 * Version: 1.4.0
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

const VERSION    = '1.4.0';
const POLL_MS    = 2000;
const STALE_MS   = 2 * 60 * 1000;
const TIER_MIN   = 2;

const TAIL_W      = 680;
const TAIL_H      = 820;
const TAIL_MARGIN = 10;

const MANAGED = [
    { label: 'Orchestrate',   script: 'scripts/orchestrate.js',     args: [] },
    { label: 'Auto-Root',     script: 'scripts/auto-root.js',       args: ['--watch'] },
    { label: 'Buy Servers',   script: 'scripts/buy-servers.js',     args: [] },
    { label: 'Upg Servers',   script: 'scripts/upgrade-servers.js', args: [] },
    { label: 'Hacknet',       script: 'scripts/hacknet-manager.js', args: [] },
    { label: 'Share Mgr',     script: 'scripts/share-manager.js',   args: [] },
    { label: 'Contracts',     script: 'scripts/contracts.js',       args: [] },
    { label: 'Singularity',   script: 'scripts/singularity.js',     args: [] },
    { label: 'Stocks',        script: 'scripts/stocks.js',          args: [] },
    { label: 'Gang',          script: 'scripts/gang.js',            args: [] },
    { label: 'Sleeve',        script: 'scripts/sleeve.js',          args: [] },
    { label: 'Bladeburner',   script: 'scripts/bladeburner.js',     args: [] },
    { label: 'Corporation',   script: 'scripts/corporation.js',     args: [] },
    { label: 'Grafting',      script: 'scripts/grafting.js',        args: [] },
    { label: 'Go',            script: 'scripts/go.js',              args: [] },
    { label: 'Stanek',        script: 'scripts/stanek.js',          args: [] },
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
    now: Date.now(), income: [0, 0],
};

// Single shared reference; main() mutates this each poll cycle.
// React reads it on its own tick — no NS calls in React context.
let sharedData = Object.assign({}, INIT_DATA);

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

    // Mutate sharedData in place so React's getData() always reads current values
    sharedData = {
        player, homeMax, homeUsed, running,
        sharePow, hwgwData, hacknetData, stale,
        farmMax, farmUsed, farmCount, farmLimit,
        targets, cycleStart, corpData, bbData,
        now: Date.now(), income,
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
        renderRamRow(d),
        renderScripts(d, ns),
        renderHWGW(d),
        renderHacknet(d),
        renderShare(d),
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
            statChip('$',    fmtNum(money,  2),    C.green),
            statChip('/s',   fmtNum(income, 2),    C.green),
        ]),
    ]);
}

function statChip(label, value, col) {
    return e('span', { key: label }, [
        e('span', { key: 'l', style: { color: C.dim } }, label + ' '),
        e('span', { key: 'v', style: { color: col } }, String(value)),
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

function renderScripts(d, ns) {
    var active   = MANAGED.filter(function(m) { return  d.running.has(m.script); });
    var inactive = MANAGED.filter(function(m) { return !d.running.has(m.script); });

    var activeRows = active.map(function(m) { return scriptRowActive(m, ns); });

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
        }, inactive.map(function(m) { return scriptChipInactive(m, ns); }));

    return e('div', {
        key: 'scripts', style: panel(),
    }, [
        sectionHead('SCRIPTS  ' + active.length + ' running / ' + inactive.length + ' stopped'),
        e('div', { key: 'active-rows' }, activeRows),
        inactiveGrid,
    ]);
}

function scriptRowActive(m, ns) {
    var onClick = function() { ns.scriptKill(m.script, 'home'); };
    return e('div', {
        key: m.script,
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' },
    }, [
        e('span', { key: 'dot',  style: { color: C.green, marginRight: '5px', fontSize: '10px' } }, '●'),
        e('span', { key: 'name', style: { flex: 1, color: C.text, fontSize: '11px' } }, m.label),
        e('button', { key: 'btn', onClick: onClick, style: btnStyle(C.red) }, 'STOP'),
    ]);
}

function scriptChipInactive(m, ns) {
    var onClick = function() { ns.run(m.script, 1, ...m.args); };
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

function renderHWGW(d) {
    var targetKeys = Object.keys(d.targets);

    var rows = targetKeys.length === 0
        ? [e('div', { key: 'none', style: { color: C.dim, fontSize: '11px' } },
            d.stale ? 'Port 1 stale — orchestrate not running?' : 'No active targets')]
        : targetKeys.map(function(host) {
            var entry      = d.targets[host];
            var mode       = entry.mode || 'PREP';
            var weakenTime = entry.weakenTime || 0;
            var elapsed    = d.now - d.cycleStart;
            var remainMs   = Math.max(0, weakenTime - elapsed);
            var modeCol    = mode === 'HACK' ? C.green : mode === 'TIER0' ? C.cyan : C.yellow;
            var remainS    = remainMs < 1000 ? 'done'
                : Math.floor(remainMs / 60000) + 'm ' + Math.floor((remainMs % 60000) / 1000) + 's';

            return e('div', {
                key: host,
                style: {
                    display: 'grid', gridTemplateColumns: '1fr auto auto',
                    alignItems: 'center', gap: '6px', padding: '2px 0',
                    borderBottom: '1px solid ' + C.border, fontSize: '11px',
                },
            }, [
                e('span', { key: 'h', style: { color: C.text } }, host),
                e('span', { key: 'm', style: { color: modeCol, minWidth: '40px', textAlign: 'right' } }, '[' + mode + ']'),
                e('span', { key: 't', style: { color: C.dim, minWidth: '55px', textAlign: 'right' } }, remainS),
            ]);
        });

    return e('div', { key: 'hwgw', style: panel() }, [sectionHead('HWGW TARGETS')].concat(rows));
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
// Corporation
// =============================================================================

function renderCorp(d) {
    var cd = d.corpData;
    return e('div', { key: 'corp', style: panel() }, [
        sectionHead('CORPORATION'),
        e('div', { key: 'row', style: { display: 'flex', gap: '16px', fontSize: '11px', flexWrap: 'wrap' } }, [
            statChip('funds',  '$' + fmtNum(cd.funds,   2), C.green),
            statChip('rev/s',  '$' + fmtNum(cd.revenue, 2), C.green),
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
        try { collectData(ns); } catch (_) {}
        await ns.sleep(POLL_MS);
    }
}
