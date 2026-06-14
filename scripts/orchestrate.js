/**
 * orchestrate.js
 * Version: 1.1.0
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
 *     calcBatchThreads: binary search for largest steal% fitting RAM budget.
 *     calcPrepThreads: Phase A (weaken-only when secDelta > 2) /
 *                      Phase B (grow + weaken when security near minimum).
 *     Phase 2: round-robin overflow batches across all prepped targets.
 *     Cycle-aware sleep: wakes at nearest cycleEnd timestamp.
 *     hackMode Set: targets receiving HACK are never given PREP on top.
 *     activePrepTarget: persists across cycles, prevents mid-prep switching.
 *     Port 2: peeked each cycle for new root events from auto-root.js.
 *     Port 1: written each cycle with timing data for status.js.
 *
 * Changelog:
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

// --- Worker script path ---
const WORKER_SCRIPT = 'scripts/worker.js';                                          // No leading slash — matches ns.exec() resolution

// --- Timing constants ---
const LAND_SPACING  = 20;                                                           // ms between each HWGW job landing in sequence
const BATCH_SPACING = 100;                                                          // ms between consecutive batch starts on same target

// --- Allocation constants ---
const WORKER_RAM            = 1.75;                                                 // GB RAM cost per worker thread
const MAX_TARGETS           = 5;                                                    // Maximum simultaneous hack targets in tier 1+
const LOOP_SLEEP            = 200;                                                  // Minimum ms between scheduler cycles
const SAFE_WEAKEN_PER_GROW  = 1 / 4;                                               // Conservative weaken ratio: 1 weaken per 4 grow threads
const MIN_STEAL             = 0.01;                                                 // Minimum steal fraction (1%) for binary search
const MAX_STEAL             = 0.50;                                                 // Maximum steal fraction (50%) for binary search

// --- Tier 0 constants ---
const GROW_RATIO   = 0.60;                                                          // 60% of home threads assigned to grow in tier 0
const WEAKEN_RATIO = 0.40;                                                          // 40% of home threads assigned to weaken in tier 0

// --- Port constants ---
const PORT_STATUS  = 1;                                                             // Port orchestrate writes timing data to
const PORT_AUTOROOT = 2;                                                            // Port auto-root writes new root events to (peek only)


// =============================================================================
// Thread pool helpers
// =============================================================================

/**
 * Attempts to allocate threadsNeeded threads from the pool.
 * Fills largest servers first to minimise ns.exec() call count.
 * Does not mutate the pool — call applyAllocation to commit.
 * @param {Array<{host: string, available: number}>} pool
 * @param {number} threadsNeeded
 * @returns {Array<{host: string, threads: number}>|null} Allocations or null if insufficient RAM
 */
function allocate(pool, threadsNeeded) {
    const result    = [];                                                            // Allocations accumulator
    let   remaining = threadsNeeded;                                                // Threads still to fill

    for (const slot of pool) {                                                      // Iterate largest-first (pool is pre-sorted)
        if (remaining <= 0) break;                                                  // Fully allocated
        if (slot.available <= 0) continue;                                          // Server exhausted — skip

        const take = Math.min(slot.available, remaining);                           // Take what's available up to need
        result.push({ host: slot.host, threads: take });
        remaining -= take;
    }

    if (remaining > 0) return null;                                                 // Not enough RAM across pool
    return result;
}

/**
 * Commits allocations to the pool, reducing available thread counts.
 * @param {Array<{host: string, available: number}>} pool
 * @param {Array<{host: string, threads: number}>} allocations
 */
function applyAllocation(pool, allocations) {
    for (const alloc of allocations) {
        const slot = pool.find(s => s.host === alloc.host);
        if (slot) slot.available -= alloc.threads;                                  // Deduct committed threads from pool slot
    }
}

/**
 * Returns allocated threads to the pool.
 * Used to roll back a partial allocation when a batch cannot be completed.
 * @param {Array<{host: string, available: number}>} pool
 * @param {Array<{host: string, threads: number}>} allocations
 */
function freeAllocation(pool, allocations) {
    for (const alloc of allocations) {
        const slot = pool.find(s => s.host === alloc.host);
        if (slot) slot.available += alloc.threads;                                  // Return threads to pool slot
    }
}


