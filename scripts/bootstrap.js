/**
 * bootstrap.js
 * Version: 1.5.0
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
 *     Tier 0:  orchestrate-t0.js, auto-root.js (RAM permitting)
 *     Tier 1+: orchestrate.js, auto-root.js, buy-servers.js, share-manager.js, contracts.js
 *     Tier 2+: upgrade-servers.js, hacknet-manager.js
 *     Tier 2+: dashboard.js (React interactive)
 *     Tier 3+: status.js only if --status flag passed (ANSI legacy fallback)
 *
 *   Orchestrate variant is chosen by tier:
 *     Tier 0 → orchestrate-t0.js (~3.5GB, no HWGW batch math)
 *     Tier 1+ → orchestrate.js (full HWGW, needs 16GB home)
 *   --no-orchestrate suppresses both variants.
 *
 *   --all overrides tier gating and launches everything regardless.
 *   --no-<script> suppresses a specific script (e.g. --no-status).
 *
 *   ns.getScriptRam() checks each script's RAM cost before exec. If the
 *   script file is not present, getScriptRam returns 0 and the launch
 *   is skipped with a warning — run installer.js first.
 *
 *   Before launching orchestrate, worker.js is SCP'd to all currently
 *   rooted servers so orchestrate's pool is ready on first cycle.
 *
 * Changelog:
 *   v2.0.0 - status.js no longer auto-launched; opt-in via --status flag (replaced by dashboard).
 *   v1.9.0 - Add grafting.js (tier 1+), go.js (tier 1+), stanek.js (tier 2+).
 *   v1.8.0 - Add sleeve.js (tier 1+), bladeburner.js (tier 1+), corporation.js (tier 2+).
 *   v1.7.0 - Add dashboard.js (tier 2+). Add --no-dashboard flag.
 *   v1.6.0 - Add singularity.js, stocks.js, gang.js (all tier 1+, self-gate at runtime).
 *            Add share-manager.js (tier 1+) and contracts.js (tier 1+).
 *   v1.4.0 - Remove auto-root and buy-servers from launch sequence. Both now
 *            launched by orchestrate.js after bootstrap exits. On 16GB home,
 *            bootstrap(~4GB) + orchestrate(~10GB) leaves no room for them.
 *            Still kills them on startup for clean restart.
 *   v1.3.0 - Strip bootstrap RAM: remove ns.scp (BFS block gone), ns.getScriptRam,
 *            ns.getServerUsedRam. launch() now trusts exec() return value.
 *            auto-root moved to tier 1 (run manually at tier 0).
 *            SCP responsibility handed to orchestrate.js runFullMode.
 *   v1.2.0 - Launch orchestrate-t0.js at tier 0, orchestrate.js at tier 1+.
 *            --no-orchestrate suppresses both.
 *   v1.1.0 - Inline ns.getScriptRam (removed from lib-utils). SCP worker.js
 *            to rooted servers before launching orchestrate.
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
 *   --status             Launch status.js (ANSI fallback; dashboard.js is default at tier 2+)
 *   --no-share           Suppress share-manager.js
 *   --no-contracts       Suppress contracts.js
 *   --no-singularity     Suppress singularity.js
 *   --no-stocks          Suppress stocks.js
 *   --no-gang            Suppress gang.js
 *   --no-dashboard       Suppress dashboard.js
 *   --hacknet-reserve N  Passed to hacknet-manager.js --reserve (default: 0)
 *   --server-reserve N   Passed to upgrade-servers.js --reserve and buy-servers.js --reserve (default: 0)
 *
 * Dependencies:
 *   import { ... } from '/scripts/lib-utils.js';
 */

import {
    getRamTier,
    log,
} from '/scripts/lib-utils.js';

// --- Script paths (no leading slash for ns.exec resolution) ---
const SCRIPT_ORCHESTRATE    = 'scripts/orchestrate.js';
const SCRIPT_ORCHESTRATE_T0 = 'scripts/orchestrate-t0.js';
const SCRIPT_AUTO_ROOT   = 'scripts/auto-root.js';
const SCRIPT_BUY         = 'scripts/buy-servers.js';
const SCRIPT_UPGRADE     = 'scripts/upgrade-servers.js';
const SCRIPT_HACKNET     = 'scripts/hacknet-manager.js';
const SCRIPT_STATUS      = 'scripts/status.js';
const SCRIPT_SHARE       = 'scripts/share-manager.js';
const SCRIPT_CONTRACTS   = 'scripts/contracts.js';
const SCRIPT_SINGULARITY = 'scripts/singularity.js';
const SCRIPT_STOCKS      = 'scripts/stocks.js';
const SCRIPT_GANG        = 'scripts/gang.js';
const SCRIPT_DASHBOARD   = 'scripts/dashboard.js';
const SCRIPT_SLEEVE      = 'scripts/sleeve.js';
const SCRIPT_BLADEBURNER = 'scripts/bladeburner.js';
const SCRIPT_CORP        = 'scripts/corporation.js';
const SCRIPT_GRAFTING    = 'scripts/grafting.js';
const SCRIPT_GO          = 'scripts/go.js';
const SCRIPT_STANEK      = 'scripts/stanek.js';

