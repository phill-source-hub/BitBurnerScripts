/**
 * lib-utils.js
 * Version: 1.1.0
 *
 * Shared utility library for PhlanxOS BitBurner automation suite.
 *
 * Behaviour:
 *   Provides all shared helper functions used by orchestrate, auto-root,
 *   buy-servers, upgrade-servers, hacknet-manager, status, and bootstrap.
 *   This is the only shared library in the suite. No logic that is used
 *   by more than one script may live outside this file.
 *
 *   Functions are grouped by concern:
 *     Logging / formatting  — log, formatTime
 *     Network scanning      — getAllServers, getPath
 *     Root access           — getRootAccess, canHack
 *     Server selection      — getWorkerServers, getRankedTargets, isPrepped
 *     RAM / tier            — getRamTier, getScriptRam
 *     Source-File detection — hasSF
 *     Port helpers          — writePort, readPort, clearPort
 *     Money protection      — canAfford
 *
 * Changelog:
 *   v1.1.0 - canAfford: added optional reserve param. Callers passing reserve
 *            get floor + reserve enforced. Zero-arg callers unchanged.
 *   v1.0.0 - Clean rewrite. All 16 functions. Adds getRamTier, hasSF,
 *            writePort, readPort, clearPort, canAfford, getScriptRam.
 *
 * Dependencies:
 *   None. This file has no imports.
 */

// --- RAM constants ---
const WORKER_RAM  = 1.75;                                                           // GB RAM cost per worker thread
const RAM_TIER_0  = 8;                                                              // Home RAM threshold for tier 0
const RAM_TIER_1  = 16;                                                             // Home RAM threshold for tier 1
const RAM_TIER_2  = 32;                                                             // Home RAM threshold for tier 2
const RAM_TIER_3  = 64;                                                             // Home RAM threshold for tier 3

// --- Money floor constant ---
const MONEY_FLOOR = 0.10;                                                           // Minimum fraction of balance to retain after any spend

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

/**
 * Finds the hop-by-hop path from home to a target server using BFS.
 * Required for ns.singularity.connect() which moves one hop at a time.
 * Returns an empty array if the target is not reachable.
 * @param {NS} ns - Netscript object
 * @param {string} target - Destination hostname
 * @returns {string[]} Ordered array of hostnames from home to target (inclusive)
 */
export function getPath(ns, target) {
    const queue   = [['home']];                                                     // BFS queue; each entry is a full path so far
    const visited = new Set(['home']);                                               // Track visited hosts to avoid cycles

    while (queue.length > 0) {                                                      // Process until queue is empty
        const path = queue.shift();                                                  // Take the next path to explore
        const node = path[path.length - 1];                                         // Current host is the last hop in path

        if (node === target) return path;                                            // Found the target — return the complete path

        for (const neighbour of ns.scan(node)) {                                    // Explore direct connections
            if (!visited.has(neighbour)) {                                          // Skip already-visited hosts
                visited.add(neighbour);                                             // Mark as visited before enqueuing
                queue.push(path.concat([neighbour]));                               // Enqueue extended path
            }
        }
    }

    return [];                                                                      // Target unreachable from home
}


// =============================================================================
// Root Access
// =============================================================================

/**
 * Checks whether the player's hacking level meets a server's requirement.
 * @param {NS} ns - Netscript object
 * @param {string} host - Target hostname
 * @returns {boolean} True if the player can hack this server
 */
export function canHack(ns, host) {
    const required    = ns.getServerRequiredHackingLevel(host);                     // Server's minimum hack level
    const playerLevel = ns.getHackingLevel();                                       // Player's current hack level
    return playerLevel >= required;                                                  // True if player meets or exceeds requirement
}

/**
 * Attempts to gain root access on a target server.
 * Tries every port-cracker program that exists on home, then nukes if enough
 * ports have been opened. Skips crackers not yet owned without error.
 * Checks NUKE.exe is present before attempting to nuke.
 * @param {NS} ns - Netscript object
 * @param {string} host - Target hostname
 * @returns {boolean} True if root access was gained or already existed
 */
export function getRootAccess(ns, host) {
    if (ns.hasRootAccess(host)) return true;                                        // Already rooted — nothing to do

    // Map each port-cracker program to its NS function
    const crackers = [
        { exe: 'BruteSSH.exe',  fn: () => ns.brutessh(host)  },
        { exe: 'FTPCrack.exe',  fn: () => ns.ftpcrack(host)  },
        { exe: 'relaySMTP.exe', fn: () => ns.relaysmtp(host) },
        { exe: 'HTTPWorm.exe',  fn: () => ns.httpworm(host)   },
        { exe: 'SQLInject.exe', fn: () => ns.sqlinject(host)  },
    ];

    let portsOpened = 0;                                                            // Count ports opened this attempt
    for (const cracker of crackers) {                                               // Try each cracker in turn
        if (ns.fileExists(cracker.exe, 'home')) {                                   // Only run if we own the program
            cracker.fn();                                                            // Open the port
            portsOpened++;                                                          // Track how many we opened
        }
    }

    const portsRequired = ns.getServerNumPortsRequired(host);                       // Ports this server needs opened before NUKE
    if (portsOpened < portsRequired) return false;                                  // Not enough ports — cannot nuke yet

    if (!ns.fileExists('NUKE.exe', 'home')) {                                       // Verify NUKE.exe is present before calling
        log(ns, 'Cannot nuke ' + host + ': NUKE.exe not found on home');
        return false;                                                               // Cannot proceed without NUKE.exe
    }

    ns.nuke(host);                                                                  // Execute NUKE — gains root access
    return ns.hasRootAccess(host);                                                  // Confirm root was actually granted
}


