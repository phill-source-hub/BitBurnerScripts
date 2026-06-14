/**
 * backdoor.js
 * Version: 1.0.0
 *
 * Installs a backdoor on a single target server via SF4 singularity functions.
 *
 * Behaviour:
 *   Launched by auto-root.js after each successful root (ns.exec, fire-and-forget).
 *   Self-exits immediately if SF4 is not owned — no-op cost.
 *   Finds the hop-by-hop path from home to target, connects each hop using
 *   ns.singularity.connect(), installs the backdoor, then returns to home.
 *   Always returns to home even on error — try/catch guarantees this.
 *
 *   Kept separate from auto-root.js deliberately: singularity functions carry a
 *   16x RAM multiplier without SF4. Isolating them here means auto-root.js and
 *   all other scripts pay no singularity RAM cost.
 *
 * Changelog:
 *   v1.0.0 - Extracted from auto-root.js. Isolates singularity RAM cost.
 *
 * Args:
 *   ns.args[0]  Target hostname to backdoor
 *
 * Flags:
 *   --help   Show version, usage, and args then exit
 *
 * Dependencies:
 *   import { hasSF, getPath } from '/scripts/lib-sf-utils.js';
 */

import {
    hasSF,
    getPath,
} from '/scripts/lib-sf-utils.js';

export async function main(ns) {
    const flags  = ns.flags([['help', false]]);
    const target = ns.args[0];

    if (flags.help) {
        ns.tprint('=== backdoor.js v1.0.0 ===');
        ns.tprint('Purpose: Installs SF4 backdoor on a single server. Launched by auto-root.js.');
        ns.tprint('Usage:   run /scripts/backdoor.js <hostname>');
        ns.tprint('Args:');
        ns.tprint('  hostname   Target server to backdoor');
        return;
    }

    if (!target) {
        ns.tprint('[BACKDOOR] ERROR: no target hostname provided');
        return;
    }

    if (!hasSF(ns, 4)) return;                                                      // No SF4 — singularity unavailable, exit silently

    ns.disableLog('ALL');

    const path = getPath(ns, target);
    if (path.length === 0) {
        ns.tprint('[BACKDOOR] No path to ' + target + ' — skipping');
        return;
    }

    try {
        for (const hop of path) {
            ns.singularity.connect(hop);                                            // Walk hop-by-hop — connect moves one step at a time
        }
        await ns.singularity.installBackdoor();
        ns.singularity.connect('home');
        ns.tprint('[BACKDOOR] Installed: ' + target);
    } catch (e) {
        ns.tprint('[BACKDOOR] Failed on ' + target + ' — ' + e);
        try { ns.singularity.connect('home'); } catch { }                           // Best-effort return to home on any error
    }
}