// All managed scripts — killed on startup before relaunch
const ALL_SCRIPTS = [
    SCRIPT_ORCHESTRATE,
    SCRIPT_ORCHESTRATE_T0,
    SCRIPT_AUTO_ROOT,
    SCRIPT_BUY,
    SCRIPT_UPGRADE,
    SCRIPT_HACKNET,
    SCRIPT_STATUS,
    SCRIPT_SHARE,
    SCRIPT_CONTRACTS,
    SCRIPT_SINGULARITY,
    SCRIPT_STOCKS,
    SCRIPT_GANG,
    SCRIPT_DASHBOARD,
    SCRIPT_SLEEVE,
    SCRIPT_BLADEBURNER,
    SCRIPT_CORP,
    SCRIPT_GRAFTING,
    SCRIPT_GO,
    SCRIPT_STANEK,
];

// Minimum tier required to launch each script.
// auto-root and buy-servers are NOT launched here — orchestrate.js owns them.
// At tier 1 (16GB): bootstrap(~4GB) + orchestrate(~10GB) = 14GB; auto-root(5.4GB)
// and buy-servers(~2GB) can't fit while bootstrap is resident. Orchestrate launches
// them after bootstrap exits. They are still killed here for a clean restart.
const TIER_REQUIREMENTS = {
    [SCRIPT_ORCHESTRATE] : 0,
    [SCRIPT_UPGRADE]     : 2,
    [SCRIPT_HACKNET]     : 2,
    [SCRIPT_STATUS]      : 3,
    [SCRIPT_SHARE]       : 1,
    [SCRIPT_CONTRACTS]   : 1,
    [SCRIPT_SINGULARITY] : 1,
    [SCRIPT_STOCKS]      : 1,
    [SCRIPT_GANG]        : 1,
    [SCRIPT_DASHBOARD]   : 2,
    [SCRIPT_SLEEVE]      : 1,
    [SCRIPT_BLADEBURNER] : 1,
    [SCRIPT_CORP]        : 2,
    [SCRIPT_GRAFTING]    : 1,
    [SCRIPT_GO]          : 1,
    [SCRIPT_STANEK]      : 2,
};


// =============================================================================
// Helpers
// =============================================================================

/**
 * Attempts to launch a script on home.
 * Intentionally avoids ns.getScriptRam and ns.getServerUsedRam to keep
 * bootstrap RAM low enough to launch orchestrate-t0 at tier 0.
 * exec() returns 0 on failure (file missing or insufficient RAM).
 * @param {NS} ns
 * @param {string} script - Script path
 * @param {string[]} args - Arguments to pass to script
 * @returns {boolean} True if launched successfully
 */
