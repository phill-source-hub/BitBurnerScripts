/**
 * share.js
 * Version: 1.0.0
 *
 * Faction rep boost worker for PhlanxOS BitBurner automation suite.
 *
 * Behaviour:
 *   Calls ns.share() in a loop. Dispatched in bulk by share-manager.js
 *   across farm servers to fill idle RAM. Each thread increases the faction
 *   reputation gain multiplier via: 1 + log(totalShareThreads) / 25.
 *
 *   This script is designed to be identical in role to worker.js:
 *   it does exactly one thing, has zero imports, and is dispatched
 *   with -t N threads by the manager script.
 *
 * RAM: 4.0 GB per instance (base 1.6 + share 2.4)
 *   Each ns.exec with -t N threads costs 4.0 * N GB on the target server.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Dependencies:
 *   None. Standalone — no imports.
 */

export async function main(ns) {
    ns.disableLog('ALL');
    while (true) {
        await ns.share();
    }
}
