/**
 * status.js
 * Version: 3.2.1
 *
 * Live operations dashboard for the PhlanxOS hacking network.
 * Renders a full-colour ANSI display in the tail window, refreshing every 5s.
 * Auto-sizes and positions the window on launch.
 *
 * Layout:
 *   - Header: title, timestamp
 *   - STATUS: hack level, money, income, home RAM, rooted servers
 *   - FARM RAM: cloud worker pool used/free with utilisation bar
 *   - THREADS: weaken/grow/hack counts and mini-bars on one line
 *   - TARGETS: 2 lines per target (hostname+mode+countdown / money+sec+threads)
 *   - HACKNET: single line - nodes, production, avg stats
 *   - SCRIPTS: inline badges - RUNNING green / STOPPED red or dim
 *   - Footer: version
 *
 * Countdown timers:
 *   Reads port 1 (written by orchestrate.js) using ns.peek() - non-consuming.
 *   Payload: { cycleStart, targets: { [host]: { weakenTime, mode } } }
 *   Remaining = weakenTime - (now - cycleStart), clamped to zero.
 *   Falls back to '--:--' if port empty, unparseable, or stale (>2min).
 *
 * Changelog:
 *   v3.2.1 - Adapted from reference v3.2.0 for PhlanxOS single-worker.js
 *            architecture. Thread counting uses worker.js args[1] for op type.
 *            Mode sourced from port 1 cycleData (not isPrepped NS call).
 *            Port 2 root count uses NS scan (auto-root port 2 is per-event).
 *            Hacknet uses our port 3 format {nodes, totalIncome, totalSpent}
 *            plus NS fallback for avg stats. No port 5 / upgrade progress.
 *   v3.2.0 - Port IPC phase 2: hacknet/upgrade state from ports 3/5.
 *   v3.1.0 - Port IPC phase 1: root state from port 2.
 *   v3.0.0 - Compressed layout, ANSI colour, ASCII bars, auto-positioned window.
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --help    Show version, usage, and flags then exit
 *   --force   Run regardless of RAM tier (default: requires tier 3 / 64GB home)
 *
 * Ports:
 *   Reads port 1: orchestrate cycle timing (peek, non-consuming)
 *   Reads port 3: hacknet stats (peek, non-consuming)
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    getAllServers,
    getRamTier,
    formatTime,
    readPort,
} from '/scripts/lib-utils.js';

// --- Version ---
const VERSION = '3.2.1';

// --- Worker script (single file, op type in args[1]) ---
const WORKER_SCRIPT = 'scripts/worker.js';

// --- Port constants ---
const PORT_STATUS  = 1;
const PORT_HACKNET = 3;
const STALE_MS     = 2 * 60 * 1000;

// --- Refresh / tier ---
const REFRESH_MS = 5000;
const TIER_MIN   = 3;

// --- Tail window ---
const TAIL_WIDTH  = 700;
const TAIL_HEIGHT = 620;
const TAIL_MARGIN = 20;
const TAIL_X = () => (globalThis['window'].innerWidth - TAIL_WIDTH - TAIL_MARGIN);
const TAIL_Y = TAIL_MARGIN;

// --- ANSI colour codes ---
const R   = '[0m';
const CY  = '[36m';
const GR  = '[32m';
const YE  = '[33m';
const RE  = '[31m';
const MA  = '[35m';
const BL  = '[34m';
const WH  = '[37m';
const DIM = '[2m';

// --- Hacknet maxes (not available via API) ---
const HN_MAX_LEVEL = 200;
const HN_MAX_RAM   = 64;
const HN_MAX_CORES = 16;

// --- Scripts to monitor ---
const WATCHED_SCRIPTS = [
    { file: 'scripts/orchestrate.js',     critical: true  },
    { file: 'scripts/orchestrate-t0.js',  critical: false },
    { file: 'scripts/auto-root.js',       critical: false },
    { file: 'scripts/hacknet-manager.js', critical: false },
    { file: 'scripts/buy-servers.js',     critical: false },
    { file: 'scripts/upgrade-servers.js', critical: false },
];


// =============================================================================
// Display helpers
// =============================================================================

function bar(value, max, width, fillCol) {
    if (width  === undefined) width   = 20;
    if (fillCol === undefined) fillCol = GR;
    const pct    = max > 0 ? Math.min(1, value / max) : 0;
    const filled = Math.round(pct * width);
    const empty  = width - filled;
    return DIM + '[' + fillCol + '█'.repeat(filled) + DIM + '░'.repeat(empty) + DIM + ']' + R;
}

function miniBar(value, max, width, fillCol) {
    if (width   === undefined) width   = 8;
    if (fillCol === undefined) fillCol = GR;
    const pct    = max > 0 ? Math.min(1, value / max) : 0;
    const filled = Math.round(pct * width);
    const empty  = width - filled;
    return fillCol + '█'.repeat(filled) + DIM + '░'.repeat(empty) + R;
}

function countdownBar(elapsed, total, width, fillCol) {
    if (width   === undefined) width   = 14;
    if (fillCol === undefined) fillCol = CY;
    const pct    = total > 0 ? Math.min(1, elapsed / total) : 0;
    const filled = Math.round(pct * width);
    const empty  = width - filled;
    return DIM + '[' + fillCol + '█'.repeat(filled) + DIM + '░'.repeat(empty) + DIM + ']' + R;
}

function section(ns, title, col) {
    ns.print(DIM + '─'.repeat(64) + R);
    ns.print(col + title + R);
}

function pctCol(pct, warnAt, critAt) {
    if (warnAt === undefined) warnAt = 60;
    if (critAt === undefined) critAt = 90;
    if (pct >= critAt) return RE;
    if (pct >= warnAt) return YE;
    return GR;
}

function secCol(delta) {
    if (delta > 5) return RE;
    if (delta > 1) return YE;
    return GR;
}


// =============================================================================
// Port readers
// =============================================================================

function readCycleData(ns) {
    const raw = ns.peek(PORT_STATUS);
    if (raw === 'NULL PORT DATA') return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed || typeof parsed.cycleStart !== 'number') return null;
    if (Date.now() - parsed.cycleStart > STALE_MS) return null;
    return parsed;
}

function readHacknetData(ns) {
    const raw = ns.peek(PORT_HACKNET);
    if (raw === 'NULL PORT DATA') return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
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
        ns.tprint('=== status.js v' + VERSION + ' ===');
        ns.tprint('Purpose: Live ANSI dashboard for orchestrate, hacknet, and server state.');
        ns.tprint('         Requires tier 3 (64GB home) unless --force is passed.');
        ns.tprint('Usage:   run /scripts/status.js [--force]');
        ns.tprint('Flags:');
        ns.tprint('  --help    Show this help and exit');
        ns.tprint('  --force   Run dashboard regardless of RAM tier');
        ns.tprint('Ports:');
        ns.tprint('  Reads port 1: orchestrate cycle data (non-consuming)');
        ns.tprint('  Reads port 3: hacknet stats (non-consuming)');
        return;
    }

    ns.tprint('=== status.js v' + VERSION + ' | force:' + flags.force + ' ===');
    ns.disableLog('ALL');

    if (!flags.force && getRamTier(ns) < TIER_MIN) {
        ns.tprint('[STATUS] Tier < ' + TIER_MIN + ' and --force not set -- exiting to conserve RAM');
        return;
    }

    ns.ui.openTail();
    await ns.sleep(100);
    ns.ui.resizeTail(TAIL_WIDTH, TAIL_HEIGHT);
    ns.ui.moveTail(TAIL_X(), TAIL_Y);
    ns.ui.setTailTitle('PhlanxOS Operations Dashboard');

    while (true) {
        ns.clearLog();

        const now = Date.now();

        // Gather: cycle data from port 1
        const cycleData   = readCycleData(ns);
        const hacknetData = readHacknetData(ns);

        // Gather: player stats
        const player      = ns.getPlayer();
        const hackLevel   = player.skills.hacking;
        const playerMoney = player.money;
        const income      = ns.getTotalScriptIncome();

        // Gather: home RAM
        const homeMax  = ns.getServerMaxRam('home');
        const homeUsed = ns.getServerUsedRam('home');
        const homeFree = homeMax - homeUsed;

        // Gather: thread counts and rooted server count
        const allServers       = getAllServers(ns);
        let   rootedCount      = 0;
        let   totalWeaken      = 0;
        let   totalGrow        = 0;
        let   totalHack        = 0;
        const targetThreads    = {};

        for (const host of allServers) {
            if (ns.hasRootAccess(host)) rootedCount++;
            for (const proc of ns.ps(host)) {
                const fname = proc.filename.replace(/^\//, '');
                if (fname !== WORKER_SCRIPT) continue;
                const target = proc.args[0];
                const op     = proc.args[1];
                if (!target || typeof target !== 'string') continue;
                if (!targetThreads[target]) targetThreads[target] = { weaken: 0, grow: 0, hack: 0 };
                if      (op === 'weaken') { totalWeaken += proc.threads; targetThreads[target].weaken += proc.threads; }
                else if (op === 'grow')   { totalGrow   += proc.threads; targetThreads[target].grow   += proc.threads; }
                else if (op === 'hack')   { totalHack   += proc.threads; targetThreads[target].hack   += proc.threads; }
            }
        }

        const totalThreads  = totalWeaken + totalGrow + totalHack;
        const activeTargets = Object.keys(targetThreads);

        // Gather: cloud farm RAM
        const cloudNames = ns.cloud.getServerNames();
        const cloudLimit = ns.cloud.getServerLimit();
        let cloudRamUsed = 0;
        let cloudRamMax  = 0;
        for (const h of cloudNames) {
            cloudRamMax  += ns.getServerMaxRam(h);
            cloudRamUsed += ns.getServerUsedRam(h);
        }
        const cloudPct = cloudRamMax > 0 ? (cloudRamUsed / cloudRamMax) * 100 : 0;

        // Gather: hacknet stats (port 3 + NS for avg stats)
        const hnPortNodes  = hacknetData ? hacknetData.nodes       : null;
        const hnPortIncome = hacknetData ? hacknetData.totalIncome : null;
        const hnCount      = hnPortNodes !== null ? hnPortNodes : ns.hacknet.numNodes();
        const hnMaxNodes   = hnCount > 0 ? ns.hacknet.maxNumNodes() : 0;
        let   hnIncome     = hnPortIncome !== null ? hnPortIncome : 0;
        let   hnAvgLevel   = 0;
        let   hnAvgRam     = 0;
        let   hnAvgCores   = 0;
        if (hnCount > 0) {
            let lvl = 0, ram = 0, cores = 0, prod = 0;
            for (let i = 0; i < hnCount; i++) {
                const s = ns.hacknet.getNodeStats(i);
                lvl += s.level; ram += s.ram; cores += s.cores; prod += s.production;
            }
            hnAvgLevel = Math.round(lvl   / hnCount);
            hnAvgRam   = Math.round(ram   / hnCount);
            hnAvgCores = Math.round(cores / hnCount);
            if (hnPortIncome === null) hnIncome = prod;
        }

        // Gather: script health
        const homeProcs    = ns.ps('home').map(p => p.filename.replace(/^\//, ''));
        const scriptHealth = WATCHED_SCRIPTS.map(s => ({ ...s, running: homeProcs.includes(s.file) }));


        // =====================================================================
        // RENDER
        // =====================================================================

        ns.print(CY + '  PHLANXOS OPS' + R + '  ' + DIM + new Date().toLocaleTimeString() + '  refresh:' + (REFRESH_MS / 1000) + 's' + R);

        // STATUS
        section(ns, '  STATUS', CY);
        ns.print(
            '  ' + DIM + 'hack' + R + ' ' + YE + hackLevel + R +
            '  ' + DIM + 'money' + R + ' ' + GR + '$' + ns.format.number(playerMoney, '0.00a') + R +
            '  ' + DIM + 'income' + R + ' ' + GR + '$' + ns.format.number(income[0], '0.00a') + '/s' + R +
            '  ' + DIM + 'rooted' + R + ' ' + WH + rootedCount + '/' + allServers.length + R
        );
        ns.print(
            '  ' + DIM + 'home' + R + ' ' + BL + homeFree.toFixed(1) + 'GB free / ' + homeMax + 'GB' + R +
            '  ' + bar(homeUsed, homeMax, 14, pctCol((homeUsed / homeMax) * 100))
        );

        // FARM RAM
        section(ns, '  FARM RAM', BL);
        if (cloudNames.length === 0) {
            ns.print('  ' + DIM + 'No cloud servers purchased' + R);
        } else {
            ns.print(
                '  ' + DIM + cloudNames.length + '/' + cloudLimit + ' servers' + R +
                '  ' + BL + cloudRamUsed.toFixed(0) + 'GB / ' + cloudRamMax.toFixed(0) + 'GB' + R +
                '  ' + bar(cloudRamUsed, cloudRamMax, 20, pctCol(cloudPct)) +
                '  ' + pctCol(cloudPct) + cloudPct.toFixed(1) + '%' + R
            );
        }

        // THREADS
        section(ns, '  THREADS', MA);
        if (totalThreads === 0) {
            ns.print('  ' + DIM + 'No worker threads active' + R);
        } else {
            const wPct = (totalWeaken / totalThreads) * 100;
            const gPct = (totalGrow   / totalThreads) * 100;
            const hPct = (totalHack   / totalThreads) * 100;
            ns.print(
                '  ' + CY + 'W' + R + ' ' + String(totalWeaken).padStart(4) + ' ' + miniBar(totalWeaken, totalThreads, 8, CY) + ' ' + CY + wPct.toFixed(0) + '%' + R +
                '   ' + YE + 'G' + R + ' ' + String(totalGrow).padStart(4)   + ' ' + miniBar(totalGrow,   totalThreads, 8, YE) + ' ' + YE + gPct.toFixed(0) + '%' + R +
                '   ' + RE + 'H' + R + ' ' + String(totalHack).padStart(4)   + ' ' + miniBar(totalHack,   totalThreads, 8, RE) + ' ' + RE + hPct.toFixed(0) + '%' + R +
                '   ' + DIM + 'total' + R + ' ' + WH + totalThreads + R
            );
        }

        // TARGETS
        section(ns, '  TARGETS', GR);
        if (activeTargets.length === 0) {
            ns.print('  ' + DIM + 'No active targets -- orchestrate may not be running' + R);
        } else {
            for (const t of activeTargets) {
                const tc          = targetThreads[t];
                const curMoney    = ns.getServerMoneyAvailable(t);
                const maxMoney    = ns.getServerMaxMoney(t);
                const security    = ns.getServerSecurityLevel(t);
                const minSecurity = ns.getServerMinSecurityLevel(t);
                const delta       = security - minSecurity;
                const moneyPct    = maxMoney > 0 ? (curMoney / maxMoney) * 100 : 0;

                const entry   = cycleData && cycleData.targets ? cycleData.targets[t] : null;
                const mode    = entry ? entry.mode : ((delta <= 1 && moneyPct >= 99) ? 'HACK' : 'PREP');
                const modeCol = mode === 'HACK' ? GR : (mode === 'TIER0' ? CY : YE);

                const elapsed   = cycleData ? now - cycleData.cycleStart : 0;
                const totalTime = entry ? entry.weakenTime : 0;
                const remainMs  = Math.max(0, totalTime - elapsed);
                const remaining = !entry ? '--:--' : (remainMs === 0 ? 'done' : formatTime(remainMs));
                const cdBar     = totalTime > 0
                    ? countdownBar(elapsed, totalTime, 14, modeCol)
                    : DIM + '[--------------]' + R;

                ns.print(
                    '  ' + WH + t + R +
                    '  ' + modeCol + '[' + mode + ']' + R +
                    '  ' + cdBar + '  ' + modeCol + remaining + R
                );
                ns.print(
                    '  ' + DIM + '$' + R + ns.format.number(curMoney, '0.0a') + DIM + '/$' + R + ns.format.number(maxMoney, '0.0a') +
                    ' ' + bar(curMoney, maxMoney, 12, GR) + ' ' + GR + moneyPct.toFixed(0) + '%' + R +
                    '  ' + DIM + 'sec' + R + secCol(delta) + security.toFixed(1) + R + DIM + '/' + R + minSecurity.toFixed(1) + DIM + '+' + R + secCol(delta) + delta.toFixed(1) + R +
                    '  ' + CY + 'W:' + tc.weaken + R + ' ' + YE + 'G:' + tc.grow + R + ' ' + RE + 'H:' + tc.hack + R
                );
            }
        }

        // HACKNET
        section(ns, '  HACKNET', YE);
        if (hnCount === 0) {
            ns.print('  ' + DIM + 'No hacknet nodes owned' + R);
        } else {
            ns.print(
                '  ' + WH + hnCount + '/' + hnMaxNodes + R + ' ' + DIM + 'nodes' + R +
                '  ' + YE + '$' + ns.format.number(hnIncome, '0.00a') + '/s' + R +
                '  ' + DIM + 'lvl' + R + WH + hnAvgLevel + '/' + HN_MAX_LEVEL + R +
                '  ' + DIM + 'ram' + R + WH + hnAvgRam + '/' + HN_MAX_RAM + 'GB' + R +
                '  ' + DIM + 'cores' + R + WH + hnAvgCores + '/' + HN_MAX_CORES + R
            );
        }

        // SCRIPTS
        section(ns, '  SCRIPTS', WH);
        const badges = scriptHealth.map(s => {
            const name = s.file.replace('scripts/', '').replace('.js', '');
            if (s.running)  return GR + '[RUN]' + R + WH + name + R;
            if (s.critical) return RE + '[STP]' + R + WH + name + R;
            return DIM + '[stp]' + name + R;
        });
        ns.print('  ' + badges.slice(0, 3).join('  '));
        if (badges.length > 3) ns.print('  ' + badges.slice(3).join('  '));

        // Footer
        ns.print(DIM + '─'.repeat(64) + R);
        ns.print(DIM + '  status.js v' + VERSION + '  |  run /scripts/status.js --force' + R);

        await ns.sleep(REFRESH_MS);
    }
}
