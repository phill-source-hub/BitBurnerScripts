/**
 * bootstrap.js
 * Version: 1.0.0
 *
 * Post-reset launcher. Detects RAM tier and starts appropriate scripts.
 *
 * Behaviour:
 *   On start, kills all managed scripts cleanly then relaunches the set
 *   appropriate for the detected tier. Scripts that exceed available home
 *   RAM or are suppressed by --no-* flags are skipped with a logged reason.
 *   Flags for reserve amounts are forwarded to the relevant scripts.
 *
 *   Launch order matches build order to respect dependencies:
 *     Tier 0+: orchestrate.js, auto-root.js
 *     Tier 1+: buy-servers.js
 *     Tier 2+: upgrade-servers.js, hacknet-manager.js
 *     Tier 3+: status.js
 *
 *   --all overrides tier gating and launches everything regardless.
 *   --no-<script> suppresses a specific script (e.g. --no-status).
 *
 *   getScriptRam() checks each script's RAM cost before exec. If the
 *   script file is not present, getScriptRam returns 0 and the launch
 *   is skipped with a warning — run installer.js first.
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --help               Show version, usage, and flags then exit
 *   --all                Launch all scripts regardless of tier
 *   --no-orchestrate     Suppress orchestrate.js
 *   --no-auto-root       Suppress auto-root.js
 *   --no-buy-servers     Suppress buy-servers.js
 *   --no-upgrade-servers Suppress upgrade-servers.js
 *   --no-hacknet         Suppress hacknet-manager.js
 *   --no-status          Suppress status.js
 *   --hacknet-reserve N  Passed to hacknet-manager.js --reserve (default: 0)
 *   --server-reserve N   Passed to upgrade-servers.js --reserve and buy-servers.js --reserve (default: 0)
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    getRamTier,
    getScriptRam,
    log,
} from '/scripts/lib-utils.js';

// --- Script paths (no leading slash for ns.exec resolution) ---
const SCRIPT_ORCHESTRATE = 'scripts/orchestrate.js';
const SCRIPT_AUTO_ROOT   = 'scripts/auto-root.js';
const SCRIPT_BUY         = 'scripts/buy-servers.js';
const SCRIPT_UPGRADE     = 'scripts/upgrade-servers.js';
const SCRIPT_HACKNET     = 'scripts/hacknet-manager.js';
const SCRIPT_STATUS      = 'scripts/status.js';

// All managed scripts — killed on startup before relaunch
const ALL_SCRIPTS = [
    SCRIPT_ORCHESTRATE,
    SCRIPT_AUTO_ROOT,
    SCRIPT_BUY,
    SCRIPT_UPGRADE,
    SCRIPT_HACKNET,
    SCRIPT_STATUS,
];

// Minimum tier required to launch each script
const TIER_REQUIREMENTS = {
    [SCRIPT_ORCHESTRATE] : 0,
    [SCRIPT_AUTO_ROOT]   : 0,
    [SCRIPT_BUY]         : 1,
    [SCRIPT_UPGRADE]     : 2,
    [SCRIPT_HACKNET]     : 2,
    [SCRIPT_STATUS]      : 3,
};


// =============================================================================
// Helpers
// =============================================================================

/**
 * Attempts to launch a script on home. Checks script exists (RAM > 0) and
 * that it will fit in available home RAM before calling ns.exec().
 * @param {NS} ns
 * @param {string} script - Script path
 * @param {string[]} args - Arguments to pass to script
 * @returns {boolean} True if launched successfully
 */
