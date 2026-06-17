/**
 * status.js
 * Version: 3.2.0
 *
 * Live operations dashboard for the BitBurner hacking network.
 * Renders a full-colour ANSI display in the tail window, refreshing every 5s.
 * Auto-sizes and positions the window on launch.
 *
 * Layout (compressed — all information retained):
 *   - Header: title, version, timestamp
 *   - STATUS: hack level, money, income, home RAM, rooted servers
 *   - FARM RAM: cloud worker pool used/free with utilisation bar
 *   - THREADS: weaken/grow/hack counts and mini-bars on one line
 *   - TARGETS: 2 lines per target (hostname+mode+countdown / money+sec+threads)
 *   - HACKNET: single line — nodes, production, avg stats
 *   - SCRIPTS: inline badges — RUNNING green / STOPPED red or dim
 *   - Footer: usage hint and version
 *
 * Countdown timers:
 *   Reads port 1 (written by orchestrate.js) using ns.peek() — non-consuming.
 *   Payload: { cycleStart, targets: { [host]: { weakenTime, mode } } }
 *   Remaining = weakenTime - (now - cycleStart), clamped to zero.
 *   Falls back to '--:--' if port empty, unparseable, or stale (>2min).
 *
 * Worker filename note:
 *   WORKER_* constants have no leading slash. ns.ps() returns filenames
 *   without leading slash, so both sides are stripped once at gather time.
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *   v2.0.0 - Full rewrite: ANSI colour, ASCII bars, hacknet/cloud/script-health
 *            sections, window auto-size/position, per-target countdown timers
 *   v2.0.1 - Fixed script health detection: use ns.ps() filename match
 *   v2.0.2 - Strip leading slash from both sides of filename comparison
 *   v3.2.0 - Port IPC phase 2: reads hacknet state from port 3 (hacknet-manager)
 *            and upgrade state from port 5 (upgrade-servers). Hacknet section
 *            uses port 3 data when available, falls back to NS calls. FARM RAM
 *            section shows upgrade progress bar when upgrade-servers is active.
 *            Added HACKNET_PORT and UPGRADE_PORT constants and reader functions.
 *   v3.1.0 - Port IPC phase 1: reads root state from port 2 (auto-root.js).
 *            Rooted/total server counts sourced from port 2 when available,
 *            falls back to direct NS scan if port is empty.
 *            Added ROOT_PORT constant and readRootState() function.
 *   v3.0.0 - Compressed layout: ~28 lines vs ~55 for 5 targets, same info
 *            Merged Player + Network RAM into STATUS section
 *            Threads compressed to single line with mini-bars
 *            Targets compressed to 2 lines each (was 5)
 *            Hacknet compressed to 1 line (was 3)
 *            Script health changed to inline badges (was 1 line per script)
 *            Farm RAM now shows cloud-only pool (home excluded — not in pool)
 *            Home RAM added to STATUS section
 *            Rooted server count added to STATUS section
 *            Added early-orchestrate.js to watched scripts
 *            STALE_THRESHOLD reduced from 10 min to 2 min
 *            Tail window now positions top-right using globalThis["window"].innerWidth
 *
 * Usage: run /scripts/status.js
 * View:  tail /scripts/status.js
 *
 * Dependencies: /scripts/lib/lib-utils.js
 */

import { getAllServers, isPrepped, formatTime } from '/scripts/lib/lib-utils.js';

// ─── Version ──────────────────────────────────────────────────────────────────
const VERSION = '3.2.0';                                                          // Dashboard version — shown in footer

// ─── Worker script filenames — no leading slash (matches ns.ps() output) ──────
const WORKER_WEAKEN = 'scripts/worker-weaken.js';                                 // Weaken worker filename
const WORKER_GROW   = 'scripts/worker-grow.js';                                   // Grow worker filename
const WORKER_HACK   = 'scripts/worker-hack.js';                                   // Hack worker filename

