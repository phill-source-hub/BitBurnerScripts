/**
 * dnet-watch.js
 * Version: 1.0.0
 *
 * Monitors the darknet for network mutations and logs topology changes.
 *
 * Behaviour:
 *   Sleeps via nextMutation() until the darknet mutates, then re-probes the
 *   network. Logs servers that appeared, disappeared, or changed status since
 *   the last cycle. Also re-acquires sessions via connectToSession() for any
 *   known-password servers visible after the mutation.
 *
 *   Password store (port 6): dnet-crack.js and dnet-orchestrate.js write a
 *   JSON array of { host, password } to port 6 when they crack a server.
 *   dnet-watch peeks this on each mutation to reconnect lost sessions.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --help   Show usage then exit
 *
 * Ports:
 *   Reads  port 6: JSON array of { host, password } — known cracked passwords
 *                  (peek only — does not consume; port 6 owned by dnet-orchestrate)
 *
 * RAM cost: 0 (nextMutation) + 0.2 (probe) + 0.1 (getServerDetails)
 *           + 0.05 (getDarknetInstability) + 0.05 (connectToSession) = ~0.4 GB
 *
 * Dependencies:
 *   import { log, readPort } from '/scripts/lib-utils.js';
 */

import { log, readPort } from '/scripts/lib-utils.js';

// --- Constants ---
const PORT_KNOWN_PASSWORDS = 6;                                                     // Ports 1-5 taken; 6 is first free darknet port
const CYCLE_SLEEP_MS       = 200;                                                   // Minimum sleep per loop to avoid engine lockup


/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-watch.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    if (ns.args.includes('--help')) {
        ns.tprint('Usage: run dnet-watch.js');
        ns.tprint('  Monitors darknet mutations and logs topology changes.');
        return;
    }

    const dnet = ns.dnet;
    let known  = new Map();                                                          // host -> { isOnline, depth } snapshot from last cycle

    // Initial probe before first mutation to establish baseline topology
    for (const host of dnet.probe()) {
        const d = dnet.getServerDetails(host);
        known.set(host, { isOnline: d.isOnline, depth: d.depth });
    }

    log(ns, 'dnet-watch started. Monitoring ' + known.size + ' visible servers.');

    while (true) {
        await dnet.nextMutation();                                                   // Sleeps until next network mutation event
        await ns.sleep(CYCLE_SLEEP_MS);                                             // Yield to engine after mutation wakeup (rule 12)

        const instability = dnet.getDarknetInstability();
        const now         = new Map();
        const visible     = dnet.probe();                                            // Re-probe after mutation — topology may have changed

        for (const host of visible) {
            const d = dnet.getServerDetails(host);
            now.set(host, { isOnline: d.isOnline, depth: d.depth });
        }

        // Log servers that appeared, moved, came back online, or went offline
        for (const [host, cur] of now) {
            if (!known.has(host)) {
                log(ns, 'NEW  server appeared: ' + host + '  depth=' + cur.depth);
            } else {
                const prev = known.get(host);
                if (prev.isOnline && !cur.isOnline) {
                    log(ns, 'GONE ' + host + ' went offline');
                } else if (!prev.isOnline && cur.isOnline) {
                    log(ns, 'UP   ' + host + ' came back online');
                } else if (prev.depth !== cur.depth) {
                    log(ns, 'MOVE ' + host + ' depth ' + prev.depth + ' -> ' + cur.depth);
                }
            }
        }
        for (const host of known.keys()) {
            if (!now.has(host)) {
                log(ns, 'LOST ' + host + ' no longer visible (moved or offline)');
            }
        }

        known = now;                                                                 // Advance snapshot for next cycle
        log(ns, 'Instability: ' + instability.authenticationDurationMultiplier.toFixed(2) + 'x  visible=' + now.size);

        // Re-connect sessions for servers we have passwords for — sessions are PID-bound and lost on mutation
        const creds = readPort(ns, PORT_KNOWN_PASSWORDS);                           // Already parsed; null if empty
        if (Array.isArray(creds)) {
            for (const { host, password } of creds) {
                if (!now.has(host)) continue;                                        // Not visible from current server right now
                const result = dnet.connectToSession(host, password);
                if (result.success) {
                    log(ns, 'Reconnected session: ' + host);
                }
            }
        }
    }
}
