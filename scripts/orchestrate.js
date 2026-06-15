/**
 * orchestrate.js
 * Version: 1.5.0
 *
 * Tier-aware HWGW batch scheduler and early-game grow/weaken dispatcher.
 *
 * Behaviour:
 *   Detects home RAM tier on startup and each cycle. Operates in two modes:
 *
 *   Tier 0 (8GB home — early mode):
 *     Runs entirely on home. Calculates free home RAM after own script cost.
 *     Dispatches grow (60%) and weaken (40%) threads on home only.
 *     Single best target only. Each cycle checks for worker servers — when
 *     found, shifts threads there. Each cycle checks RAM tier — when risen,
 *     restarts self in full mode and exits.
 *
 *   Tier 1+ (full HWGW mode):
 *     Multi-target (up to MAX_TARGETS). Workers run on purchased/rooted
 *     servers only — home is never used as a worker host.
 *     PREP mode: grow + weaken until isPrepped() (sec <= min+1, money >= 99%).
 *     HACK mode: HWGW batches with precise landing delays:
 *       H  lands at t+0, WH at t+LAND_SPACING, G at t+2*LAND_SPACING,
 *       WG at t+3*LAND_SPACING.
 *     calcBatchThreads: uses ns.formulas.hacking when Formulas.exe is present
 *       for exact grow thread counts (no binary search). Falls back to binary
 *       search over growthAnalyze when Formulas.exe is absent.
 *     calcPrepThreads: Phase A (weaken-only when secDelta > 2) /
 *                      Phase B (grow + weaken when security near minimum).
 *                      Uses formulas for exact grow threads when available.
 *     Phase 2: round-robin overflow batches across all prepped targets.
 *     Cycle-aware sleep: wakes at nearest cycleEnd timestamp.
 *     hackMode Set: targets receiving HACK are never given PREP on top.
 *     activePrepTarget: persists across cycles, prevents mid-prep switching.
 *     Port 2: peeked each cycle for new root events from auto-root.js.
 *     Port 1: written each cycle with timing data for status.js.
 *
 * Formulas integration (v1.5.0):
 *   Checks for Formulas.exe at startup and each cycle. When present:
 *   - calcBatchThreads uses formulas.hacking.growThreads() with a mocked
 *     post-hack server object for exact grow thread counts per steal fraction.
 *   - calcPrepThreads uses formulas.hacking.growThreads() for exact prep grow counts.
 *   - Binary search is replaced with a direct scan over steal fractions.
 *   Uses bracket notation (ns['formulas']) to avoid static RAM cost when
 *   Formulas.exe is absent — the static scanner does not see bracket access.
 *
 * Changelog:
 *   v1.6.0 - Ladder mode: fixed target progression until --ladder-threads capacity reached.
 *            activePrepTarget now protected from mid-PREP eviction — only switches when
 *            target is prepped, gone, or unhackable (not when new server ranks higher).
 *            In dynamic mode, activePrepTarget preserved even if pushed outside top-N.
 *   v1.5.0 - Add Formulas.exe integration. When present, calcBatchThreads uses
 *            ns.formulas.hacking.growThreads() + hackPercent() for exact thread
 *            counts, replacing binary search over growthAnalyze. calcPrepThreads
 *            similarly uses formulas for grow. Falls back to v1.4.0 behaviour
 *            when Formulas.exe absent. Bracket notation used throughout to keep
 *            static RAM cost unchanged.
 *   v1.4.0 - Orchestrate now owns companion launch (auto-root, buy-servers).
 *            Bootstrap can't launch them at tier 1 (RAM too tight while bootstrap
 *            is resident). Orchestrate waits 1s for bootstrap to exit, launches
 *            auto-root (single pass), waits 10s for it to finish, then buy-servers.
 *            Adds ns.isRunning to prevent duplicate launches on orchestrate restart.
 *   v1.3.0 - Add back scpWorker in runFullMode only. tier 0 logic removed to
 *            orchestrate-t0.js; this file only runs at tier 1+ (16GB home).
 *   v1.2.0 - Inline getRankedTargets, isPrepped, canHack (removed from lib-utils).
 *            hackAnalyzeChance + hackAnalyze now only cost this script, not all
 *            lib-utils importers.
 *   v1.1.0 - Remove ns.scp from orchestrate. Worker pre-copied by bootstrap
 *            and auto-root. Pool built via ns.fileExists check instead.
 *   v1.0.0 - Initial version. Clean rewrite of v2.9.1 reference.
 *            Single worker.js replaces three-file worker model.
 *
 * Flags:
 *   --help   Show version, usage, and flags then exit
 *
 * Ports:
 *   Writes port 1: JSON cycle timing data for status.js
 *   Reads  port 2: New root events from auto-root.js (peek, non-consuming)
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    getAllServers,
    getWorkerServers,
    formatTime,
    getRamTier,
    writePort,
    readPort,
    clearPort,
    log,
} from '/scripts/lib-utils.js';

// --- Inlined from lib-utils: these use expensive NS calls (hackAnalyzeChance,
//     hackAnalyze, growthAnalyze) — isolated here so only orchestrate pays. ---

function canHack(ns, host) {
    return ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(host);
}

function getRankedTargets(ns) {
    return getAllServers(ns)
        .filter(h => h !== 'home')
        .filter(h => !h.startsWith('cloud-server'))
        .filter(h => ns.hasRootAccess(h))
        .filter(h => canHack(ns, h))
        .filter(h => ns.getServerMaxMoney(h) > 0)
        .map(h => {
            const maxMoney    = ns.getServerMaxMoney(h);
            const weakenTime  = ns.getWeakenTime(h);
            const hackChance  = ns.hackAnalyzeChance(h);
            const hackPercent = ns.hackAnalyze(h);
            const score       = (maxMoney / weakenTime) * hackChance * hackPercent;
            return { host: h, maxMoney, weakenTime, score };
        })
        .sort((a, b) => b.score - a.score);
}

function isPrepped(ns, host) {
    const security    = ns.getServerSecurityLevel(host);
    const minSecurity = ns.getServerMinSecurityLevel(host);
    const money       = ns.getServerMoneyAvailable(host);
    const maxMoney    = ns.getServerMaxMoney(host);
    return security <= minSecurity + 1 && money >= maxMoney * 0.99;
}

/**
 * Returns the highest-priority ladder target that is rooted and hackable at current level.
 * Falls back to n00dles if nothing else qualifies.
 */