// ─── Port constants ───────────────────────────────────────────────────────────
const STATUS_PORT     = 1;                                                        // Port orchestrate.js writes cycle data to
const ROOT_PORT       = 2;                                                        // Port auto-root.js writes root state to
const HACKNET_PORT    = 3;                                                        // Port hacknet-manager.js writes state to
const UPGRADE_PORT    = 5;                                                        // Port upgrade-servers.js writes state to
const STALE_THRESHOLD = 2 * 60 * 1000;                                           // 2 minutes — max age before treating port data as stale

// ─── Refresh interval ─────────────────────────────────────────────────────────
const REFRESH_MS = 5000;                                                          // Dashboard refresh interval in ms

// ─── Tail window dimensions ───────────────────────────────────────────────────
const TAIL_WIDTH  = 700;                                                          // Tail window width in pixels
const TAIL_HEIGHT = 620;                                                          // Reduced height — compressed layout
const TAIL_MARGIN = 20;                                                           // Gap from screen edge in pixels

// Screen width read at runtime via browser global — not available via NS API.
// globalThis["window"].innerWidth reflects the actual BitBurner window width.
// X places the right edge of the tail TAIL_MARGIN px from the screen right.
// Y is always TAIL_MARGIN from the top.
const TAIL_X = () => (globalThis['window'].innerWidth - TAIL_WIDTH - TAIL_MARGIN); // Right-aligned X position (function — evaluated at runtime)
const TAIL_Y = TAIL_MARGIN;                                                       // Fixed top margin

// ─── ANSI colour codes ────────────────────────────────────────────────────────
const R   = '\u001b[0m';                                                          // Reset all colours
const CY  = '\u001b[36m';                                                        // Cyan   — headers / status
const GR  = '\u001b[32m';                                                        // Green  — healthy / HACK / good
const YE  = '\u001b[33m';                                                        // Yellow — warnings / PREP / hacknet
const RE  = '\u001b[31m';                                                        // Red    — critical / high security
const MA  = '\u001b[35m';                                                        // Magenta — thread activity
const BL  = '\u001b[34m';                                                        // Blue   — RAM / farm
const WH  = '\u001b[37m';                                                        // White  — values
const DIM = '\u001b[2m';                                                         // Dim    — borders / structure / labels

// ─── Hacknet constants (hardcoded — not available via API) ────────────────────
const HN_MAX_LEVEL = 200;                                                         // Maximum hacknet node level
const HN_MAX_RAM   = 64;                                                          // Maximum hacknet node RAM in GB
const HN_MAX_CORES = 16;                                                          // Maximum hacknet node cores

// ─── Scripts to monitor in the health section ─────────────────────────────────
const WATCHED_SCRIPTS = [
    { file: 'scripts/orchestrate.js',        critical: true  },                   // Orchestrate — critical
    { file: 'scripts/early-orchestrate.js',  critical: false },                   // Early orchestrate — non-critical bridge
    { file: 'scripts/auto-root.js',          critical: false },                   // Auto-root — non-critical
    { file: 'scripts/hacknet-manager.js',    critical: false },                   // Hacknet manager — non-critical
    { file: 'scripts/buy-servers.js',        critical: false },                   // Buy servers — non-critical
    { file: 'scripts/upgrade-servers.js',    critical: false },                   // Upgrade servers — non-critical
];

// ─── ASCII progress bar ───────────────────────────────────────────────────────
/**
 * Renders a fixed-width ASCII progress bar.
 * @param {number} value   - Current value (0–max)
 * @param {number} max     - Maximum value
 * @param {number} width   - Total bar character width
 * @param {string} fillCol - ANSI colour for filled portion
 * @returns {string} Formatted bar string with surrounding brackets
 */
function bar(value, max, width = 20, fillCol = GR) {
    const pct    = max > 0 ? Math.min(1, value / max) : 0;                        // Clamp ratio 0–1
    const filled = Math.round(pct * width);                                       // Filled character count
    const empty  = width - filled;                                                // Empty character count
    return `${DIM}[${fillCol}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${DIM}]${R}`; // Assembled bar
}

