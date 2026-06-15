/**
 * upgrade-servers.js
 * Version: 1.2.0
 *
 * Upgrades owned cloud servers to maximum RAM by doubling each cycle.
 *
 * Behaviour:
 *   Each cycle finds the cheapest available upgrade across all non-maxed servers
 *   and purchases it if canAfford() allows. Respects the 10% money floor plus
 *   any --reserve balance. Writes a port 4 event for each upgrade. Self-exits
 *   when all servers are at MAX_SERVER_RAM — no more upgrades are possible.
 *
 *   RAM doubles each step: 8→16→32→...→MAX_SERVER_RAM (32768GB).
 *
 *   Cheapest-first strategy: always buy the single cheapest upgrade available.
 *   Since upgrade cost scales with target RAM, the cheapest upgrade is always
 *   the smallest server's next tier. This naturally saturates small servers first
 *   and immediately spends any funds that fit, eliminating the tier-grouping
 *   stall of the previous even-tier strategy.
 *
 * Changelog:
 *   v1.2.0 - Replaced even-tier strategy with cheapest-first.
 *            Previously, all servers had to reach tier N before any could advance
 *            to tier N+1. Now: sort all upgrades by cost, buy cheapest first.
 *            Eliminates stalls where affordable upgrades existed but were blocked
 *            because cheaper laggers hadn't been bought yet.
 *   v1.1.0 - Even upgrade strategy: all servers advance together tier by tier.
 *            New servers added mid-run are upgraded before any server advances further.
 *            Also fixed premature exit when slots not yet fully purchased.
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --help        Show version, usage, and flags then exit
 *   --reserve N   Additional minimum balance to retain beyond 10% floor (default: 0)
 *
 * Ports:
 *   Writes port 4: { event: 'upgrade', host, ram } on each successful upgrade
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    log,
    writePort,
    clearPort,
} from '/scripts/lib-utils.js';

// --- Constants ---
const LOOP_SLEEP   = 5000;                                                          // ms between upgrade cycles
const MONEY_FLOOR  = 0.10;
const PORT_SERVERS = 4;

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
        ['help',    false],
        ['reserve', 0],
    ]);

    if (flags.help) {
        ns.tprint('=== upgrade-servers.js v1.2.0 ===');
        ns.tprint('Purpose: Upgrades all owned cloud servers to max RAM by doubling each step.');
        ns.tprint('         Self-exits when all servers reach maximum RAM.');
        ns.tprint('Usage:   run /scripts/upgrade-servers.js [--reserve N]');
        ns.tprint('Flags:');
        ns.tprint('  --help        Show this help and exit');
        ns.tprint('  --reserve N   Keep at least N additional dollars beyond 10% floor (default: 0)');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 4: upgrade events for status.js');
        return;
    }

    ns.tprint('=== upgrade-servers.js v1.2.0 | reserve:$' + flags.reserve + ' ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    clearPort(ns, PORT_SERVERS);                                                    // Clear stale port 4 data from any previous run
    ns.atExit(() => clearPort(ns, PORT_SERVERS));                                   // Clear port 4 on exit so status.js shows no-data immediately

    const reserve = flags.reserve;

    while (true) {
        const owned = ns.cloud.getServerNames();

        if (owned.length === 0) {
            log(ns, 'No servers owned yet — waiting for buy-servers.js');
            await ns.sleep(LOOP_SLEEP);
            continue;
        }

        const maxServerRam = ns.cloud.getRamLimit();

        // Check exit condition: all slots filled and all servers at max RAM
        const allSlotsFilled = owned.length >= ns.cloud.getServerLimit();
        const allMaxed       = owned.every(h => ns.getServerMaxRam(h) >= maxServerRam);
        if (allMaxed && allSlotsFilled) {
            log(ns, 'All servers at max RAM (' + maxServerRam + 'GB) — exiting');
            ns.tprint('[UPGRADE-SERVERS] All servers at max RAM. Exiting.');
            return;
        }

        // Build upgrade candidates: all non-maxed servers with their next-tier cost.
        // Sort cheapest first — smallest RAM server always has cheapest next upgrade.
        const candidates = owned
            .filter(h => ns.getServerMaxRam(h) < maxServerRam)
            .map(h => {
                const currentRam = ns.getServerMaxRam(h);
                const targetRam  = Math.min(currentRam * 2, maxServerRam);
                const cost       = ns.cloud.getServerUpgradeCost(h, targetRam);
                return { host: h, currentRam, targetRam, cost };
            })
            .sort((a, b) => a.cost - b.cost);                                      // Cheapest upgrade first

        let upgradesThisCycle = 0;

        for (const u of candidates) {
            if (!canAfford(ns, u.cost, reserve)) {
                log(ns, 'Cannot afford ' + u.host + ' ' + u.currentRam + '->' + u.targetRam + 'GB ($' + ns.format.number(u.cost) + ') — waiting for funds');
                break;                                                              // Sorted cheapest-first: if we can't afford this, we can't afford anything
            }

            const ok = ns.cloud.upgradeServer(u.host, u.targetRam);
            if (!ok) {
                log(ns, 'upgradeServer failed for ' + u.host + ' — unexpected, will retry');
                continue;
            }

            ns.tprint('[UPGRADE-SERVERS] Upgraded: ' + u.host + ' ' + u.currentRam + 'GB -> ' + u.targetRam + 'GB');
            clearPort(ns, PORT_SERVERS);
            writePort(ns, PORT_SERVERS, { event: 'upgrade', host: u.host, ram: u.targetRam });
            log(ns, 'Upgraded ' + u.host + ' | ' + u.currentRam + 'GB -> ' + u.targetRam + 'GB | cost: $' + ns.format.number(u.cost));
            upgradesThisCycle++;
        }

        if (upgradesThisCycle === 0) {
            log(ns, 'No upgrades this cycle — waiting for funds');
        }

        await ns.sleep(LOOP_SLEEP);
    }
}
