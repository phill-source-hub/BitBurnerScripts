/**
 * orchestrate.js
 * Version: 2.9.1
 *
 * HWGW batch scheduler with multi-target support.
 *
 * Strategy — HWGW batching:
 *   Each batch fires four one-shot workers with calculated delays so they
 *   land on the target in strict order, spaced LAND_SPACING ms apart:
 *     1. Hack     — steals 50% of max money
 *     2. WeakenH  — cancels hack's security increase
 *     3. Grow     — restores money to max
 *     4. WeakenG  — cancels grow's security increase
 *
 *   Because all four jobs complete before the next batch touches the server,
 *   the target stays at min-security / max-money permanently, maximising
 *   hack yield on every batch.
 *
 * Strategy — multi-target:
 *   All hackable rooted servers are ranked by score (see lib-utils getRankedTargets).
 *   The scheduler assigns batches to the top-ranked targets in order until
 *   available RAM is exhausted. Spare RAM after primary targets are served
 *   is used for additional batches on the highest-ranked prepped target.
 *
 * Strategy — PREP:
 *   A target not yet at min-security / max-money is in PREP mode.
 *   PREP batches use only grow and weaken workers (no hack) until the
 *   server is fully prepared. isPrepped() uses tight thresholds (sec ≤
 *   min+1, money ≥ 99% max) required for accurate batch timing.
 *
 * Timing model:
 *   weakenTime is the reference duration (slowest operation).
 *   grow and hack are fired late so all four land at:
 *     H   lands at: t + 0ms  (weakenTime - hackTime   - LAND_SPACING)
 *     WH  lands at: t + 1×LAND_SPACING
 *     G   lands at: t + 2×LAND_SPACING  (weakenTime - growTime   + LAND_SPACING)
 *     WG  lands at: t + 3×LAND_SPACING
 *
 *   Consecutive batches on the same target are staggered by BATCH_SPACING ms
 *   so their landing windows never collide.
 *
 * Cycle-aware sleep:
 *   Each dispatched target records its expected cycleEnd timestamp
 *   (= now + weakenTime + LAND_SPACING * 4). The scheduler sleeps until
 *   the nearest cycleEnd rather than the raw shortest weakenTime. On wake,
 *   targets whose cycleEnd is still in the future are skipped — preventing
 *   redundant re-dispatch of slow targets during a fast target's cycle.
 *
 * RAM allocation:
 *   Worker servers are sorted largest-first to minimise process count.
 *   Each batch of 4 workers is allocated from the pool greedily.
 *   Home server is always excluded.
 *   SCP is run each cycle to push worker scripts to any new servers.
 *
 * Port 1 — cycle timing data for status.js dashboard:
 *   After each Phase 1 dispatch, writes a JSON payload to port 1:
 *     { cycleStart: number, targets: { [host]: { weakenTime, mode } } }
 *   status.js reads this with ns.peek(1) (non-consuming) to drive
 *   per-target countdown timers. Port is cleared on startup.
 *
 * Changelog:
 *   v1.0.0 - v1.8.0 — continuous worker model (see git history)
 *   v2.0.0 - Full rewrite: HWGW batch scheduling, multi-target, retired
 *            calc-threads.js dependency, home always excluded, loop implied
 *   v2.1.0 - Writes cycle timing payload to port 1 after each Phase 1
 *            dispatch for status.js per-target countdown support
 *   v2.2.0 - freeAllocation() rollback, hackAnalyzeThreads guard, cycle-aware sleep
 *   v2.3.0 - calcPrepThreads: weaken-first strategy (Phase A / Phase B)
 *            Phase A: all threads to weaken when sec > min+2
 *            Phase B: grow + weaken (SAFE_WEAKEN_PER_GROW ratio) when sec at min
 *            existingSecInc included in Phase B weaken budget
 *            cycleEnd buffer set to max(growTime, weakenTime) + 500ms
 *   v2.4.0 - Serialised PREP: one active prep target at a time, persists across
 *            cycles, only changes on completion or rank drop
 *            Secondary [SEC] weaken pass uses surplus RAM on queued targets
 *            SAFE_WEAKEN_PER_GROW = 1/4 (replaces growthAnalyzeSecurity())
 *            WORKER_* paths: removed leading slash to match ns.exec() resolution
 *            EXEC FAIL logged to ns.print; exec failures are transient RAM contention
 *            PREP allocation: weaken committed before grow to prevent server overlap
 *            activePrepTarget persists; no longer reassigned mid-cycle
 *   v2.5.0 - Phase A threshold raised to > 2 (Phase B covers deltas up to 2.0)
 *            SAFE_WEAKEN_PER_GROW promoted to module-level constant
 *   v2.6.0 - Phase 1 split into two passes: HACK first, then PREP
 *            Prepped targets no longer starved by active PREP consuming all RAM
 *   v2.7.0 - calcBatchThreads: binary search for optimal steal fraction
 *            Previously hardcoded 50% required thousands of grow threads
 *            Binary search between MIN_STEAL=1% and MAX_STEAL=50%
 *            Per-target thread budget: threadsRemaining / dispatchSlots
 *            HACK log shows steal% and total threads
 *   v2.8.0 - Removed WAIT guard and lastPrepPhase tracking (no longer needed
 *            now weaken correctly allocated to separate servers via commit-first)
 *   v2.8.1 - Fixed: hackMode Set added. Targets receiving HACK batches are marked
 *            permanently — isPrepped() returning false mid-cycle no longer causes
 *            PREP dispatch on top of in-flight HACK workers. preppedCache treats
 *            hackMode targets as always prepped. activePrepTarget excludes hackMode.
 *            Fixed: duplicate [SKIP] lines — Pass 2 PREP skip now silent.
 *   v2.9.1 - Fixed: Overflow cycleEnd now updated after each batch to cover the
 *            last overflow batch's landing time. Without this the scheduler woke
 *            while late overflow batches were still in-flight (e.g. 174 batches
 *            × 100ms = 17.4s stagger beyond primary cycleEnd), causing re-dispatch
 *            on a server with depleted money and triggering hackMode $0 fallback.
 *   v2.9.0 - Rewrote Phase 2 overflow as round-robin across all prepped targets.
 *            Previously all overflow went to topTarget (best scorer) only.
 *            Now cycles through all prepped targets in rank order, one batch
 *            per target per round. Per-target batch sizes calculated upfront.
 *            Reserve threads holds back one batch per target for next cycle.
 *            Slot cap uses shortest weakenTime target as reference. Logs
 *            per-target overflow counts. Scales correctly at all RAM levels.
 *   v2.8.6 - Fixed: Dynamic overflow cap replacing hardcoded MAX_OVERFLOW=50.
 *            cycleSlots = floor(weakenTime / BATCH_SPACING) — max batches in window.
 *            reserveThreads = MAX_TARGETS * batch.totalThreads — holds back one
 *            batch per target for next cycle's primaries.
 *            maxOverflow = min(cycleSlots, floor(overflowBudget / batchSize)).
 *            Scales automatically: 0 overflow at 50 threads (early game),
 *            ~13 at 18k threads, ~450 at 896k threads within cycle window.
 *   v2.8.5 - Fixed: MAX_OVERFLOW=50 cap on overflow batches. At 896k
 *            threads with 1,277 threads/batch, overflow was launching 700+
 *            batches consuming all RAM. Next cycle pool showed 0 available,
 *            all targets SKIP'd indefinitely. Cap at 50 batches leaves surplus
 *            RAM for subsequent cycles across all targets.
 *   v2.8.4 - Fixed: Removed PREP_RESERVE, fully dynamic RAM scaling. At low RAM
 *            (early game ~100 threads) this starved both HACK and PREP. Now uses
 *            threadsRemaining directly for HACK — binary search scales naturally
 *            from 1% steal at 50 threads to 50% steal at 18k threads. PREP gets
 *            whatever remains after HACK batches allocate, which is correct since
 *            Pass 1 HACK runs first. Scales correctly at all RAM levels.
 *   v2.8.3 - Fixed: overflow cycleEnd, per-target budget replaced with PREP_RESERVE.
 *            far into the future with many overflow batches, causing all targets
 *            to be permanently SKIP'd with 18k threads idle. Primary batch
 *            cycleEnd (weakenTime + LAND_SPACING*4) is sufficient.
 *            Fixed: Per-target budget replaced with simple PREP_RESERVE (500
 *            threads). Each HACK target now gets threadsRemaining minus reserve,
 *            enabling full 50% steal batches at scale.
 *   v2.8.2 - Fixed: hackMode $0 money, overflow cycleEnd extension.
 *            of logging "thread calculation failed". Overflow batch cycleEnd updated
 *            after each batch to cover last worker landing, preventing early re-dispatch.
 *
 * Usage: run /scripts/orchestrate.js
 * View:  tail /scripts/orchestrate.js
 *
 * Dependencies: /scripts/lib/lib-utils.js
 */