// ─── Mini bar (no brackets, narrower) ────────────────────────────────────────
/**
 * Renders a compact bar without brackets for inline thread display.
 * @param {number} value   - Current value
 * @param {number} max     - Maximum value
 * @param {number} width   - Bar character width
 * @param {string} fillCol - ANSI colour for filled portion
 * @returns {string} Compact bar string
 */
function miniBar(value, max, width = 8, fillCol = GR) {
    const pct    = max > 0 ? Math.min(1, value / max) : 0;                        // Clamp ratio 0–1
    const filled = Math.round(pct * width);                                       // Filled character count
    const empty  = width - filled;                                                // Empty character count
    return `${fillCol}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${R}`;       // No brackets — inline use
}

// ─── Countdown bar ────────────────────────────────────────────────────────────
/**
 * Renders a countdown bar that fills left-to-right as time elapses.
 * @param {number} elapsed - Time already elapsed in ms
 * @param {number} total   - Total cycle duration in ms
 * @param {number} width   - Bar character width
 * @param {string} fillCol - ANSI colour for elapsed portion
 * @returns {string} Formatted countdown bar with brackets
 */
function countdownBar(elapsed, total, width = 14, fillCol = CY) {
    const pct    = total > 0 ? Math.min(1, elapsed / total) : 0;                  // Elapsed ratio 0–1
    const filled = Math.round(pct * width);                                       // Elapsed character count
    const empty  = width - filled;                                                // Remaining character count
    return `${DIM}[${fillCol}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${DIM}]${R}`; // Assembled countdown bar
}

// ─── Section header ───────────────────────────────────────────────────────────
/**
 * Prints a coloured section header with top divider.
 * @param {NS}     ns    - Netscript object
 * @param {string} title - Section title text
 * @param {string} col   - ANSI colour for title
 */
function section(ns, title, col) {
    ns.print(`${DIM}${'─'.repeat(64)}${R}`);                                      // Horizontal divider above section
    ns.print(`${col}${title}${R}`);                                               // Coloured section title
}

// ─── Percentage colour selector ───────────────────────────────────────────────
/**
 * Returns green/yellow/red ANSI code based on a percentage value.
 * @param {number} pct    - Percentage 0–100
 * @param {number} warnAt - Threshold for yellow (default 60)
 * @param {number} critAt - Threshold for red (default 90)
 * @returns {string} ANSI colour code
 */
function pctCol(pct, warnAt = 60, critAt = 90) {
    if (pct >= critAt) return RE;                                                  // Red at critical threshold
    if (pct >= warnAt) return YE;                                                 // Yellow at warning threshold
    return GR;                                                                    // Green below warning
}

// ─── Security delta colour selector ──────────────────────────────────────────
/**
 * Returns green/yellow/red based on security delta above minimum.
 * @param {number} delta - security - minSecurity
 * @returns {string} ANSI colour code
 */
function secCol(delta) {
    if (delta > 5) return RE;                                                     // Red — significantly above min
    if (delta > 1) return YE;                                                     // Yellow — slightly above min
    return GR;                                                                    // Green — at or near minimum
}

// ─── Port data reader ─────────────────────────────────────────────────────────
/**
 * Reads and validates cycle timing data from port 1.
 * Uses ns.peek() — non-consuming — so orchestrate never loses its data.
 * Returns null if port is empty, unparseable, or stale.
 * @param {NS} ns
 * @returns {{ cycleStart: number, targets: Object }|null}
 */
function readCycleData(ns) {
    const raw = ns.peek(STATUS_PORT);                                             // Peek at port — does not consume
    if (raw === 'NULL PORT DATA') return null;                                    // Port is empty
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }                     // Malformed — treat as missing
    if (!parsed || typeof parsed.cycleStart !== 'number') return null;            // Missing required fields
    if (Date.now() - parsed.cycleStart > STALE_THRESHOLD) return null;           // Data is stale
    return parsed;                                                                // Valid, fresh cycle data
}

// ─── Root state reader ────────────────────────────────────────────────────────
/**
 * Reads root state from port 2 (written by auto-root.js).
 * Uses ns.peek() — non-consuming.
 * Returns null if port is empty or data is malformed.
 * No stale check — auto-root republishes on every scan cycle.
 * @param {NS} ns
 * @returns {{ rootedCount: number, totalCount: number, crackers: string[] }|null}
 */