function getLadderTarget(ns) {
    const hackLevel = ns.getHackingLevel();
    for (let i = TARGET_LADDER.length - 1; i >= 0; i--) {
        const host = TARGET_LADDER[i];
        try {
            if (ns.hasRootAccess(host) && hackLevel >= ns.getServerRequiredHackingLevel(host)) return host;
        } catch (_) {}
    }
    return TARGET_LADDER[0];
}

// --- Script paths ---
const WORKER_SCRIPT   = 'scripts/worker.js';
const AUTOROOT_SCRIPT = 'scripts/auto-root.js';
const BUY_SCRIPT      = 'scripts/buy-servers.js';

// --- Timing constants ---
const LAND_SPACING  = 20;                                                           // ms between each HWGW job landing in sequence
const BATCH_SPACING = 100;                                                          // ms between consecutive batch starts on same target

// --- Allocation constants ---
const WORKER_RAM            = 2.0;                                                  // GB RAM cost per worker thread
const MAX_TARGETS           = 5;                                                    // Maximum simultaneous hack targets in tier 1+
const LOOP_SLEEP            = 200;                                                  // Minimum ms between scheduler cycles
const SAFE_WEAKEN_PER_GROW  = 1 / 4;                                               // Fallback weaken ratio when formulas unavailable
const MIN_STEAL             = 0.01;                                                 // Minimum steal fraction (1%)
const MAX_STEAL             = 0.50;                                                 // Maximum steal fraction (50%)
const STEAL_STEP            = 0.005;                                                // Step size for formulas-mode steal scan

// --- Tier 0 constants ---
const GROW_RATIO   = 0.60;
const WEAKEN_RATIO = 0.40;

// --- Port constants ---
const PORT_STATUS   = 1;
const PORT_AUTOROOT = 2;

// --- Formulas.exe path ---
const FORMULAS_EXE = 'Formulas.exe';

// --- Early-game target ladder ---
// Used when worker pool thread count is below LADDER_EXIT_THREADS.
// Ordered low → high hack requirement; getLadderTarget picks the highest reachable entry.
// Prevents wasteful PREP-switching when new servers get rooted.
const TARGET_LADDER = [
    'n00dles',         // hack 1   — starting target, minSec 1 = fastest PREP
    'joesguns',        // hack 10
    'hong-fang-tea',   // hack 30
    'harakiri-sushi',  // hack 40
    'neo-net',         // hack 50
    'zer0',            // hack 75
    'silver-helix',    // hack 150
    'omega-net',       // hack 200
    'avmnite-02h',     // hack 202
    'I.I.I.I',         // hack 300
    'run4theh111z',    // hack 505
    'The-Cave',        // hack 750
];
const DEFAULT_LADDER_THREADS = 200;                                                 // Thread count above which ladder exits and dynamic scoring takes over


// =============================================================================
// Thread pool helpers
// =============================================================================

function allocate(pool, threadsNeeded) {
    const result    = [];
    let   remaining = threadsNeeded;

    for (const slot of pool) {
        if (remaining <= 0) break;
        if (slot.available <= 0) continue;

        const take = Math.min(slot.available, remaining);
        result.push({ host: slot.host, threads: take });
        remaining -= take;
    }

    if (remaining > 0) return null;
    return result;
}

function applyAllocation(pool, allocations) {
    for (const alloc of allocations) {
        const slot = pool.find(s => s.host === alloc.host);
        if (slot) slot.available -= alloc.threads;
    }
}

function freeAllocation(pool, allocations) {
    for (const alloc of allocations) {
        const slot = pool.find(s => s.host === alloc.host);
        if (slot) slot.available += alloc.threads;
    }
}


// =============================================================================
// Batch calculation — formulas mode
// =============================================================================

/**
 * Exact batch thread calculation using ns.formulas.hacking.
 * Scans steal fractions from MAX_STEAL down to MIN_STEAL in STEAL_STEP increments.
 * Each iteration is O(1) and exact — no estimation or binary search needed.
 * Requires Formulas.exe. Uses bracket notation to avoid static RAM cost.
 * @param {NS} ns
 * @param {string} target
 * @param {number} maxThreads
 * @returns {{hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction}|null}
 */