import {
    getWorkerServers,
    getRankedTargets,
    isPrepped,
    formatTime,
} from '/scripts/lib/lib-utils.js';

// --- Worker script paths — no leading slash, matches ns.exec() file resolution ---
const WORKER_HACK   = 'scripts/worker-hack.js';                                   // Path to hack worker
const WORKER_GROW   = 'scripts/worker-grow.js';                                   // Path to grow worker
const WORKER_WEAKEN = 'scripts/worker-weaken.js';                                 // Path to weaken worker

// --- Timing constants ---
const LAND_SPACING  = 20;                                                          // ms between each job landing
const BATCH_SPACING = 100;                                                         // ms between consecutive batch starts on same target

// --- Allocation constants ---
const WORKER_RAM          = 1.75;                                                  // GB RAM cost per worker thread
const MAX_TARGETS         = 5;                                                     // Maximum simultaneous hack targets
const LOOP_SLEEP          = 200;                                                   // ms minimum sleep between scheduler cycles
const SAFE_WEAKEN_PER_GROW = 1 / 4;                                               // Safe weaken ratio: 1 weaken per 4 grow threads (3x safety margin over theoretical 12.5)

// --- Port constants ---
const STATUS_PORT   = 1;                                                           // Port used to share cycle timing with status.js

/** Helper to print to both terminal and log window */
function tlog(ns, msg) {
    ns.tprint(msg);                                                                // Print to terminal
    ns.print(msg);                                                                 // Print to log/tail window
}

/**
 * Calculates thread counts for a single HWGW batch on a target.
 * Assumes target is fully prepped (min security, max money).
 *
 * Uses binary search to find the largest steal fraction that fits within
 * maxThreads. Starts at MAX_STEAL (50%) and searches down to MIN_STEAL (1%).
 * Returns null if even the minimum steal fraction exceeds maxThreads.
 *
 * Grow threads use the safe weaken ratio (SAFE_WEAKEN_PER_GROW = 1/4) for
 * weakenG rather than growthAnalyzeSecurity(), which underestimates in-game
 * security increase by ~3x.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {number} maxThreads - Maximum threads available for this batch
 * @returns {{ hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction }|null}
 */
