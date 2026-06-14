/**
 * lib-utils.js
 * Version: 1.4.0
 *
 * Shared utility library for PhlanxOS BitBurner automation suite.
 *
 * Behaviour:
 *   Provides shared helper functions used by all managed scripts.
 *   Deliberately kept cheap: every NS function here costs < 0.25GB so
 *   importing scripts do not pay for expensive analysis calls.
 *
 *   SF4 / singularity utilities live in lib-sf-utils.js to isolate their
 *   RAM cost. Without SF4, singularity functions carry a 16x RAM multiplier.
 *
 *   Functions are grouped by concern:
 *     Logging / formatting  — log, formatTime
 *     Network scanning      — getAllServers
 *     Server selection      — getWorkerServers
 *     RAM / tier            — getRamTier
 *     Port helpers          — writePort, readPort, clearPort
 *
 *   Intentionally absent (expensive — inlined only where needed):
 *     getRankedTargets  — uses hackAnalyzeChance + hackAnalyze (~2GB combined).
 *                         Inlined in orchestrate.js only.
 *     isPrepped         — uses getServerSecurityLevel, getServerMoneyAvailable.
 *                         Inlined in orchestrate.js only.
 *     canAfford         — uses ns.getPlayer(). Inlined in spending scripts.
 *     getScriptRam      — uses ns.getScriptRam(). Inlined in bootstrap.js.
 *
 * Changelog:
 *   v1.4.0 - Removed getRankedTargets, isPrepped, canHack (internal).
 *            hackAnalyzeChance + hackAnalyze were costing every lib-utils
 *            importer ~2GB. Inlined in orchestrate.js only.
 *   v1.3.0 - Removed canAfford (ns.getPlayer) and getScriptRam (ns.getScriptRam).
 *            Both inlined at call sites.
 *   v1.2.0 - Removed hasSF, getRootAccess, getPath — moved to lib-sf-utils.js
 *            and auto-root.js respectively.
 *   v1.1.0 - canAfford: added optional reserve param.
 *   v1.0.0 - Initial version.
 *
 * Dependencies:
 *   None. This file has no imports.
 */

// --- RAM constants ---
const WORKER_RAM  = 2.0;                                                            // GB RAM cost per worker thread
const RAM_TIER_0  = 8;                                                              // Home RAM threshold for tier 0
const RAM_TIER_1  = 16;                                                             // Home RAM threshold for tier 1
const RAM_TIER_2  = 32;                                                             // Home RAM threshold for tier 2
const RAM_TIER_3  = 64;                                                             // Home RAM threshold for tier 3

// --- Port sentinel ---
const PORT_EMPTY  = 'NULL PORT DATA';                                               // Value returned by ns.peek when port is empty


// =============================================================================
// Logging / Formatting
// =============================================================================

/**
 * Prints a formatted message to the script's internal log.
 * All runtime output uses ns.print (internal), never ns.tprint (terminal).
 * @param {NS} ns - Netscript object
 * @param {string} msg - Message to log
 */
export function log(ns, msg) {
    ns.print('[BB] ' + msg);                                                        // Prefix all messages with [BB] tag
}

/**
 * Converts a duration in milliseconds to a human-readable string.
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted string e.g. "3m 45s"
 */
export function formatTime(ms) {
    const totalSecs = Math.ceil(ms / 1000);                                         // Convert ms to whole seconds, rounding up
    const mins      = Math.floor(totalSecs / 60);                                   // Extract whole minutes
    const secs      = totalSecs % 60;                                               // Remaining seconds after minutes
    return mins + 'm ' + secs + 's';                                                // Return readable string
}


// =============================================================================
// Network Scanning
// =============================================================================

/**
 * Recursively discovers all reachable servers from a starting host.
 * Uses ns.scan() to get direct neighbours, then recurses into each unvisited one.
 * @param {NS} ns - Netscript object
 * @param {string} [host='home'] - Starting hostname
 * @param {Set<string>} [visited=new Set()] - Accumulator; tracks visited hosts to prevent loops
 * @returns {string[]} Array of all reachable hostnames including the start host
 */
