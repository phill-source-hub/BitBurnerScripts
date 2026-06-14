/**
 * status.js
 * Version: 1.0.1
 *
 * Realtime dashboard displaying orchestrate, hacknet, and server state.
 *
 * Behaviour:
 *   Only activates at tier 3 (64GB+ home RAM) or when --force is passed.
 *   Exits immediately at lower tiers without --force — home RAM is too
 *   valuable to spend on a dashboard at early tiers.
 *
 *   Refreshes every REFRESH_MS (1000ms). Each cycle calls ns.clearLog()
 *   then ns.print() to build a clean display. All port reads are non-
 *   consuming (readPort uses ns.peek) — status.js never owns any port.
 *
 *   Sections:
 *     ORCHESTRATE — active targets, mode (PREP/HACK/TIER0), time remaining
 *     HACKNET     — node count, total income rate, total spent
 *     SERVERS     — owned count, RAM distribution
 *     HOME        — RAM used/free, tier, currently running scripts
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --help    Show version, usage, and flags then exit
 *   --force   Run regardless of RAM tier
 *
 * Ports:
 *   Reads port 1: orchestrate cycle timing (peek, non-consuming)
 *   Reads port 3: hacknet stats (peek, non-consuming)
 *   Reads port 4: latest server event (peek, non-consuming)
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    readPort,
    getRamTier,
    formatTime,
    log,
} from '/scripts/lib-utils.js';

// --- Constants ---
const REFRESH_MS   = 1000;                                                          // Dashboard refresh interval
const PORT_ORCH    = 1;                                                             // Orchestrate cycle timing port
const PORT_HACKNET = 3;                                                             // Hacknet stats port
const PORT_SERVERS = 4;                                                             // Server events port
const TIER_MIN     = 3;                                                             // Minimum tier to run without --force


// =============================================================================
// Display helpers
// =============================================================================

/**
 * Returns a bar string visualising a ratio (e.g. RAM used vs max).
 * @param {number} used - Current value
 * @param {number} total - Maximum value
 * @param {number} [width=20] - Number of characters in bar
 * @returns {string} Bar string e.g. "[####........] 45%"
 */
function bar(used, total, width = 20) {
    if (total <= 0) return '[' + '.'.repeat(width) + '] 0%';                       // Avoid divide-by-zero
    const filled  = Math.round((used / total) * width);                             // Characters to fill
    const empty   = width - filled;
    const pct     = Math.round((used / total) * 100);
    return '[' + '#'.repeat(filled) + '.'.repeat(empty) + '] ' + pct + '%';
}