function calcBatchThreads(ns, target, maxThreads) {
    const maxMoney       = ns.getServerMaxMoney(target);                           // Max money on target
    const weakenPerThread = ns.weakenAnalyze(1);                                   // Security reduction per weaken thread
    const MIN_STEAL      = 0.01;                                                   // Minimum steal fraction (1%) — below this not worthwhile
    const MAX_STEAL      = 0.50;                                                   // Maximum steal fraction (50%) — standard HWGW target

    /**
     * Calculate total threads required for a given steal fraction.
     * Returns thread counts and total, or null if hackAnalyzeThreads is invalid.
     */
    function threadsForSteal(fraction) {
        const rawHack = ns.hackAnalyzeThreads(target, maxMoney * fraction);        // Threads to steal this fraction
        if (!isFinite(rawHack) || rawHack < 0) return null;                       // Invalid target state
        const hackThreads    = Math.max(1, Math.floor(rawHack));                   // Floor to whole threads, minimum 1
        const hackSecInc     = ns.hackAnalyzeSecurity(hackThreads, target);        // Security increase from hack
        const weakenHThreads = Math.ceil(hackSecInc / weakenPerThread);            // Threads to cancel hack security increase
        const growMult       = Math.max(1.001, 1 / (1 - fraction));               // Multiplier to restore money after stealing fraction
        const growThreads    = Math.ceil(ns.growthAnalyze(target, growMult));      // Threads to restore money to max
        const weakenGThreads = Math.ceil(growThreads * SAFE_WEAKEN_PER_GROW) + 1; // Safe ratio weaken for grow's security increase
        const totalThreads   = hackThreads + weakenHThreads + growThreads + weakenGThreads;
        return { hackThreads, weakenHThreads, growThreads, weakenGThreads, totalThreads, stealFraction: fraction };
    }

    // --- Guard: check if minimum steal fits at all ---
    const minResult = threadsForSteal(MIN_STEAL);                                  // Test at minimum steal fraction
    if (!minResult) {                                                               // hackAnalyzeThreads returned invalid value
        ns.print(`[WARN] calcBatchThreads: invalid hackAnalyzeThreads for ${target}`);
        return null;
    }
    if (minResult.totalThreads > maxThreads) return null;                          // Even minimum steal doesn't fit — caller skips target

    // --- Binary search for largest steal fraction that fits within maxThreads ---
    let lo   = MIN_STEAL;                                                          // Lower bound — known to fit
    let hi   = MAX_STEAL;                                                          // Upper bound — may not fit
    let best = minResult;                                                          // Best result found so far

    for (let i = 0; i < 20; i++) {                                                // 20 iterations gives precision of ~0.0000001
        const mid    = (lo + hi) / 2;                                             // Midpoint steal fraction
        const result = threadsForSteal(mid);                                       // Calculate threads at midpoint
        if (result && result.totalThreads <= maxThreads) {                         // Fits within budget
            best = result;                                                         // Update best — try higher steal
            lo   = mid;                                                            // Raise lower bound
        } else {
            hi = mid;                                                              // Doesn't fit — lower upper bound
        }
    }

    return best;                                                                   // Return highest-steal batch that fits
}

/**
 * Calculates thread counts for a PREP cycle (grow + weaken only, no hack).
 *
 * Weaken-first strategy:
 *   Phase A — security above minimum: dedicate all available threads to weaken only.
 *             High security slows weaken/grow/hack times, so clearing it first is
 *             the most efficient path. Grow is skipped entirely this cycle.
 *   Phase B — security at minimum: grow to max money, plus weaken to cover grow's
 *             security increase. Scaled proportionally if over threadsRemaining budget.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {number} threadsRemaining - Threads still available in the pool this cycle
 * @returns {{ growThreads, weakenThreads, totalThreads, phase }}
 */
function calcPrepThreads(ns, target, threadsRemaining) {
    const weakenPerThread = ns.weakenAnalyze(1);                                   // Security reduction per weaken thread

    // --- Evaluate current security ---
    const security    = ns.getServerSecurityLevel(target);                         // Current security level
    const minSecurity = ns.getServerMinSecurityLevel(target);                      // Minimum security level
    const secDelta    = Math.max(0, security - minSecurity);                       // How much security remains to reduce

    // --- Phase A: security significantly above minimum — weaken only ---
    // Threshold of > 2 means Phase B handles minor drift (up to 2.0 above min)
    // without wasting a full cycle on weaken-only. isPrepped() accepts <= min+1,
    // so Phase B covers the gap between 1.0 and 2.0 via its existingSecInc weaken.
    // Phase A only fires when security is badly elevated and needs dedicated clearing.
    if (secDelta > 2) {                                                            // Only weaken-only when significantly above minimum
        const fullWeakenThreads  = Math.ceil(secDelta / weakenPerThread);          // Threads to fully clear security
        const weakenThreads      = Math.min(fullWeakenThreads, threadsRemaining);  // Cap to available budget
        return { growThreads: 0, weakenThreads, totalThreads: weakenThreads, phase: 'A' };
    }

    // --- Phase B: security at minimum — grow money to max ---
    const money    = ns.getServerMoneyAvailable(target);                           // Current money
    const maxMoney = ns.getServerMaxMoney(target);                                 // Max money

    let growThreads   = 0;                                                         // Default: no grow needed
    let weakenThreads = 0;                                                         // Default: no weaken needed

    // Weaken threads to cover existing security delta (may be up to 2.0 above min)
    // plus the security increase from grow. Both must be cleared in the same cycle.
    const existingSecInc = secDelta;                                               // Security already above minimum

    // Safe weaken ratio defined at module level as SAFE_WEAKEN_PER_GROW = 1/4.
    // growthAnalyzeSecurity() underestimates actual in-game increase by ~3x;
    // the fixed ratio provides a reliable safety margin.

    if (money < maxMoney * 0.99) {                                                 // Only grow if below 99% max
        const growMult = money > 0                                                 // Avoid divide-by-zero
            ? maxMoney / money                                                     // Required growth multiplier
            : 1e9;                                                                 // If empty, use large multiplier to fill from zero
        growThreads = Math.ceil(ns.growthAnalyze(target, Math.max(1.001, growMult))); // Threads to reach max money

        // Weaken covers: existing delta + safe-ratio estimate of grow's security increase
        const growSecEst  = growThreads * SAFE_WEAKEN_PER_GROW * weakenPerThread; // Estimated grow security increase (safe ratio)
        const totalSecEst = existingSecInc + growSecEst;                           // Total estimated security to clear
        weakenThreads = Math.ceil(totalSecEst / weakenPerThread) + 1;             // +1 buffer for rounding safety
    } else {
        // Money is at max but security may still need clearing
        weakenThreads = secDelta > 0
            ? Math.ceil(existingSecInc / weakenPerThread) + 1                     // Clear existing delta only
            : 0;
    }

    let totalThreads = growThreads + weakenThreads;                                // Total threads for this phase

    // --- Scale down if over budget ---
    // Grow is scaled first using the safe ratio to reserve correct weaken budget.
    // 1 weaken per 6 grow threads: budget = G + G/6 = G * (1 + 1/6) = G * 7/6
    // So max G = floor(budget_for_grow * 6/7)
    if (totalThreads > threadsRemaining && threadsRemaining > 0) {
        const existingWeakenCost = Math.ceil(existingSecInc / weakenPerThread) + 1; // Weaken threads for existing delta + buffer
        const budgetForGrow      = threadsRemaining - existingWeakenCost;          // Remaining budget after reserving existing weaken
        growThreads   = growThreads > 0 && budgetForGrow > 0
            ? Math.max(1, Math.floor(budgetForGrow / (1 + SAFE_WEAKEN_PER_GROW))) // Fit grow + safe weaken within budget
            : 0;
        // Recalculate weaken from scaled grow count using safe ratio
        weakenThreads = growThreads > 0
            ? Math.ceil((existingSecInc + growThreads * SAFE_WEAKEN_PER_GROW * weakenPerThread) / weakenPerThread) + 1
            : existingWeakenCost;                                                  // Fall back to existing delta only
        totalThreads  = growThreads + weakenThreads;                               // Recalculate total after correction
    }

    return { growThreads, weakenThreads, totalThreads, phase: 'B' };
}

