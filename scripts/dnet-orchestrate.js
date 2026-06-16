/**
 * dnet-orchestrate.js
 * Version: 1.4.0
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
 *               Heartbleed peek before brute-force surfaces any prior-attempt clues.
 *               Crack worker (dnet-crack-worker.js) is exec'd with max threads that
 *               fit in free RAM; more threads = faster per authenticate() call.
 *               Result arrives on port 7; orchestrator connects via connectToSession.
 *   4. MEMFREE — for cracked servers with blocked RAM: runs memoryReallocation()
 *               inline (same PID = same session). Loops until RAM freed or fail.
 *   5. PHISH  — for cracked servers where dnet-phish.js is not already running:
 *               SCPs dnet-phish.js + lib-utils.js to the target then exec()s
 *               with as many threads as fit in free RAM.
 *   6. STASIS — for cracked servers not yet stasis-linked, within the global
 *               stasis limit, prioritised by shallowest depth: SCPs
 *               dnet-stasis-set.js then exec()s onto the target (requires
 *               STASIS_RAM_GB free on target).
 *   7. EXPAND — propagateToStasisLinked(): for stasis-linked servers NOT in
 *               probe() list (i.e. deeper than current host), gets a session
 *               via connectToSession() and exec()s orchestrator onto them.
 *               Stasis links enable exec at any distance per the darknet API.
 *               Enables recursive depth expansion: home→darkweb→depth0→depth1→…
 *   8. WAIT   — nextMutation() sleeps until the next network mutation event.
 *
 *   Session note: authenticate() and connectToSession() sessions are bound to
 *   this script's PID. memoryReallocation() and exec() onto darknet servers
 *   all use this session. dnet-phish.js runs on the remote server under its
 *   own PID and needs no session for phishingAttack().
 *
 * Changelog:
 *   v1.7.0 - Stasis expansion: propagateToStasisLinked() execs orchestrator onto
 *            stasis-linked servers not in current probe() list. Stasis allows
 *            exec at any distance, enabling home→depth0→depth1→… propagation.
 *            ensurePhish reserves ORCH_RAM_GB so orchestrator fits alongside phish.
 *   v1.6.0 - Fix hub vs ZeroLogon detection: hub = isStationary OR (passwordLength=0
 *            AND hasSession already granted). ZeroLogon servers have passwordLength=0
 *            but hasSession=false and must be cracked with authenticate(host,'').
 *            Previously skipped as hubs — smart_toaster etc. now crackable.
 *            crackInline now logs modelId and short-circuits on ZeroLogon model.
 *   v1.5.0 - Remove crack worker machinery — darknet hub nodes cannot exec new
 *            scripts onto themselves even with a session. Inline sequential
 *            cracking (crackInline) is the only viable approach from a hub.
 *            Removes PORT_CRACK_RESULT, CRACK_WORKER, crackPid state, worker
 *            launch/check code, and self-session attempt.
 *   v1.3.0 - Heartbleed peek before brute-force to surface clues from prior
 *            attempts. BB does not allow concurrent NS calls so Promise.all
 *            parallel cracking is not possible; sequential loop retained.
 *   v1.2.1 - Separate stasis and propagation across cycles — stasis worker uses
 *            12 GB so orchestrator (5 GB) must wait until next cycle for RAM.
 *            Return early after stasis exec; propagate on next mutation cycle.
 *   v1.2.0 - Apply stasis to hub nodes before propagating orchestrator.
 *            Mutations restart hub servers, killing mid-crack orchestrators.
 *            Hub stability takes priority over cracked-server stasis slots.
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
 *   0.6  heartbleed         0.05 ns.getServerUsedRam
 *   ~= 4.7 GB total — run from home
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
    ns.tprint('=== dnet-orchestrate.js v1.7.0 ===');
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

    log(ns, '=== dnet-orchestrate.js v1.7.0 ===');
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
        // Hub detection: isStationary OR (passwordLength=0 AND auto-session already granted).
        // ZeroLogon servers also have passwordLength=0 but hasSession=false — they need cracking.
        const isHub = d.isStationary || (d.passwordLength === 0 && d.hasSession);
        if (isHub) {
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
            // Crack inline — hub nodes cannot exec worker scripts onto themselves
            const pw = await crackInline(ns, host, d);
            if (pw) {
                s.password = pw;
                saveCredToPort(ns, host, pw);
            }
            continue;
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

    // Propagate orchestrator to stasis-linked servers not in this host's probe() list.
    // Stasis links enable exec at any distance — home can reach depth-0, depth-1, etc.
    await propagateToStasisLinked(ns, new Set(visible));
}


// =============================================================================
// Crack
// =============================================================================

/**
 * Reads completed crack results from port 7, updates state, and establishes
 * sessions for newly cracked servers. Called at the top of every runCycle.
 * @param {NS} ns - Netscript object
 */
