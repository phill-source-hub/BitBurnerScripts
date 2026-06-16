/**
 * dnet-phish.js
 * Version: 1.0.0
 *
 * Runs phishing attacks in a loop to earn money and build charisma.
 *
 * Behaviour:
 *   Repeatedly calls dnet.phishingAttack(). On success: logs money earned and
 *   any .cache files received. Opens .cache files automatically via openCache().
 *   On failure: logs the result code and continues.
 *
 *   MUST run on a darknet server — phishingAttack() will fail from home or
 *   normal servers. Use ns.exec() from dnet-orchestrate.js to deploy here.
 *
 *   Scales with threads: more threads = more money per successful attack.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --help   Show usage then exit
 *
 * RAM cost: 2 GB (phishingAttack) + 2 GB (openCache) = 4 GB base
 *   Note: openCache only called when a .cache file is present.
 *
 * Dependencies:
 *   import { log } from '/scripts/lib-utils.js';
 */

import { log } from '/scripts/lib-utils.js';

// --- Constants ---
const CYCLE_SLEEP_MS = 200;                                                         // Minimum yield per loop to avoid engine lockup


/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-phish.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    if (ns.args.includes('--help')) {
        ns.tprint('Usage: run dnet-phish.js  (must run ON a darknet server)');
        ns.tprint('  Loops phishingAttack() for money + charisma. Scale with threads.');
        return;
    }

    const dnet   = ns.dnet;
    let attempts  = 0;
    let successes = 0;

    log(ns, 'dnet-phish started on ' + ns.getHostname());

    while (true) {
        const result = await dnet.phishingAttack();                                 // Blocks until attack resolves; scales with threads
        attempts++;

        if (result.success) {
            successes++;
            log(ns, 'Phish hit! (' + successes + '/' + attempts + ')  '
                + (result.data ? JSON.stringify(result.data) : ''));

            // Collect any .cache files dropped into this server's directory
            const caches = ns.ls(ns.getHostname(), '.cache');
            for (const file of caches) {
                const cacheResult = dnet.openCache(file);                           // Opens and consumes the cache for its reward
                log(ns, 'Opened cache ' + file + ': ' + JSON.stringify(cacheResult));
            }
        } else {
            log(ns, 'Phish miss. Code: ' + result.code + '  (' + attempts + ' attempts)');
        }

        await ns.sleep(CYCLE_SLEEP_MS);                                             // Yield to engine between attacks (rule 12)
    }
}