function launch(ns, script, args = []) {
    const pid = ns.exec(script, 'home', 1, ...args);
    if (pid === 0) {
        ns.tprint('[BOOTSTRAP] FAIL ' + script + ' — exec returned 0 (file missing or insufficient RAM)');
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
        ['status',             false],
        ['no-share',           false],
        ['no-contracts',       false],
        ['no-singularity',     false],
        ['no-stocks',          false],
        ['no-gang',            false],
        ['no-dashboard',       false],
        ['no-sleeve',          false],
        ['no-bladeburner',     false],
        ['no-corp',            false],
        ['no-grafting',        false],
        ['no-go',              false],
        ['no-stanek',          false],
        ['hacknet-reserve',    0],
        ['server-reserve',     0],
    ]);

    if (flags.help) {
        ns.tprint('=== bootstrap.js v2.0.0 ===');
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
        ns.tprint('  --status              Launch status.js (ANSI fallback — dashboard.js is default at tier 2+)');
        ns.tprint('  --no-share            Suppress share-manager.js');
        ns.tprint('  --no-contracts        Suppress contracts.js');
        ns.tprint('  --no-singularity      Suppress singularity.js');
        ns.tprint('  --no-stocks           Suppress stocks.js');
        ns.tprint('  --no-gang             Suppress gang.js');
        ns.tprint('  --no-dashboard        Suppress dashboard.js');
        ns.tprint('  --no-sleeve           Suppress sleeve.js');
        ns.tprint('  --no-bladeburner      Suppress bladeburner.js');
        ns.tprint('  --no-corp             Suppress corporation.js');
        ns.tprint('  --no-grafting         Suppress grafting.js');
        ns.tprint('  --no-go               Suppress go.js');
        ns.tprint('  --no-stanek           Suppress stanek.js');
        ns.tprint('  --hacknet-reserve N   Reserve N dollars extra for hacknet-manager (default: 0)');
        ns.tprint('  --server-reserve N    Reserve N dollars extra for buy/upgrade-servers (default: 0)');
        return;
    }

    ns.tprint('=== bootstrap.js v1.7.0 ===');
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
    if (!flags.status)               suppressed.add(SCRIPT_STATUS);                  // Status is opt-in; dashboard is default
    if (flags['no-share'])           suppressed.add(SCRIPT_SHARE);
    if (flags['no-contracts'])       suppressed.add(SCRIPT_CONTRACTS);
    if (flags['no-singularity'])     suppressed.add(SCRIPT_SINGULARITY);
    if (flags['no-stocks'])          suppressed.add(SCRIPT_STOCKS);
    if (flags['no-gang'])            suppressed.add(SCRIPT_GANG);
    if (flags['no-dashboard'])       suppressed.add(SCRIPT_DASHBOARD);
    if (flags['no-sleeve'])          suppressed.add(SCRIPT_SLEEVE);
    if (flags['no-bladeburner'])     suppressed.add(SCRIPT_BLADEBURNER);
    if (flags['no-corp'])            suppressed.add(SCRIPT_CORP);
    if (flags['no-grafting'])        suppressed.add(SCRIPT_GRAFTING);
    if (flags['no-go'])              suppressed.add(SCRIPT_GO);
    if (flags['no-stanek'])          suppressed.add(SCRIPT_STANEK);

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

    // Orchestrate: tier 0 uses the lightweight t0 variant; tier 1+ uses full HWGW.
    // --no-orchestrate suppresses both.
    if (!suppressed.has(SCRIPT_ORCHESTRATE)) {
        const orchScript = tier === 0 ? SCRIPT_ORCHESTRATE_T0 : SCRIPT_ORCHESTRATE;
        launch(ns, orchScript, []);
    } else {
        ns.tprint('[BOOTSTRAP] SKIP orchestrate — suppressed by --no-orchestrate');
    }

    // auto-root and buy-servers are launched by orchestrate.js after it starts —
    // they don't fit alongside bootstrap + orchestrate on 16GB home. See orchestrate.js v1.4.0.

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

    if (shouldLaunch(SCRIPT_SHARE)) {
        launch(ns, SCRIPT_SHARE, []);
    }

    if (shouldLaunch(SCRIPT_CONTRACTS)) {
        launch(ns, SCRIPT_CONTRACTS, []);
    }

    if (shouldLaunch(SCRIPT_SINGULARITY)) {
        launch(ns, SCRIPT_SINGULARITY, []);
    }

    if (shouldLaunch(SCRIPT_STOCKS)) {
        launch(ns, SCRIPT_STOCKS, []);
    }

    if (shouldLaunch(SCRIPT_GANG)) {
        launch(ns, SCRIPT_GANG, []);
    }

    if (shouldLaunch(SCRIPT_DASHBOARD)) {
        launch(ns, SCRIPT_DASHBOARD, []);
    }

    if (shouldLaunch(SCRIPT_SLEEVE)) {
        launch(ns, SCRIPT_SLEEVE, []);
    }

    if (shouldLaunch(SCRIPT_BLADEBURNER)) {
        launch(ns, SCRIPT_BLADEBURNER, []);
    }

    if (shouldLaunch(SCRIPT_CORP)) {
        launch(ns, SCRIPT_CORP, []);
    }

    if (shouldLaunch(SCRIPT_GRAFTING)) {
        launch(ns, SCRIPT_GRAFTING, []);
    }

    if (shouldLaunch(SCRIPT_GO)) {
        launch(ns, SCRIPT_GO, []);
    }

    if (shouldLaunch(SCRIPT_STANEK)) {
        launch(ns, SCRIPT_STANEK, []);
    }

    ns.tprint('[BOOTSTRAP] Done.');
}
