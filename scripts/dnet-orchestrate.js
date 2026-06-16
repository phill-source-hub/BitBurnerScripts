/**
 * dnet-orchestrate.js
 * Version: 1.1.2
 *
 * Master darknet controller: crack → memfree → deploy phish → stasis.
 *
 * Behaviour:
 *   Runs a continuous loop gated on dnet.nextMutation(). Each cycle:
 *
 *   1. PROBE  — discover all darknet servers visible from current host.
 *   2. RECONNECT — for servers with known passwords (port 6): call connectToSession()
 *                  to restore sessions lost across mutations (sessions are PID-bound).
 *   3. CRACK  — for uncracked servers with numeric passwords (length <= AUTO_CRACK_MAX_LEN):
 *               brute-forces all combinations via authenticate(). On success the
 *               password is saved to port 6 and in-memory state is updated.
 *               Longer or non-numeric passwords are logged as needing manual crack.
 *   4. MEMFREE — for cracked servers with blocked RAM: runs memoryReallocation()
 *               inline (same PID = same session). Loops until RAM freed or fail.
 *   5. PHISH  — for cracked servers where dnet-phish.js is not already running:
 *               SCPs dnet-phish.js + lib-utils.js to the target then exec()s
 *               with as many threads as fit in free RAM.
 *   6. STASIS — for cracked servers not yet stasis-linked, within the global
 *               stasis limit, prioritised by shallowest depth: SCPs
 *               dnet-stasis-set.js then exec()s onto the target (requires
 *               STASIS_RAM_GB free on target).
 *   7. WAIT   — nextMutation() sleeps until the next network mutation event.
 *
 *   Session note: authenticate() and connectToSession() sessions are bound to
 *   this script's PID. memoryReallocation() and exec() onto darknet servers
 *   all use this session. dnet-phish.js runs on the remote server under its
 *   own PID and needs no session for phishingAttack().
 *
 * Changelog:
 *   v1.1.2 - Remove per-attempt sleep from tryCrack; authenticate() yields to
 *            engine itself. Only sleep on TIMEOUT/RATE_LIMITED responses.
 *   v1.1.1 - All scp() calls now pass 'home' as source — orchestrate may run on
 *            a darknet relay (darkweb) that doesn't have phish/stasis scripts.
 *   v1.1.0 - Hub propagation: stationary/passwordLength=0 nodes with a session
 *            (e.g. darkweb) now receive a copy of the orchestrator via exec(),
 *            allowing it to probe and crack the next layer of servers.
 *   v1.0.2 - Also skip passwordLength===0 servers; darkweb may not be isStationary.
 *            Add version to tail log via log() (tprint only reaches terminal).
 *   v1.0.1 - Skip isStationary servers (darkweb gateway) to prevent infinite
 *            crack loop on passwordLength=0 nodes.
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --no-stasis   Skip stasis link management (saves 12 GB on target servers)
 *   --no-phish    Skip phishing deployment
 *   --help        Show usage then exit
 *
 * Ports:
 *   Writes port 6: JSON array of { host, password } — cracked server creds.
 *                  Peek-safe: dnet-watch.js also reads this port without consuming.
 *
 * RAM cost:
 *   0.2  probe              0.05 getDarknetInstability
 *   0.1  getServerDetails   0.05 getStasisLinkedServers
 *   0.4  authenticate       0.05 getStasisLinkLimit
 *   0.05 connectToSession   1.0  memoryReallocation
 *   1.3  ns.exec            0.6  ns.scp
 *   0.1  ns.isRunning       0.05 ns.getServerMaxRam
 *   0.05 ns.getServerUsedRam
 *   ~= 4.1 GB total — run from home
 *
 * Dependencies:
 *   import { log, readPort, writePort, clearPort } from '/scripts/lib-utils.js';
 */

import { log, readPort, writePort, clearPort } from '/scripts/lib-utils.js';

// --- Constants ---
const PORT_DNET_CREDS    = 6;                                                       // Shared with dnet-watch.js and dnet-crack.js; ports 1-5 taken
const PHISH_SCRIPT       = '/scripts/dnet-phish.js';                                // Deployed to cracked servers for income
const STASIS_SCRIPT      = '/scripts/dnet-stasis-set.js';                           // One-shot worker exec'd onto target to apply stasis link
const LIB_UTILS          = '/scripts/lib-utils.js';                                 // Required by dnet-phish.js on remote server
const STASIS_RAM_GB      = 12;                                                      // GB required on target to run dnet-stasis-set.js
const PHISH_RAM_GB       = 4;                                                       // GB per thread for dnet-phish.js (2 phish + 2 openCache)
const AUTO_CRACK_MAX_LEN = 4;                                                       // Only brute-force numeric passwords up to this length (10K max)
const RATE_LIMIT_SLEEP_MS  = 2000;                                                  // Pause after rate-limit or timeout response from authenticate
const CYCLE_SLEEP_MS       = 200;                                                   // Minimum yield per loop iteration to avoid engine lockup
const ORCH_SCRIPT          = '/scripts/dnet-orchestrate.js';                        // Self-path for hub propagation
const ORCH_RAM_GB          = 5;                                                     // Approximate RAM to reserve for orchestrate on hub nodes


