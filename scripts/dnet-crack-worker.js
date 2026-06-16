/**
 * dnet-crack-worker.js
 * Version: 1.0.0
 *
 * Brute-force crack worker for dnet-orchestrate.js.
 *
 * Behaviour:
 *   Exec'd by dnet-orchestrate.js with as many threads as fit in free RAM.
 *   Authentication speed scales with thread count — more threads = faster per
 *   attempt. Tries all numeric passwords for the given length sequentially.
 *   On success or exhaustion, writes { host, password } to port 7 and exits.
 *   The orchestrator picks up the result on the next mutation cycle and calls
 *   connectToSession() to establish its own PID-bound session.
 *
 *   Must be exec'd on a server directly connected to the target — authenticate()
 *   requires the target to be a direct neighbour of the running script's host.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Args:
 *   host           Hostname of the target darknet server (required)
 *   passwordLength Number of digits to brute-force (required)
 *
 * Ports:
 *   Writes port 7: JSON array of { host, password } — password is null on failure.
 *                  dnet-orchestrate.js drains this port at the start of each cycle.
 *
 * RAM cost: 0.4 (authenticate) + 0.6 (heartbleed) + lib-utils ~= 1.1 GB per thread
 *
 * Dependencies:
 *   import { log, writePort, readPort, clearPort } from '/scripts/lib-utils.js';
 */

import { log, writePort, readPort, clearPort } from '/scripts/lib-utils.js';

// --- Constants ---
const PORT_CRACK_RESULT  = 7;                                                       // Results port; orchestrator drains each cycle
const RATE_LIMIT_SLEEP_MS = 2000;                                                   // Pause on rate-limit / timeout response


/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-crack-worker.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    const host  = ns.args[0];
    const pwLen = Number(ns.args[1]);

    if (!host || !pwLen) {
        ns.tprint('Usage: run dnet-crack-worker.js <host> <passwordLength>');
        return;
    }

    const total = Math.pow(10, pwLen);
    log(ns, 'Crack worker: ' + host + ' — ' + total + ' combos');

    let found = null;

    for (let i = 0; i < total; i++) {
        const pw = String(i).padStart(pwLen, '0');                                  // Zero-pad to exact length (e.g. "007")
        const r  = await ns.dnet.authenticate(host, pw);
        if (r.success) {
            found = pw;
            log(ns, 'CRACKED ' + host + ' = ' + pw);
            break;
        }
        if (r.code === 'TIMEOUT' || r.code === 'RATE_LIMITED') {
            await ns.sleep(RATE_LIMIT_SLEEP_MS);                                    // Back off on rate-limit; retries same password next iteration
        }
    }

    if (!found) log(ns, 'CRACK FAILED ' + host + ' — exhausted ' + total + ' combos');

    // Write result to port 7 for orchestrator to pick up next cycle
    const results = readPort(ns, PORT_CRACK_RESULT) || [];
    const idx = results.findIndex(r => r.host === host);
    if (idx >= 0) { results[idx].password = found; } else { results.push({ host, password: found }); }
    clearPort(ns, PORT_CRACK_RESULT);
    writePort(ns, PORT_CRACK_RESULT, results);
}
