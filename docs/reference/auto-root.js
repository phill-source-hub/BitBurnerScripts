/**
 * auto-root.js
 * Version: 1.4.1
 *
 * Scans all reachable servers and attempts to gain root access on each.
 * Uses all available port-cracker programs found on home, skipping any
 * that are not yet owned. Reports results for each server to terminal.
 *
 * In --watch mode, monitors for new cracker programs every 5 minutes.
 * When new crackers are detected, re-attempts rooting immediately then
 * continues normal watch cycle. If new servers are rooted, relaunches
 * orchestrate.js automatically.
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *   v1.1.0 - Added --watch flag for continuous monitoring
 *            Detects new crackers and re-attempts rooting automatically
 *            Relaunches orchestrate.js when new servers are rooted
 *   v1.2.0 - Updated relaunchOrchestrate to match orchestrate.js v2.0.0
 *            Removed --skiphome --loop flags (no longer accepted)
 *   v1.3.0 - New crackers now trigger immediate attemptRooting() rather
 *            than deferring to the next watch cycle
 *   v1.4.1 - Terminal output limited to event-level messages (new roots, new crackers,
 *            relaunch). Per-server scan results and summaries moved to ns.print() (tail).
 *   v1.4.0 - relaunchOrchestrate is now async; adds 500ms sleep between
 *            scriptKill and exec to let the killed process fully terminate
 *            before the new instance starts, preventing double-dispatch
 *            on the first orchestrate cycle
 *
 * Usage: run /scripts/auto-root.js
 * Usage: run /scripts/auto-root.js --watch
 * View:  tail /scripts/auto-root.js
 *
 * Dependencies: /scripts/lib/lib-utils.js
 */
 
import { getAllServers, getRootAccess, log } from '/scripts/lib/lib-utils.js';
 
const ORCHESTRATE_SCRIPT = '/scripts/orchestrate.js';                           // Path to orchestrate script
const WATCH_INTERVAL     = 5 * 60 * 1000;                                       // 5 minutes in ms
const KILL_SETTLE_MS     = 500;                                                  // ms to wait after kill before relaunching
const CRACKERS           = [                                                     // All known cracker programs
    'BruteSSH.exe',
    'FTPCrack.exe',
    'relaySMTP.exe',
    'HTTPWorm.exe',
    'SQLInject.exe',
];
 
export async function main(ns) {
    ns.disableLog('ALL');                                                        // Suppress default NS logs
 
    const flags     = ns.flags([['watch', false]]);                              // Parse --watch flag
    const watchMode = flags.watch;                                               // Store watch mode value
 
    // Get initial cracker state
    let knownCrackers = getOwnedCrackers(ns);                                    // Track currently owned crackers
 
    do {
        const newlyRooted = await attemptRooting(ns);                            // Attempt rooting all servers
 
        if (newlyRooted > 0) {                                                   // New servers were rooted
            ns.tprint(`[AUTO-ROOT] ${newlyRooted} new server(s) rooted — relaunching orchestrate.js`);
            await relaunchOrchestrate(ns);                                       // Relaunch orchestrate (async — waits for settle)
        }
 
        if (watchMode) {                                                         // Watch mode enabled
            ns.print(`[AUTO-ROOT] Next check in 5 minutes...`);                  // Log next check time to tail
            await ns.sleep(WATCH_INTERVAL);                                      // Wait 5 minutes
 
            // Check for new crackers
            const currentCrackers = getOwnedCrackers(ns);                       // Get current cracker list
            const newCrackers     = currentCrackers.filter(                      // Find newly acquired crackers
                c => !knownCrackers.includes(c)
            );
 
            if (newCrackers.length > 0) {                                        // New crackers detected
                ns.tprint(`[AUTO-ROOT] New cracker(s) detected: ${newCrackers.join(', ')}`); // Report
                knownCrackers = currentCrackers;                                 // Update known crackers list
                const crackerRooted = await attemptRooting(ns);                  // Immediately re-attempt rooting
                if (crackerRooted > 0) {                                         // New servers rooted from new crackers
                    ns.tprint(`[AUTO-ROOT] ${crackerRooted} new server(s) rooted — relaunching orchestrate.js`);
                    await relaunchOrchestrate(ns);                               // Relaunch orchestrate with expanded farm
                }
            } else {                                                             // No new crackers
                ns.print(`[AUTO-ROOT] No new crackers detected`);                // Log no change to tail
            }
        }
 
    } while (watchMode);                                                         // Loop if watch mode
}
 