function launch(ns, script, args = []) {
    const scriptRam = getScriptRam(ns, script);                                     // 0 if file not found
    if (scriptRam === 0) {
        ns.tprint('[BOOTSTRAP] SKIP ' + script + ' — file not found (run installer.js)');
        return false;
    }

    const homeMax  = ns.getServerMaxRam('home');
    const homeUsed = ns.getServerUsedRam('home');
    const homeFree = homeMax - homeUsed;

    if (scriptRam > homeFree) {
        ns.tprint('[BOOTSTRAP] SKIP ' + script + ' — needs ' + scriptRam + 'GB, only ' + homeFree.toFixed(1) + 'GB free');
        return false;
    }

    const pid = ns.exec(script, 'home', 1, ...args);                               // Launch with 1 thread on home
    if (pid === 0) {
        ns.tprint('[BOOTSTRAP] FAIL ' + script + ' — exec returned 0 (RAM contention?)');
        return false;
    }

    ns.tprint('[BOOTSTRAP] OK   ' + script + ' (pid ' + pid + ')');
    return true;
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',               false],
        ['all',                false],
        ['no-orchestrate',     false],
        ['no-auto-root',       false],
        ['no-buy-servers',     false],
        ['no-upgrade-servers', false],
        ['no-hacknet',         false],
        ['no-status',          false],
        ['hacknet-reserve',    0],
        ['server-reserve',     0],
    ]);

    if (flags.help) {
        ns.tprint('=== bootstrap.js v1.0.0 ===');
        ns.tprint('Purpose: Kills and relaunches all managed scripts for the detected RAM tier.');
        ns.tprint('Usage:   run /scripts/bootstrap.js [flags]');
        ns.tprint('Flags:');
        ns.tprint('  --help                Show this help and exit');
        ns.tprint('  --all                 Launch all scripts regardless of tier');
        ns.tprint('  --no-orchestrate      Suppress orchestrate.js');
        ns.tprint('  --no-auto-root        Suppress auto-root.js');
        ns.tprint('  --no-buy-servers      Suppress buy-servers.js');
        ns.tprint('  --no-upgrade-servers  Suppress upgrade-servers.js');
        ns.tprint('  --no-hacknet          Suppress hacknet-manager.js');
        ns.tprint('  --no-status           Suppress status.js');
        ns.tprint('  --hacknet-reserve N   Reserve N dollars extra for hacknet-manager (default: 0)');
        ns.tprint('  --server-reserve N    Reserve N dollars extra for buy/upgrade-servers (default: 0)');
        return;
    }

    ns.tprint('=== bootstrap.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    const tier = getRamTier(ns);
    ns.tprint('[BOOTSTRAP] Home RAM tier: ' + tier + ' (' + ns.getServerMaxRam('home') + 'GB)');

    // --- Kill all managed scripts for a clean slate ---
    ns.tprint('[BOOTSTRAP] Killing managed scripts...');
    for (const script of ALL_SCRIPTS) {
        ns.scriptKill(script, 'home');                                              // Idempotent — no error if not running
    }
    await ns.sleep(500);                                                            // Brief settle time for killed processes to free RAM

    // --- Build suppression set from --no-* flags ---
    const suppressed = new Set();
    if (flags['no-orchestrate'])     suppressed.add(SCRIPT_ORCHESTRATE);
    if (flags['no-auto-root'])       suppressed.add(SCRIPT_AUTO_ROOT);
    if (flags['no-buy-servers'])     suppressed.add(SCRIPT_BUY);
    if (flags['no-upgrade-servers']) suppressed.add(SCRIPT_UPGRADE);
    if (flags['no-hacknet'])         suppressed.add(SCRIPT_HACKNET);
    if (flags['no-status'])          suppressed.add(SCRIPT_STATUS);

    const hacknetReserve = flags['hacknet-reserve'];
    const serverReserve  = flags['server-reserve'];

    /**
     * Determines whether a script should be launched given tier and suppression.
     * @param {string} script
     * @returns {boolean}
     */
    function shouldLaunch(script) {
        if (suppressed.has(script)) {
            ns.tprint('[BOOTSTRAP] SKIP ' + script + ' — suppressed by --no-* flag');
            return false;
        }
        if (!flags.all && tier < TIER_REQUIREMENTS[script]) {
            ns.tprint('[BOOTSTRAP] SKIP ' + script + ' — requires tier ' + TIER_REQUIREMENTS[script] + ', current tier ' + tier);
            return false;
        }
        return true;
    }

    ns.tprint('[BOOTSTRAP] Launching scripts for tier ' + (flags.all ? 'ALL' : tier) + '...');

    // --- Launch in dependency order ---

    if (shouldLaunch(SCRIPT_ORCHESTRATE)) {
        launch(ns, SCRIPT_ORCHESTRATE, []);
    }

    if (shouldLaunch(SCRIPT_AUTO_ROOT)) {
        launch(ns, SCRIPT_AUTO_ROOT, ['--watch']);                                  // Always launch in watch mode
    }

    if (shouldLaunch(SCRIPT_BUY)) {
        const args = serverReserve > 0 ? ['--reserve', serverReserve] : [];
        launch(ns, SCRIPT_BUY, args);
    }

    if (shouldLaunch(SCRIPT_UPGRADE)) {
        const args = serverReserve > 0 ? ['--reserve', serverReserve] : [];
        launch(ns, SCRIPT_UPGRADE, args);
    }

    if (shouldLaunch(SCRIPT_HACKNET)) {
        const args = hacknetReserve > 0 ? ['--reserve', hacknetReserve] : [];
        launch(ns, SCRIPT_HACKNET, args);
    }

    if (shouldLaunch(SCRIPT_STATUS)) {
        launch(ns, SCRIPT_STATUS, []);
    }

    ns.tprint('[BOOTSTRAP] Done.');
}
