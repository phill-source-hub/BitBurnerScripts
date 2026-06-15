/**
 * hacknet-manager.js
 * Version: 1.2.0
 *
 * Manages hacknet nodes and Hacknet Servers (SF9).
 *
 * Behaviour:
 *   Detects each cycle whether hacknet is in node mode (pre-SF9) or server
 *   mode (SF9 active). Upgrades the appropriate stats accordingly.
 *
 *   Node mode (pre-SF9):
 *     1. Buy new node
 *     2. Upgrade level → RAM → cores on all nodes (up to caps)
 *
 *   Server mode (SF9):
 *     1. Buy new server (same call — ns.hacknet.purchaseNode())
 *     2. Upgrade level → RAM → cores → cache (hash capacity) on all servers
 *     3. Spend hashes: 'Reduce Minimum Security' + 'Increase Maximum Money'
 *        on hack targets (improves HWGW income), then 'Sell for Money' for rest
 *
 *   All purchases check canAfford() first — 10% floor plus --reserve balance.
 *   Writes node/server stats to port 3 each cycle for status/dashboard.
 *   Runs indefinitely — does not self-exit.
 *
 * Changelog:
 *   v1.2.0 - Add --no-buy flag: write stats to port 3 without purchasing anything.
 *   v1.1.0 - Add SF9 Hacknet Server support: cache upgrades + hash spending.
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --help        Show version, usage, and flags then exit
 *   --no-buy      Stats-only mode: skip all purchases and upgrades (default: false)
 *   --reserve N   Additional minimum balance to retain beyond 10% floor (default: 0)
 *   --hash-target S  Server to target with 'Reduce Min Security'/'Increase Max Money'
 *                    (default: 'n00dles' — cheapest to reduce, helps any HWGW target)
 *
 * Ports:
 *   Writes port 3: { nodes, totalIncome, totalSpent, hashes, hashCapacity, isServerMode } each cycle
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    log,
    writePort,
    clearPort,
} from '/scripts/lib-utils.js';

// --- Hacknet caps (not exposed in NS API — hardcoded per BitBurner v3.0.1) ---
const MAX_LEVEL  = 200;                                                             // Maximum hacknet node level
const MAX_RAM    = 64;                                                              // Maximum hacknet node RAM (GB)
const MAX_CORES  = 16;                                                              // Maximum hacknet node core count
const MAX_CACHE  = 15;                                                              // Maximum hacknet server cache level (SF9)

// Hash spending priority — for SF9 Hacknet Servers
const HASH_UPGRADES = [
    'Reduce Minimum Security',                                                      // Improves HWGW prep on target
    'Increase Maximum Money',                                                       // Increases max money on target
    'Improve Studying',                                                             // Hacking XP gain
    'Improve Gym Training',                                                         // Combat stat gain
    'Sell for Money',                                                               // Convert leftover hashes to $
];

// --- Timing ---
const LOOP_SLEEP = 5000;                                                            // ms between management cycles

// --- Port ---
const PORT_HACKNET = 3;                                                             // Port this script owns and writes stats to
const MONEY_FLOOR  = 0.10;

/**
 * Spends hashes according to HASH_UPGRADES priority.
 * Keeps spending until we can't afford the next upgrade.
 */
function spendHashes(ns, hashTarget) {
    for (const upgrade of HASH_UPGRADES) {
        while (true) {
            try {
                const cost = ns.hacknet.hashCost(upgrade);
                const have = ns.hacknet.numHashes();
                if (have < cost) break;

                // Upgrades that target a specific server need a target argument
                const needsTarget = upgrade === 'Reduce Minimum Security' || upgrade === 'Increase Maximum Money';
                const ok = needsTarget
                    ? ns.hacknet.spendHashes(upgrade, hashTarget)
                    : ns.hacknet.spendHashes(upgrade);

                if (!ok) break;
            } catch (_) { break; }
        }
    }
}

