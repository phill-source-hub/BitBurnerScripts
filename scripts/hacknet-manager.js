/**
 * hacknet-manager.js
 * Version: 1.0.0
 *
 * Manages hacknet nodes — purchases new nodes and upgrades existing ones.
 *
 * Behaviour:
 *   Each cycle, spends available money on hacknet in this priority order:
 *     1. Buy new node (if below no hard cap — game limits naturally)
 *     2. Upgrade level on all nodes (up to MAX_LEVEL)
 *     3. Upgrade RAM on all nodes (up to MAX_RAM)
 *     4. Upgrade cores on all nodes (up to MAX_CORES)
 *
 *   All purchases check canAfford() first — 10% floor plus --reserve balance.
 *   Writes node stats to port 3 each cycle for status.js.
 *   Runs indefinitely (always managing) — does not self-exit.
 *
 *   Hacknet constants are hardcoded because they are not exposed in the NS API:
 *     MaxLevel = 200, MaxRam = 64, MaxCores = 16
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --help        Show version, usage, and flags then exit
 *   --reserve N   Additional minimum balance to retain beyond 10% floor (default: 0)
 *
 * Ports:
 *   Writes port 3: { nodes, totalIncome, totalSpent } each cycle
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    log,
    canAfford,
    writePort,
    clearPort,
} from '/scripts/lib-utils.js';

// --- Hacknet caps (not exposed in NS API — hardcoded per BitBurner v3.0.1) ---
const MAX_LEVEL  = 200;                                                             // Maximum hacknet node level
const MAX_RAM    = 64;                                                              // Maximum hacknet node RAM (GB)
const MAX_CORES  = 16;                                                              // Maximum hacknet node core count

// --- Timing ---
const LOOP_SLEEP = 5000;                                                            // ms between management cycles

// --- Port ---
const PORT_HACKNET = 3;                                                             // Port this script owns and writes stats to


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',    false],
        ['reserve', 0],
    ]);

    if (flags.help) {
        ns.tprint('=== hacknet-manager.js v1.0.0 ===');
        ns.tprint('Purpose: Purchases and upgrades hacknet nodes for passive income.');
        ns.tprint('         Runs continuously — does not self-exit.');
        ns.tprint('Usage:   run /scripts/hacknet-manager.js [--reserve N]');
        ns.tprint('Flags:');
        ns.tprint('  --help        Show this help and exit');
        ns.tprint('  --reserve N   Keep at least N additional dollars beyond 10% floor (default: 0)');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 3: { nodes, totalIncome, totalSpent } each cycle');
        ns.tprint('Caps (hardcoded, not in NS API):');
        ns.tprint('  MaxLevel=' + MAX_LEVEL + '  MaxRam=' + MAX_RAM + 'GB  MaxCores=' + MAX_CORES);
        return;
    }

    ns.tprint('=== hacknet-manager.js v1.0.0 | reserve:$' + flags.reserve + ' ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    clearPort(ns, PORT_HACKNET);                                                    // Clear stale port 3 data from any previous run
    ns.atExit(() => clearPort(ns, PORT_HACKNET));                                   // Clear port 3 on exit so status.js shows no-data immediately

    const reserve    = flags.reserve;
    let   totalSpent = 0;                                                           // Track total money spent this session

    while (true) {
        const nodeCount = ns.hacknet.numNodes();                                    // Current number of hacknet nodes

        // --- Priority 1: Buy a new node if we can afford it ---
        const newNodeCost = ns.hacknet.getPurchaseNodeCost();
        if (canAfford(ns, newNodeCost, reserve)) {
            const idx = ns.hacknet.purchaseNode();                                  // Returns index of new node, or -1 on fail
            if (idx !== -1) {
                totalSpent += newNodeCost;
                log(ns, 'Purchased hacknet node ' + idx + ' | cost: $' + ns.format.number(newNodeCost));
            }
        }

        // --- Priority 2: Upgrade level on all nodes ---
        for (let i = 0; i < ns.hacknet.numNodes(); i++) {
            const stats = ns.hacknet.getNodeStats(i);                               // Current stats for this node
            if (stats.level >= MAX_LEVEL) continue;                                 // Already at cap

            const cost = ns.hacknet.getLevelUpgradeCost(i, 1);                     // Cost to add 1 level
            if (!canAfford(ns, cost, reserve)) continue;                            // Floor check — skip if unaffordable

            const ok = ns.hacknet.upgradeLevel(i, 1);
            if (ok) {
                totalSpent += cost;
                log(ns, 'Node ' + i + ' level -> ' + (stats.level + 1));
            }
        }

        // --- Priority 3: Upgrade RAM on all nodes ---
        for (let i = 0; i < ns.hacknet.numNodes(); i++) {
            const stats = ns.hacknet.getNodeStats(i);
            if (stats.ram >= MAX_RAM) continue;                                     // Already at cap

            const cost = ns.hacknet.getRamUpgradeCost(i, 1);                       // Cost to double RAM once
            if (!canAfford(ns, cost, reserve)) continue;

            const ok = ns.hacknet.upgradeRam(i, 1);
            if (ok) {
                totalSpent += cost;
                log(ns, 'Node ' + i + ' RAM -> ' + (stats.ram * 2) + 'GB');
            }
        }

        // --- Priority 4: Upgrade cores on all nodes ---
        for (let i = 0; i < ns.hacknet.numNodes(); i++) {
            const stats = ns.hacknet.getNodeStats(i);
            if (stats.cores >= MAX_CORES) continue;                                 // Already at cap

            const cost = ns.hacknet.getCoreUpgradeCost(i, 1);                      // Cost to add 1 core
            if (!canAfford(ns, cost, reserve)) continue;

            const ok = ns.hacknet.upgradeCore(i, 1);
            if (ok) {
                totalSpent += cost;
                log(ns, 'Node ' + i + ' cores -> ' + (stats.cores + 1));
            }
        }

        // --- Write stats to port 3 for status.js ---
        const currentNodeCount = ns.hacknet.numNodes();
        let   totalIncome      = 0;
        for (let i = 0; i < currentNodeCount; i++) {
            totalIncome += ns.hacknet.getNodeStats(i).production;                   // Sum production rate across all nodes
        }

        clearPort(ns, PORT_HACKNET);
        writePort(ns, PORT_HACKNET, {
            nodes       : currentNodeCount,
            totalIncome,                                                             // $/s across all nodes
            totalSpent,                                                             // Cumulative spend this session
        });

        log(ns, 'Nodes: ' + currentNodeCount + ' | income: $' + ns.format.number(totalIncome) + '/s | spent: $' + ns.format.number(totalSpent));

        await ns.sleep(LOOP_SLEEP);
    }
}
