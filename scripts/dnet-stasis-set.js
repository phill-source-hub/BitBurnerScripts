/**
 * dnet-stasis-set.js
 * Version: 1.0.0
 *
 * One-shot worker: applies (or removes) a stasis link on the server it runs on.
 *
 * Behaviour:
 *   Must be exec()'d onto a darknet server by dnet-orchestrate.js.
 *   setStasisLink() acts on the script's current server — it cannot be called
 *   remotely. dnet-orchestrate SCPs this file, execs it with 1 thread, then
 *   the worker exits. Requires 12 GB free RAM on the target server.
 *   Pass --remove to remove an existing stasis link instead of applying one.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --remove   Remove the stasis link instead of applying one (default: false)
 *   --help     Show usage then exit
 *
 * RAM cost: 12 GB (setStasisLink)
 *
 * Dependencies: none
 */

/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-stasis-set.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    if (ns.args.includes('--help')) {
        ns.tprint('Usage: run dnet-stasis-set.js [--remove]');
        ns.tprint('  Must be exec()d onto a darknet server. Sets or removes a stasis link.');
        return;
    }

    const remove = ns.args.includes('--remove');                                    // Flag: remove link instead of applying
    const result = await ns.dnet.setStasisLink(!remove);                            // true = apply, false = remove
    ns.tprint((remove ? 'Removed' : 'Applied') + ' stasis link on ' + ns.getHostname()
        + ': ' + (result.success ? 'OK' : 'FAILED code=' + result.code));
}