// --- Server state map (in-memory, survives across mutations) ---
// Map<host, { password: string|null, phishPid: number, stasisLinked: boolean }>
const state = new Map();


// =============================================================================
// Entry point
// =============================================================================

/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-orchestrate.js v1.1.2 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    const flags = ns.flags([
        ['no-stasis', false],
        ['no-phish',  false],
        ['help',      false],
    ]);

    if (flags.help) {
        ns.tprint('Usage: run dnet-orchestrate.js [--no-stasis] [--no-phish]');
        ns.tprint('  --no-stasis  Skip stasis link management');
        ns.tprint('  --no-phish   Skip phishing deployment');
        return;
    }

    log(ns, '=== dnet-orchestrate.js v1.1.2 ===');
    log(ns, 'Starting on ' + ns.getHostname());

    // Load any previously cracked creds from port 6 into state map
    loadCredsFromPort(ns);

    // Run one pass immediately before first mutation so we act on existing servers
    await runCycle(ns, flags);

    while (true) {
        await ns.dnet.nextMutation();                                                // Sleeps until next darknet topology mutation
        await ns.sleep(CYCLE_SLEEP_MS);                                             // Yield to engine after wakeup (rule 12)
        log(ns, '--- mutation ---');
        await runCycle(ns, flags);
    }
}


// =============================================================================
// Main cycle
// =============================================================================

/**
 * Runs one full probe → crack → memfree → phish → stasis cycle.
 * @param {NS} ns - Netscript object
 * @param {object} flags - Parsed ns.flags() result
 * @returns {Promise<void>}
 */
async function runCycle(ns, flags) {
    const dnet     = ns.dnet;
    const visible  = dnet.probe();                                                  // All darknet servers directly connected to this host

    if (visible.length === 0) {
        log(ns, 'No darknet servers visible from ' + ns.getHostname());
        return;
    }

    const instability  = dnet.getDarknetInstability();
    const stasisLinked = new Set(dnet.getStasisLinkedServers());                    // Currently stasis-pinned servers
    const stasisLimit  = dnet.getStasisLinkLimit();
    let   stasisUsed   = stasisLinked.size;                                         // Track locally so we can decrement/increment without re-querying

    log(ns, 'Visible: ' + visible.length
        + '  instability: ' + instability.authenticationDurationMultiplier.toFixed(2) + 'x'
        + '  stasis: ' + stasisUsed + '/' + stasisLimit);

    // Reconnect sessions for servers we already have passwords for — sessions lost on mutation
    for (const host of visible) {
        const s = state.get(host);
        if (s && s.password) {
            const r = dnet.connectToSession(host, s.password);
            if (r.success) log(ns, 'Session reconnected: ' + host);
        }
    }

    // Sort shallowest depth first — stasis slots go to most accessible servers
    const byDepth = [...visible].sort(function(a, b) {
        return dnet.getServerDetails(a).depth - dnet.getServerDetails(b).depth;
    });

    for (const host of byDepth) {
        const d = dnet.getServerDetails(host);
        if (!d.isOnline) {
            log(ns, 'SKIP ' + host + ' (offline)');
            continue;
        }
        if (d.isStationary || d.passwordLength === 0) {
            // Hub node (e.g. darkweb) — not crackable, but if session exists propagate deeper
            if (d.hasSession) {
                await propagateToHub(ns, host);
            } else {
                log(ns, 'SKIP ' + host + ' (hub, no session yet)');
            }
            continue;
        }

        // Initialise state entry on first encounter
        if (!state.has(host)) state.set(host, { password: null, phishPid: 0, stasisLinked: false });
        const s = state.get(host);

        s.stasisLinked = stasisLinked.has(host);                                    // Sync stasis status from live data each cycle

        // --- CRACK ---
        if (!s.password) {
            const cracked = await tryCrack(ns, host, d);
            if (cracked) {
                s.password = cracked;
                saveCredToPort(ns, host, cracked);                                  // Persist to port 6 so dnet-watch can reconnect too
            } else {
                continue;                                                            // Cannot proceed without a session
            }
        }

        // Ensure session is active — may have been lost if mutation killed the server
        if (!d.hasSession) {
            const r = dnet.connectToSession(host, s.password);
            if (!r.success) {
                log(ns, 'Session lost on ' + host + ' — will retry next cycle');
                continue;
            }
        }

        // --- MEMFREE ---
        if (d.blockedRam > 0) {
            await freeMemory(ns, host, d.blockedRam);
        }

        // --- PHISH ---
        if (!flags['no-phish']) {
            s.phishPid = await ensurePhish(ns, host, s.phishPid);
        }

        // --- STASIS ---
        if (!flags['no-stasis'] && !s.stasisLinked && stasisUsed < stasisLimit) {
            const applied = await applyStasis(ns, host);
            if (applied) {
                s.stasisLinked = true;
                stasisUsed++;                                                        // Decrement available slots locally
            }
        }
    }
}


