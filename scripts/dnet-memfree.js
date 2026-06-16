/**
 * dnet-memfree.js
 * Version: 1.0.0
 *
 * Frees blocked RAM on an authenticated darknet server via memoryReallocation().
 *
 * Behaviour:
 *   Loops memoryReallocation() on the target until no blocked RAM remains or
 *   the call fails. Target must be directly connected AND the current script
 *   must have a session (authenticate or connectToSession first — sessions are
 *   PID-bound, so this runs from the same script that holds the session, or
 *   via dnet-orchestrate.js which manages sessions centrally).
 *   Amount freed per call scales with charisma and thread count.
 *   Exits cleanly when done (self-exits to free home RAM).
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Args:
 *   host   Hostname of the authenticated, directly-connected target (optional).
 *          Defaults to the script's own server if omitted.
 *
 * Flags:
 *   --help   Show usage then exit
 *
 * RAM cost: 0.1 (getServerDetails) + 1 GB (memoryReallocation) = 1.1 GB
 *
 * Dependencies:
 *   import { log } from '/scripts/lib-utils.js';
 */

import { log } from '/scripts/lib-utils.js';

// --- Constants ---
const CYCLE_SLEEP_MS = 200;                                                         // Minimum yield per loop to avoid engine lockup


/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-memfree.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    if (ns.args.includes('--help')) {
        ns.tprint('Usage: run dnet-memfree.js [host]');
        ns.tprint('  host : authenticated darknet server to free RAM on (default: current)');
        return;
    }

    const host        = ns.args[0] || undefined;                                    // undefined causes memoryReallocation to target own server
    const dnet        = ns.dnet;
    const displayHost = host || ns.getHostname();                                   // Resolved name for log messages only

    log(ns, 'dnet-memfree targeting ' + displayHost);

    while (true) {
        const d = dnet.getServerDetails(host || ns.getHostname());
        if (!d.isOnline) {
            log(ns, 'Server went offline. Stopping.');
            break;
        }
        if (d.blockedRam <= 0) {
            log(ns, 'No blocked RAM remaining on ' + displayHost + '. Done.');
            break;
        }

        log(ns, 'Blocked RAM: ' + d.blockedRam + ' GB — running memoryReallocation...');
        const result = await dnet.memoryReallocation(host);                         // Frees a chunk of blocked RAM; amount scales with charisma + threads
        if (!result.success) {
            log(ns, 'memoryReallocation failed. Code: ' + result.code + '. Need authenticated session?');
            break;
        }

        await ns.sleep(CYCLE_SLEEP_MS);                                             // Yield to engine between reallocation calls (rule 12)
    }

    log(ns, 'dnet-memfree finished on ' + displayHost);
}