// Inlined — ns.getPlayer() removed from lib-utils to keep orchestrate RAM low.
function canAfford(ns, cost, reserve = 0) {
    const money = ns.getPlayer().money;
    return (money - cost) >= (money * MONEY_FLOOR + reserve);
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',         false],
        ['no-buy',       false],
        ['reserve',      0],
        ['hash-target',  'n00dles'],
    ]);

    if (flags.help) {
        ns.tprint('=== hacknet-manager.js v1.2.0 ===');
        ns.tprint('Purpose: Purchases and upgrades hacknet nodes/servers. SF9: also manages hashes.');
        ns.tprint('         Runs continuously — does not self-exit.');
        ns.tprint('Usage:   run /scripts/hacknet-manager.js [--no-buy] [--reserve N] [--hash-target S]');
        ns.tprint('Flags:');
        ns.tprint('  --help           Show this help and exit');
        ns.tprint('  --no-buy         Stats-only mode: write port 3 data, skip all purchases');
        ns.tprint('  --reserve N      Keep at least N additional dollars beyond 10% floor (default: 0)');
        ns.tprint('  --hash-target S  Target server for Reduce Min Security / Increase Max Money (default: n00dles)');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 3: { nodes, totalIncome, totalSpent, hashes, hashCapacity, isServerMode }');
        ns.tprint('Caps (hardcoded, not in NS API):');
        ns.tprint('  MaxLevel=' + MAX_LEVEL + '  MaxRam=' + MAX_RAM + 'GB  MaxCores=' + MAX_CORES + '  MaxCache=' + MAX_CACHE);
        return;
    }

    ns.tprint('=== hacknet-manager.js v1.2.0 | reserve:$' + flags.reserve + (flags['no-buy'] ? ' | NO-BUY' : '') + ' ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    clearPort(ns, PORT_HACKNET);                                                    // Clear stale port 3 data from any previous run
    ns.atExit(() => clearPort(ns, PORT_HACKNET));                                   // Clear port 3 on exit so status.js shows no-data immediately

    const reserve = flags.reserve;
    let   totalSpent = 0;                                                           // Track total money spent this session

    while (true) {
        // Resolve hash target: prefer active HWGW target from port 1, fall back to flag default
        let hashTarget = flags['hash-target'];
        try {
            const p1 = ns.peek(1);
            if (p1 !== 'NULL PORT DATA') {
                const p1Data = JSON.parse(p1);
                if (p1Data && p1Data.targets) {
                    const keys = Object.keys(p1Data.targets);
                    const hackKey = keys.find(k => p1Data.targets[k].mode === 'HACK');
                    hashTarget = hackKey || keys[0] || hashTarget;
                }
            }
        } catch (_) {}

        // Detect SF9 server mode: hashRate field present on node stats
        let isServerMode = false;
        try {
            if (ns.hacknet.numNodes() > 0) {
                const stats = ns.hacknet.getNodeStats(0);
                isServerMode = typeof stats.hashRate === 'number';
            } else {
                // Try numHashes to detect SF9 without nodes
                ns.hacknet.numHashes();
                isServerMode = true;
            }
        } catch (_) {}

        const nodeCount = ns.hacknet.numNodes();

        if (!flags['no-buy']) {
            // --- Priority 1: Buy a new node/server if we can afford it ---
            const newNodeCost = ns.hacknet.getPurchaseNodeCost();
            if (canAfford(ns, newNodeCost, reserve)) {
                const idx = ns.hacknet.purchaseNode();
                if (idx !== -1) {
                    totalSpent += newNodeCost;
                    log(ns, 'Purchased hacknet ' + (isServerMode ? 'server' : 'node') + ' ' + idx + ' | cost: $' + ns.format.number(newNodeCost));
                }
            }

            // --- Priority 2: Upgrade level on all nodes/servers ---
            for (let i = 0; i < ns.hacknet.numNodes(); i++) {
                const stats = ns.hacknet.getNodeStats(i);
                if (stats.level >= MAX_LEVEL) continue;

                const cost = ns.hacknet.getLevelUpgradeCost(i, 1);
                if (!canAfford(ns, cost, reserve)) continue;

                const ok = ns.hacknet.upgradeLevel(i, 1);
                if (ok) {
                    totalSpent += cost;
                    log(ns, 'Node ' + i + ' level -> ' + (stats.level + 1));
                }
            }

            // --- Priority 3: Upgrade RAM ---
            for (let i = 0; i < ns.hacknet.numNodes(); i++) {
                const stats = ns.hacknet.getNodeStats(i);
                if (stats.ram >= MAX_RAM) continue;

                const cost = ns.hacknet.getRamUpgradeCost(i, 1);
                if (!canAfford(ns, cost, reserve)) continue;

                const ok = ns.hacknet.upgradeRam(i, 1);
                if (ok) {
                    totalSpent += cost;
                    log(ns, 'Node ' + i + ' RAM -> ' + (stats.ram * 2) + 'GB');
                }
            }

            // --- Priority 4: Upgrade cores ---
            for (let i = 0; i < ns.hacknet.numNodes(); i++) {
                const stats = ns.hacknet.getNodeStats(i);
                if (stats.cores >= MAX_CORES) continue;

                const cost = ns.hacknet.getCoreUpgradeCost(i, 1);
                if (!canAfford(ns, cost, reserve)) continue;

                const ok = ns.hacknet.upgradeCore(i, 1);
                if (ok) {
                    totalSpent += cost;
                    log(ns, 'Node ' + i + ' cores -> ' + (stats.cores + 1));
                }
            }

            // --- Priority 5 (SF9 only): Upgrade cache (hash capacity) ---
            if (isServerMode) {
                for (let i = 0; i < ns.hacknet.numNodes(); i++) {
                    const stats = ns.hacknet.getNodeStats(i);
                    if ((stats.cache || 0) >= MAX_CACHE) continue;

                    const cost = ns.hacknet.getCacheUpgradeCost(i, 1);
                    if (!canAfford(ns, cost, reserve)) continue;

                    const ok = ns.hacknet.upgradeCache(i, 1);
                    if (ok) {
                        totalSpent += cost;
                        log(ns, 'Server ' + i + ' cache -> ' + ((stats.cache || 0) + 1));
                    }
                }

                // --- Priority 6 (SF9 only): Spend hashes ---
                spendHashes(ns, hashTarget);
            }
        }

        // --- Write stats to port 3 ---
        const currentNodeCount = ns.hacknet.numNodes();
        let   totalIncome      = 0;
        let   hashes           = 0;
        let   hashCapacity     = 0;

        for (let i = 0; i < currentNodeCount; i++) {
            const stats = ns.hacknet.getNodeStats(i);
            totalIncome += isServerMode ? (stats.hashRate || 0) : (stats.production || 0);
        }

        if (isServerMode) {
            try { hashes       = ns.hacknet.numHashes(); }       catch (_) {}
            try { hashCapacity = ns.hacknet.hashCapacity(); }    catch (_) {}
        }

        clearPort(ns, PORT_HACKNET);
        writePort(ns, PORT_HACKNET, {
            nodes        : currentNodeCount,
            totalIncome,
            totalSpent,
            hashes,
            hashCapacity,
            isServerMode,
        });

        log(ns, (isServerMode ? 'Servers' : 'Nodes') + ': ' + currentNodeCount + ' | income: ' + ns.format.number(totalIncome) + (isServerMode ? ' H/s' : ' $/s') + (isServerMode ? ' | hashes: ' + hashes.toFixed(0) + '/' + hashCapacity.toFixed(0) : ''));

        await ns.sleep(LOOP_SLEEP);
    }
}
