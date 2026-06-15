/**
 * share-manager.js
 * Version: 1.0.0
 *
 * Faction rep multiplier manager for PhlanxOS BitBurner automation suite.
 *
 * Behaviour:
 *   Periodically scans all rooted worker servers and fills idle RAM with
 *   share.js threads. Each thread contributes to the global share power
 *   multiplier: sharePower = 1 + ln(totalThreads) / 25.
 *
 *   On each cycle the manager kills existing share.js instances, recalculates
 *   available RAM on each server, and relaunches with updated thread counts.
 *   This ensures new HWGW workers dispatched by orchestrate.js always take
 *   priority — share threads vacate and respawn around them automatically.
 *
 *   Home is excluded: home RAM belongs to the control plane.
 *   Only servers with root access and enough RAM for at least 1 share thread
 *   are used.
 *
 *   share.js must exist on the target server before exec. The manager copies
 *   it if not already present.
 *
 * No gate. Runs from tier 1 (16GB home, farm servers present).
 * At tier 0 there are no farm servers so the script loops harmlessly.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Rescan interval in seconds (default: 60)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~3.3 GB
 *   Base 1.6 + scan 0.2 + exec 1.3 + kill 0.5 (scriptKill) + scp 0.6
 *   getServerMaxRam / getServerUsedRam / hasRootAccess: negligible (no listed cost)
 */

const VERSION    = '1.0.0';
const SHARE_RAM  = 4.0;                                                             // GB cost per share.js thread (base 1.6 + ns.share 2.4)
const SHARE_SCRIPT = 'scripts/share.js';

export async function main(ns) {
    const flags    = ns.flags([['interval', 60]]);
    const interval = flags.interval * 1000;

    ns.disableLog('ALL');
    ns.print('=== share-manager.js v' + VERSION + ' | interval=' + flags.interval + 's ===');

    while (true) {
        dispatch(ns);
        await ns.sleep(interval);
    }
}


// =============================================================================
// Dispatch
// =============================================================================

function dispatch(ns) {
    const workers = getWorkerServers(ns);
    let totalThreads = 0;

    for (const host of workers) {
        // Kill existing share.js on this host to reclaim RAM accurately
        ns.scriptKill(SHARE_SCRIPT, host);

        const maxRam  = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const freeRam = maxRam - usedRam;
        const threads = Math.floor(freeRam / SHARE_RAM);

        if (threads <= 0) continue;

        // Ensure share.js is present on target
        if (!ns.fileExists(SHARE_SCRIPT, host)) {
            ns.scp(SHARE_SCRIPT, host, 'home');
        }

        const pid = ns.exec(SHARE_SCRIPT, host, threads);
        if (pid > 0) {
            totalThreads += threads;
            ns.print('[SHARE] ' + host + ' | threads=' + threads + ' | freeRam=' + freeRam.toFixed(1) + 'GB');
        } else {
            ns.print('[SHARE] FAIL ' + host + ' | exec returned 0');
        }
    }

    const sharePower = totalThreads > 0 ? (1 + Math.log(totalThreads) / 25).toFixed(3) : '1.000';
    ns.print('[SHARE] Total threads: ' + totalThreads + ' | sharePower: ' + sharePower + 'x');
}


// =============================================================================
// Server discovery (inlined — no lib-utils import to keep RAM minimal)
// =============================================================================

function getWorkerServers(ns) {
    const visited = new Set();
    const queue   = ['home'];
    while (queue.length > 0) {
        const host = queue.pop();
        if (visited.has(host)) continue;
        visited.add(host);
        for (const nb of ns.scan(host)) {
            if (!visited.has(nb)) queue.push(nb);
        }
    }
    return Array.from(visited)
        .filter(h => h !== 'home')
        .filter(h => ns.hasRootAccess(h))
        .filter(h => ns.getServerMaxRam(h) >= SHARE_RAM);
}