function readRootState(ns) {
    const raw = ns.peek(ROOT_PORT);                                              // Peek port 2 — non-consuming
    if (raw === 'NULL PORT DATA') return null;                                   // Port empty — auto-root not yet run
    try { return JSON.parse(raw); } catch { return null; }                      // Parse or return null on failure
}

// ─── Hacknet state reader ─────────────────────────────────────────────────────
/**
 * Reads hacknet state from port 3 (written by hacknet-manager.js).
 * Uses ns.peek() — non-consuming.
 * Returns null if port is empty or data is malformed.
 * @param {NS} ns
 * @returns {{ nodes, maxNodes, production, avgLevel, avgRam, avgCores, done }|null}
 */
function readHacknetState(ns) {
    const raw = ns.peek(HACKNET_PORT);                                           // Peek port 3 — non-consuming
    if (raw === 'NULL PORT DATA') return null;                                   // Port empty — hacknet-manager not running
    try { return JSON.parse(raw); } catch { return null; }                      // Parse or return null on failure
}

// ─── Upgrade state reader ─────────────────────────────────────────────────────
/**
 * Reads upgrade state from port 5 (written by upgrade-servers.js).
 * Uses ns.peek() — non-consuming.
 * Returns null if port is empty or data is malformed.
 * @param {NS} ns
 * @returns {{ owned, maxed, ramLimit, done, servers }|null}
 */
function readUpgradeState(ns) {
    const raw = ns.peek(UPGRADE_PORT);                                           // Peek port 5 — non-consuming
    if (raw === 'NULL PORT DATA') return null;                                   // Port empty — upgrade-servers not running
    try { return JSON.parse(raw); } catch { return null; }                      // Parse or return null on failure
}

// ─── Countdown remaining time formatter ───────────────────────────────────────
/**
 * Calculates remaining cycle time for a target and returns a display string.
 * Returns '--:--' when cycle data is unavailable or target not in payload.
 * @param {Object|null} cycleData - Parsed port 1 payload, or null
 * @param {string}      host      - Target hostname
 * @returns {string} Formatted remaining time, 'done', or '--:--'
 */
