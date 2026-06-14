/**
 * buy-servers.js
 * Version: 1.0.0
 *
 * Purchases cloud servers until all available slots are filled.
 *
 * Behaviour:
 *   Iterates available server slots and purchases one server per iteration
 *   at DEFAULT_RAM (8GB — the smallest purchasable size). Checks canAfford()
 *   before every purchase to enforce the 10% money floor plus any --reserve
 *   balance. Writes a port 4 event for each successful purchase so status.js
 *   can display server activity. Self-exits when all slots are filled —
 *   upgrade-servers.js handles RAM expansion from there.
 *
 *   Does not loop indefinitely — once all slots are purchased this script
 *   has no more work to do and exits to free home RAM.
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --help        Show version, usage, and flags then exit
 *   --reserve N   Additional minimum balance to retain beyond 10% floor (default: 0)
 *
 * Ports:
 *   Writes port 4: { event: 'buy', host, ram } on each successful purchase
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
const DEFAULT_RAM    = 8;                                                           // GB — smallest purchasable server RAM
const LOOP_SLEEP     = 5000;                                                        // ms between purchase attempts when waiting for funds
const PORT_SERVERS   = 4;                                                           // Port shared with upgrade-servers for server events


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',    false],
        ['reserve', 0],
    ]);

    if (flags.help) {
        ns.tprint('=== buy-servers.js v1.0.0 ===');
        ns.tprint('Purpose: Purchases cloud servers to fill all available slots at 8GB each.');
        ns.tprint('         Self-exits when all slots are filled.');
        ns.tprint('Usage:   run /scripts/buy-servers.js [--reserve N]');
        ns.tprint('Flags:');
        ns.tprint('  --help        Show this help and exit');
        ns.tprint('  --reserve N   Keep at least N additional dollars beyond 10% floor (default: 0)');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 4: purchase events for status.js');
        return;
    }

    ns.tprint('=== buy-servers.js v1.0.0 | reserve:$' + flags.reserve + ' ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    clearPort(ns, PORT_SERVERS);                                                    // Clear stale port 4 data from any previous run
    ns.atExit(() => clearPort(ns, PORT_SERVERS));                                   // Clear port 4 on exit so status.js shows no-data immediately

    const reserve   = flags.reserve;                                                // Additional balance floor from flag
    const limit     = ns.cloud.getServerLimit();                                    // Maximum number of purchasable servers

    log(ns, 'Server limit: ' + limit + ' | target RAM: ' + DEFAULT_RAM + 'GB | reserve: $' + reserve);

    while (true) {
        const owned = ns.cloud.getServerNames();                                    // Current list of owned cloud servers

        if (owned.length >= limit) {
            log(ns, 'All ' + limit + ' server slots filled — exiting');
            ns.tprint('[BUY-SERVERS] All slots filled. Exiting.');
            return;                                                                  // Job done — free home RAM
        }

        const cost = ns.cloud.getServerCost(DEFAULT_RAM);                          // Cost of one 8GB server

        if (!canAfford(ns, cost, reserve)) {
            log(ns, 'Cannot afford $' + ns.format.number(cost) + ' — waiting for funds');
            await ns.sleep(LOOP_SLEEP);
            continue;                                                               // Check again after sleep
        }

        const host = ns.cloud.purchaseServer('cloud-server-' + owned.length, DEFAULT_RAM); // Purchase with indexed name
        if (host === '') {
            log(ns, 'purchaseServer returned empty — unexpected failure, retrying');
            await ns.sleep(LOOP_SLEEP);
            continue;
        }

        ns.tprint('[BUY-SERVERS] Purchased: ' + host + ' (' + DEFAULT_RAM + 'GB)');
        clearPort(ns, PORT_SERVERS);
        writePort(ns, PORT_SERVERS, { event: 'buy', host, ram: DEFAULT_RAM });     // Notify status.js

        log(ns, 'Purchased ' + host + ' | slots: ' + (owned.length + 1) + '/' + limit);

        // No sleep between purchases — buy as fast as funds allow
        // Loop immediately re-checks owned count and affordability
    }
}