// =============================================================================
// Server Selection
// =============================================================================

/**
 * Returns all servers suitable for running worker threads.
 * Criteria: rooted, not home, maxRam >= WORKER_RAM (1.75GB).
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

/**
 * Returns all valid hack targets ranked by realistic expected yield.
 *
 * Score = (maxMoney / weakenTime) * hackChance * hackPercent
 *
 *   maxMoney    — theoretical ceiling; more money is better
 *   weakenTime  — proxy for all operation durations; shorter is better
 *   hackChance  — probability the hack succeeds (ns.hackAnalyzeChance, 0–1)
 *   hackPercent — fraction of money stolen per thread per hack (ns.hackAnalyze, 0–1)
 *
 * Excludes: home, purchased cloud servers, unrooted servers, servers the
 * player cannot yet hack, and servers with no money.
 *
 * @param {NS} ns - Netscript object
 * @returns {Array<{host: string, maxMoney: number, weakenTime: number, score: number}>}
 *   Target objects sorted by score descending
 */
export function getRankedTargets(ns) {
    return getAllServers(ns)
        .filter(h => h !== 'home')                                                  // Home is never a hack target
        .filter(h => !h.startsWith('cloud-server'))                                 // Purchased servers have no money
        .filter(h => ns.hasRootAccess(h))                                           // Must have root to run workers
        .filter(h => canHack(ns, h))                                                // Player must meet hack level requirement
        .filter(h => ns.getServerMaxMoney(h) > 0)                                   // Must have money — some servers have none
        .map(h => {
            const maxMoney    = ns.getServerMaxMoney(h);                            // Theoretical max money on server
            const weakenTime  = ns.getWeakenTime(h);                               // Weaken time — slowest op, used as cycle duration
            const hackChance  = ns.hackAnalyzeChance(h);                            // Probability hack succeeds at current skill
            const hackPercent = ns.hackAnalyze(h);                                  // Fraction of money stolen per thread
            const score       = (maxMoney / weakenTime) * hackChance * hackPercent; // Realistic $/ms yield
            return { host: h, maxMoney, weakenTime, score };
        })
        .sort((a, b) => b.score - a.score);                                         // Best score first
}

/**
 * Checks whether a target server is fully prepped for HWGW batch hacking.
 * Tight thresholds are required — batch timing calculations assume min security
 * and max money. Drift from these causes desync and reduces yield.
 * @param {NS} ns - Netscript object
 * @param {string} host - Target hostname
 * @returns {boolean} True if server is ready for batch hacking
 */
export function isPrepped(ns, host) {
    const security    = ns.getServerSecurityLevel(host);                            // Current security level
    const minSecurity = ns.getServerMinSecurityLevel(host);                         // Server's minimum possible security
    const money       = ns.getServerMoneyAvailable(host);                           // Current money on server
    const maxMoney    = ns.getServerMaxMoney(host);                                 // Server's maximum possible money

    return security <= minSecurity + 1                                              // Security at or near minimum (1.0 tolerance)
        && money    >= maxMoney    * 0.99;                                          // Money at or near maximum (1% tolerance)
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

/**
 * Returns the RAM cost of a script in GB.
 * Safe to call on scripts that may not exist — returns 0 rather than throwing.
 * Use before ns.exec() to verify a script will fit before trying to launch it.
 * @param {NS} ns - Netscript object
 * @param {string} script - Script path (e.g. '/scripts/worker.js')
 * @returns {number} RAM cost in GB, or 0 if the script does not exist
 */
export function getScriptRam(ns, script) {
    return ns.getScriptRam(script, 'home');                                         // Returns 0 if file not found — safe default
}


// =============================================================================
// Source-File Detection
// =============================================================================

/**
 * Detects whether the player has a specific Source-File.
 * Singularity functions require SF4 and throw if called without it.
 * This function wraps the detection in try/catch so callers can safely
 * gate SF-dependent behaviour without crashing.
 * @param {NS} ns - Netscript object
 * @param {number} n - Source-File number to check for (e.g. 4 for SF4)
 * @returns {boolean} True if the player owns Source-File n
 */
export function hasSF(ns, n) {
    try {
        const sourceFiles = ns.singularity.getOwnedSourceFiles();                   // Throws if SF4 not owned
        return sourceFiles.some(sf => sf.n === n);                                  // Check if target SF is in the list
    } catch {
        return false;                                                               // SF4 not available — treat as not owned
    }
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


// =============================================================================
// Money Protection
// =============================================================================

/**
 * Returns true only if spending `cost` would leave the player with at least
 * 10% of their current balance. Enforces the PhlanxOS money floor rule.
 * Any script that spends player money must call this before every spend.
 * Never inline the floor calculation — always use this shared function.
 * @param {NS} ns - Netscript object
 * @param {number} cost - Amount about to be spent
 * @param {number} [reserve=0] - Additional minimum balance to retain beyond the 10% floor
 * @returns {boolean} True if the spend is safe, false if it breaches floor + reserve
 */
export function canAfford(ns, cost, reserve = 0) {
    const money = ns.getPlayer().money;                                             // Current player balance
    const floor = money * MONEY_FLOOR;                                              // 10% of current balance — hard minimum
    return (money - cost) >= (floor + reserve);                                     // Must clear both floor and caller's reserve
}