// =============================================================================
// Crack
// =============================================================================

/**
 * Attempts to crack host by brute-forcing numeric passwords up to AUTO_CRACK_MAX_LEN.
 * Returns the cracked password string on success, or null if unable to auto-crack.
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the target server
 * @param {object} d - DarknetServerDetails for the target
 * @returns {Promise<string|null>}
 */
async function tryCrack(ns, host, d) {
    const dnet = ns.dnet;

    if (d.passwordFormat !== 'numeric' || d.passwordLength > AUTO_CRACK_MAX_LEN) {
        // Non-numeric or too long — log for manual follow-up with dnet-crack.js
        log(ns, 'MANUAL ' + host + ' — ' + d.passwordFormat + ' len=' + d.passwordLength
            + '  hint: ' + (d.passwordHint || 'none'));
        return null;
    }

    const total = Math.pow(10, d.passwordLength);                                   // Candidate count: 10^length
    log(ns, 'Cracking ' + host + ' (' + total + ' numeric combos)...');

    for (let i = 0; i < total; i++) {
        const pw = String(i).padStart(d.passwordLength, '0');                       // Zero-pad to exact length (e.g. "007")
        const r  = await dnet.authenticate(host, pw);
        if (r.success) {
            log(ns, 'CRACKED ' + host + ' = ' + pw);
            return pw;
        }
        // Back off on rate-limit only — authenticate() already yields to the engine
        if (r.code === 'TIMEOUT' || r.code === 'RATE_LIMITED') {
            await ns.sleep(RATE_LIMIT_SLEEP_MS);
        }
    }

    log(ns, 'CRACK FAILED ' + host + ' — exhausted ' + total + ' combos');
    return null;
}


// =============================================================================
// Memory reallocation
// =============================================================================

/**
 * Loops memoryReallocation() on host until blockedRam hits 0 or the call fails.
 * Requires an active session (same PID that called authenticate/connectToSession).
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the authenticated target server
 * @param {number} initialBlocked - Blocked RAM in GB as read before this call
 * @returns {Promise<void>}
 */
async function freeMemory(ns, host, initialBlocked) {
    log(ns, 'memfree ' + host + ' blocked=' + initialBlocked + ' GB');
    let blocked = initialBlocked;

    while (blocked > 0) {
        const r = await ns.dnet.memoryReallocation(host);
        if (!r.success) {
            log(ns, 'memfree stopped on ' + host + ' code=' + r.code);
            break;
        }
        const updated = ns.dnet.getServerDetails(host).blockedRam;
        if (updated >= blocked) break;                                              // No progress this iteration — stop to avoid infinite loop
        blocked = updated;

        await ns.sleep(CYCLE_SLEEP_MS);                                             // Yield to engine between reallocation calls (rule 12)
    }

    log(ns, 'memfree done ' + host + ' remaining=' + blocked + ' GB');
}


// =============================================================================
// Phish deployment
// =============================================================================

/**
 * Ensures dnet-phish.js is running on the target server. Re-deploys if the
 * previous PID has died (e.g. server restarted after a mutation).
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the cracked darknet server
 * @param {number} prevPid - PID from a previous deploy, or 0 if none
 * @returns {Promise<number>} Active PID, or 0 if deploy failed
 */
async function ensurePhish(ns, host, prevPid) {
    if (prevPid > 0 && ns.isRunning(prevPid)) return prevPid;                      // Script still alive — no action needed

    const maxRam  = ns.getServerMaxRam(host);
    const usedRam = ns.getServerUsedRam(host);
    const freeRam = maxRam - usedRam;
    const threads = Math.floor(freeRam / PHISH_RAM_GB);                            // Fill all free RAM with phish threads

    if (threads < 1) {
        log(ns, 'PHISH SKIP ' + host + ' — only ' + freeRam.toFixed(1) + ' GB free (need ' + PHISH_RAM_GB + ')');
        return 0;
    }

    // Always pull from home — orchestrate may be running on a darknet relay (e.g. darkweb)
    const scpOk = await ns.scp([PHISH_SCRIPT, LIB_UTILS], host, 'home');
    if (!scpOk) {
        log(ns, 'PHISH SCP FAILED ' + host);
        return 0;
    }

    const pid = ns.exec(PHISH_SCRIPT, host, threads);
    if (pid === 0) {
        log(ns, 'PHISH EXEC FAILED ' + host);
        return 0;
    }

    log(ns, 'PHISH deployed ' + host + ' t=' + threads + ' pid=' + pid);
    return pid;
}


