/** @param {NS} ns */
export async function main(ns) {
    const fns = [
        'dnet.authenticate',
        'dnet.connectToSession',
        'dnet.getServerDetails',
        'dnet.heartbleed',
        'dnet.isDarknetServer',
        'dnet.memoryReallocation',
        'dnet.nextMutation',
        'dnet.probe',
        'dnet.getStasisLinkedServers',
        'dnet.getStasisLinkLimit',
        'dnet.getDarknetInstability',
        'exec',
        'scp',
        'isRunning',
        'getScriptRam',
        'getServerMaxRam',
        'getServerUsedRam',
        'getPlayer',
        'scan',
        'hasRootAccess',
    ];
    ns.tprint('=== RAM cost per function ===');
    for (const fn of fns) {
        ns.tprint(fn.padEnd(35) + ns.getFunctionRamCost(fn).toFixed(2) + ' GB');
    }
    ns.tprint('Total dnet-orchestrate.js: ' + ns.getScriptRam('/scripts/dnet-orchestrate.js').toFixed(2) + ' GB');
    ns.tprint('Total dnet-phish.js:       ' + ns.getScriptRam('/scripts/dnet-phish.js').toFixed(2) + ' GB');
}
