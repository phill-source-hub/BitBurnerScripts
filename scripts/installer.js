/**
 * installer.js
 * Version: 1.0.0
 *
 * Downloads all PhlanxOS scripts from GitHub to /scripts/.
 *
 * Behaviour:
 *   Fetches each script via ns.wget() from the GitHub raw content URL.
 *   Overwrites any existing local file — re-running installer is the update
 *   mechanism. No diff or selective logic: wget is cheap and ensures all
 *   scripts are in sync with the repository.
 *
 *   Reports success or failure per file. A failed wget leaves the previous
 *   version in place (or no file if this is a fresh install).
 *
 *   Run order after install:
 *     run /scripts/installer.js    <- this script (already present)
 *     run /scripts/bootstrap.js    <- starts everything for current tier
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --help   Show version, usage, and flags then exit
 *
 * Dependencies:
 *   None. Standalone — no imports.
 */

// --- GitHub raw content base URL ---
const BASE_URL = 'https://raw.githubusercontent.com/phill-source-hub/BitBurnerScripts/main/scripts/';

// --- All scripts to install, in dependency order ---
const SCRIPTS = [
    'lib-utils.js',
    'lib-sf-utils.js',
    'worker.js',
    'orchestrate.js',
    'auto-root.js',
    'buy-servers.js',
    'upgrade-servers.js',
    'hacknet-manager.js',
    'status.js',
    'bootstrap.js',
    'installer.js',
];

// --- Local install path prefix ---
const INSTALL_PATH = '/scripts/';


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([['help', false]]);

    if (flags.help) {
        ns.tprint('=== installer.js v1.0.0 ===');
        ns.tprint('Purpose: Downloads all PhlanxOS scripts from GitHub to /scripts/.');
        ns.tprint('         Re-run at any time to update all scripts to latest version.');
        ns.tprint('Usage:   run /scripts/installer.js');
        ns.tprint('After:   run /scripts/bootstrap.js');
        ns.tprint('Flags:');
        ns.tprint('  --help   Show this help and exit');
        return;
    }

    ns.tprint('=== installer.js v1.0.0 ===');
    ns.tprint('Downloading ' + SCRIPTS.length + ' scripts from GitHub...');  // 11 scripts
    ns.disableLog('ALL');

    let successCount = 0;
    let failCount    = 0;

    for (const filename of SCRIPTS) {
        const url       = BASE_URL + filename;                                      // Full raw GitHub URL for this file
        const localPath = INSTALL_PATH + filename;                                  // Destination path in-game

        const ok = await ns.wget(url, localPath);                                   // Fetch and write; returns true on success

        if (ok) {
            ns.tprint('[OK]   ' + localPath);
            successCount++;
        } else {
            ns.tprint('[FAIL] ' + localPath + ' — check network or repo URL');
            failCount++;
        }
    }

    ns.tprint('');
    ns.tprint('Install complete: ' + successCount + ' ok, ' + failCount + ' failed');

    if (failCount === 0) {
        ns.tprint('All scripts installed. Run: run /scripts/bootstrap.js');
    } else {
        ns.tprint('Some files failed. Re-run installer or check the repo URL.');
    }
}