// =============================================================================
// Stasis
// =============================================================================

/**
 * Execs dnet-stasis-set.js on host to apply a stasis link.
 * Requires at least STASIS_RAM_GB free on the target server.
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the cracked darknet server
 * @returns {Promise<boolean>} true if the stasis worker was successfully exec'd
 */
async function applyStasis(ns, host) {
    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (freeRam < STASIS_RAM_GB) {
        log(ns, 'STASIS SKIP ' + host + ' — ' + freeRam.toFixed(1) + ' GB free (need ' + STASIS_RAM_GB + ')');
        return false;
    }

    const scpOk = await ns.scp(STASIS_SCRIPT, host, 'home');                       // Always pull from home — may be running on a relay
    if (!scpOk) {
        log(ns, 'STASIS SCP FAILED ' + host);
        return false;
    }

    const pid = ns.exec(STASIS_SCRIPT, host, 1);
    if (pid === 0) {
        log(ns, 'STASIS EXEC FAILED ' + host);
        return false;
    }

    log(ns, 'STASIS worker launched on ' + host + ' pid=' + pid);
    return true;
}


// =============================================================================
// Hub propagation
// =============================================================================

/**
 * Deploys a copy of the orchestrator onto a hub node (e.g. darkweb) so it can
 * probe and crack the next layer of servers. Hub nodes have sessions but no
 * password — we cannot crack them, but we can exec onto them.
 * Skips deployment if orchestrate is already running on the hub.
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the hub server
 * @returns {Promise<void>}
 */
async function propagateToHub(ns, host) {
    // Check if orchestrate is already running on this hub — avoid duplicates
    if (ns.isRunning(ORCH_SCRIPT, host)) {
        return;                                                                      // Already propagated — nothing to do
    }

    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (freeRam < ORCH_RAM_GB) {
        log(ns, 'HUB SKIP ' + host + ' — only ' + freeRam.toFixed(1) + ' GB free (need ~' + ORCH_RAM_GB + ')');
        return;
    }

    // Pull orchestrate + lib-utils from home — hub has neither file
    const scpOk = await ns.scp([ORCH_SCRIPT, LIB_UTILS], host, 'home');
    if (!scpOk) {
        log(ns, 'HUB SCP FAILED ' + host);
        return;
    }

    const pid = ns.exec(ORCH_SCRIPT, host, 1);
    if (pid === 0) {
        log(ns, 'HUB EXEC FAILED ' + host);
        return;
    }

    log(ns, 'HUB propagated orchestrate to ' + host + ' pid=' + pid);
}


// =============================================================================
// Port 6 credential store
// =============================================================================

/**
 * Loads existing cracked creds from port 6 into the in-memory state map.
 * Called once on startup so previously discovered passwords survive restarts.
 * @param {NS} ns - Netscript object
 * @returns {void}
 */
function loadCredsFromPort(ns) {
    const creds = readPort(ns, PORT_DNET_CREDS);
    if (!Array.isArray(creds)) return;
    for (const { host, password } of creds) {
        if (!state.has(host)) state.set(host, { password: null, phishPid: 0, stasisLinked: false });
        state.get(host).password = password;
    }
    log(ns, 'Loaded ' + creds.length + ' known password(s) from port ' + PORT_DNET_CREDS);
}

/**
 * Appends or updates { host, password } in the port 6 credential array.
 * Clears and rewrites the port to ensure only one JSON array is present.
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the newly cracked server
 * @param {string} password - The discovered password
 * @returns {void}
 */
function saveCredToPort(ns, host, password) {
    const creds = readPort(ns, PORT_DNET_CREDS) || [];                             // Existing list; null on first run
    const idx   = creds.findIndex(c => c.host === host);
    if (idx >= 0) {
        creds[idx].password = password;                                             // Update in place if previously known
    } else {
        creds.push({ host, password });
    }
    clearPort(ns, PORT_DNET_CREDS);                                                 // Discard old value before writing updated list (rule 10)
    writePort(ns, PORT_DNET_CREDS, creds);                                          // writePort JSON-encodes — do not pre-encode
}