function calcBatchThreadsFormulas(ns, target, maxThreads) {
    const server           = ns.getServer(target);
    const player           = ns.getPlayer();
    const formulas         = ns['formulas']['hacking'];                             // Bracket notation — no static RAM cost
    const weakenPerThread  = ns.weakenAnalyze(1);
    const hackPct          = formulas['hackPercent'](server, player);               // Fraction stolen per hack thread

    if (!hackPct || hackPct <= 0) return null;

    const maxMoney = server.moneyMax;
    if (!maxMoney || maxMoney <= 0) return null;

    let best = null;

    // Scan from high steal% down to find largest fraction fitting maxThreads
    for (let fraction = MAX_STEAL; fraction >= MIN_STEAL; fraction -= STEAL_STEP) {
        const hackThreads = Math.max(1, Math.ceil(fraction / hackPct));

        const hackSecInc     = ns.hackAnalyzeSecurity(hackThreads, target);
        const weakenHThreads = Math.ceil(hackSecInc / weakenPerThread);

        // Mock server with post-hack money to get exact grow threads needed
        const postHackServer               = Object.assign({}, server);
        postHackServer.moneyAvailable      = Math.max(1, maxMoney * (1 - fraction));

        const growThreads    = Math.ceil(formulas['growThreads'](postHackServer, player, maxMoney));
        const growSecInc     = ns.growthAnalyzeSecurity(growThreads, target, 1);
        const weakenGThreads = Math.ceil(growSecInc / weakenPerThread) + 1;        // +1 rounding buffer

        const totalThreads = hackThreads + weakenHThreads + growThreads + weakenGThreads;

        if (totalThreads <= maxThreads) {
            best = { hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction: fraction };
            break;                                                                  // First (highest) fraction that fits is optimal
        }
    }

    return best;
}


// =============================================================================
// Batch calculation — fallback mode (binary search)
// =============================================================================

/**
 * Binary search batch calculation. Used when Formulas.exe is absent.
 * SAFE_WEAKEN_PER_GROW ratio (1/4) used instead of growthAnalyzeSecurity
 * which can underestimate in-game security increase.
 * @param {NS} ns
 * @param {string} target
 * @param {number} maxThreads
 * @returns {{hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction}|null}
 */
function calcBatchThreadsFallback(ns, target, maxThreads) {
    const maxMoney        = ns.getServerMaxMoney(target);
    const weakenPerThread = ns.weakenAnalyze(1);

    // Money depleted (post-hack, grow not yet landed) — return null silently.
    // WAIT-HACK handler upstream already manages this state.
    const curMoney = ns.getServerMoneyAvailable(target);
    if (curMoney < maxMoney * MIN_STEAL) return null;

    function threadsForSteal(fraction) {
        const hackAmount = Math.min(curMoney, maxMoney) * fraction;
        const rawHack = ns.hackAnalyzeThreads(target, hackAmount);
        if (!isFinite(rawHack) || rawHack < 0) return null;
        const hackThreads    = Math.max(1, Math.floor(rawHack));
        const hackSecInc     = ns.hackAnalyzeSecurity(hackThreads, target);
        const weakenHThreads = Math.ceil(hackSecInc / weakenPerThread);
        const growMult       = Math.max(1.001, 1 / (1 - fraction));
        const growThreads    = Math.ceil(ns.growthAnalyze(target, growMult));
        const weakenGThreads = Math.ceil(growThreads * SAFE_WEAKEN_PER_GROW) + 1;
        const totalThreads   = hackThreads + weakenHThreads + growThreads + weakenGThreads;
        return { hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction: fraction };
    }

    const minResult = threadsForSteal(MIN_STEAL);
    if (!minResult) {
        log(ns, 'calcBatchThreads: invalid state for ' + target + ' — hackAnalyzeThreads returned NaN/-1');
        return null;
    }
    if (minResult.totalThreads > maxThreads) return null;

    let lo   = MIN_STEAL;
    let hi   = MAX_STEAL;
    let best = minResult;

    for (let i = 0; i < 20; i++) {
        const mid    = (lo + hi) / 2;
        const result = threadsForSteal(mid);
        if (result && result.totalThreads <= maxThreads) {
            best = result;
            lo   = mid;
        } else {
            hi = mid;
        }
    }

    return best;
}


/**
 * Dispatch to the appropriate batch calculation mode.
 * @param {NS} ns
 * @param {string} target
 * @param {number} maxThreads
 * @param {boolean} hasFormulas
 */
function calcBatchThreads(ns, target, maxThreads, hasFormulas) {
    return hasFormulas
        ? calcBatchThreadsFormulas(ns, target, maxThreads)
        : calcBatchThreadsFallback(ns, target, maxThreads);
}


// =============================================================================
// Prep calculation
// =============================================================================

/**
 * Calculates grow + weaken threads for a PREP cycle (no hack).
 * Uses formulas.hacking.growThreads when Formulas.exe present for exact counts.
 * Falls back to growthAnalyze with conservative weaken ratio when absent.
 * @param {NS} ns
 * @param {string} target
 * @param {number} threadsRemaining
 * @param {boolean} hasFormulas
 * @returns {{growThreads: number, weakenThreads: number, totalThreads: number, phase: string}}
 */