function remainingTime(cycleData, host) {
    if (!cycleData) return '--:--';                                               // No cycle data available
    const entry = cycleData.targets?.[host];                                      // Look up this target's timing
    if (!entry)  return '--:--';                                                  // Target not in payload
    const elapsed   = Date.now() - cycleData.cycleStart;                         // Time since cycle started
    const remaining = Math.max(0, entry.weakenTime - elapsed);                   // Clamp to zero — never negative
    return remaining === 0 ? 'done' : formatTime(remaining);                     // 'done' when cycle complete
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function main(ns) {
    ns.disableLog('ALL');                                                         // Suppress all default NS logs

    // --- Position and size the tail window on launch -------------------------
    ns.ui.openTail();                                                             // Open tail window
    await ns.sleep(100);                                                          // Brief pause — moveTail requires window to exist
    ns.ui.resizeTail(TAIL_WIDTH, TAIL_HEIGHT);                                    // Set window size
    ns.ui.moveTail(TAIL_X(), TAIL_Y);                                             // Position: top-right of screen
    ns.ui.setTailTitle('BitBurner Operations Dashboard');                         // Set descriptive window title

    while (true) {                                                                // Refresh loop — runs indefinitely
        ns.clearLog();                                                            // Clear previous frame

        // ── Gather: cycle timing from port 1 ──────────────────────────────────
        const cycleData = readCycleData(ns);                                     // Read orchestrate timing payload (non-consuming)

        // ── Gather: root state from port 2 ────────────────────────────────────
        const rootState    = readRootState(ns);                                  // Read auto-root state (non-consuming)

        // ── Gather: hacknet state from port 3 ─────────────────────────────────
        const hacknetState = readHacknetState(ns);                               // Read hacknet-manager state (non-consuming)

        // ── Gather: upgrade state from port 5 ─────────────────────────────────
        const upgradeState = readUpgradeState(ns);                               // Read upgrade-servers state (non-consuming)

        // ── Gather: player stats ──────────────────────────────────────────────
        const player      = ns.getPlayer();                                      // Full player object
        const hackLevel   = ns.getHackingLevel();                                // Player hacking level
        const playerMoney = player.money;                                        // Current money
        const income      = ns.getTotalScriptIncome();                           // [$/sec current, $/sec since augment]

        // ── Gather: home RAM ──────────────────────────────────────────────────
        const homeRamMax  = ns.getServerMaxRam('home');                          // Home total RAM
        const homeRamUsed = ns.getServerUsedRam('home');                         // Home used RAM
        const homeRamFree = homeRamMax - homeRamUsed;                            // Home free RAM

        // ── Gather: all servers — thread counts ───────────────────────────────
        // Root counts come from port 2 (auto-root.js) when available.
        // Fall back to direct NS scan if port 2 is empty.
        const allServers       = getAllServers(ns);                               // All reachable servers (needed for thread gather)
        const rootedFromPort   = rootState?.rootedCount ?? null;                 // Port 2 rooted count (may be null)
        const totalFromPort    = rootState?.totalCount  ?? null;                 // Port 2 total count (may be null)
        let   totalRootedCount = rootedFromPort ?? 0;                            // Use port 2 if available
        let   totalServerCount = totalFromPort  ?? allServers.length;            // Use port 2 if available

        if (rootedFromPort === null) {                                           // Port 2 empty — fall back to NS scan
            for (const host of allServers) {
                if (ns.hasRootAccess(host)) totalRootedCount++;                  // Count rooted servers directly
            }
        }
        let totalWeakenThreads = 0;                                              // Total weaken threads active
        let totalGrowThreads   = 0;                                              // Total grow threads active
        let totalHackThreads   = 0;                                              // Total hack threads active
        const targetThreads    = {};                                             // Per-target thread counts

        for (const host of allServers) {                                         // Iterate every known server — thread counts only
            for (const proc of ns.ps(host)) {                                   // Iterate running processes
                const fname  = proc.filename.replace(/^\//, '');                 // Strip leading slash — ns.ps() omits it
                const target = proc.args[0];                                     // First arg is always the target hostname
                if (!target || typeof target !== 'string' || target.startsWith('--')) continue; // Skip non-target args

                if (!targetThreads[target]) {                                    // Initialise entry for new target
                    targetThreads[target] = { weaken: 0, grow: 0, hack: 0 };    // Zero all thread counts
                }

                if (fname === WORKER_WEAKEN) {                                   // Weaken worker process
                    totalWeakenThreads           += proc.threads;                // Add to global weaken total
                    targetThreads[target].weaken += proc.threads;                // Add to per-target weaken count
                } else if (fname === WORKER_GROW) {                              // Grow worker process
                    totalGrowThreads           += proc.threads;                  // Add to global grow total
                    targetThreads[target].grow += proc.threads;                  // Add to per-target grow count
                } else if (fname === WORKER_HACK) {                              // Hack worker process
                    totalHackThreads           += proc.threads;                  // Add to global hack total
                    targetThreads[target].hack += proc.threads;                  // Add to per-target hack count
                }
            }
        }

        const totalThreads  = totalWeakenThreads + totalGrowThreads + totalHackThreads; // All active threads
        const activeTargets = Object.keys(targetThreads);                        // Servers currently being worked

        // ── Gather: cloud (worker farm) RAM — home excluded from pool ─────────
        const cloudNames   = ns.cloud.getServerNames();                          // All purchased cloud server names
        const cloudMax     = ns.cloud.getServerLimit();                          // Maximum purchasable servers
        let   cloudRamUsed = 0;                                                  // Cloud RAM used total
        let   cloudRamMax  = 0;                                                  // Cloud RAM max total
        for (const h of cloudNames) {                                            // Iterate each cloud server
            cloudRamMax  += ns.getServerMaxRam(h);                              // Add cloud server max RAM
            cloudRamUsed += ns.getServerUsedRam(h);                             // Add cloud server used RAM
        }
        const cloudRamPct = cloudRamMax > 0 ? (cloudRamUsed / cloudRamMax) * 100 : 0; // Cloud RAM utilisation %

        // ── Gather: hacknet stats — port 3 preferred, NS fallback ─────────────
        // hacknet-manager.js publishes to port 3 after every action.
        // If port 3 is empty (manager not running), gather directly via NS.
        let hnCount, hnProd, hnAvgLevel, hnAvgRam, hnAvgCores, hnMaxNodes;

        if (hacknetState) {                                                      // Port 3 has fresh data
            hnCount    = hacknetState.nodes;                                     // Node count from port
            hnMaxNodes = hacknetState.maxNodes;                                  // Max nodes from port
            hnProd     = hacknetState.production;                                // Production rate from port
            hnAvgLevel = hacknetState.avgLevel;                                  // Average level from port
            hnAvgRam   = hacknetState.avgRam;                                    // Average RAM from port
            hnAvgCores = hacknetState.avgCores;                                  // Average cores from port
        } else {                                                                 // Port 3 empty — gather via NS
            hnCount    = ns.hacknet.numNodes();                                  // Current node count via NS
            hnMaxNodes = hnCount > 0 ? ns.hacknet.maxNumNodes() : 0;            // Max nodes via NS
            hnProd     = 0;                                                      // Accumulated production
            let hnLevel = 0, hnRam = 0, hnCores = 0;                            // Accumulators for averages
            for (let i = 0; i < hnCount; i++) {                                  // Iterate each node
                const stats = ns.hacknet.getNodeStats(i);                        // Get node stats
                hnProd  += stats.production;                                     // Sum production
                hnLevel += stats.level;                                          // Sum levels
                hnRam   += stats.ram;                                            // Sum RAM
                hnCores += stats.cores;                                          // Sum cores
            }
            hnAvgLevel = hnCount > 0 ? Math.round(hnLevel / hnCount) : 0;      // Average level
            hnAvgRam   = hnCount > 0 ? Math.round(hnRam   / hnCount) : 0;      // Average RAM
            hnAvgCores = hnCount > 0 ? Math.round(hnCores / hnCount) : 0;      // Average cores
        }

        // ── Gather: script health ─────────────────────────────────────────────
        const homeProcs    = ns.ps('home').map(p => p.filename.replace(/^\//, '')); // Running filenames on home, slash stripped
        const scriptStatus = WATCHED_SCRIPTS.map(s => ({                         // Map each watched script to running state
            ...s,
            running: homeProcs.includes(s.file),                                 // Both sides already have no leading slash
        }));

        // ══════════════════════════════════════════════════════════════════════
        // RENDER
        // ══════════════════════════════════════════════════════════════════════

        // ── Header ────────────────────────────────────────────────────────────
        ns.print(`${CY}  BITBURNER OPS${R}  ${DIM}${new Date().toLocaleTimeString()}  refresh:${REFRESH_MS/1000}s${R}`);

        // ── STATUS: player + home ─────────────────────────────────────────────
        // Combines player stats and home server info — all identity/context data in one place
        section(ns, '  STATUS', CY);
        ns.print(
            `  ${DIM}hack${R} ${YE}${hackLevel}${R}` +
            `  ${DIM}money${R} ${GR}$${ns.format.number(playerMoney, '0.00a')}${R}` +
            `  ${DIM}income${R} ${GR}$${ns.format.number(income[0], '0.00a')}/s${R}` +
            `  ${DIM}rooted${R} ${WH}${totalRootedCount}/${totalServerCount}${R}`
        );
        ns.print(
            `  ${DIM}home${R} ${BL}${ns.format.number(homeRamFree,'0.0a')}GB free` +
            ` / ${ns.format.number(homeRamMax,'0.0a')}GB${R}` +
            `  ${bar(homeRamUsed, homeRamMax, 14, pctCol((homeRamUsed/homeRamMax)*100))}`
        );

        // ── FARM RAM: cloud worker pool only ──────────────────────────────────
        // Home is excluded from the worker pool so is shown separately above.
        // Upgrade progress from port 5 shown when upgrade-servers.js is active.
        section(ns, '  FARM RAM', BL);
        if (cloudNames.length === 0) {
            ns.print(`  ${DIM}No cloud servers purchased${R}`);                  // No farm yet
        } else {
            ns.print(
                `  ${DIM}${cloudNames.length}/${cloudMax} servers${R}` +
                `  ${BL}${ns.format.number(cloudRamUsed,'0.0a')}GB / ${ns.format.number(cloudRamMax,'0.0a')}GB${R}` +
                `  ${bar(cloudRamUsed, cloudRamMax, 20, pctCol(cloudRamPct))}` +
                `  ${pctCol(cloudRamPct)}${cloudRamPct.toFixed(1)}%${R}`
            );
            // Show upgrade progress if upgrade-servers.js is active and not done
            if (upgradeState && !upgradeState.done) {                            // Upgrade in progress
                ns.print(
                    `  ${DIM}upgrading${R}  ${WH}${upgradeState.maxed}/${upgradeState.owned}${R}` +
                    ` ${DIM}at max RAM${R}` +
                    `  ${bar(upgradeState.maxed, upgradeState.owned, 16, YE)}` +
                    `  ${YE}${upgradeState.ramLimit}GB target${R}`
                );
            } else if (upgradeState?.done) {                                     // All servers maxed
                ns.print(`  ${DIM}all servers at${R} ${GR}${upgradeState.ramLimit}GB${R} ${DIM}max RAM${R}`);
            }
        }

        // ── THREADS: all worker activity on one line ──────────────────────────
        // Mini-bars show relative share of each type without taking 4 lines
        section(ns, '  THREADS', MA);
        if (totalThreads === 0) {
            ns.print(`  ${DIM}No worker threads active${R}`);                    // Nothing running yet
        } else {
            const wPct = (totalWeakenThreads / totalThreads) * 100;             // Weaken share %
            const gPct = (totalGrowThreads   / totalThreads) * 100;             // Grow share %
            const hPct = (totalHackThreads   / totalThreads) * 100;             // Hack share %
            ns.print(
                `  ${CY}W${R} ${String(totalWeakenThreads).padStart(4)} ${miniBar(totalWeakenThreads, totalThreads, 8, CY)} ${CY}${wPct.toFixed(0)}%${R}` +
                `   ${YE}G${R} ${String(totalGrowThreads).padStart(4)} ${miniBar(totalGrowThreads, totalThreads, 8, YE)} ${YE}${gPct.toFixed(0)}%${R}` +
                `   ${RE}H${R} ${String(totalHackThreads).padStart(4)} ${miniBar(totalHackThreads, totalThreads, 8, RE)} ${RE}${hPct.toFixed(0)}%${R}` +
                `   ${DIM}total${R} ${WH}${totalThreads}${R}`
            );
        }

        // ── TARGETS: 2 lines per target ───────────────────────────────────────
        // Line 1: hostname  [mode]  countdown-bar  eta
        // Line 2: $cur/$max moneybar %  sec:cur/min +delta  W:n G:n H:n
        section(ns, '  TARGETS', GR);
        if (activeTargets.length === 0) {
            ns.print(`  ${DIM}No active targets — orchestrate.js may not be running${R}`);
        } else {
            for (const t of activeTargets) {                                     // One block per active target
                const tc          = targetThreads[t];                            // Thread counts for this target
                const curMoney    = ns.getServerMoneyAvailable(t);               // Current money on target
                const maxMoney    = ns.getServerMaxMoney(t);                     // Max money on target
                const security    = ns.getServerSecurityLevel(t);                // Current security level
                const minSecurity = ns.getServerMinSecurityLevel(t);             // Minimum security level
                const delta       = security - minSecurity;                      // Security above minimum
                const moneyPct    = maxMoney > 0 ? (curMoney / maxMoney) * 100 : 0; // Money as % of max
                const prepped     = isPrepped(ns, t);                            // Tight threshold check via lib-utils
                const mode        = prepped ? 'HACK' : 'PREP';                   // Mode string
                const modeCol     = prepped ? GR : YE;                          // Green for HACK, yellow for PREP

                // Countdown
                const entry     = cycleData?.targets?.[t];                       // Timing entry for this target
                const elapsed   = cycleData ? Date.now() - cycleData.cycleStart : 0; // Time since cycle started
                const totalTime = entry?.weakenTime ?? 0;                        // Full cycle duration
                const remaining = remainingTime(cycleData, t);                   // Formatted remaining time string
                const cdBar     = totalTime > 0
                    ? countdownBar(elapsed, totalTime, 14, modeCol)              // Elapsed fills left-to-right
                    : `${DIM}[──────────────]${R}`;                              // Placeholder when no timing data

                // Line 1 — identity, mode, countdown
                ns.print(
                    `  ${WH}${t}${R}` +
                    `  ${modeCol}[${mode}]${R}` +
                    `  ${cdBar}  ${modeCol}${remaining}${R}`
                );

                // Line 2 — money, security, threads (all on one line)
                ns.print(
                    `  ${DIM}$${R}${ns.format.number(curMoney,'0.0a')}${DIM}/$${R}${ns.format.number(maxMoney,'0.0a')}` +
                    ` ${bar(curMoney, maxMoney, 12, GR)} ${GR}${moneyPct.toFixed(0)}%${R}` +
                    `  ${DIM}sec${R}${secCol(delta)}${security.toFixed(1)}${R}${DIM}/${R}${minSecurity.toFixed(1)}${DIM}+${R}${secCol(delta)}${delta.toFixed(1)}${R}` +
                    `  ${CY}W:${tc.weaken}${R} ${YE}G:${tc.grow}${R} ${RE}H:${tc.hack}${R}`
                );
            }
        }

        // ── HACKNET: single line ───────────────────────────────────────────────
        section(ns, '  HACKNET', YE);
        if (hnCount === 0) {
            ns.print(`  ${DIM}No hacknet nodes owned${R}`);                      // No nodes yet
        } else {
            ns.print(
                `  ${WH}${hnCount}/${hnMaxNodes}${R} ${DIM}nodes${R}` +
                `  ${YE}$${ns.format.number(hnProd,'0.00a')}/s${R}` +
                `  ${DIM}lvl${R}${WH}${hnAvgLevel}/${HN_MAX_LEVEL}${R}` +
                `  ${DIM}ram${R}${WH}${hnAvgRam}/${HN_MAX_RAM}GB${R}` +
                `  ${DIM}cores${R}${WH}${hnAvgCores}/${HN_MAX_CORES}${R}`
            );
        }

        // ── SCRIPTS: inline badges ────────────────────────────────────────────
        // All scripts on two lines max — coloured inline rather than one-per-line
        section(ns, '  SCRIPTS', WH);
        const badges = scriptStatus.map(s => {
            const name = s.file.replace('scripts/', '').replace('.js', '');      // Short display name
            if (s.running)   return `${GR}[RUN]${R}${WH}${name}${R}`;           // Green — running
            if (s.critical)  return `${RE}[STP]${R}${WH}${name}${R}`;           // Red — stopped, critical
            return `${DIM}[stp]${name}${R}`;                                     // Dim — stopped, non-critical
        });
        // Print in two rows of three to keep width manageable
        const row1 = badges.slice(0, 3).join('  ');                             // First three scripts
        const row2 = badges.slice(3).join('  ');                                // Remaining scripts
        ns.print(`  ${row1}`);                                                   // First badge row
        if (row2) ns.print(`  ${row2}`);                                         // Second badge row if needed

        // ── Footer ────────────────────────────────────────────────────────────
        ns.print(`${DIM}${'─'.repeat(64)}${R}`);
        ns.print(`${DIM}  status.js v${VERSION}  |  run /scripts/status.js  |  tail /scripts/status.js${R}`);

        await ns.sleep(REFRESH_MS);                                              // Wait before next full redraw
    }
}