export function getAllServers(ns, host = 'home', visited = new Set()) {
    visited.add(host);                                                              // Mark this host as seen
    const neighbours = ns.scan(host);                                               // Direct connections from this host
    for (const neighbour of neighbours) {                                           // Walk each neighbour
        if (!visited.has(neighbour)) {                                              // Only recurse into unvisited hosts
            getAllServers(ns, neighbour, visited);                                   // Recurse — fills visited in-place
        }
    }
    return Array.from(visited);                                                     // Return flat array of all found hosts
}

// =============================================================================
// Server Selection
// =============================================================================

/**
 * Returns all servers suitable for running worker threads.
 * Criteria: rooted, not home, maxRam >= WORKER_RAM (2.0GB).
 * Sorted by maxRam descending so the scheduler fills large servers first,
 * minimising process count and ns.exec() calls.
 * @param {NS} ns - Netscript object
 * @returns {string[]} Worker server hostnames, largest RAM first
 */
export function getWorkerServers(ns) {
    return getAllServers(ns)
        .filter(h => h !== 'home')                                                  // Home is control plane only — never a worker
        .filter(h => ns.hasRootAccess(h))                                           // Must have root to exec scripts
        .filter(h => ns.getServerMaxRam(h) >= WORKER_RAM)                           // Must fit at least one worker thread
        .sort((a, b) => ns.getServerMaxRam(b) - ns.getServerMaxRam(a));            // Largest RAM first
}


// =============================================================================
// RAM / Tier
// =============================================================================

/**
 * Returns the current RAM tier based on home's maximum RAM.
 * Tier drives which scripts bootstrap launches and how orchestrate behaves.
 *   Tier 0 —  8GB: orchestrate early mode + auto-root only
 *   Tier 1 — 16GB: + buy-servers
 *   Tier 2 — 32GB: + upgrade-servers, hacknet-manager
 *   Tier 3 — 64GB+: + status dashboard
 * @param {NS} ns - Netscript object
 * @returns {number} Tier number 0–3
 */
export function getRamTier(ns) {
    const ram = ns.getServerMaxRam('home');                                         // Home's current max RAM in GB
    if (ram >= RAM_TIER_3) return 3;                                                // 64GB+: full suite
    if (ram >= RAM_TIER_2) return 2;                                                // 32GB: mid-game
    if (ram >= RAM_TIER_1) return 1;                                                // 16GB: early expansion
    return 0;                                                                       // 8GB: post-reset minimal
}

// =============================================================================
// Port Helpers
// =============================================================================

/**
 * Encodes data as JSON and writes it to a port.
 * All port data in PhlanxOS is JSON — this enforces that contract.
 * @param {NS} ns - Netscript object
 * @param {number} port - Port number to write to
 * @param {*} data - Data to encode and write (any JSON-serialisable value)
 */
export function writePort(ns, port, data) {
    ns.writePort(port, JSON.stringify(data));                                       // Always encode to JSON before writing
}

/**
 * Non-consumingly reads and decodes JSON data from a port.
 * Uses ns.peek() so the data remains in the port for other readers.
 * Returns null if the port is empty or the data cannot be parsed.
 * @param {NS} ns - Netscript object
 * @param {number} port - Port number to read from
 * @returns {*} Decoded value, or null if port is empty or data is invalid
 */
export function readPort(ns, port) {
    const raw = ns.peek(port);                                                      // Peek without consuming — other readers still see it
    if (raw === PORT_EMPTY) return null;                                             // Port is empty — nothing to decode
    try {
        return JSON.parse(raw);                                                     // Decode JSON payload
    } catch {
        log(ns, 'readPort: invalid JSON on port ' + port + ': ' + raw);
        return null;                                                                // Bad data — return null rather than crashing
    }
}

/**
 * Drains a port completely, discarding all data.
 * Must be called by the port's owner script on startup to clear stale data
 * from a previous run. Non-owner scripts must never call this.
 * @param {NS} ns - Netscript object
 * @param {number} port - Port number to clear
 */
export function clearPort(ns, port) {
    while (ns.peek(port) !== PORT_EMPTY) {                                          // Keep reading until the port reports empty
        ns.readPort(port);                                                          // Consume and discard one item
    }
}


