/**
 * orchestrate-t0.js
 * Version: 1.0.0
 *
 * Lightweight tier-0 grow/weaken dispatcher for 8GB home.
 *
 * Behaviour:
 *   Runs entirely on home RAM. Picks the best hackable target by
 *   maxMoney / weakenTime (no hackAnalyzeChance or hackAnalyze — too expensive).
 *   Splits free home RAM 60% grow / 40% weaken each cycle and sleeps until
 *   the cycle completes.
 *
 *   Exits and relaunches orchestrate.js when:
 *     - Home RAM tier rises above 0 (home upgraded to 16GB+)
 *     - Worker servers become available (any rooted/purchased server appears)
 *
 *   Intentionally omits hackAnalyze*, growthAnalyze, weakenAnalyze to stay
 *   well under 4GB. Full HWGW batch maths live in orchestrate.js (tier 1+).
 *
 * Changelog:
 *   v1.1.0 - Fix handoff: only exit on tier rise, not on worker-server
 *            availability. orchestrate.js is ~10GB and won't fit on 8GB home
 *            even when worker servers exist. Stay in t0 mode until home upgrades.
 *   v1.0.0 - Initial version. Extracted from orchestrate.js to isolate
 *            tier-0 logic and avoid paying full HWGW RAM cost at reset.
 *
 * Flags:
 *   --help   Show version, usage, and flags then exit
 *
 * Ports:
 *   Writes port 1: basic timing data for status.js each cycle
 *   Reads  port 2: root events from auto-root.js (peek, non-consuming)
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    getAllServers,
    getWorkerServers,
    getRamTier,
    formatTime,
    writePort,
    readPort,
    clearPort,
    log,
} from '/scripts/lib-utils.js';

// --- Constants ---
const WORKER_SCRIPT = 'scripts/worker.js';
const FULL_SCRIPT   = 'scripts/orchestrate.js';
const WORKER_RAM    = 1.75;
const GROW_RATIO    = 0.60;
const LOOP_SLEEP    = 200;
const PORT_STATUS   = 1;
const PORT_AUTOROOT = 2;

// --- Inline helpers (cheap — no hackAnalyze*, growthAnalyze, weakenAnalyze) ---

function canHack(ns, host) {
    return ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(host);
}

// Simple scoring: maxMoney / weakenTime. Good enough for single-target tier 0.
function getBestTarget(ns) {
    const best = getAllServers(ns)
        .filter(h => h !== 'home')
        .filter(h => !h.startsWith('cloud-server'))
        .filter(h => ns.hasRootAccess(h))
        .filter(h => canHack(ns, h))
        .filter(h => ns.getServerMaxMoney(h) > 0)
        .map(h => ({ host: h, score: ns.getServerMaxMoney(h) / ns.getWeakenTime(h) }))
        .sort((a, b) => b.score - a.score)[0];
    return best || null;
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([['help', false]]);

    if (flags.help) {
        ns.tprint('=== orchestrate-t0.js v1.1.0 ===');
        ns.tprint('Purpose: Lightweight tier-0 grow/weaken dispatcher for 8GB home.');
        ns.tprint('         Automatically relaunches orchestrate.js when tier rises or');
        ns.tprint('         worker servers become available.');
        ns.tprint('Usage:   run /scripts/orchestrate-t0.js');
        ns.tprint('Flags:');
        ns.tprint('  --help   Show this help and exit');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 1: cycle timing data for status.js');
        ns.tprint('  Reads  port 2: root events from auto-root.js (peek only)');
        return;
    }

    ns.tprint('=== orchestrate-t0.js v1.1.0 | TIER 0 early mode ===');
    ns.disableLog('ALL');

    clearPort(ns, PORT_STATUS);
    ns.atExit(() => clearPort(ns, PORT_STATUS));

    const cycleEnds = {};

    while (true) {
        // Tier rose — hand off to full HWGW orchestrate.
        // Do NOT hand off on worker-server availability alone: orchestrate.js is
        // ~10GB and won't fit on 8GB home. Stay in t0 mode until home is upgraded.
        if (getRamTier(ns) > 0) {
            ns.tprint('[T0] Tier risen — launching ' + FULL_SCRIPT);
            ns.exec(FULL_SCRIPT, 'home', 1);
            return;
        }

        // Peek root events (non-consuming — for log visibility only)
        const rootEvent = readPort(ns, PORT_AUTOROOT);
        if (rootEvent) {
            log(ns, 'Root event: ' + rootEvent.host);
        }

        // Pick best single target
        const target = getBestTarget(ns);
        if (!target) {
            log(ns, 'No valid targets — waiting');
            await ns.sleep(5000);
            continue;
        }

        // Skip if cycle still in flight for this target
        const now = Date.now();
        if (cycleEnds[target.host] && cycleEnds[target.host] > now) {
            const remaining = cycleEnds[target.host] - now;
            log(ns, 'Cycle in flight for ' + target.host + ' — ' + formatTime(remaining) + ' remaining');
            await ns.sleep(Math.max(remaining, LOOP_SLEEP));
            continue;
        }

        // Free RAM available for worker threads (getServerUsedRam includes self)
        const freeRam = ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
        const threads = Math.floor(freeRam / WORKER_RAM);

        if (threads < 1) {
            log(ns, 'Insufficient home RAM — waiting');
            await ns.sleep(LOOP_SLEEP);
            continue;
        }

        const growThreads   = Math.max(1, Math.floor(threads * GROW_RATIO));
        const weakenThreads = Math.max(1, threads - growThreads);

        const growPid   = ns.exec(WORKER_SCRIPT, 'home', growThreads,   target.host, 'grow',   '--delay', 0);
        const weakenPid = ns.exec(WORKER_SCRIPT, 'home', weakenThreads, target.host, 'weaken', '--delay', 0);

        if (growPid   === 0) log(ns, 'grow exec failed on home');
        if (weakenPid === 0) log(ns, 'weaken exec failed on home');

        const weakenTime       = ns.getWeakenTime(target.host);
        cycleEnds[target.host] = now + weakenTime + 500;

        clearPort(ns, PORT_STATUS);
        writePort(ns, PORT_STATUS, {
            cycleStart : now,
            targets    : { [target.host]: { weakenTime, mode: 'TIER0' } },
        });

        log(ns, target.host + ' | G:' + growThreads + ' W:' + weakenThreads + ' | ' + formatTime(weakenTime));

        await ns.sleep(Math.max(weakenTime + 500, LOOP_SLEEP));
    }
}
