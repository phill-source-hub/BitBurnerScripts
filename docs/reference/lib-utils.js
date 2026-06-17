/**
 * lib-utils.js
 * Version: 1.6.1
 *
 * Shared utility library for BitBurner scripts.
 * Provides reusable helper functions for:
 *   - Network scanning          (getAllServers)
 *   - Gaining root access       (getRootAccess)
 *   - Hack level checking       (canHack)
 *   - Formatted logging         (log)
 *   - Path finding              (getPath)
 *   - Worker farm discovery     (getWorkerServers)
 *   - Ranked target selection   (getRankedTargets)
 *   - Prep state check          (isPrepped)
 *   - Time formatting           (formatTime)
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *   v1.1.0 - Added NUKE.exe check in getRootAccess
 *   v1.2.0 - Added getBestTarget
 *   v1.3.0 - Added getReadyTarget
 *   v1.4.0 - Added getPath
 *   v1.5.0 - Retired getBestTarget and getReadyTarget (superseded by getRankedTargets)
 *            Added getWorkerServers, getRankedTargets, isPrepped, formatTime
 *   v1.6.1 - Fix: ns.hackChance -> ns.hackAnalyzeChance (correct API)
 *   v1.6.0 - getRankedTargets score now includes hackChance and hackPercent
 *            Score = (maxMoney / weakenTime) * hackChance * hackPercent
 *            Accurately weights targets by realistic $/ms yield, not just
 *            theoretical max money. Servers with low hack chance or low
 *            steal-per-thread are correctly deprioritised.
 *
 * Import into other scripts with:
 *   import {
 *     getAllServers, getRootAccess, canHack, log, getPath,
 *     getWorkerServers, getRankedTargets, isPrepped, formatTime
 *   } from '/scripts/lib/lib-utils.js';
 */
 
/**
 * Recursively scans all reachable servers from a starting host.
 * Uses ns.scan() which returns direct neighbours; we recurse to find all.
 * @param {NS} ns - Netscript object
 * @param {string} host - Starting hostname (default: 'home')
 * @param {Set} visited - Tracks already-seen servers to avoid loops
 * @returns {string[]} Array of all discovered hostnames
 */
export function getAllServers(ns, host = 'home', visited = new Set()) {
    visited.add(host);                                                             // Mark current host as visited
    const neighbours = ns.scan(host);                                              // Get directly connected servers
    for (const neighbour of neighbours) {                                          // Iterate each neighbour
        if (!visited.has(neighbour)) {                                             // Only recurse if not yet visited
            getAllServers(ns, neighbour, visited);                                  // Recurse into neighbour
        }
    }
    return Array.from(visited);                                                    // Return all found servers as array
}
 
/**
 * Attempts to gain root access on a target server.
 * Tries all known port-cracker .exe programs if they exist on home.
 * Skips any cracker that is not yet available.
 * Checks NUKE.exe exists before attempting to nuke.
 * Calls ns.nuke() if enough ports have been opened.
 * @param {NS} ns - Netscript object
 * @param {string} host - Target server hostname
 * @returns {boolean} True if root access was gained or already exists
 */
export function getRootAccess(ns, host) {
    if (ns.hasRootAccess(host)) return true;                                       // Already rooted, nothing to do
 
    // All known port-cracker programs mapped to their NS function
    const crackers = [
        { exe: 'BruteSSH.exe',  fn: () => ns.brutessh(host)  },
        { exe: 'FTPCrack.exe',  fn: () => ns.ftpcrack(host)  },
        { exe: 'relaySMTP.exe', fn: () => ns.relaysmtp(host) },
        { exe: 'HTTPWorm.exe',  fn: () => ns.httpworm(host)   },
        { exe: 'SQLInject.exe', fn: () => ns.sqlinject(host)  },
    ];
 
    let portsOpened = 0;                                                           // Track how many ports we open
    for (const cracker of crackers) {                                              // Try each cracker
        if (ns.fileExists(cracker.exe, 'home')) {                                  // Only run if we own the .exe
            cracker.fn();                                                           // Execute the port cracker
            portsOpened++;                                                         // Increment open port count
        }
    }
 
    const portsRequired = ns.getServerNumPortsRequired(host);                     // How many ports this server needs
    if (portsOpened >= portsRequired) {                                            // Check if we opened enough
        if (!ns.fileExists('NUKE.exe', 'home')) {                                  // Verify NUKE.exe exists on home
            log(ns, `Cannot nuke ${host}: NUKE.exe not found`);                    // Warn if NUKE.exe is missing
            return false;                                                           // Cannot proceed without NUKE.exe
        }
        ns.nuke(host);                                                             // NUKE.exe confirmed, gain root
        return ns.hasRootAccess(host);                                             // Confirm and return result
    }
 
    return false;                                                                  // Not enough ports opened
}
 
/**
 * Checks whether the player's hacking level meets the server's requirement.
 * @param {NS} ns - Netscript object
 * @param {string} host - Target server hostname
 * @returns {boolean} True if player can hack this server
 */
export function canHack(ns, host) {
    const required    = ns.getServerRequiredHackingLevel(host);                    // Server's required hack level
    const playerLevel = ns.getHackingLevel();                                      // Player's current hack level
    return playerLevel >= required;                                                // True if player meets requirement
}
 
/**
 * Prints a formatted log message to the script's log output.
 * Prefixes all messages with [BB] for easy identification.
 * @param {NS} ns - Netscript object
 * @param {string} msg - Message to print
 */