function calcPrepThreads(ns, target, threadsRemaining, hasFormulas) {
    const weakenPerThread = ns.weakenAnalyze(1);
    const security        = ns.getServerSecurityLevel(target);
    const minSecurity     = ns.getServerMinSecurityLevel(target);
    const secDelta        = Math.max(0, security - minSecurity);

    // Phase A: security badly elevated — weaken only until near minimum
    if (secDelta > 2) {
        const fullWeaken    = Math.ceil(secDelta / weakenPerThread);
        const weakenThreads = Math.min(fullWeaken, threadsRemaining);
        return { growThreads: 0, weakenThreads, totalThreads: weakenThreads, phase: 'A' };
    }

    // Phase B: security near minimum — grow money and weaken to cover growth
    const money    = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    let growThreads   = 0;
    let weakenThreads = 0;

    if (money < maxMoney * 0.99) {
        if (hasFormulas) {
            // Exact grow threads via formulas
            const server              = ns.getServer(target);
            const player              = ns.getPlayer();
            server.moneyAvailable     = Math.max(1, money);
            growThreads               = Math.ceil(ns['formulas']['hacking']['growThreads'](server, player, maxMoney));
            const growSecInc          = ns.growthAnalyzeSecurity(growThreads, target, 1);
            const totalSecEst         = secDelta + growSecInc;
            weakenThreads             = Math.ceil(totalSecEst / weakenPerThread) + 1;
        } else {
            // Fallback: growthAnalyze with conservative weaken ratio
            const growMult  = money > 0 ? maxMoney / money : 1e6;
            const safeMult  = Math.min(growMult, 1e6);
            growThreads     = Math.ceil(ns.growthAnalyze(target, Math.max(1.001, safeMult)));
            const growSecEst    = growThreads * SAFE_WEAKEN_PER_GROW * weakenPerThread;
            const totalSecEst   = secDelta + growSecEst;
            weakenThreads       = Math.ceil(totalSecEst / weakenPerThread) + 1;
        }
    } else {
        weakenThreads = secDelta > 0 ? Math.ceil(secDelta / weakenPerThread) + 1 : 0;
    }

    let totalThreads = growThreads + weakenThreads;

    // Scale down proportionally if over budget
    if (totalThreads > threadsRemaining && threadsRemaining > 0) {
        const existingWeakenCost = Math.ceil(secDelta / weakenPerThread) + 1;
        const budgetForGrow      = threadsRemaining - existingWeakenCost;
        growThreads   = growThreads > 0 && budgetForGrow > 0
            ? Math.max(1, Math.floor(budgetForGrow / (1 + SAFE_WEAKEN_PER_GROW)))
            : 0;
        weakenThreads = growThreads > 0
            ? Math.ceil((secDelta + growThreads * SAFE_WEAKEN_PER_GROW * weakenPerThread) / weakenPerThread) + 1
            : existingWeakenCost;
        totalThreads  = growThreads + weakenThreads;
    }

    return { growThreads, weakenThreads, totalThreads, phase: 'B' };
}


// =============================================================================
// Worker launching
// =============================================================================

function launchWorkers(ns, operation, allocations, target, delay) {
    for (const alloc of allocations) {
        const pid = ns.exec(
            WORKER_SCRIPT,
            alloc.host,
            alloc.threads,
            target,
            operation,
            '--delay', Math.max(0, delay),
        );
        if (pid === 0) {
            log(ns, '[EXEC FAIL] ' + operation + ' on ' + alloc.host + ' t:' + alloc.threads + ' — RAM contention, resolves next cycle');
        }
    }
}


// =============================================================================
// Tier 0 — early mode
// =============================================================================

async function runTier0(ns) {
    ns.tprint('=== orchestrate.js v1.6.0 | TIER 0 early mode ===');

    const cycleEnds = {};

    while (true) {
        if (getRamTier(ns) > 0) {
            ns.tprint('[ORCHESTRATE] Tier risen — restarting in full HWGW mode');
            ns.exec('scripts/orchestrate.js', 'home', 1);
            return;
        }

        const workers = getWorkerServers(ns);
        if (workers.length > 0) {
            ns.tprint('[ORCHESTRATE] Worker servers detected — restarting in full HWGW mode');
            ns.exec('scripts/orchestrate.js', 'home', 1);
            return;
        }

        const targets = getRankedTargets(ns);
        if (targets.length === 0) {
            log(ns, 'Tier 0: no valid targets — waiting');
            await ns.sleep(5000);
            continue;
        }
        const target = targets[0];

        const maxRam  = ns.getServerMaxRam('home');
        const usedRam = ns.getServerUsedRam('home');
        const freeRam = maxRam - usedRam;
        const threads = Math.floor(freeRam / WORKER_RAM);

        if (threads < 1) {
            log(ns, 'Tier 0: insufficient home RAM for workers — waiting');
            await ns.sleep(LOOP_SLEEP);
            continue;
        }

        const now = Date.now();
        if (cycleEnds[target.host] && cycleEnds[target.host] > now) {
            const remaining = cycleEnds[target.host] - now;
            log(ns, 'Tier 0: cycle in flight for ' + target.host + ' — sleeping ' + formatTime(remaining));
            await ns.sleep(Math.max(remaining, LOOP_SLEEP));
            continue;
        }

        const growThreads   = Math.max(1, Math.floor(threads * GROW_RATIO));
        const weakenThreads = Math.max(1, threads - growThreads);

        const growPid   = ns.exec(WORKER_SCRIPT, 'home', growThreads,   target.host, 'grow',   '--delay', 0);
        const weakenPid = ns.exec(WORKER_SCRIPT, 'home', weakenThreads, target.host, 'weaken', '--delay', 0);

        if (growPid   === 0) log(ns, 'Tier 0: grow exec failed on home');
        if (weakenPid === 0) log(ns, 'Tier 0: weaken exec failed on home');

        const weakenTime       = ns.getWeakenTime(target.host);
        cycleEnds[target.host] = now + weakenTime + 500;

        clearPort(ns, PORT_STATUS);
        writePort(ns, PORT_STATUS, {
            cycleStart : now,
            targets    : { [target.host]: { weakenTime, mode: 'TIER0' } },
        });

        log(ns, 'Tier 0: ' + target.host + ' | G:' + growThreads + ' W:' + weakenThreads + ' | cycle: ' + formatTime(weakenTime));

        await ns.sleep(Math.max(weakenTime + 500, LOOP_SLEEP));
    }
}