// =============================================================================
// Batch calculation
// =============================================================================

/**
 * Calculates thread counts for a single HWGW batch on a prepped target.
 * Uses binary search to find the largest steal fraction fitting maxThreads.
 * Grow weaken uses SAFE_WEAKEN_PER_GROW ratio (1/4) rather than
 * growthAnalyzeSecurity() which underestimates in-game security increase ~3x.
 * Returns null if even MIN_STEAL fraction exceeds maxThreads or state invalid.
 * @param {NS} ns
 * @param {string} target
 * @param {number} maxThreads - Thread budget for this batch
 * @returns {{hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction}|null}
 */
function calcBatchThreads(ns, target, maxThreads) {
    const maxMoney        = ns.getServerMaxMoney(target);                           // Max money — assumes target is fully prepped
    const weakenPerThread = ns.weakenAnalyze(1);                                    // Security reduction per weaken thread

    /**
     * Calculate total threads required for a given steal fraction.
     * @param {number} fraction - Fraction of maxMoney to steal (0–1)
     * @returns {object|null} Thread counts and total, or null if state invalid
     */
    function threadsForSteal(fraction) {
        const rawHack = ns.hackAnalyzeThreads(target, maxMoney * fraction);         // Raw hack threads for this steal amount
        if (!isFinite(rawHack) || rawHack < 0) return null;                        // Invalid target state — $0 or NaN
        const hackThreads    = Math.max(1, Math.floor(rawHack));                    // Whole threads, minimum 1
        const hackSecInc     = ns.hackAnalyzeSecurity(hackThreads, target);         // Security raised by hack
        const weakenHThreads = Math.ceil(hackSecInc / weakenPerThread);             // Threads to cancel hack's security increase
        const growMult       = Math.max(1.001, 1 / (1 - fraction));                // Multiplier to restore money after steal
        const growThreads    = Math.ceil(ns.growthAnalyze(target, growMult));       // Threads to restore money to max
        const weakenGThreads = Math.ceil(growThreads * SAFE_WEAKEN_PER_GROW) + 1;  // Safe-ratio weaken for grow's security increase
        const totalThreads   = hackThreads + weakenHThreads + growThreads + weakenGThreads;
        return { hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction: fraction };
    }

    // Guard: if minimum steal fraction is invalid or exceeds budget, bail out
    const minResult = threadsForSteal(MIN_STEAL);
    if (!minResult) {
        log(ns, 'calcBatchThreads: invalid state for ' + target + ' — hackAnalyzeThreads returned NaN/-1');
        return null;
    }
    if (minResult.totalThreads > maxThreads) return null;                           // Even 1% steal doesn't fit — caller skips

    // Binary search: find largest steal fraction that fits within maxThreads
    let lo   = MIN_STEAL;                                                           // Known-good lower bound
    let hi   = MAX_STEAL;                                                           // Upper bound — may not fit
    let best = minResult;                                                           // Track best result found

    for (let i = 0; i < 20; i++) {                                                  // 20 iterations → ~0.0000001 precision
        const mid    = (lo + hi) / 2;
        const result = threadsForSteal(mid);
        if (result && result.totalThreads <= maxThreads) {
            best = result;                                                           // Fits — try higher steal
            lo   = mid;
        } else {
            hi = mid;                                                               // Doesn't fit — lower upper bound
        }
    }

    return best;
}

/**
 * Calculates grow + weaken threads for a PREP cycle (no hack).
 * Weaken-first strategy:
 *   Phase A (secDelta > 2): dedicate all threads to weaken only. High security
 *     slows all operations; clearing it first is fastest path to ready state.
 *   Phase B (secDelta <= 2): grow money to max plus weaken to cover grow's
 *     security increase. Scaled proportionally if over threadsRemaining budget.
 * @param {NS} ns
 * @param {string} target
 * @param {number} threadsRemaining - Thread budget available this cycle
 * @returns {{growThreads: number, weakenThreads: number, totalThreads: number, phase: string}}
 */