/**
 * Pads a string to a fixed width for column alignment.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function pad(str, width) {
    const s = String(str);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);               // Right-pad with spaces
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',  false],
        ['force', false],
    ]);

    if (flags.help) {
        ns.tprint('=== status.js v1.0.0 ===');
        ns.tprint('Purpose: Realtime dashboard for orchestrate, hacknet, and server state.');
        ns.tprint('         Only active at tier 3 (64GB+ home RAM) unless --force is used.');
        ns.tprint('Usage:   run /scripts/status.js [--force]');
        ns.tprint('Flags:');
        ns.tprint('  --help    Show this help and exit');
        ns.tprint('  --force   Run dashboard regardless of RAM tier');
        ns.tprint('Ports:');
        ns.tprint('  Reads port 1: orchestrate cycle data (non-consuming)');
        ns.tprint('  Reads port 3: hacknet stats (non-consuming)');
        ns.tprint('  Reads port 4: server events (non-consuming)');
        return;
    }

    ns.tprint('=== status.js v1.0.0 | force:' + flags.force + ' ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    // Exit at low tiers unless forced — RAM is too valuable early
    if (!flags.force && getRamTier(ns) < TIER_MIN) {
        ns.tprint('[STATUS] Tier < ' + TIER_MIN + ' and --force not set — exiting to conserve RAM');
        return;
    }

    // Display only in log window — opens the tail window automatically
    ns.ui.openTail();

    while (true) {
        ns.clearLog();                                                              // Wipe previous frame for clean refresh

        const now      = Date.now();
        const tier     = getRamTier(ns);
        const homeMax  = ns.getServerMaxRam('home');
        const homeUsed = ns.getServerUsedRam('home');
        const homeFree = homeMax - homeUsed;

        // --- Read ports (non-consuming) ---
        const orchData    = readPort(ns, PORT_ORCH);                                // { cycleStart, targets: { host: { weakenTime, mode } } }
        const hacknetData = readPort(ns, PORT_HACKNET);                             // { nodes, totalIncome, totalSpent }
        const serverEvent = readPort(ns, PORT_SERVERS);                             // { event, host, ram }

        // --- Header ---
        ns.print('======================================');
        ns.print(' PhlanxOS Status  |  ' + new Date().toLocaleTimeString());
        ns.print(' Tier: ' + tier + '  |  Home: ' + homeUsed.toFixed(1) + '/' + homeMax + 'GB');
        ns.print('======================================');

        // --- ORCHESTRATE section ---
        ns.print('');
        ns.print('[ ORCHESTRATE ]');
        if (!orchData || !orchData.targets) {
            ns.print('  No data yet — orchestrate not running or no cycle complete');
        } else {
            const cycleAge = now - orchData.cycleStart;                             // How old is this cycle data
            ns.print('  Cycle data age: ' + formatTime(cycleAge));
            for (const host of Object.keys(orchData.targets)) {
                const t          = orchData.targets[host];
                const remaining  = Math.max(0, (orchData.cycleStart + t.weakenTime) - now); // Estimated time left in cycle
                ns.print('  ' + pad(host, 20) + ' ' + pad(t.mode, 6) + ' ' + formatTime(remaining) + ' remaining');
            }
        }

        // --- HACKNET section ---
        ns.print('');
        ns.print('[ HACKNET ]');
        if (!hacknetData) {
            ns.print('  No data — hacknet-manager not running');
        } else {
            ns.print('  Nodes:  ' + hacknetData.nodes);
            ns.print('  Income: $' + ns.format.number(hacknetData.totalIncome) + '/s');
            ns.print('  Spent:  $' + ns.format.number(hacknetData.totalSpent) + ' this session');
        }

        // --- SERVERS section ---
        ns.print('');
        ns.print('[ SERVERS ]');
        const owned = ns.cloud.getServerNames();                                    // Correct v3.0.1 API for purchased server list
        if (owned.length === 0) {
            ns.print('  No cloud servers purchased yet');
        } else {
            // Group by RAM size for compact display
            const ramGroups = {};
            for (const host of owned) {
                const ram = ns.getServerMaxRam(host);
                ramGroups[ram] = (ramGroups[ram] || 0) + 1;                         // Count servers at each RAM tier
            }
            ns.print('  Owned: ' + owned.length + ' / ' + ns.cloud.getServerLimit());
            for (const ram of Object.keys(ramGroups).sort((a, b) => Number(a) - Number(b))) {
                ns.print('  ' + ramGroups[ram] + 'x ' + ram + 'GB');
            }
        }
        if (serverEvent) {
            ns.print('  Last event: ' + serverEvent.event + ' ' + serverEvent.host + ' (' + serverEvent.ram + 'GB)');
        }

        // --- HOME section ---
        ns.print('');
        ns.print('[ HOME ]');
        ns.print('  RAM: ' + homeUsed.toFixed(1) + '/' + homeMax + 'GB  ' + bar(homeUsed, homeMax));
        ns.print('  Free: ' + homeFree.toFixed(1) + 'GB');

        // List running scripts on home
        const running = ns.ps('home');                                              // Returns processes on home (filenames without leading slash)
        ns.print('  Scripts (' + running.length + '):');
        for (const proc of running) {
            ns.print('    ' + proc.filename + ' [' + proc.threads + 't]');          // Filename and thread count
        }

        ns.print('');
        ns.print('======================================');

        await ns.sleep(REFRESH_MS);
    }
}
