/**
 * dnet-crack.js
 * Version: 1.0.0
 *
 * Attempts to crack a directly-connected darknet server's password.
 *
 * Behaviour:
 *   1. Reads server details (length, format, hint) via getServerDetails().
 *   2. Peeks logs via heartbleed() to gather any clues from prior attempts.
 *   3. If a password is provided via --pass, tries it directly.
 *   4. If format is "numeric" and length <= NUMERIC_BRUTE_MAX_LEN, brute-forces
 *      all combinations via authenticate(). Pauses on rate-limit responses.
 *   5. On success: saves the password to port 6 so dnet-watch.js can reconnect
 *      sessions after network mutations.
 *   6. On failure: drains and prints heartbleed logs for manual analysis.
 *
 *   The target must be directly connected to the server running this script.
 *   Authentication speed scales with threads — run with more threads to go faster.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Args:
 *   host         Hostname of the target darknet server (required)
 *
 * Flags:
 *   --pass <pw>  Try a specific password instead of brute-forcing
 *   --help       Show usage then exit
 *
 * Ports:
 *   Writes port 6: appends { host, password } to JSON array on successful crack.
 *                  dnet-watch.js and dnet-orchestrate.js peek this port.
 *
 * RAM cost: 0.1 (getServerDetails) + 0.4 (authenticate) + 0.6 (heartbleed) = 1.1 GB
 *
 * Dependencies:
 *   import { log, readPort, writePort, clearPort } from '/scripts/lib-utils.js';
 */

import { log, readPort, writePort, clearPort } from '/scripts/lib-utils.js';

// --- Constants ---
const NUMERIC_BRUTE_MAX_LEN = 6;                                                    // Max password length to attempt numeric brute-force
const PORT_KNOWN_PASSWORDS  = 6;                                                    // Shared credential store; ports 1-5 are taken
const RATE_LIMIT_SLEEP_MS   = 2000;                                                 // Pause when server signals rate-limit or timeout


/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-crack.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    const flags = ns.flags([
        ['pass', ''],
        ['help', false],
    ]);

    if (flags.help || flags._.length === 0) {
        ns.tprint('Usage: run dnet-crack.js <host> [--pass <password>]');
        ns.tprint('  host   : directly-connected darknet server to crack');
        ns.tprint('  --pass : try a specific password');
        return;
    }

    const host = flags._[0];
    const dnet = ns.dnet;

    const d = dnet.getServerDetails(host);
    if (!d.isOnline) {
        ns.tprint('ERROR: ' + host + ' is offline.');
        return;
    }

    // Print server intel gathered before attempting crack
    ns.tprint('Target   : ' + host);
    ns.tprint('Format   : ' + d.passwordFormat + '  Length: ' + d.passwordLength);
    ns.tprint('Hint     : ' + (d.passwordHint || '(none)'));
    ns.tprint('Hint data: ' + (d.data || '(none)'));
    ns.tprint('Charisma : ' + d.requiredCharismaSkill + ' required');
    ns.tprint('');

    // Peek logs first — non-destructive, may reveal clues from prior auth attempts
    const bleed = await dnet.heartbleed(host, { peek: true });
    if (bleed.logs && bleed.logs.length > 0) {
        ns.tprint('Heartbleed logs (' + bleed.logs.length + '):');
        for (const entry of bleed.logs) {
            ns.tprint('  ' + entry);
        }
        ns.tprint('');
    }

    // --- Explicit password provided via flag ---
    if (flags.pass) {
        ns.tprint('Trying password: ' + flags.pass);
        const result = await dnet.authenticate(host, flags.pass);
        if (result.success) {
            ns.tprint('SUCCESS. Session granted.');
            saveCredential(ns, host, flags.pass);
        } else {
            ns.tprint('FAILED. Code: ' + result.code);
            // Drain logs after failure — server may have written clues in response
            const failBleed = await dnet.heartbleed(host, { peek: false });
            if (failBleed.logs.length > 0) {
                ns.tprint('Post-auth logs:');
                for (const entry of failBleed.logs) ns.tprint('  ' + entry);
            }
        }
        return;
    }

    // --- Numeric brute-force ---
    if (d.passwordFormat === 'numeric' && d.passwordLength <= NUMERIC_BRUTE_MAX_LEN) {
        const total = Math.pow(10, d.passwordLength);                                // Total candidates: 10^length
        ns.tprint('Brute-forcing ' + total + ' numeric passwords (length ' + d.passwordLength + ')...');

        for (let i = 0; i < total; i++) {
            const pw     = String(i).padStart(d.passwordLength, '0');                // Zero-pad to exact length (e.g. "007")
            const result = await dnet.authenticate(host, pw);
            if (result.success) {
                ns.tprint('CRACKED: password = ' + pw);
                saveCredential(ns, host, pw);
                return;
            }
            // Back off on rate-limit — avoids triggering longer lockouts
            if (result.code === 'TIMEOUT' || result.code === 'RATE_LIMITED') {
                await ns.sleep(RATE_LIMIT_SLEEP_MS);
            }
        }
        ns.tprint('Brute-force exhausted. No match found in ' + total + ' attempts.');
        return;
    }

    // Non-numeric or too long — cannot auto-crack
    ns.tprint('Format "' + d.passwordFormat + '" len=' + d.passwordLength + ' — manual analysis needed.');
    ns.tprint('Use --pass <password> once you have a candidate from the hint/logs above.');
}


/**
 * Appends or updates { host, password } in the JSON credential array on port 6.
 * Uses peek (non-destructive read) so other scripts still see the full list.
 * dnet-watch.js and dnet-orchestrate.js peek port 6 to reconnect sessions.
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the cracked server
 * @param {string} password - The discovered password
 * @returns {void}
 */
function saveCredential(ns, host, password) {
    const creds = readPort(ns, PORT_KNOWN_PASSWORDS) || [];                         // Peek existing list; null → fresh install
    const idx   = creds.findIndex(c => c.host === host);
    if (idx >= 0) {
        creds[idx].password = password;                                             // Update in place if already cracked before
    } else {
        creds.push({ host, password });                                             // New entry
    }
    clearPort(ns, PORT_KNOWN_PASSWORDS);                                            // Discard old value before writing updated list
    writePort(ns, PORT_KNOWN_PASSWORDS, creds);                                     // writePort JSON-encodes — do not pre-encode
    ns.tprint('Saved creds for ' + host + ' to port ' + PORT_KNOWN_PASSWORDS);
}
