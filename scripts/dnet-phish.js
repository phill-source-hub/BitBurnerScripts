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
 *   v1.2.0 - ns.ramOverride(4): actual calculated cost is 5.85 GB; override so
 *            orchestrate can exec more threads per server (PHISH_RAM_GB=4 matches).
 *   v1.1.0 - Check for .cache files every loop iteration (not only after phish success)
 *            so caches dropped by memoryReallocation() are collected promptly.
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

/**
 * Opens and logs all .cache files present on the current host.
 * Called at top of each loop and after each phish success.
 */
function openAllCaches(ns, dnet) {
    const caches = ns.ls(ns.getHostname(), '.cache');
    for (const file of caches) {
        const r = dnet.openCache(file);
        log(ns, 'Cache opened ' + file + ': ' + (r.message || JSON.stringify(r)));
    }
}

// --- Constants ---
const CYCLE_SLEEP_MS = 200;                                                         // Minimum yield per loop to avoid engine lockup


/** @param {NS} ns */
export async function main(ns) {
    ns.ramOverride(4);                                                               // Actual calc=5.85 GB; override to 4 GB so orchestrate can fit more threads
    ns.tprint('=== dnet-phish.js v1.2.0 ===');
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
        // Open any .cache files present — may have been dropped by memoryReallocation()
        // in a previous cycle, not just by phishing. Check every iteration.
        openAllCaches(ns, dnet);

        const result = await dnet.phishingAttack();                                 // Blocks until attack resolves; scales with threads
        attempts++;

        if (result.success) {
            successes++;
            log(ns, 'Phish hit! (' + successes + '/' + attempts + ')  '
                + (result.data ? JSON.stringify(result.data) : ''));
            openAllCaches(ns, dnet);                                                // Collect caches dropped by this attack immediately
        } else {
            log(ns, 'Phish miss. Code: ' + result.code + '  (' + attempts + ' attempts)');
        }

        await ns.sleep(CYCLE_SLEEP_MS);                                             // Yield to engine between attacks (rule 12)
    }
}
