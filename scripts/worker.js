/**
 * worker.js
 * Version: 1.1.0
 *
 * Single-operation worker script for HWGW batch scheduling.
 *
 * Behaviour:
 *   Receives a target hostname and operation name as arguments.
 *   Waits for an optional delay, then executes exactly one NS operation.
 *   Designed to be dispatched in bulk by orchestrate.js with controlled
 *   delays so multiple workers land on target in precise sequence.
 *
 *   RAM cost must remain at 2.0GB. Do not add any NS calls beyond the
 *   single operation. No imports. No lib-utils.
 *
 * Changelog:
 *   v1.1.0 - try/catch around operation — JS crashes tprint to terminal so they
 *            surface across a large farm without requiring tail log monitoring
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --delay N   Milliseconds to wait before executing operation (default: 0)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 */

export async function main(ns) {
    const flags     = ns.flags([['delay', 0]]);                                     // Parse optional delay argument
    const target    = ns.args[0];                                                   // Target hostname passed by orchestrate
    const operation = ns.args[1];                                                   // Operation: 'hack', 'grow', or 'weaken'

    ns.print('=== worker.js v1.1.0 | ' + operation + ' -> ' + target + ' | delay: ' + flags.delay + 'ms ===');
    ns.disableLog('ALL');                                                            // Suppress NS logs — worker output is noise

    if (flags.delay > 0) {                                                          // Only sleep if delay is non-zero
        await ns.sleep(flags.delay);                                                // Wait for batch timing alignment
    }

    try {
        if (operation === 'hack') {
            await ns.hack(target);                                                  // Steal money from target
        } else if (operation === 'grow') {
            await ns.grow(target);                                                  // Restore money on target
        } else if (operation === 'weaken') {
            await ns.weaken(target);                                                // Reduce security on target
        } else {
            ns.tprint('[worker.js] ERROR: unknown operation "' + operation + '" — expected hack, grow, or weaken');
        }
    } catch (e) {
        // Exceptions here are unexpected — ns.hack/grow/weaken return values on normal failure, not throw.
        // A catch means a JS crash or game-engine error. tprint ensures it surfaces to the terminal.
        ns.tprint('[worker.js] CRASH: ' + operation + ' on ' + target + ' | ' + e);
    }
}
