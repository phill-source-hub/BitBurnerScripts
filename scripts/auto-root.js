/**
 * auto-root.js
 * Version: 1.4.0
 *
 * Scans all reachable servers and attempts to gain root access on each.
 *
 * Behaviour:
 *   Single pass (default): scans all servers, attempts root, reports results,
 *   then exits. Use this for a one-off root attempt after acquiring new crackers.
 *
 *   Watch mode (--watch): runs continuously every WATCH_INTERVAL ms. Detects
 *   newly acquired cracker programs and immediately re-attempts rooting when
 *   new ones are found. On any new root, writes an event to port 2 so that
 *   orchestrate.js can incorporate the new server next cycle.
 *
 *   SF4 backdoor: if the player owns Source-File 4, newly rooted servers that
 *   the player can hack are automatically backdoored using singularity functions.
 *   getPath() provides the hop-by-hop connect sequence required by
 *   ns.singularity.connect().
 *
 *   Port 2 ownership: this script clears port 2 on startup and writes a JSON
 *   event { host, time } for each newly rooted server. orchestrate.js peeks
 *   port 2 each cycle without consuming.
 *
 * Changelog:
 *   v1.4.0 - SCP worker.js to already-rooted servers that are missing it.
 *            Fixes pool gap when servers were rooted before v1.3.0 was installed.
 *   v1.3.0 - SCP worker.js to newly rooted servers so orchestrate pool is
 *            ready immediately without waiting for orchestrate's first cycle.
 *   v1.2.0 - Backdoor logic moved to backdoor.js (exec fire-and-forget).
 *            Removes lib-sf-utils.js import — auto-root now pays zero
 *            singularity RAM cost regardless of SF4 ownership.
 *   v1.1.0 - Imports hasSF + getPath from lib-sf-utils.js (not lib-utils).
 *            Inlines getAllServers, getRootAccess, canHack.
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --help    Show version, usage, and flags then exit
 *   --watch   Run continuously, re-checking every 5 minutes
 *
 * Ports:
 *   Writes port 2: { host, time } for each newly rooted server
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    writePort,
    clearPort,
    log,
} from '/scripts/lib-utils.js';

// --- Constants ---
const WATCH_INTERVAL     = 5 * 60 * 1000;                                          // 5 minutes between watch cycles
const KILL_SETTLE_MS     = 500;                                                     // ms to wait after killing orchestrate before relaunch
const PORT_AUTOROOT      = 2;                                                       // Port this script owns and writes to
const ORCHESTRATE_SCRIPT = '/scripts/orchestrate.js';                              // Path to orchestrate for relaunch
const BACKDOOR_SCRIPT    = 'scripts/backdoor.js';                                   // Launched per-host when SF4 available
const WORKER_SCRIPT      = 'scripts/worker.js';                                     // Copied to newly rooted servers for orchestrate

// All known port-cracker programs
const CRACKERS = [
    'BruteSSH.exe',
    'FTPCrack.exe',
    'relaySMTP.exe',
    'HTTPWorm.exe',
    'SQLInject.exe',
];


// =============================================================================
// Inlined network / root helpers (not in lib-utils — cracker fns add RAM cost)
// =============================================================================

function getAllServers(ns, host = 'home', visited = new Set()) {
    visited.add(host);
    for (const n of ns.scan(host)) {
        if (!visited.has(n)) getAllServers(ns, n, visited);
    }
    return Array.from(visited);
}

function canHack(ns, host) {
    return ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(host);
}

function getRootAccess(ns, host) {
    if (ns.hasRootAccess(host)) return true;

    const crackers = [
        { exe: 'BruteSSH.exe',  fn: () => ns.brutessh(host)  },
        { exe: 'FTPCrack.exe',  fn: () => ns.ftpcrack(host)  },
        { exe: 'relaySMTP.exe', fn: () => ns.relaysmtp(host) },
        { exe: 'HTTPWorm.exe',  fn: () => ns.httpworm(host)   },
        { exe: 'SQLInject.exe', fn: () => ns.sqlinject(host)  },
    ];

    let portsOpened = 0;
    for (const c of crackers) {
        if (ns.fileExists(c.exe, 'home')) { c.fn(); portsOpened++; }
    }

    if (portsOpened < ns.getServerNumPortsRequired(host)) return false;
    if (!ns.fileExists('NUKE.exe', 'home')) return false;

    ns.nuke(host);
    return ns.hasRootAccess(host);
}


// =============================================================================
// Helpers
// =============================================================================

/**
 * Returns the list of cracker programs currently owned on home.
 * @param {NS} ns
 * @returns {string[]} Owned cracker filenames
 */
function getOwnedCrackers(ns) {
    return CRACKERS.filter(exe => ns.fileExists(exe, 'home'));                      // Only crackers present on home
}

/**
 * Scans all servers and attempts root access on each unrooted server.
 * Writes a port 2 event for each newly rooted server.
 * Launches backdoor.js per newly rooted server — it self-exits if SF4 absent.
 * Returns the count of newly rooted servers.
 * @param {NS} ns
 * @returns {Promise<number>} Count of newly rooted servers this pass
 */