function checkCrackResults(ns) {
    const results = readPort(ns, PORT_CRACK_RESULT);
    if (!Array.isArray(results) || results.length === 0) return;

    for (const { host, password } of results) {
        if (!state.has(host)) state.set(host, { password: null, phishPid: 0, stasisLinked: false });
        const s = state.get(host);
        s.crackPid = 0;                                                             // Worker has exited regardless of success/failure

        if (!password) {
            log(ns, 'Crack worker reported failure on ' + host + ' — will relaunch next cycle');
            continue;
        }
        if (s.password) continue;                                                   // Already have it (duplicate result)

        s.password = password;
        saveCredToPort(ns, host, password);
        log(ns, 'Crack result: ' + host + ' = ' + password);

        const r = ns.dnet.connectToSession(host, password);                         // Restore orchestrator's own PID-bound session
        if (r.success) {
            log(ns, 'Session established: ' + host);
        } else {
            log(ns, 'connectToSession failed for ' + host + ' code=' + r.code);
        }
    }

    clearPort(ns, PORT_CRACK_RESULT);                                               // Drain processed results; workers will re-populate as needed
}

/**
 * Inline sequential brute-force — used when exec onto this host is not permitted.
 * Tries all numeric passwords up to AUTO_CRACK_MAX_LEN, one attempt per iteration.
 * authenticate() already yields to the engine each call, so no extra sleep needed.
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the target server
 * @param {object} d - DarknetServerDetails for the target
 * @returns {Promise<string|null>} Password on success, null on failure or non-crackable
 */
async function crackInline(ns, host, d) {
    const model = d.modelId || 'unknown';

    // ZeroLogon model (or any passwordLength=0 non-hub): always empty password
    if (d.modelId === 'ZeroLogon' || d.passwordLength === 0) {
        log(ns, 'ZeroLogon crack: ' + host + ' (model=' + model + ')');
        const r = await ns.dnet.authenticate(host, '');
        if (r.success) {
            log(ns, 'CRACKED ' + host + ' = "" (ZeroLogon)');
            return '';
        }
        log(ns, 'ZeroLogon FAILED ' + host + ' code=' + r.code);
        return null;
    }

    if (d.passwordFormat !== 'numeric' || d.passwordLength > AUTO_CRACK_MAX_LEN) {
        log(ns, 'MANUAL ' + host + ' — model=' + model + ' format=' + d.passwordFormat
            + ' len=' + d.passwordLength + '  hint: ' + (d.passwordHint || 'none'));
        return null;
    }

    const total = Math.pow(10, d.passwordLength);
    log(ns, 'Cracking inline ' + host + ' (model=' + model + ' ' + total + ' combos)...');

    for (let i = 0; i < total; i++) {
        const pw = String(i).padStart(d.passwordLength, '0');
        const r  = await ns.dnet.authenticate(host, pw);
        if (r.success) {
            log(ns, 'CRACKED ' + host + ' = ' + pw);
            return pw;
        }
        if (r.code === 'TIMEOUT' || r.code === 'RATE_LIMITED') {
            await ns.sleep(RATE_LIMIT_SLEEP_MS);
        }
    }

    log(ns, 'CRACK FAILED ' + host + ' — exhausted ' + total + ' combos');
    return null;
}