/**
 * Attempts to allocate `threadsNeeded` threads from the pool.
 * Fills from the largest servers first to minimise process count.
 * Returns an array of { host, threads } allocations, or null if insufficient RAM.
 * Does not mutate the pool — caller must call applyAllocation() to commit.
 * @param {Array<{host: string, available: number}>} pool
 * @param {number} threadsNeeded
 * @returns {Array<{host: string, threads: number}>|null}
 */
function allocate(pool, threadsNeeded) {
    const result    = [];                                                           // Allocations to return
    let   remaining = threadsNeeded;                                               // Threads still to allocate

    for (const slot of pool) {                                                     // Iterate pool largest-first
        if (remaining <= 0) break;                                                 // Done if fully allocated
        if (slot.available <= 0) continue;                                         // Skip exhausted servers

        const take = Math.min(slot.available, remaining);                          // Take what's available up to need
        result.push({ host: slot.host, threads: take });                           // Record allocation
        remaining -= take;                                                         // Reduce remaining need
    }

    if (remaining > 0) return null;                                                // Insufficient RAM — reject
    return result;                                                                  // Return confirmed allocations
}

/**
 * Commits a confirmed allocation to the pool, reducing available counts.
 * @param {Array<{host: string, available: number}>} pool
 * @param {Array<{host: string, threads: number}>} allocations
 */
function applyAllocation(pool, allocations) {
    for (const alloc of allocations) {                                             // Iterate each allocation
        const slot = pool.find(s => s.host === alloc.host);                        // Find matching pool slot
        if (slot) slot.available -= alloc.threads;                                 // Deduct allocated threads from pool
    }
}

/**
 * Returns allocated threads back to the pool.
 * Used to roll back partial allocations when a batch cannot be fully satisfied.
 * @param {Array<{host: string, available: number}>} pool
 * @param {Array<{host: string, threads: number}>} allocations
 */
function freeAllocation(pool, allocations) {
    for (const alloc of allocations) {                                             // Iterate each allocation to reverse
        const slot = pool.find(s => s.host === alloc.host);                        // Find matching pool slot
        if (slot) slot.available += alloc.threads;                                 // Return threads to pool
    }
}

/**
 * Launches a set of worker allocations for a given script, target, and delay.
 * One ns.exec() call per server in the allocation.
 * @param {NS} ns
 * @param {string} script - Worker script path
 * @param {Array<{host: string, threads: number}>} allocations
 * @param {string} target - Target hostname passed as first arg
 * @param {number} delay - Delay in ms passed as --delay arg
 */
function launchWorkers(ns, script, allocations, target, delay, scpDone = null) {
    for (const alloc of allocations) {                                             // Iterate each allocation
        const pid = ns.exec(                                                       // Launch worker on assigned server
            script,
            alloc.host,
            alloc.threads,
            target,
            '--delay', delay                                                       // Pass delay for batch timing
        );
        if (pid === 0) {                                                           // Exec failed — likely RAM contention from in-flight workers
            ns.print(`[EXEC FAIL] ${script} on ${alloc.host} t:${alloc.threads} — RAM contention, resolves next cycle`);
        }
    }
}

/**
 * Writes cycle timing data to port 1 for status.js to consume.
 * Clears the port first so status.js always reads the freshest payload.
 * Payload: { cycleStart, targets: { [host]: { weakenTime, mode } } }
 * @param {NS} ns
 * @param {Object} targetTiming - Map of host -> { weakenTime, mode }
 */
function writeCycleData(ns, targetTiming) {
    ns.clearPort(STATUS_PORT);                                                     // Clear stale data before writing
    const payload = JSON.stringify({                                               // Build JSON payload
        cycleStart : Date.now(),                                                   // Timestamp of this cycle start
        targets    : targetTiming,                                                 // Per-target timing and mode
    });
    ns.writePort(STATUS_PORT, payload);                                            // Write to port 1
}

/**
 * Copies worker scripts to a server. Returns true if all copies succeeded.
 * Logs a warning for any server where SCP fails.
 * @param {NS} ns
 * @param {string} host - Destination server
 * @returns {boolean} True if all three workers were copied successfully
 */