async function attemptRooting(ns) {
    const servers = getAllServers(ns);

    let alreadyRooted = 0;
    let newlyRooted   = 0;
    let failed        = 0;

    log(ns, '--- rooting pass ---');

    for (const host of servers) {
        if (host === 'home') continue;                                              // Home is never a target
        if (host.startsWith('cloud-server')) continue;                              // Skip our own purchased servers

        if (ns.hasRootAccess(host)) {
            alreadyRooted++;
            if (!ns.fileExists(WORKER_SCRIPT, host)) ns.scp(WORKER_SCRIPT, host, 'home');
            continue;
        }

        const success = getRootAccess(ns, host);

        if (success) {
            newlyRooted++;
            ns.tprint('[AUTO-ROOT] Rooted: ' + host);
            writePort(ns, PORT_AUTOROOT, { host, time: Date.now() });              // Notify orchestrate of new root
            ns.scp(WORKER_SCRIPT, host, 'home');                                   // Pre-copy worker so orchestrate pool is ready immediately

            // Launch backdoor.js per host — it self-exits if SF4 not owned.
            // Singularity RAM cost is isolated there; auto-root pays none of it.
            if (canHack(ns, host)) {
                ns.exec(BACKDOOR_SCRIPT, 'home', 1, host);
            }
        } else {
            failed++;
            const have   = getOwnedCrackers(ns).length;
            const needed = ns.getServerNumPortsRequired(host);
            log(ns, '[-] ' + host + ' — need ' + needed + ' ports, have ' + have);
        }
    }

    log(ns, 'Pass complete | already: ' + alreadyRooted + ' | new: ' + newlyRooted + ' | failed: ' + failed);
    return newlyRooted;
}

/**
 * Kills any running orchestrate.js instance and relaunches it.
 * Waits KILL_SETTLE_MS after kill to ensure old process has freed RAM
 * before the new instance starts — prevents double-dispatch on first cycle.
 * @param {NS} ns
 */
async function relaunchOrchestrate(ns) {
    ns.scriptKill(ORCHESTRATE_SCRIPT, 'home');                                      // Kill existing orchestrate instance
    await ns.sleep(KILL_SETTLE_MS);                                                 // Wait for process to fully terminate and free RAM
    const pid = ns.exec(ORCHESTRATE_SCRIPT, 'home', 1);
    if (pid === 0) {
        ns.tprint('[AUTO-ROOT] WARNING: failed to relaunch orchestrate.js');
    } else {
        ns.tprint('[AUTO-ROOT] orchestrate.js relaunched (pid ' + pid + ')');
    }
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',  false],
        ['watch', false],
    ]);

    if (flags.help) {
        ns.tprint('=== auto-root.js v1.4.0 ===');
        ns.tprint('Purpose: Gains root access on all reachable servers. Optionally');
        ns.tprint('         monitors for new crackers and backdoors servers via SF4.');
        ns.tprint('Usage:   run /scripts/auto-root.js [--watch]');
        ns.tprint('Flags:');
        ns.tprint('  --help    Show this help and exit');
        ns.tprint('  --watch   Run continuously, re-scanning every 5 minutes');
        ns.tprint('Ports:');
        ns.tprint('  Writes port 2: { host, time } for each newly rooted server');
        return;
    }

    ns.tprint('=== auto-root.js v1.4.0 | watch:' + flags.watch + ' ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    clearPort(ns, PORT_AUTOROOT);                                                   // Clear stale port 2 data from any previous run
    ns.atExit(() => clearPort(ns, PORT_AUTOROOT));                                  // Clear port 2 on exit so orchestrate sees no stale root events

    let knownCrackers = getOwnedCrackers(ns);                                       // Snapshot crackers at start for change detection

    do {
        const newlyRooted = await attemptRooting(ns);

        if (newlyRooted > 0) {
            ns.tprint('[AUTO-ROOT] ' + newlyRooted + ' new server(s) rooted — relaunching orchestrate.js');
            await relaunchOrchestrate(ns);
        }

        if (flags.watch) {
            log(ns, 'Next check in 5 minutes...');
            await ns.sleep(WATCH_INTERVAL);

            // Detect newly acquired crackers — trigger immediate re-attempt if found
            const currentCrackers = getOwnedCrackers(ns);
            const newCrackers     = currentCrackers.filter(c => !knownCrackers.includes(c));

            if (newCrackers.length > 0) {
                ns.tprint('[AUTO-ROOT] New cracker(s): ' + newCrackers.join(', ') + ' — re-attempting root');
                knownCrackers = currentCrackers;                                    // Update snapshot
                const crackerRooted = await attemptRooting(ns);
                if (crackerRooted > 0) {
                    ns.tprint('[AUTO-ROOT] ' + crackerRooted + ' new server(s) rooted — relaunching orchestrate.js');
                    await relaunchOrchestrate(ns);
                }
            } else {
                log(ns, 'No new crackers detected');
            }
        }

    } while (flags.watch);                                                          // Single pass exits here; watch mode loops
}