function calcPrepThreads(ns, target, threadsRemaining) {
    const weakenPerThread = ns.weakenAnalyze(1);                                    // Security reduction per weaken thread
    const security        = ns.getServerSecurityLevel(target);
    const minSecurity     = ns.getServerMinSecurityLevel(target);
    const secDelta        = Math.max(0, security - minSecurity);                    // Security above minimum

    // Phase A: security badly elevated — weaken only until near minimum
    if (secDelta > 2) {
        const fullWeaken  = Math.ceil(secDelta / weakenPerThread);                  // Threads to fully clear security
        const weakenThreads = Math.min(fullWeaken, threadsRemaining);               // Cap to budget
        return { growThreads: 0, weakenThreads, totalThreads: weakenThreads, phase: 'A' };
    }

    // Phase B: security near minimum — grow money and weaken to cover growth
    const money    = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    let growThreads   = 0;
    let weakenThreads = 0;

    if (money < maxMoney * 0.99) {                                                  // Only grow if below 99% max
        const growMult  = money > 0
            ? maxMoney / money                                                      // Multiplier to reach max money
            : 1e6;                                                                  // Server is empty — use large multiplier (capped below)
        // Cap grow multiplier to prevent astronomically large thread counts on $0 servers
        const safeMult  = Math.min(growMult, 1e6);
        growThreads     = Math.ceil(ns.growthAnalyze(target, Math.max(1.001, safeMult)));
        const growSecEst    = growThreads * SAFE_WEAKEN_PER_GROW * weakenPerThread; // Estimated security increase from grow
        const totalSecEst   = secDelta + growSecEst;                                // Existing delta + grow's contribution
        weakenThreads       = Math.ceil(totalSecEst / weakenPerThread) + 1;         // +1 rounding buffer
    } else {
        // Money at max — only clear residual security if any
        weakenThreads = secDelta > 0 ? Math.ceil(secDelta / weakenPerThread) + 1 : 0;
    }

    let totalThreads = growThreads + weakenThreads;

    // Scale down proportionally if over budget
    if (totalThreads > threadsRemaining && threadsRemaining > 0) {
        const existingWeakenCost = Math.ceil(secDelta / weakenPerThread) + 1;       // Threads to cover existing delta
        const budgetForGrow      = threadsRemaining - existingWeakenCost;           // Remaining budget after reserving weaken
        growThreads   = growThreads > 0 && budgetForGrow > 0
            ? Math.max(1, Math.floor(budgetForGrow / (1 + SAFE_WEAKEN_PER_GROW)))  // Scale grow to fit with its weaken share
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

/**
 * Launches one ns.exec() call per allocation entry.
 * Operation and delay are passed as positional args to worker.js.
 * Logs exec failures — these are transient RAM contention and resolve next cycle.
 * @param {NS} ns
 * @param {string} operation - 'hack', 'grow', or 'weaken'
 * @param {Array<{host: string, threads: number}>} allocations
 * @param {string} target - Target hostname
 * @param {number} delay - ms delay before worker executes operation
 */
function launchWorkers(ns, operation, allocations, target, delay) {
    for (const alloc of allocations) {
        const pid = ns.exec(
            WORKER_SCRIPT,
            alloc.host,
            alloc.threads,
            target,
            operation,
            '--delay', Math.max(0, delay),                                          // Ensure delay is never negative
        );
        if (pid === 0) {                                                             // PID 0 = exec failed
            log(ns, '[EXEC FAIL] ' + operation + ' on ' + alloc.host + ' t:' + alloc.threads + ' — RAM contention, resolves next cycle');
        }
    }
}


// =============================================================================
// Tier 0 — early mode
// =============================================================================

/**
 * Tier 0 early-mode loop. Runs entirely on home with minimal RAM footprint.
 * Dispatches grow + weaken threads on home using free RAM after own script cost.
 * Exits when tier rises (restarts self) or worker servers become available.
 * @param {NS} ns
 */
async function runTier0(ns) {
    ns.tprint('=== orchestrate.js v1.2.0 | TIER 0 early mode ===');

    const selfRam   = ns.getScriptRam('orchestrate.js', 'home');                    // Own RAM cost — excluded from worker budget
    const cycleEnds = {};                                                            // Per-target cycleEnd timestamps

    while (true) {
        // Check if tier has risen — restart in full mode
        if (getRamTier(ns) > 0) {
            ns.tprint('[ORCHESTRATE] Tier risen — restarting in full HWGW mode');
            ns.exec('scripts/orchestrate.js', 'home', 1);                           // Launch fresh instance — it will detect tier 1+
            return;                                                                  // Exit tier 0 loop
        }

        // Check if worker servers now available — switch to using them
        const workers = getWorkerServers(ns);
        if (workers.length > 0) {
            ns.tprint('[ORCHESTRATE] Worker servers detected — restarting in full HWGW mode');
            ns.exec('scripts/orchestrate.js', 'home', 1);
            return;
        }

        // Select single best target
        const targets = getRankedTargets(ns);
        if (targets.length === 0) {
            log(ns, 'Tier 0: no valid targets — waiting');
            await ns.sleep(5000);
            continue;
        }
        const target = targets[0];

        // Calculate free home RAM available for worker threads
        const maxRam  = ns.getServerMaxRam('home');
        const usedRam = ns.getServerUsedRam('home');
        const freeRam = maxRam - usedRam;                                           // Remaining RAM after all running scripts
        const threads = Math.floor(freeRam / WORKER_RAM);                           // How many worker threads fit

        if (threads < 1) {
            log(ns, 'Tier 0: insufficient home RAM for workers — waiting');
            await ns.sleep(LOOP_SLEEP);
            continue;
        }

        // Skip if cycle still in flight for this target
        const now = Date.now();
        if (cycleEnds[target.host] && cycleEnds[target.host] > now) {
            const remaining = cycleEnds[target.host] - now;
            log(ns, 'Tier 0: cycle in flight for ' + target.host + ' — sleeping ' + formatTime(remaining));
            await ns.sleep(Math.max(remaining, LOOP_SLEEP));
            continue;
        }

        // Split threads 60% grow / 40% weaken
        const growThreads   = Math.max(1, Math.floor(threads * GROW_RATIO));
        const weakenThreads = Math.max(1, threads - growThreads);                   // Remaining threads go to weaken

        // Launch grow then weaken on home
        const growPid   = ns.exec(WORKER_SCRIPT, 'home', growThreads,   target.host, 'grow',   '--delay', 0);
        const weakenPid = ns.exec(WORKER_SCRIPT, 'home', weakenThreads, target.host, 'weaken', '--delay', 0);

        if (growPid   === 0) log(ns, 'Tier 0: grow exec failed on home');
        if (weakenPid === 0) log(ns, 'Tier 0: weaken exec failed on home');

        const weakenTime      = ns.getWeakenTime(target.host);
        cycleEnds[target.host] = now + weakenTime + 500;                            // +500ms buffer for grow/weaken to land

        // Write basic timing to port 1 for status.js — clear first so port never fills
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

/**
 * Full HWGW mode. Runs on tier 1+ home, workers on purchased/rooted servers only.
 * @param {NS} ns
 */
async function runFullMode(ns) {
    ns.tprint('=== orchestrate.js v1.2.0 | TIER ' + getRamTier(ns) + ' full HWGW mode ===');

    const cycleEnds  = {};                                                          // host -> expected cycleEnd timestamp
    const hackMode   = new Set();                                                   // Targets that have received HACK batches
    let activePrepTarget = null;                                                     // Serialised PREP: one target at a time

    while (true) {

        // If tier has dropped back to 0 (e.g. augment reset mid-run), restart in tier 0
        if (getRamTier(ns) === 0) {
            ns.tprint('[ORCHESTRATE] Tier dropped to 0 — restarting in early mode');
            ns.exec('scripts/orchestrate.js', 'home', 1);
            return;
        }

        // Refresh targets and worker farm each cycle
        const workerList = getWorkerServers(ns);                                    // Rooted non-home servers, largest-first
        const targets    = getRankedTargets(ns).slice(0, MAX_TARGETS);              // Top N targets by score

        if (targets.length === 0) {
            log(ns, 'No valid targets — waiting');
            await ns.sleep(5000);
            continue;
        }

        // Build thread pool from servers with worker.js present
        // worker.js pre-copied by bootstrap (initial farm) and auto-root (new roots)
        const pool = workerList
            .filter(host => ns.fileExists(WORKER_SCRIPT, host))
            .map(host => ({
                host,
                available: Math.floor(
                    (ns.getServerMaxRam(host) - ns.getServerUsedRam(host)) / WORKER_RAM
                ),
            }))
            .filter(slot => slot.available > 0);                                    // Exclude servers with no free RAM

        const totalAvailableThreads = pool.reduce((s, p) => s + p.available, 0);
        let   threadsRemaining      = totalAvailableThreads;
        let   batchesLaunched       = 0;
        let   prepLaunched          = 0;
        const targetTiming          = {};                                            // Timing payload for port 1

        const now = Date.now();

        // Cache isPrepped per target — hackMode targets always treated as prepped
        // (their HWGW batch handles restoration; PREP on top would conflict)
        const preppedCache = {};
        for (const t of targets) {
            preppedCache[t.host] = hackMode.has(t.host) || isPrepped(ns, t.host);
        }

        // Update activePrepTarget only when necessary — avoid mid-prep switching
        const targetHosts = new Set(targets.map(t => t.host));
        if (
            activePrepTarget === null ||
            !targetHosts.has(activePrepTarget) ||
            preppedCache[activePrepTarget]
        ) {
            // Pick next unprepped non-hackMode target
            activePrepTarget = (targets.find(t => !preppedCache[t.host] && !hackMode.has(t.host)) || {}).host || null;
            if (activePrepTarget) log(ns, '[PREP TARGET] ' + activePrepTarget);
        }

        // Check port 2 for new root events from auto-root.js (non-consuming peek)
        const rootEvent = readPort(ns, PORT_AUTOROOT);
        if (rootEvent) {
            log(ns, 'New root detected: ' + rootEvent.host + ' — SCP will cover next cycle');
        }

        log(ns, '--- cycle | threads: ' + totalAvailableThreads + ' | targets: ' + targets.length + ' ---');

        // --- Phase 1 Pass 1: HACK batches for all prepped targets ---
        for (const t of targets) {
            if (threadsRemaining <= 0) break;

            // Skip if previous batch still in flight
            if (cycleEnds[t.host] && cycleEnds[t.host] > now) {
                log(ns, '[SKIP] ' + t.host + ' — cycle ends in ' + formatTime(cycleEnds[t.host] - now));
                continue;
            }

            if (!preppedCache[t.host]) continue;                                    // Not prepped — handled in Pass 2

            const batch = calcBatchThreads(ns, t.host, threadsRemaining);
            if (!batch) {
                if (hackMode.has(t.host)) {
                    // Money depleted mid-flight — grow still in-flight, extend cycleEnd to wait
                    const wt = ns.getWeakenTime(t.host);
                    cycleEnds[t.host] = now + wt;
                    log(ns, '[WAIT-HACK] ' + t.host + ' — money depleted, waiting for grow');
                } else {
                    log(ns, '[HACK] ' + t.host + ' — thread calc failed, skipping');
                }
                continue;
            }

            // Allocate all four job types — roll back cleanly on any failure
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

            // Calculate delays so all four jobs land in strict H→WH→G→WG order
            const weakenTime  = ns.getWeakenTime(t.host);                          // Reference duration (slowest op)
            const hackTime    = ns.getHackTime(t.host);
            const growTime    = ns.getGrowTime(t.host);

            const hackDelay    = weakenTime - hackTime   - LAND_SPACING;           // H fires late, lands LAND_SPACING before WH
            const weakenHDelay = 0;                                                 // WH fires immediately — reference point
            const growDelay    = weakenTime - growTime   + LAND_SPACING;           // G lands LAND_SPACING after WH
            const weakenGDelay = LAND_SPACING * 2;                                  // WG fires 2 spacings after WH fires

            launchWorkers(ns, 'hack',   hackAlloc,    t.host, hackDelay);
            launchWorkers(ns, 'weaken', weakenHAlloc, t.host, weakenHDelay);
            launchWorkers(ns, 'grow',   growAlloc,    t.host, growDelay);
            launchWorkers(ns, 'weaken', weakenGAlloc, t.host, weakenGDelay);

            threadsRemaining  -= batch.totalThreads;
            batchesLaunched++;
            hackMode.add(t.host);                                                   // Mark HACK — prevents PREP dispatch on top

            cycleEnds[t.host]     = now + weakenTime + LAND_SPACING * 4;           // Full cycle duration
            targetTiming[t.host]  = { weakenTime, mode: 'HACK' };

            log(ns, '[HACK] ' + t.host + ' | steal:' + (batch.stealFraction * 100).toFixed(1) + '% | H:' + batch.hackThreads + ' WH:' + batch.weakenHThreads + ' G:' + batch.growThreads + ' WG:' + batch.weakenGThreads + ' | total:' + batch.totalThreads + ' | cycle:' + formatTime(weakenTime));
        }

        // --- Phase 1 Pass 2: PREP for active target using remaining RAM ---
        if (threadsRemaining > 0 && activePrepTarget) {
            const t = targets.find(t => t.host === activePrepTarget);

            if (t && !preppedCache[t.host]) {
                // Silent skip if cycle still in flight — Pass 1 already logged SKIP
                const cycleActive = cycleEnds[t.host] && cycleEnds[t.host] > now;

                if (!cycleActive) {
                    const prep = calcPrepThreads(ns, t.host, threadsRemaining);

                    if (prep.totalThreads > 0) {
                        // Allocate weaken first to prevent server overlap with grow
                        const weakenAlloc = prep.weakenThreads > 0 ? allocate(pool, prep.weakenThreads) : [];
                        if (prep.weakenThreads > 0 && !weakenAlloc) {
                            log(ns, '[PREP] ' + t.host + ' — insufficient RAM for weaken');
                        } else {
                            if (weakenAlloc && weakenAlloc.length > 0) applyAllocation(pool, weakenAlloc);

                            const growAlloc = prep.growThreads > 0 ? allocate(pool, prep.growThreads) : [];
                            if (prep.growThreads > 0 && !growAlloc) {
                                if (weakenAlloc && weakenAlloc.length > 0) freeAllocation(pool, weakenAlloc);
                                log(ns, '[PREP] ' + t.host + ' — insufficient RAM for grow');
                            } else {
                                if (growAlloc && growAlloc.length > 0) applyAllocation(pool, growAlloc);

                                const weakenTime  = ns.getWeakenTime(t.host);
                                const growTime    = ns.getGrowTime(t.host);
                                // Grow fires first; weaken delayed so both land close together
                                const weakenDelay = Math.max(0, growTime - weakenTime + LAND_SPACING);

                                if (growAlloc   && growAlloc.length   > 0) launchWorkers(ns, 'grow',   growAlloc,   t.host, 0);
                                if (weakenAlloc && weakenAlloc.length > 0) launchWorkers(ns, 'weaken', weakenAlloc, t.host, weakenDelay);

                                const prepThreads = (growAlloc   ? growAlloc.reduce((s, a)   => s + a.threads, 0) : 0)
                                                  + (weakenAlloc ? weakenAlloc.reduce((s, a) => s + a.threads, 0) : 0);
                                threadsRemaining   -= prepThreads;
                                prepLaunched++;

                                cycleEnds[t.host]    = now + Math.max(growTime, weakenTime) + 500;
                                targetTiming[t.host] = { weakenTime, mode: 'PREP' };

                                const sec    = ns.getServerSecurityLevel(t.host);
                                const minSec = ns.getServerMinSecurityLevel(t.host);
                                const money  = ns.getServerMoneyAvailable(t.host);
                                const maxMon = ns.getServerMaxMoney(t.host);
                                log(ns, '[PREP-' + prep.phase + '] ' + t.host + ' | sec:' + sec.toFixed(1) + '/' + minSec.toFixed(1) + ' | $' + ns.format.number(money, '0.0a') + '/$' + ns.format.number(maxMon, '0.0a') + ' | G:' + prep.growThreads + ' W:' + prep.weakenThreads + ' | ~' + formatTime(weakenTime));
                            }
                        }
                    }
                }
            }
        }

        // Write cycle timing to port 1 for status.js — clear first so port never fills
        clearPort(ns, PORT_STATUS);
        writePort(ns, PORT_STATUS, { cycleStart: now, targets: targetTiming });

        // --- Secondary pass: weaken-only on queued targets using surplus RAM ---
        // Advances security on non-active unprepped targets without disrupting prep logic
        if (threadsRemaining > 0) {
            for (const t of targets) {
                if (threadsRemaining <= 0) break;
                if (t.host === activePrepTarget) continue;                          // Active prep target already handled
                if (preppedCache[t.host]) continue;                                 // Already prepped
                if (cycleEnds[t.host] && cycleEnds[t.host] > now) continue;        // Cycle in flight — skip silently

                const sec             = ns.getServerSecurityLevel(t.host);
                const minSec          = ns.getServerMinSecurityLevel(t.host);
                const secDelta        = Math.max(0, sec - minSec);
                if (secDelta <= 0) continue;                                        // Security already at minimum

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
            // Pre-calculate batch size per target; null = target invalid for overflow
            const targetBatches = preppedTargets.map(t => ({
                target    : t,
                batch     : calcBatchThreads(ns, t.host, threadsRemaining),
                weakenTime: ns.getWeakenTime(t.host),
                hackTime  : ns.getHackTime(t.host),
                growTime  : ns.getGrowTime(t.host),
                offset    : batchesLaunched * BATCH_SPACING,                        // Stagger starts after primary batches
            })).filter(tb => tb.batch !== null);

            if (targetBatches.length > 0) {
                const minBatchSize   = Math.min(...targetBatches.map(tb => tb.batch.totalThreads));
                const reserveThreads = preppedTargets.length * minBatchSize;        // Hold back one batch per target for next cycle
                const overflowBudget = Math.max(0, threadsRemaining - reserveThreads);
                const minWeakenTime  = Math.min(...targetBatches.map(tb => tb.weakenTime));
                const cycleSlots     = Math.floor(minWeakenTime / BATCH_SPACING);   // Max batches fitting in shortest cycle window

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
                    tb.offset        += BATCH_SPACING;                              // Advance this target's stagger for next batch
                    totalOverflow++;
                    overflowLog[tb.target.host] = (overflowLog[tb.target.host] || 0) + 1;

                    // Extend cycleEnd to cover last overflow batch landing
                    cycleEnds[tb.target.host] = now + tb.offset + tb.weakenTime + LAND_SPACING * 4;
                }

                for (const host of Object.keys(overflowLog)) {
                    log(ns, '[OVERFLOW] ' + host + ' — ' + overflowLog[host] + ' extra batch(es)');
                }
            }
        }

        log(ns, 'Batches: ' + batchesLaunched + ' hack | ' + prepLaunched + ' prep | threads used: ' + (totalAvailableThreads - threadsRemaining) + '/' + totalAvailableThreads);

        // Cycle-aware sleep: wake at nearest active cycleEnd
        const pendingEnds = targets
            .map(t => cycleEnds[t.host])
            .filter(e => e !== undefined && e > now);

        const sleepTime = pendingEnds.length > 0
            ? Math.min(...pendingEnds) - now
            : 10000;                                                                // Fallback: no active targets dispatched

        log(ns, 'Next cycle in ' + formatTime(sleepTime));
        await ns.sleep(Math.max(sleepTime, LOOP_SLEEP));
    }
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([['help', false]]);

    if (flags.help) {
        ns.tprint('=== orchestrate.js v1.2.0 ===');
        ns.tprint('Purpose: Tier-aware HWGW batch scheduler. Manages grow/weaken/hack');
        ns.tprint('         workers across all rooted servers to maximise income.');
        ns.tprint('Usage:   run /scripts/orchestrate.js');
        ns.tprint('Flags:');
        ns.tprint('  --help   Show this help and exit');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 1: cycle timing data for status.js');
        ns.tprint('  Reads  port 2: new root events from auto-root.js (peek only)');
        return;
    }

    ns.disableLog('ALL');

    clearPort(ns, PORT_STATUS);                                                     // Clear stale port 1 data from any previous run
    ns.atExit(() => clearPort(ns, PORT_STATUS));                                    // Clear port 1 on exit so status.js shows no-data immediately

    const tier = getRamTier(ns);
    if (tier === 0) {
        await runTier0(ns);
    } else {
        await runFullMode(ns);
    }
}