async function scpWorkers(ns, host) {
    const ok = await ns.scp([WORKER_HACK, WORKER_GROW, WORKER_WEAKEN], host, 'home'); // Copy all three workers
    if (!ok) {                                                                     // SCP returned false — at least one file failed
        ns.print(`[WARN] scpWorkers: failed to copy workers to ${host} — skipping this server`);
    }
    return ok;                                                                     // Return success flag to caller
}

export async function main(ns) {
    ns.disableLog('ALL');                                                          // Suppress default NS logs

    ns.clearPort(STATUS_PORT);                                                     // Clear port on startup — remove stale data

    tlog(ns, '==========================================================');
    tlog(ns, ' ORCHESTRATE v2.9.1 — HWGW Batch Scheduler');
    tlog(ns, '==========================================================');

    // --- Track which servers have already received worker scripts ---
    const scpDone = new Set();                                                     // Servers that have had a successful SCP

    // --- Per-target cycle end timestamps — persisted across loop iterations ---
    const cycleEnds = {};                                                          // host -> expected cycleEnd timestamp (ms)

    // --- Track targets in HACK mode — persists across cycles ---
    // Once a target has received a HACK batch, it stays in HACK mode even when
    // isPrepped() returns false mid-cycle (money depleted by hack, grow/weaken
    // workers still in-flight). Prevents PREP being dispatched on top of HACK.
    const hackMode = new Set();                                                    // Hosts currently being hacked

    // --- Serialised PREP: persist active prep target across cycles ---
    // Only changes when the current target completes prep or leaves the target list.
    // Prevents switching to a higher-ranked target mid-prep and abandoning nearly-done targets.
    let activePrepTarget = null;                                                   // Currently active PREP target hostname

    // --- Main scheduler loop ---
    while (true) {

        // --- Refresh server and target lists each cycle ---
        const workerList = getWorkerServers(ns);                                   // Re-check worker farm each cycle
        const targets    = getRankedTargets(ns).slice(0, MAX_TARGETS);             // Top N targets by score

        if (targets.length === 0) {                                                // No valid targets available
            tlog(ns, ' ORCHESTRATE — No valid targets found. Waiting...');
            await ns.sleep(5000);                                                  // Wait before retrying
            continue;                                                               // Retry loop
        }

        // --- SCP worker scripts to any server not yet confirmed ---
        // Runs each cycle so newly purchased or newly rooted servers are covered.
        const scpReady = new Set();                                                // Servers confirmed ready this cycle
        for (const host of workerList) {                                           // Iterate every worker server
            if (scpDone.has(host)) {                                               // Already successfully copied
                scpReady.add(host);                                                // Mark ready without re-copying
                continue;
            }
            const ok = await scpWorkers(ns, host);                                 // Attempt SCP to this server
            if (ok) {                                                              // Copy succeeded
                scpDone.add(host);                                                 // Remember so we don't repeat
                scpReady.add(host);                                                // Mark ready for this cycle
            }
            // If !ok: server is skipped — not added to scpReady
        }

        // --- Build thread pool from servers that have worker scripts ---
        // Sorted largest-first (getWorkerServers guarantees this) to minimise process count
        const pool = workerList
            .filter(host => scpReady.has(host))                                    // Only servers with workers present
            .map(host => ({
                host,
                available: Math.floor(                                             // Available threads on this server
                    (ns.getServerMaxRam(host) - ns.getServerUsedRam(host)) / WORKER_RAM
                ),
            }))
            .filter(slot => slot.available > 0);                                   // Exclude servers with no free RAM

        const totalAvailableThreads = pool.reduce((s, p) => s + p.available, 0);  // Sum all available threads

        let threadsRemaining = totalAvailableThreads;                              // Track threads left to assign
        let batchesLaunched  = 0;                                                  // Count HACK batches fired this cycle
        let prepLaunched     = 0;                                                  // Count PREP cycles fired this cycle
        const targetTiming   = {};                                                 // Timing payload for status.js port write

        // --- Cache isPrepped result per target to avoid redundant NS calls ---
        // Targets in hackMode are treated as prepped regardless of current server state.
        // Their HWGW batch handles restoration — we must not dispatch PREP on top of HACK.
        const preppedCache = {};                                                   // host -> boolean
        for (const t of targets) {
            preppedCache[t.host] = hackMode.has(t.host) || isPrepped(ns, t.host); // hackMode targets always treated as prepped
        }

        // --- Update activePrepTarget only when necessary ---
        // Keep current target unless: it completed prep, it left the target list, or none is set.
        // hackMode targets are excluded — they self-restore via HWGW and never need PREP.
        const targetHosts = new Set(targets.map(t => t.host));                     // Set of current target hostnames
        if (
            activePrepTarget === null ||                                            // No active target yet
            !targetHosts.has(activePrepTarget) ||                                  // Target dropped off the list
            preppedCache[activePrepTarget]                                          // Target completed prep
        ) {
            activePrepTarget = targets.find(t => !preppedCache[t.host] && !hackMode.has(t.host))?.host ?? null; // Next unprepped non-HACK target
            if (activePrepTarget) tlog(ns, `  [PREP TARGET] ${activePrepTarget}`); // Log target change
        }

        tlog(ns, '==========================================================');
        tlog(ns, ` ORCHESTRATE — ${new Date().toLocaleTimeString()} | Threads available: ${totalAvailableThreads}`);

        const now = Date.now();                                                    // Snapshot current time for cycle comparisons

        // --- Phase 1, Pass 1: HACK batches for all prepped targets ---
        // Each target gets a batch sized by binary search within threadsRemaining.
        // Pass 2 PREP runs after with whatever threads remain — no pre-reserve needed.
        // At low RAM: binary search finds a small steal%; at high RAM: hits 50% cap.
        // Targets are already ranked by score — highest value targets get batches first.
        for (const t of targets) {
            if (threadsRemaining <= 0) break;                                      // No threads left

            // --- Skip targets whose previous batch cycle is still in flight ---
            if (cycleEnds[t.host] && cycleEnds[t.host] > now) {                   // CycleEnd exists and is in the future
                tlog(ns, `  [SKIP] ${t.host} — cycle ends in ${formatTime(cycleEnds[t.host] - now)}`);
                continue;                                                           // Do not re-dispatch this target yet
            }

            if (!preppedCache[t.host]) continue;                                   // Not prepped — handled in Pass 2

            // --- HACK: full HWGW batch — binary search finds best steal% within available RAM ---
            const batch = calcBatchThreads(ns, t.host, threadsRemaining);          // Size batch to available threads
            if (!batch) {
                if (hackMode.has(t.host)) {
                    // hackMode target with $0 money — grow from previous batch still in-flight.
                    // Extend cycleEnd to wait for restoration rather than logging an error.
                    const wt = ns.getWeakenTime(t.host);                           // Use weakenTime as wait duration
                    cycleEnds[t.host] = now + wt;                                  // Wait one full weaken cycle
                    ns.print(`[WAIT-HACK] ${t.host} — money depleted, waiting for grow to land`);
                } else {
                    tlog(ns, `  [HACK] ${t.host} — thread calculation failed, skipping`);
                }
                continue;
            }

            // Allocate all four job types — roll back cleanly if any step fails
            const hackAlloc = allocate(pool, batch.hackThreads);                   // Allocate hack threads
            if (!hackAlloc) continue;                                              // Not enough RAM — skip target
            applyAllocation(pool, hackAlloc);                                      // Commit hack threads

            const weakenHAlloc = allocate(pool, batch.weakenHThreads);            // Allocate weaken-H threads
            if (!weakenHAlloc) {
                freeAllocation(pool, hackAlloc);
                continue;
            }
            applyAllocation(pool, weakenHAlloc);                                   // Commit weaken-H threads

            const growAlloc = allocate(pool, batch.growThreads);                   // Allocate grow threads
            if (!growAlloc) {
                freeAllocation(pool, hackAlloc);
                freeAllocation(pool, weakenHAlloc);
                continue;
            }
            applyAllocation(pool, growAlloc);                                      // Commit grow threads

            const weakenGAlloc = allocate(pool, batch.weakenGThreads);            // Allocate weaken-G threads
            if (!weakenGAlloc) {
                freeAllocation(pool, hackAlloc);
                freeAllocation(pool, weakenHAlloc);
                freeAllocation(pool, growAlloc);
                continue;
            }
            applyAllocation(pool, weakenGAlloc);                                   // Commit weaken-G threads

            // --- Calculate delays so all four jobs land in correct sequence ---
            const weakenTime = ns.getWeakenTime(t.host);                          // Slowest — reference duration
            const hackTime   = ns.getHackTime(t.host);                            // Hack duration
            const growTime   = ns.getGrowTime(t.host);                            // Grow duration

            // WH fires at t=0 (reference), lands at weakenTime
            // H  fires late, lands LAND_SPACING before WH
            // G  fires late, lands LAND_SPACING after WH
            // WG fires LAND_SPACING*2 after WH fires, lands last
            const hackDelay    = weakenTime - hackTime   - LAND_SPACING;          // H lands 1 spacing before WH
            const weakenHDelay = 0;                                                // WH fires immediately (reference)
            const growDelay    = weakenTime - growTime   + LAND_SPACING;          // G lands 1 spacing after WH
            const weakenGDelay = LAND_SPACING * 2;                                // WG fires 2 spacings after WH

            launchWorkers(ns, WORKER_HACK,   hackAlloc,    t.host, Math.max(0, hackDelay), scpDone);
            launchWorkers(ns, WORKER_WEAKEN, weakenHAlloc, t.host, weakenHDelay, scpDone);
            launchWorkers(ns, WORKER_GROW,   growAlloc,    t.host, Math.max(0, growDelay), scpDone);
            launchWorkers(ns, WORKER_WEAKEN, weakenGAlloc, t.host, weakenGDelay, scpDone);

            threadsRemaining -= batch.totalThreads;                                // Deduct from remaining budget
            batchesLaunched++;

            hackMode.add(t.host);                                                  // Mark as HACK mode — prevents PREP dispatch mid-cycle

            // Record cycle end for this target — used for sleep and skip logic
            cycleEnds[t.host] = now + weakenTime + LAND_SPACING * 4;              // Full cycle duration

            // Record timing for status.js — mode HACK, weakenTime is cycle duration
            targetTiming[t.host] = { weakenTime, mode: 'HACK' };

            tlog(ns, `  [HACK] ${t.host} | steal:${(batch.stealFraction*100).toFixed(1)}% | $${ns.format.number(t.maxMoney, '0.0a')} | H:${batch.hackThreads} WH:${batch.weakenHThreads} G:${batch.growThreads} WG:${batch.weakenGThreads} | threads:${batch.totalThreads} | cycle: ${formatTime(weakenTime)}`);
        }

        // --- Phase 1, Pass 2: PREP for active target using remaining RAM ---
        // Runs after all HACK batches are allocated so prepped targets are never starved.
        if (threadsRemaining > 0 && activePrepTarget) {
            const t = targets.find(t => t.host === activePrepTarget);              // Find active PREP target object

            if (t && !preppedCache[t.host]) {                                     // Still unprepped and in target list

                // --- Skip if cycle still in flight — silent, Pass 1 already logged SKIP ---
                if (cycleEnds[t.host] && cycleEnds[t.host] > now) {
                    // Silently skip — Pass 1 already logged [SKIP] for this target
                } else {

                    // --- PREP: weaken-first strategy (see calcPrepThreads) ---
                    const prep = calcPrepThreads(ns, t.host, threadsRemaining);    // Calculate prep threads

                    if (prep.totalThreads > 0) {

                        // Allocate weaken first, then grow against reduced pool
                        const weakenAlloc = prep.weakenThreads > 0
                            ? allocate(pool, prep.weakenThreads)
                            : [];                                                   // No weaken needed
                        if (prep.weakenThreads > 0 && !weakenAlloc) {
                            tlog(ns, `  [PREP] ${t.host} — insufficient RAM for weaken, skipping`);
                        } else {
                            if (weakenAlloc && weakenAlloc.length > 0) applyAllocation(pool, weakenAlloc); // Commit weaken

                            const growAlloc = prep.growThreads > 0
                                ? allocate(pool, prep.growThreads)
                                : [];                                               // No grow needed
                            if (prep.growThreads > 0 && !growAlloc) {
                                if (weakenAlloc && weakenAlloc.length > 0) freeAllocation(pool, weakenAlloc);
                                tlog(ns, `  [PREP] ${t.host} — insufficient RAM for grow, skipping`);
                            } else {
                                if (growAlloc && growAlloc.length > 0) applyAllocation(pool, growAlloc); // Commit grow

                                const weakenTime  = ns.getWeakenTime(t.host);     // Weaken duration
                                const growTime    = ns.getGrowTime(t.host);       // Grow duration
                                const weakenDelay = Math.max(0, growTime - weakenTime + LAND_SPACING);

                                if (growAlloc && growAlloc.length > 0) {
                                    launchWorkers(ns, WORKER_GROW, growAlloc, t.host, 0, scpDone);
                                }
                                if (weakenAlloc && weakenAlloc.length > 0) {
                                    launchWorkers(ns, WORKER_WEAKEN, weakenAlloc, t.host, weakenDelay, scpDone);
                                }

                                const prepCost = (growAlloc?.reduce((s, a) => s + a.threads, 0) ?? 0)
                                               + (weakenAlloc?.reduce((s, a) => s + a.threads, 0) ?? 0);
                                threadsRemaining -= prepCost;
                                prepLaunched++;

                                cycleEnds[t.host] = now + Math.max(growTime, weakenTime) + 500;

                                targetTiming[t.host] = { weakenTime, mode: 'PREP' };

                                const security    = ns.getServerSecurityLevel(t.host);
                                const minSecurity = ns.getServerMinSecurityLevel(t.host);
                                const money       = ns.getServerMoneyAvailable(t.host);
                                const maxMoney    = ns.getServerMaxMoney(t.host);
                                tlog(ns, `  [PREP-${prep.phase}] ${t.host} | sec: ${security.toFixed(1)}/${minSecurity.toFixed(1)} | $${ns.format.number(money, '0.0a')}/$${ns.format.number(maxMoney, '0.0a')} | G:${prep.growThreads} W:${prep.weakenThreads} | done in ~${formatTime(weakenTime)}`);
                            }
                        }
                    }
                }
            }
        }

        // --- Write cycle timing to port 1 for status.js dashboard ---
        writeCycleData(ns, targetTiming);                                          // Publish timing payload to port

        // --- Secondary pass: weaken-only on queued targets using leftover RAM ---
        // When the active PREP target only needs Phase A (few weaken threads), most
        // RAM sits idle. Use surplus to advance security on other unprepped targets.
        // Only Phase A weaken — no grow — so we never interfere with active prep logic.
        // Does not update activePrepTarget or lastPrepPhase.
        if (threadsRemaining > 0) {
            for (const t of targets) {
                if (threadsRemaining <= 0) break;                                   // No threads left

                if (t.host === activePrepTarget) continue;                         // Active target already handled
                if (preppedCache[t.host]) continue;                                // Already prepped — skip
                if (cycleEnds[t.host] && cycleEnds[t.host] > now) continue;       // Cycle still in flight — skip silently

                const security    = ns.getServerSecurityLevel(t.host);             // Current security
                const minSecurity = ns.getServerMinSecurityLevel(t.host);          // Minimum security
                const secDelta    = Math.max(0, security - minSecurity);           // Security above minimum
                if (secDelta <= 0) continue;                                       // Security already at min — skip

                const weakenPerThread = ns.weakenAnalyze(1);                       // Security reduction per weaken thread
                const fullWeaken      = Math.ceil(secDelta / weakenPerThread);     // Threads to fully clear security
                const weakenThreads   = Math.min(fullWeaken, threadsRemaining);    // Cap to available budget

                const weakenAlloc = allocate(pool, weakenThreads);                 // Allocate weaken threads
                if (!weakenAlloc) continue;                                        // Not enough RAM — skip
                applyAllocation(pool, weakenAlloc);                                // Commit allocation

                const weakenTime = ns.getWeakenTime(t.host);                      // Weaken duration
                launchWorkers(ns, WORKER_WEAKEN, weakenAlloc, t.host, 0, scpDone); // Fire immediately

                threadsRemaining  -= weakenThreads;                                // Deduct from budget
                cycleEnds[t.host]  = now + weakenTime + 500;                      // Set cycleEnd so we don't re-dispatch mid-flight

                tlog(ns, `  [SEC] ${t.host} | sec: ${security.toFixed(1)}/${minSecurity.toFixed(1)} | W:${weakenThreads} (surplus)`);
            }
        }

        // --- Phase 2: Round-robin overflow batches across all prepped targets ---
        // Distributes surplus RAM evenly across all prepped targets by cycling through
        // them in rank order. Each target gets one batch per round until the overflow
        // budget or cycle slot cap is reached. Scales automatically with available RAM:
        //   - Early game (~50 threads): budget exhausted immediately, 0-1 overflow batches
        //   - Mid game (~18k threads): ~13 batches distributed across targets
        //   - Late game (~896k threads): hundreds of batches spread across all targets
        const preppedTargets = targets.filter(t => preppedCache[t.host]);          // All prepped targets in rank order

        if (preppedTargets.length > 0 && threadsRemaining > 0) {

            // --- Calculate per-target batch sizes and global overflow budget ---
            // Each target may have a different batch size (different weakenTime, maxMoney).
            // Pre-calculate batch for each target; null means target can't be overflow-hacked.
            const targetBatches = preppedTargets.map(t => ({
                target: t,
                batch:  calcBatchThreads(ns, t.host, threadsRemaining),           // Size batch to current remaining RAM
                weakenTime: ns.getWeakenTime(t.host),
                hackTime:   ns.getHackTime(t.host),
                growTime:   ns.getGrowTime(t.host),
                offset:     batchesLaunched * BATCH_SPACING,                      // Per-target stagger offset starts after primaries
            })).filter(tb => tb.batch !== null);                                   // Exclude targets with invalid state

            if (targetBatches.length > 0) {
                // Reserve threads for next cycle's primary batches (one batch per target)
                const minBatchSize   = Math.min(...targetBatches.map(tb => tb.batch.totalThreads));
                const reserveThreads = preppedTargets.length * minBatchSize;      // Conservative reserve
                const overflowBudget = Math.max(0, threadsRemaining - reserveThreads);

                // Cycle slot cap: use the shortest weakenTime target as the reference
                const minWeakenTime  = Math.min(...targetBatches.map(tb => tb.weakenTime));
                const cycleSlots     = Math.floor(minWeakenTime / BATCH_SPACING); // Max batches fitting in shortest cycle

                let totalOverflow    = 0;                                          // Total overflow batches dispatched
                let roundIdx         = 0;                                          // Current position in round-robin
                const overflowLog    = {};                                         // Per-target overflow count for logging

                // Round-robin: one batch per target per round until budget/slots exhausted
                while (totalOverflow < cycleSlots && threadsRemaining > reserveThreads) {
                    const tb = targetBatches[roundIdx % targetBatches.length];     // Next target in rotation
                    roundIdx++;

                    // Re-check batch fits within remaining threads
                    if (threadsRemaining - tb.batch.totalThreads < reserveThreads) break;

                    // Stagger this batch within the target's own offset sequence
                    const hackDelay    = tb.weakenTime - tb.hackTime - LAND_SPACING + tb.offset;
                    const weakenHDelay = tb.offset;
                    const growDelay    = tb.weakenTime - tb.growTime + LAND_SPACING + tb.offset;
                    const weakenGDelay = LAND_SPACING * 2                          + tb.offset;

                    // Allocate all four — roll back on any failure and skip this target
                    const hackAlloc = allocate(pool, tb.batch.hackThreads);
                    if (!hackAlloc) { roundIdx++; continue; }                      // Skip — try next target
                    applyAllocation(pool, hackAlloc);

                    const weakenHAlloc = allocate(pool, tb.batch.weakenHThreads);
                    if (!weakenHAlloc) { freeAllocation(pool, hackAlloc); roundIdx++; continue; }
                    applyAllocation(pool, weakenHAlloc);

                    const growAlloc = allocate(pool, tb.batch.growThreads);
                    if (!growAlloc) { freeAllocation(pool, hackAlloc); freeAllocation(pool, weakenHAlloc); roundIdx++; continue; }
                    applyAllocation(pool, growAlloc);

                    const weakenGAlloc = allocate(pool, tb.batch.weakenGThreads);
                    if (!weakenGAlloc) { freeAllocation(pool, hackAlloc); freeAllocation(pool, weakenHAlloc); freeAllocation(pool, growAlloc); roundIdx++; continue; }
                    applyAllocation(pool, weakenGAlloc);

                    launchWorkers(ns, WORKER_HACK,   hackAlloc,    tb.target.host, Math.max(0, hackDelay), scpDone);
                    launchWorkers(ns, WORKER_WEAKEN, weakenHAlloc, tb.target.host, weakenHDelay, scpDone);
                    launchWorkers(ns, WORKER_GROW,   growAlloc,    tb.target.host, Math.max(0, growDelay), scpDone);
                    launchWorkers(ns, WORKER_WEAKEN, weakenGAlloc, tb.target.host, weakenGDelay, scpDone);

                    threadsRemaining         -= tb.batch.totalThreads;             // Deduct from remaining budget
                    tb.offset                += BATCH_SPACING;                     // Advance this target's stagger
                    totalOverflow++;                                                // Increment total overflow count
                    overflowLog[tb.target.host] = (overflowLog[tb.target.host] ?? 0) + 1; // Track per-target count

                    // Extend cycleEnd for this target to cover the last overflow batch landing.
                    // Last weaken lands at: now + tb.offset (after increment) + tb.weakenTime
                    cycleEnds[tb.target.host] = now + tb.offset + tb.weakenTime + LAND_SPACING * 4;
                }

                // Log overflow summary per target
                for (const [host, count] of Object.entries(overflowLog)) {
                    tlog(ns, `  [OVERFLOW] ${host} — ${count} extra batch(es)`);
                }
            }
        }

        tlog(ns, `  Batches: ${batchesLaunched} hack | ${prepLaunched} prep | Threads used: ${totalAvailableThreads - threadsRemaining}/${totalAvailableThreads}`);
        tlog(ns, '==========================================================');

        // --- Cycle-aware sleep: wake when the nearest active cycleEnd arrives ---
        // Only consider targets that were dispatched this cycle (have a cycleEnd entry).
        // This avoids waking on the shortest target's cadence when slower targets
        // still have batches in flight and nothing useful can be re-dispatched.
        const pendingEnds = targets
            .map(t => cycleEnds[t.host])                                           // Get cycleEnd for each target
            .filter(e => e !== undefined && e > now);                              // Only future cycleEnds

        const sleepTime = pendingEnds.length > 0
            ? Math.min(...pendingEnds) - now                                       // Sleep until the nearest cycleEnd
            : 10000;                                                                // Fallback: all targets in PREP or no data

        tlog(ns, ` Next cycle in ${formatTime(sleepTime)}`);
        tlog(ns, '==========================================================');

        await ns.sleep(Math.max(sleepTime, LOOP_SLEEP));                           // Respect minimum loop sleep
    }
}