/**
 * Attempts to gain root access on all reachable servers.
 * Returns the count of newly rooted servers.
 * @param {NS} ns - Netscript object
 * @returns {number} Count of newly rooted servers
 */
async function attemptRooting(ns) {
    const servers = getAllServers(ns);                                            // Get all reachable servers
 
    let alreadyRooted = 0;                                                       // Servers already rooted
    let newlyRooted   = 0;                                                       // Servers rooted this run
    let failed        = 0;                                                       // Servers we could not root
 
    ns.print('==========================================================');
    ns.print(' AUTO-ROOT — Attempting root access on all servers');
    ns.print('==========================================================');
 
    for (const host of servers) {                                                // Iterate every server
        if (host === 'home') continue;                                           // Skip home server
        if (host.startsWith('cloud-server')) continue;                           // Skip our own servers
 
        const wasRooted = ns.hasRootAccess(host);                                // Check existing root status
 
        if (wasRooted) {                                                         // Already have root access
            alreadyRooted++;                                                     // Increment already rooted count
            continue;                                                            // No action needed
        }
 
        const success = getRootAccess(ns, host);                                 // Attempt to gain root access
 
        if (success) {                                                           // Root attempt succeeded
            newlyRooted++;                                                       // Increment newly rooted count
            ns.print(`  [+] Rooted: ${host}`);                                  // Report success to tail
        } else {                                                                 // Root attempt failed
            failed++;                                                            // Increment failed count
            const portsHave   = countOwnedCrackers(ns);                          // How many crackers we own
            const portsNeeded = ns.getServerNumPortsRequired(host);              // How many ports server needs
            ns.print(`  [-] Failed: ${host} (need ${portsNeeded} ports, have ${portsHave})`); // Report to tail
        }
    }
 
    ns.print('==========================================================');
    ns.print(` Already rooted : ${alreadyRooted}`);
    ns.print(` Newly rooted   : ${newlyRooted}`);
    ns.print(` Failed         : ${failed}`);
    ns.print('==========================================================');
 
    return newlyRooted;                                                          // Return newly rooted count
}
 
/**
 * Kills any running instance of orchestrate.js and relaunches it.
 * Waits KILL_SETTLE_MS after kill before exec to ensure the old process
 * has fully terminated and freed its RAM before the new one starts.
 * This prevents double-dispatch on the first orchestrate cycle.
 * @param {NS} ns - Netscript object
 */
async function relaunchOrchestrate(ns) {
    ns.scriptKill(ORCHESTRATE_SCRIPT, 'home');                                   // Kill existing instance
    await ns.sleep(KILL_SETTLE_MS);                                              // Wait for kill to settle before relaunching
    ns.exec(ORCHESTRATE_SCRIPT, 'home', 1);                                      // Relaunch with no flags needed
    ns.tprint(`[AUTO-ROOT] orchestrate.js relaunched`);                          // Confirm relaunch
}
 
/**
 * Returns list of cracker programs currently owned on home.
 * @param {NS} ns - Netscript object
 * @returns {string[]} Array of owned cracker filenames
 */
function getOwnedCrackers(ns) {
    return CRACKERS.filter(exe => ns.fileExists(exe, 'home'));                   // Filter to owned only
}
 
/**
 * Counts how many port-cracker programs the player currently owns on home.
 * @param {NS} ns - Netscript object
 * @returns {number} Count of owned cracker programs
 */
function countOwnedCrackers(ns) {
    return getOwnedCrackers(ns).length;                                          // Return count of owned
}
 