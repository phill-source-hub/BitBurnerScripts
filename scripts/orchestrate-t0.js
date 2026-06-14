/**
 * orchestrate-t0.js
 * Version: 1.2.0
 *
 * Lightweight tier-0 grow/weaken dispatcher for 8GB home.
 *
 * Behaviour:
 *   Picks the best hackable target by maxMoney / weakenTime (no hackAnalyzeChance
 *   or hackAnalyze — too expensive for 8GB RAM budget).
 *
 *   Builds a thread pool each cycle from:
 *     1. Rooted worker servers with worker.js present (largest first)
 *     2. Home (always included at tier 0 — home IS a valid worker at this tier)
 *   Threads are distributed 60% grow / 40% weaken across the pool, filling
 *   largest servers first to minimise exec() calls.
 *
 *   Exits and relaunches orchestrate.js ONLY when tier rises above 0.
 *   Does NOT exit on worker-server appearance alone — orchestrate.js is ~10GB
 *   and won't fit on 8GB home.
 *
 *   Intentionally omits hackAnalyze*, growthAnalyze, weakenAnalyze.
 *   Full HWGW batch maths live in orchestrate.js (tier 1+).
 *
 * Changelog:
 *   v1.2.0 - Use worker servers when available. Build pool from workers + home,
 *            dispatch grow/weaken across pool. Adds ns.fileExists (~0.1GB).
 *   v1.1.0 - Fix handoff: only exit on tier rise, not worker-server availability.
 *   v1.0.0 - Initial version.
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

// Dispatch threadsNeeded threads of op across pool slots (mutates slot.threads).
// Fills largest slots first; stops when threadsNeeded met or pool exhausted.
function dispatch(ns, pool, op, threadsNeeded, target) {
    let remaining = threadsNeeded;
    for (const slot of pool) {
        if (remaining <= 0) break;
        const take = Math.min(slot.threads, remaining);
        if (take <= 0) continue;
        const pid = ns.exec(WORKER_SCRIPT, slot.host, take, target, op, '--delay', 0);
        if (pid === 0) log(ns, op + ' exec failed on ' + slot.host);
        else { slot.threads -= take; remaining -= take; }
    }
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([['help', false]]);

    if (flags.help) {
        ns.tprint('=== orchestrate-t0.js v1.2.0 ===');
        ns.tprint('Purpose: Lightweight tier-0 grow/weaken dispatcher for 8GB home.');
        ns.tprint('         Uses worker servers when available, falls back to home.');
        ns.tprint('         Relaunches orchestrate.js when home tier rises above 0.');
        ns.tprint('Usage:   run /scripts/orchestrate-t0.js');
        ns.tprint('Flags:');
        ns.tprint('  --help   Show this help and exit');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 1: cycle timing data for status.js');
        ns.tprint('  Reads  port 2: root events from auto-root.js (peek only)');
        return;
    }

    ns.tprint('=== orchestrate-t0.js v1.2.0 | TIER 0 early mode ===');
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

        // Build thread pool: worker servers (largest first) then home.
        // Worker servers have worker.js if auto-root SCPd it on root.
        const pool = [];
        for (const host of getWorkerServers(ns)) {
            if (!ns.fileExists(WORKER_SCRIPT, host)) continue;
            const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
            const t    = Math.floor(free / WORKER_RAM);
            if (t > 0) pool.push({ host, threads: t });
        }
        // Home is always a valid worker at tier 0
        const homeFree    = ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
        const homeThreads = Math.floor(homeFree / WORKER_RAM);
        if (homeThreads > 0) pool.push({ host: 'home', threads: homeThreads });

        const totalThreads = pool.reduce((s, p) => s + p.threads, 0);

        if (totalThreads < 1) {
            log(ns, 'No threads available — waiting');
            await ns.sleep(LOOP_SLEEP);
            continue;
        }

        const growThreads   = Math.max(1, Math.floor(totalThreads * GROW_RATIO));
        const weakenThreads = Math.max(1, totalThreads - growThreads);

        dispatch(ns, pool, 'grow',   growThreads,   target.host);
        dispatch(ns, pool, 'weaken', weakenThreads, target.host);

        const weakenTime       = ns.getWeakenTime(target.host);
        cycleEnds[target.host] = now + weakenTime + 500;

        clearPort(ns, PORT_STATUS);
        writePort(ns, PORT_STATUS, {
            cycleStart : now,
            targets    : { [target.host]: { weakenTime, mode: 'TIER0' } },
        });

        const workerCount = pool.filter(s => s.host !== 'home').length;
        log(ns, target.host + ' | G:' + growThreads + ' W:' + weakenThreads + ' | workers:' + workerCount + ' | ' + formatTime(weakenTime));

        await ns.sleep(Math.max(weakenTime + 500, LOOP_SLEEP));
    }
}