// =============================================================================
// Tier 1+ — full HWGW mode
// =============================================================================

async function runFullMode(ns, ladderThreads) {
    ns.tprint('=== orchestrate.js v1.6.0 | TIER ' + getRamTier(ns) + ' full HWGW mode ===');

    const scpDone    = new Set();
    const cycleEnds  = {};
    const hackMode   = new Set();
    let activePrepTarget = null;

    while (true) {

        if (getRamTier(ns) === 0) {
            ns.tprint('[ORCHESTRATE] Tier dropped to 0 — restarting in early mode');
            ns.exec('scripts/orchestrate.js', 'home', 1);
            return;
        }

        // Check Formulas.exe each cycle — player may acquire it mid-run
        const hasFormulas = ns.fileExists(FORMULAS_EXE, 'home');

        const workerList = getWorkerServers(ns);

        for (const host of workerList) {
            if (!scpDone.has(host)) {
                const ok = await ns.scp(WORKER_SCRIPT, host, 'home');
                if (ok) scpDone.add(host);
                else log(ns, 'scp failed: ' + host + ' — skipped this cycle');
            }
        }

        const pool = workerList
            .filter(host => scpDone.has(host))
            .map(host => ({
                host,
                available: Math.floor(
                    (ns.getServerMaxRam(host) - ns.getServerUsedRam(host)) / WORKER_RAM
                ),
            }))
            .filter(slot => slot.available > 0);

        const totalAvailableThreads = pool.reduce((s, p) => s + p.available, 0);
        let   threadsRemaining      = totalAvailableThreads;
        let   batchesLaunched       = 0;
        let   prepLaunched          = 0;
        const targetTiming          = {};

        const now = Date.now();

        // Total theoretical capacity (used for ladder mode decision, independent of current usage)
        const totalWorkerThreads = workerList.reduce((s, h) =>
            s + Math.floor(ns.getServerMaxRam(h) / WORKER_RAM), 0);
        const useLadder = totalWorkerThreads < ladderThreads;

        // Build target list: ladder mode keeps active hack targets + one prep target;
        // dynamic mode uses top-N by score, preserving activePrepTarget if near the cut.
        const allRanked = getRankedTargets(ns);
        let targets;
        if (useLadder) {
            const ladderHost  = getLadderTarget(ns);
            const hackingNow  = allRanked.filter(t => hackMode.has(t.host));
            const alreadySet  = new Set(hackingNow.map(t => t.host));
            targets = [...hackingNow];
            if (ladderHost && !alreadySet.has(ladderHost)) {
                const entry = allRanked.find(t => t.host === ladderHost) ||
                    { host: ladderHost, score: 0, maxMoney: ns.getServerMaxMoney(ladderHost), weakenTime: ns.getWeakenTime(ladderHost) };
                targets.push(entry);
            }
            log(ns, '[LADDER] threads=' + totalWorkerThreads + '/' + ladderThreads + ' target=' + (ladderHost || 'none'));
        } else {
            targets = allRanked.slice(0, MAX_TARGETS);
            // Keep activePrepTarget in list even if a newly-rooted server pushed it outside top-N
            if (activePrepTarget && !targets.find(t => t.host === activePrepTarget)) {
                const preserved = allRanked.find(t => t.host === activePrepTarget);
                if (preserved) targets.push(preserved);
            }
        }

        if (targets.length === 0) {
            log(ns, 'No valid targets — waiting');
            await ns.sleep(5000);
            continue;
        }

        const preppedCache = {};
        for (const t of targets) {
            preppedCache[t.host] = hackMode.has(t.host) || isPrepped(ns, t.host);
        }

        // Only switch activePrepTarget when it's actually done or inaccessible —
        // not just because a newly-rooted server ranked higher this cycle.
        let needNewPrepTarget = (activePrepTarget === null);
        if (!needNewPrepTarget) {
            const inCache = Object.prototype.hasOwnProperty.call(preppedCache, activePrepTarget);
            const isDone  = inCache ? preppedCache[activePrepTarget] : isPrepped(ns, activePrepTarget);
            needNewPrepTarget = isDone;
            if (!needNewPrepTarget) {
                try { needNewPrepTarget = !ns.hasRootAccess(activePrepTarget) || !canHack(ns, activePrepTarget); }
                catch (_) { needNewPrepTarget = true; }
            }
        }
        if (needNewPrepTarget) {
            const next     = targets.find(t => !preppedCache[t.host] && !hackMode.has(t.host));
            const nextHost = next ? next.host : null;
            if (nextHost !== activePrepTarget) {
                activePrepTarget = nextHost;
                if (activePrepTarget) log(ns, '[PREP TARGET] → ' + activePrepTarget);
            }
        }

        const rootEvent = readPort(ns, PORT_AUTOROOT);
        if (rootEvent) {
            log(ns, 'New root detected: ' + rootEvent.host + ' — SCP will cover next cycle');
        }

        log(ns, '--- cycle | threads: ' + totalAvailableThreads + ' | targets: ' + targets.length + ' | formulas: ' + hasFormulas + ' ---');

        // --- Phase 1 Pass 1: HACK batches for all prepped targets ---
        for (const t of targets) {
            if (threadsRemaining <= 0) break;

            if (cycleEnds[t.host] && cycleEnds[t.host] > now) {
                log(ns, '[SKIP] ' + t.host + ' — cycle ends in ' + formatTime(cycleEnds[t.host] - now));
                targetTiming[t.host] = { mode: 'SKIP', cycleEnd: cycleEnds[t.host], weakenTime: cycleEnds[t.host] - now };
                continue;
            }

            if (!preppedCache[t.host]) continue;

            const batch = calcBatchThreads(ns, t.host, threadsRemaining, hasFormulas);
            if (!batch) {
                if (hackMode.has(t.host)) {
                    const wt = ns.getWeakenTime(t.host);
                    cycleEnds[t.host] = now + wt;
                    targetTiming[t.host] = { mode: 'WAIT', cycleEnd: now + wt, weakenTime: wt };
                    log(ns, '[WAIT-HACK] ' + t.host + ' — money depleted, waiting for grow');
                } else {
                    log(ns, '[HACK] ' + t.host + ' — thread calc failed, skipping');
                }
                continue;
            }

            const hackAlloc = allocate(pool, batch.hackThreads);
            if (!hackAlloc) continue;
            applyAllocation(pool, hackAlloc);

            const weakenHAlloc = allocate(pool, batch.weakenHThreads);
            if (!weakenHAlloc) { freeAllocation(pool, hackAlloc); continue; }
            applyAllocation(pool, weakenHAlloc);

            const growAlloc = allocate(pool, batch.growThreads);
            if (!growAlloc) { freeAllocation(pool, hackAlloc); freeAllocation(pool, weakenHAlloc); continue; }
            applyAllocation(pool, growAlloc);

            const weakenGAlloc = allocate(pool, batch.weakenGThreads);
            if (!weakenGAlloc) {
                freeAllocation(pool, hackAlloc);
                freeAllocation(pool, weakenHAlloc);
                freeAllocation(pool, growAlloc);
                continue;
            }
            applyAllocation(pool, weakenGAlloc);

            const weakenTime = ns.getWeakenTime(t.host);
            const hackTime   = ns.getHackTime(t.host);
            const growTime   = ns.getGrowTime(t.host);

            const hackDelay    = weakenTime - hackTime  - LAND_SPACING;
            const weakenHDelay = 0;
            const growDelay    = weakenTime - growTime  + LAND_SPACING;
            const weakenGDelay = LAND_SPACING * 2;

            launchWorkers(ns, 'hack',   hackAlloc,    t.host, hackDelay);
            launchWorkers(ns, 'weaken', weakenHAlloc, t.host, weakenHDelay);
            launchWorkers(ns, 'grow',   growAlloc,    t.host, growDelay);
            launchWorkers(ns, 'weaken', weakenGAlloc, t.host, weakenGDelay);

            threadsRemaining  -= batch.totalThreads;
            batchesLaunched++;
            hackMode.add(t.host);

            cycleEnds[t.host]    = now + weakenTime + LAND_SPACING * 4;
            targetTiming[t.host] = { weakenTime, mode: 'HACK', cycleEnd: cycleEnds[t.host], H: batch.hackThreads, WH: batch.weakenHThreads, G: batch.growThreads, WG: batch.weakenGThreads };

            log(ns, '[HACK] ' + t.host + ' | steal:' + (batch.stealFraction * 100).toFixed(1) + '% | H:' + batch.hackThreads + ' WH:' + batch.weakenHThreads + ' G:' + batch.growThreads + ' WG:' + batch.weakenGThreads + ' | total:' + batch.totalThreads + ' | cycle:' + formatTime(weakenTime));
        }

        // --- Phase 1 Pass 2: PREP for active target using remaining RAM ---
        if (threadsRemaining > 0 && activePrepTarget) {
            const t = targets.find(t => t.host === activePrepTarget);

            if (t && !preppedCache[t.host]) {
                const cycleActive = cycleEnds[t.host] && cycleEnds[t.host] > now;

                if (!cycleActive) {
                    const prep = calcPrepThreads(ns, t.host, threadsRemaining, hasFormulas);

                    if (prep.totalThreads > 0) {
                        const weakenAlloc = prep.weakenThreads > 0 ? allocate(pool, prep.weakenThreads) : [];
                        if (prep.weakenThreads > 0 && !weakenAlloc) {
                            log(ns, '[PREP] ' + t.host + ' — insufficient RAM for weaken');
                        } else {
                            if (weakenAlloc && weakenAlloc.length > 0) applyAllocation(pool, weakenAlloc);

                            const growAlloc = prep.growThreads > 0 ? allocate(pool, prep.growThreads) : [];
                            if (prep.growThreads > 0 && !growAlloc) {
                                if (weakenAlloc && weakenAlloc.length > 0) freeAllocation(pool, weakenAlloc);
                                const poolAfterWeaken = pool.reduce((s, p) => s + p.available, 0);
                                log(ns, '[PREP] ' + t.host + ' — insufficient RAM for grow | need:' + prep.growThreads + ' pool_remaining:' + poolAfterWeaken + ' total_needed:' + prep.totalThreads + ' budget:' + threadsRemaining);
                            } else {
                                if (growAlloc && growAlloc.length > 0) applyAllocation(pool, growAlloc);

                                const weakenTime  = ns.getWeakenTime(t.host);
                                const growTime    = ns.getGrowTime(t.host);
                                const weakenDelay = Math.max(0, growTime - weakenTime + LAND_SPACING);

                                if (growAlloc   && growAlloc.length   > 0) launchWorkers(ns, 'grow',   growAlloc,   t.host, 0);
                                if (weakenAlloc && weakenAlloc.length > 0) launchWorkers(ns, 'weaken', weakenAlloc, t.host, weakenDelay);

                                const prepThreads = (growAlloc   ? growAlloc.reduce((s, a)   => s + a.threads, 0) : 0)
                                                  + (weakenAlloc ? weakenAlloc.reduce((s, a) => s + a.threads, 0) : 0);
                                threadsRemaining   -= prepThreads;
                                prepLaunched++;

                                cycleEnds[t.host]    = now + Math.max(growTime, weakenTime) + 500;
                                targetTiming[t.host] = { weakenTime, mode: 'PREP', cycleEnd: cycleEnds[t.host], G: prep.growThreads, W: prep.weakenThreads };

                                const sec    = ns.getServerSecurityLevel(t.host);
                                const minSec = ns.getServerMinSecurityLevel(t.host);
                                const money  = ns.getServerMoneyAvailable(t.host);
                                const maxMon = ns.getServerMaxMoney(t.host);
                                log(ns, '[PREP-' + prep.phase + '] ' + t.host + ' | sec:' + sec.toFixed(1) + '/' + minSec.toFixed(1) + ' | $' + ns.format.number(money, 1) + '/$' + ns.format.number(maxMon, 1) + ' | G:' + prep.growThreads + ' W:' + prep.weakenThreads + ' | ~' + formatTime(weakenTime));
                            }
                        }
                    }
                }
            }
        }

        // Ensure every tracked target has an entry so dashboard shows full picture
        for (const t of targets) {
            if (!targetTiming[t.host]) {
                targetTiming[t.host] = {
                    mode: hackMode.has(t.host) ? 'WAIT' : 'QUEUE',
                    cycleEnd: cycleEnds[t.host] || 0,
                    weakenTime: 0,
                };
            }
        }

        // Write cycle timing to port 1 for status.js / dashboard
        clearPort(ns, PORT_STATUS);
        writePort(ns, PORT_STATUS, { cycleStart: now, targets: targetTiming });

        // --- Secondary pass: weaken-only on queued targets using surplus RAM ---
        if (threadsRemaining > 0) {
            for (const t of targets) {
                if (threadsRemaining <= 0) break;
                if (t.host === activePrepTarget) continue;
                if (preppedCache[t.host]) continue;
                if (cycleEnds[t.host] && cycleEnds[t.host] > now) continue;

                const sec             = ns.getServerSecurityLevel(t.host);
                const minSec          = ns.getServerMinSecurityLevel(t.host);
                const secDelta        = Math.max(0, sec - minSec);
                if (secDelta <= 0) continue;

                const weakenPerThread = ns.weakenAnalyze(1);
                const fullWeaken      = Math.ceil(secDelta / weakenPerThread);
                const weakenThreads   = Math.min(fullWeaken, threadsRemaining);
                const weakenAlloc     = allocate(pool, weakenThreads);
                if (!weakenAlloc) continue;
                applyAllocation(pool, weakenAlloc);

                const weakenTime      = ns.getWeakenTime(t.host);
                launchWorkers(ns, 'weaken', weakenAlloc, t.host, 0);
                threadsRemaining  -= weakenThreads;
                cycleEnds[t.host]  = now + weakenTime + 500;

                log(ns, '[SEC] ' + t.host + ' | sec:' + sec.toFixed(1) + '/' + minSec.toFixed(1) + ' | W:' + weakenThreads + ' (surplus)');
            }
        }

        // --- Phase 2: round-robin overflow batches across all prepped targets ---
        const preppedTargets = targets.filter(t => preppedCache[t.host]);

        if (preppedTargets.length > 0 && threadsRemaining > 0) {
            const targetBatches = preppedTargets.map(t => ({
                target    : t,
                batch     : calcBatchThreads(ns, t.host, threadsRemaining, hasFormulas),
                weakenTime: ns.getWeakenTime(t.host),
                hackTime  : ns.getHackTime(t.host),
                growTime  : ns.getGrowTime(t.host),
                offset    : batchesLaunched * BATCH_SPACING,
            })).filter(tb => tb.batch !== null);

            if (targetBatches.length > 0) {
                const minBatchSize   = Math.min(...targetBatches.map(tb => tb.batch.totalThreads));
                const reserveThreads = preppedTargets.length * minBatchSize;
                const minWeakenTime  = Math.min(...targetBatches.map(tb => tb.weakenTime));
                const cycleSlots     = Math.floor(minWeakenTime / BATCH_SPACING);

                let totalOverflow = 0;
                let roundIdx      = 0;
                const overflowLog = {};

                while (totalOverflow < cycleSlots && threadsRemaining > reserveThreads) {
                    const tb = targetBatches[roundIdx % targetBatches.length];
                    roundIdx++;

                    if (threadsRemaining - tb.batch.totalThreads < reserveThreads) break;

                    const hackDelay    = tb.weakenTime - tb.hackTime - LAND_SPACING + tb.offset;
                    const weakenHDelay = tb.offset;
                    const growDelay    = tb.weakenTime - tb.growTime + LAND_SPACING + tb.offset;
                    const weakenGDelay = LAND_SPACING * 2 + tb.offset;

                    const hackAlloc = allocate(pool, tb.batch.hackThreads);
                    if (!hackAlloc) { roundIdx++; continue; }
                    applyAllocation(pool, hackAlloc);

                    const weakenHAlloc = allocate(pool, tb.batch.weakenHThreads);
                    if (!weakenHAlloc) { freeAllocation(pool, hackAlloc); roundIdx++; continue; }
                    applyAllocation(pool, weakenHAlloc);

                    const growAlloc = allocate(pool, tb.batch.growThreads);
                    if (!growAlloc) { freeAllocation(pool, hackAlloc); freeAllocation(pool, weakenHAlloc); roundIdx++; continue; }
                    applyAllocation(pool, growAlloc);

                    const weakenGAlloc = allocate(pool, tb.batch.weakenGThreads);
                    if (!weakenGAlloc) {
                        freeAllocation(pool, hackAlloc);
                        freeAllocation(pool, weakenHAlloc);
                        freeAllocation(pool, growAlloc);
                        roundIdx++;
                        continue;
                    }
                    applyAllocation(pool, weakenGAlloc);

                    launchWorkers(ns, 'hack',   hackAlloc,    tb.target.host, hackDelay);
                    launchWorkers(ns, 'weaken', weakenHAlloc, tb.target.host, weakenHDelay);
                    launchWorkers(ns, 'grow',   growAlloc,    tb.target.host, growDelay);
                    launchWorkers(ns, 'weaken', weakenGAlloc, tb.target.host, weakenGDelay);

                    threadsRemaining -= tb.batch.totalThreads;
                    tb.offset        += BATCH_SPACING;
                    totalOverflow++;
                    overflowLog[tb.target.host] = (overflowLog[tb.target.host] || 0) + 1;

                    cycleEnds[tb.target.host] = now + tb.offset + tb.weakenTime + LAND_SPACING * 4;
                }

                for (const host of Object.keys(overflowLog)) {
                    log(ns, '[OVERFLOW] ' + host + ' — ' + overflowLog[host] + ' extra batch(es)');
                }
            }
        }

        log(ns, 'Batches: ' + batchesLaunched + ' hack | ' + prepLaunched + ' prep | threads used: ' + (totalAvailableThreads - threadsRemaining) + '/' + totalAvailableThreads);

        const pendingEnds = targets
            .map(t => cycleEnds[t.host])
            .filter(e => e !== undefined && e > now);

        const sleepTime = pendingEnds.length > 0
            ? Math.min(...pendingEnds) - now
            : 10000;

        log(ns, 'Next cycle in ' + formatTime(sleepTime));
        await ns.sleep(Math.max(sleepTime, LOOP_SLEEP));
    }
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',           false],
        ['ladder-threads', DEFAULT_LADDER_THREADS],
    ]);

    if (flags.help) {
        ns.tprint('=== orchestrate.js v1.6.0 ===');
        ns.tprint('Purpose: Tier-aware HWGW batch scheduler. Manages grow/weaken/hack');
        ns.tprint('         workers across all rooted servers to maximise income.');
        ns.tprint('         Uses Formulas.exe when present for exact thread calculations.');
        ns.tprint('         Ladder mode: sticks to a fixed target progression until');
        ns.tprint('         worker pool exceeds --ladder-threads (default ' + DEFAULT_LADDER_THREADS + ').');
        ns.tprint('Usage:   run /scripts/orchestrate.js [--ladder-threads N]');
        ns.tprint('Flags:');
        ns.tprint('  --help              Show this help and exit');
        ns.tprint('  --ladder-threads N  Exit ladder mode above N total worker threads (default: ' + DEFAULT_LADDER_THREADS + ')');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 1: cycle timing data for status.js');
        ns.tprint('  Reads  port 2: new root events from auto-root.js (peek only)');
        return;
    }

    ns.disableLog('ALL');

    clearPort(ns, PORT_STATUS);
    ns.atExit(() => clearPort(ns, PORT_STATUS));

    const tier        = getRamTier(ns);
    const hasFormulas = ns.fileExists(FORMULAS_EXE, 'home');
    log(ns, 'Startup: tier=' + tier + ' formulas=' + hasFormulas + ' ladder-threads=' + flags['ladder-threads']);

    if (tier === 0) {
        await runTier0(ns);
    } else {
        await ns.sleep(1000);
        if (!ns.isRunning(AUTOROOT_SCRIPT, 'home')) {
            const arPid = ns.exec(AUTOROOT_SCRIPT, 'home', 1);
            if (arPid > 0) log(ns, 'Launched auto-root.js (pid ' + arPid + ')');
            else           log(ns, 'WARNING: auto-root.js launch failed');
        }
        await ns.sleep(10000);
        if (!ns.isRunning(BUY_SCRIPT, 'home')) {
            const bsPid = ns.exec(BUY_SCRIPT, 'home', 1);
            if (bsPid > 0) log(ns, 'Launched buy-servers.js (pid ' + bsPid + ')');
            else           log(ns, 'WARNING: buy-servers.js launch failed');
        }
        await runFullMode(ns, flags['ladder-threads']);
    }
}