export function log(ns, msg) {
    ns.print(`[BB] ${msg}`);                                                       // Print with [BB] prefix tag
}
 
/**
 * Finds the hop-by-hop path from home to a target server using BFS.
 * Required for ns.singularity.connect() which can only hop to adjacent servers.
 * @param {NS} ns - Netscript object
 * @param {string} target - Target server hostname
 * @returns {string[]} Array of hostnames representing the path, including target
 */
export function getPath(ns, target) {
    const queue   = [['home']];                                                    // BFS queue starting from home
    const visited = new Set(['home']);                                              // Track visited servers
 
    while (queue.length > 0) {                                                     // Process until queue empty
        const path = queue.shift();                                                // Get next path to explore
        const node = path[path.length - 1];                                        // Current server at end of path
 
        if (node === target) return path;                                           // Found target — return path
 
        for (const neighbour of ns.scan(node)) {                                   // Scan neighbours
            if (!visited.has(neighbour)) {                                         // Only visit unvisited servers
                visited.add(neighbour);                                            // Mark as visited
                queue.push([...path, neighbour]);                                  // Add extended path to queue
            }
        }
    }
 
    return [];                                                                     // Target not found — return empty
}
 
/**
 * Returns all servers suitable for use as batch workers.
 * Criteria: rooted, not home, maxRam >= WORKER_RAM.
 * Sorted by maxRam descending — largest servers first — to minimise
 * process count by filling big servers before small ones.
 * @param {NS} ns - Netscript object
 * @returns {string[]} Array of worker server hostnames, largest first
 */
export function getWorkerServers(ns) {
    return getAllServers(ns)
        .filter(h => h !== 'home')                                                 // Exclude home server
        .filter(h => ns.hasRootAccess(h))                                          // Must have root access
        .filter(h => ns.getServerMaxRam(h) >= 1.75)                               // Must fit at least one worker thread
        .sort((a, b) =>
            ns.getServerMaxRam(b) - ns.getServerMaxRam(a)                          // Sort largest RAM first
        );
}
 
/**
 * Returns all valid hack targets ranked by realistic efficiency score.
 *
 * Score = (maxMoney / weakenTime) * hackChance * hackPercent
 *
 * This weights targets by actual expected $/ms yield rather than theoretical
 * max money alone. A server with high maxMoney but low hack chance or low
 * steal-per-thread is correctly ranked below a more reliably hackable target.
 *
 *   maxMoney    — theoretical ceiling; more is better
 *   weakenTime  — proxy for all operation durations; shorter is better
 *   hackChance  — probability the hack succeeds at current skill level (0–1)
 *   hackPercent — fraction of money stolen per thread per successful hack (0–1)
 *
 * Criteria: rooted, player can hack it, maxMoney > 0, not home, not cloud-server.
 *
 * @param {NS} ns - Netscript object
 * @returns {Array<{host: string, maxMoney: number, weakenTime: number, score: number}>}
 *   Array of target objects sorted by score descending
 */
export function getRankedTargets(ns) {
    return getAllServers(ns)
        .filter(h => h !== 'home')                                                 // Exclude home
        .filter(h => !h.startsWith('cloud-server'))                                // Exclude purchased servers
        .filter(h => ns.hasRootAccess(h))                                          // Must have root access
        .filter(h => canHack(ns, h))                                               // Player must meet hack level
        .filter(h => ns.getServerMaxMoney(h) > 0)                                  // Must have money
        .map(h => {
            const maxMoney    = ns.getServerMaxMoney(h);                           // Max money on target
            const weakenTime  = ns.getWeakenTime(h);                              // Weaken time in ms (slowest op)
            const hackChance  = ns.hackAnalyzeChance(h);                                  // Probability hack succeeds (0-1) — ns.hackAnalyzeChance is the correct API
            const hackPercent = ns.hackAnalyze(h);                                 // Fraction stolen per thread per hack
            const score       = (maxMoney / weakenTime) * hackChance * hackPercent; // Realistic $/ms yield score
            return { host: h, maxMoney, weakenTime, score };                       // Build ranked target object
        })
        .sort((a, b) => b.score - a.score);                                        // Sort best score first
}
 
/**
 * Checks whether a target server is fully prepped for batch hacking.
 * Requires security at minimum and money at maximum (within tight tolerance).
 * Tight thresholds are required for HWGW batch timing to be accurate.
 * @param {NS} ns - Netscript object
 * @param {string} host - Target server hostname
 * @returns {boolean} True if server is ready for batch hacking
 */
export function isPrepped(ns, host) {
    const security    = ns.getServerSecurityLevel(host);                           // Current security level
    const minSecurity = ns.getServerMinSecurityLevel(host);                        // Minimum security level
    const money       = ns.getServerMoneyAvailable(host);                          // Current money
    const maxMoney    = ns.getServerMaxMoney(host);                                // Maximum money
 
    return security <= minSecurity + 1                                             // Security at or near minimum
        && money    >= maxMoney    * 0.99;                                         // Money at or near maximum
}
 
/**
 * Converts a duration in milliseconds to a human-readable mm:ss string.
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted string e.g. "3m 45s"
 */
export function formatTime(ms) {
    const totalSecs = Math.ceil(ms / 1000);                                        // Convert ms to whole seconds
    const mins      = Math.floor(totalSecs / 60);                                  // Extract minutes
    const secs      = totalSecs % 60;                                              // Extract remaining seconds
    return `${mins}m ${secs}s`;                                                    // Return formatted string
}