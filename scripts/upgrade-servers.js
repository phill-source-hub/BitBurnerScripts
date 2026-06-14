/**
 * upgrade-servers.js
 * Version: 1.1.0
 *
 * Upgrades owned cloud servers to maximum RAM by doubling each cycle.
 *
 * Behaviour:
 *   Each cycle iterates all owned cloud servers. For each server below
 *   MAX_SERVER_RAM, calculates the cost to double its RAM and purchases
 *   the upgrade if canAfford() allows. Respects the 10% money floor plus
 *   any --reserve balance. Writes a port 4 event for each upgrade so
 *   status.js can display activity. Self-exits when all servers are at
 *   MAX_SERVER_RAM — no more upgrades are possible.
 *
 *   RAM doubles each step: 8→16→32→...→MAX_SERVER_RAM (32768GB).
 *
 * Changelog:
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
    canAfford,
    writePort,
    clearPort,
} from '/scripts/lib-utils.js';

// --- Constants ---
const LOOP_SLEEP   = 5000;                                                          // ms between upgrade cycles
const PORT_SERVERS = 4;                                                             // Port shared with buy-servers for server events
// MAX_SERVER_RAM is read from ns.cloud.getRamLimit() at runtime — not hardcoded


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',    false],
        ['reserve', 0],
    ]);

    if (flags.help) {
        ns.tprint('=== upgrade-servers.js v1.0.0 ===');
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

    ns.tprint('=== upgrade-servers.js v1.0.0 | reserve:$' + flags.reserve + ' ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    clearPort(ns, PORT_SERVERS);                                                    // Clear stale port 4 data from any previous run
    ns.atExit(() => clearPort(ns, PORT_SERVERS));                                   // Clear port 4 on exit so status.js shows no-data immediately

    const reserve = flags.reserve;

    while (true) {
        const owned = ns.cloud.getServerNames();                                    // All currently owned cloud servers

        if (owned.length === 0) {
            log(ns, 'No servers owned yet — waiting for buy-servers.js');
            await ns.sleep(LOOP_SLEEP);
            continue;
        }

        const maxServerRam = ns.cloud.getRamLimit();                                // Max RAM per server — from API, not hardcoded

        // Check if all servers are at max RAM AND all slots are filled
        const allSlotsFilled = owned.length >= ns.cloud.getServerLimit();
        const allMaxed       = owned.every(h => ns.getServerMaxRam(h) >= maxServerRam);
        if (allMaxed && allSlotsFilled) {
            log(ns, 'All servers at max RAM (' + maxServerRam + 'GB) — exiting');
            ns.tprint('[UPGRADE-SERVERS] All servers at max RAM. Exiting.');
            return;                                                                  // Job done — free home RAM
        }

        // Even upgrade strategy: find the lowest RAM tier across all servers, then
        // only upgrade servers AT that tier. All servers must reach a tier before
        // any advance to the next — including servers added after script start.
        const minRam          = Math.min(...owned.map(h => ns.getServerMaxRam(h)));
        const tierTarget      = Math.min(minRam * 2, maxServerRam);                 // Next tier above the laggards
        const laggers         = owned.filter(h => ns.getServerMaxRam(h) === minRam);
        let   upgradesThisCycle = 0;

        log(ns, 'Tier floor: ' + minRam + 'GB | upgrading ' + laggers.length + ' server(s) to ' + tierTarget + 'GB');

        for (const host of laggers) {
            const cost = ns.cloud.getServerUpgradeCost(host, tierTarget);           // Cost to bring this server up to tier floor

            if (!canAfford(ns, cost, reserve)) {
                log(ns, 'Cannot afford ' + host + ' ' + minRam + '->' + tierTarget + 'GB ($' + ns.format.number(cost) + ') — waiting for funds');
                continue;
            }

            const ok = ns.cloud.upgradeServer(host, tierTarget);                   // Execute the upgrade
            if (!ok) {
                log(ns, 'upgradeServer failed for ' + host + ' — unexpected, will retry');
                continue;
            }

            ns.tprint('[UPGRADE-SERVERS] Upgraded: ' + host + ' to ' + tierTarget + 'GB');
            clearPort(ns, PORT_SERVERS);
            writePort(ns, PORT_SERVERS, { event: 'upgrade', host, ram: tierTarget }); // Notify status.js
            log(ns, 'Upgraded ' + host + ' | ' + minRam + 'GB -> ' + tierTarget + 'GB');
            upgradesThisCycle++;
        }

        if (upgradesThisCycle === 0) {
            log(ns, 'No upgrades this cycle — waiting for funds');
        }

        await ns.sleep(LOOP_SLEEP);
    }
}