/**
 * Execs dnet-crack-worker.js on the current host with as many threads as fit
 * in free RAM. More threads = faster per authenticate() call per the API.
 * Returns the worker PID (> 0) on success, or 0 if the server cannot be auto-cracked.
 * @param {NS} ns - Netscript object
 * @param {string} host - Hostname of the target server
 * @param {object} d - DarknetServerDetails for the target
 * @returns {Promise<number>} Worker PID or 0
 */
async function launchCrackWorker(ns, host, d) {
    if (d.passwordFormat !== 'numeric' || d.passwordLength > AUTO_CRACK_MAX_LEN) {
        return 0;                                                                    // Caller (crackInline) will log MANUAL
    }

    // Heartbleed peek — surface any clues from prior attempts before launching worker
    const preBleed = await ns.dnet.heartbleed(host, { peek: true });
    if (preBleed.success && preBleed.logs && preBleed.logs.length > 0) {
        log(ns, 'HB pre-crack ' + host + ':');
        for (const entry of preBleed.logs) log(ns, '  HB: ' + entry);
    }

    const myHost  = ns.getHostname();
    const maxRam  = ns.getServerMaxRam(myHost);
    const usedRam = ns.getServerUsedRam(myHost);
    const freeRam = maxRam - usedRam;
    const threads = Math.max(1, Math.floor(freeRam / CRACK_WORKER_RAM_GB));         // Fill free RAM with crack threads; minimum 1

    log(ns, 'Crack worker RAM: max=' + maxRam.toFixed(1) + ' used=' + usedRam.toFixed(1)
        + ' free=' + freeRam.toFixed(1) + ' → ' + threads + ' threads');

    const scpOk = await ns.scp([CRACK_WORKER, LIB_UTILS], myHost, 'home');         // Ensure worker is present on this host
    if (!scpOk) {
        log(ns, 'CRACK WORKER SCP FAILED for ' + host);
        return 0;
    }

    const pid = ns.exec(CRACK_WORKER, myHost, threads, host, d.passwordLength);
    if (pid === 0) {
        log(ns, 'CRACK WORKER EXEC FAILED for ' + host
            + ' (freeRam=' + freeRam.toFixed(1) + ' GB, threads=' + threads + ')');
        return 0;
    }

    log(ns, 'Crack worker launched: ' + host + ' — ' + threads + ' threads (freeRam='
        + freeRam.toFixed(1) + ' GB) pid=' + pid);
    return pid;
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

    const maxRam    = ns.getServerMaxRam(host);
    const usedRam   = ns.getServerUsedRam(host);
    const freeRam   = maxRam - usedRam;
    const available = freeRam - ORCH_RAM_GB;                                        // Reserve ORCH_RAM_GB for a future orchestrator propagating deeper
    const threads   = Math.floor(available / PHISH_RAM_GB);                         // Fill remaining RAM with phish threads

    if (threads < 1) {
        log(ns, 'PHISH SKIP ' + host + ' — only ' + freeRam.toFixed(1) + ' GB free after ' + ORCH_RAM_GB + ' GB reserved (need ' + PHISH_RAM_GB + ')');
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
    const stasisLinked = new Set(ns.dnet.getStasisLinkedServers());
    const slotsLimit   = ns.dnet.getStasisLinkLimit();

    // Step 1: ensure hub has a stasis link before propagating the orchestrator.
    // We exec the stasis worker and return early this cycle — the worker needs
    // 12 GB and its RAM must be freed before the orchestrator (5 GB) can start.
    // On the next cycle, stasis should be confirmed and RAM freed.
    if (!stasisLinked.has(host)) {
        if (stasisLinked.size >= slotsLimit) {
            log(ns, 'HUB stasis skip ' + host + ' — no stasis slots available');
            // Fall through to propagate without stasis — better than nothing
        } else {
            const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
            if (freeRam < STASIS_RAM_GB) {
                log(ns, 'HUB stasis skip ' + host + ' — only ' + freeRam.toFixed(1) + ' GB free (need ' + STASIS_RAM_GB + ' for worker)');
                // Fall through to try propagating anyway with available RAM
            } else {
                const scpOk = await ns.scp(STASIS_SCRIPT, host, 'home');
                if (scpOk) {
                    const pid = ns.exec(STASIS_SCRIPT, host, 1);
                    if (pid > 0) {
                        log(ns, 'HUB stasis worker exec on ' + host + ' pid=' + pid + ' — waiting next cycle to propagate');
                        return;                                                      // Return now; stasis worker needs its 12 GB, and the next cycle will propagate orchestrate once RAM is freed
                    }
                    log(ns, 'HUB stasis exec failed on ' + host);
                } else {
                    log(ns, 'HUB stasis scp failed to ' + host);
                }
            }
        }
    }

    // Step 2: propagate orchestrator — stasis is either confirmed or unavailable
    if (ns.isRunning(ORCH_SCRIPT, host)) {
        return;                                                                      // Already running — nothing to do
    }

    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (freeRam < ORCH_RAM_GB) {
        log(ns, 'HUB SKIP ' + host + ' — only ' + freeRam.toFixed(1) + ' GB free (need ~' + ORCH_RAM_GB + ')');
        return;
    }

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
// Stasis expansion
// =============================================================================

/**
 * Propagates the orchestrator to stasis-linked servers not visible in the current
 * host's probe() list. Stasis links allow exec at any distance — home can reach
 * depth-0, depth-1, etc. directly without needing to be adjacent.
 *
 * Requires a known password (port 6) and connectToSession() to get a session first.
 * Skips servers already in the probe() visible set (handled by hub propagation).
 * Skips servers where the orchestrator is already running.
 *
 * @param {NS} ns - Netscript object
 * @param {Set<string>} skip - Hostnames already handled this cycle (probe() result)
 * @returns {Promise<void>}
 */
async function propagateToStasisLinked(ns, skip) {
    const stasisLinked = ns.dnet.getStasisLinkedServers();
    if (stasisLinked.length === 0) return;

    const creds = readPort(ns, PORT_DNET_CREDS) || [];
    if (creds.length === 0) return;

    for (const host of stasisLinked) {
        if (skip.has(host)) continue;                                               // In probe() list — already handled by hub/server loop
        if (ns.isRunning(ORCH_SCRIPT, host)) continue;                             // Already running — nothing to do

        const cred = creds.find(c => c.host === host);
        if (!cred) {
            log(ns, 'STASIS EXPAND skip ' + host + ' — no password in port 6');
            continue;
        }

        // Establish session — stasis link allows connectToSession at any distance
        const r = ns.dnet.connectToSession(host, cred.password);
        if (!r.success) {
            log(ns, 'STASIS EXPAND session failed ' + host + ' code=' + r.code);
            continue;
        }

        const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        if (freeRam < ORCH_RAM_GB) {
            log(ns, 'STASIS EXPAND skip ' + host + ' — only ' + freeRam.toFixed(1) + ' GB free (need ~' + ORCH_RAM_GB + ')');
            continue;
        }

        // SCP from home — orchestrator and lib-utils must always be pulled from the source of truth
        const scpOk = await ns.scp([ORCH_SCRIPT, LIB_UTILS], host, 'home');
        if (!scpOk) {
            log(ns, 'STASIS EXPAND scp failed to ' + host);
            continue;
        }

        const pid = ns.exec(ORCH_SCRIPT, host, 1);
        if (pid === 0) {
            log(ns, 'STASIS EXPAND exec failed on ' + host);
            continue;
        }

        log(ns, 'STASIS EXPAND propagated orchestrate to ' + host + ' pid=' + pid);
    }
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
