/**
 * dnet-scan.js
 * Version: 1.0.0
 *
 * Scans all darknet servers visible from the current server and prints details.
 *
 * Behaviour:
 *   Probes darknet from current host, then calls getServerDetails() on each.
 *   Prints password hints, depth, charisma req, blocked RAM, and stasis status.
 *   Also shows global instability and stasis link usage.
 *   Run from home to see darkweb, or from a darknet server to see deeper nodes.
 *   One-shot: prints results and exits.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --help   Show usage then exit
 *
 * RAM cost: 0.2 (probe) + 0.1 (getServerDetails) + 0.05 (getDarknetInstability)
 *           + 0.05 (getStasisLinkedServers) + 0.05 (getStasisLinkLimit) = ~0.45 GB
 *
 * Dependencies:
 *   import { log } from '/scripts/lib-utils.js';
 */

import { log } from '/scripts/lib-utils.js';

/** @param {NS} ns */
export async function main(ns) {
    ns.tprint('=== dnet-scan.js v1.0.0 ===');
    ns.tprint('Args: ' + JSON.stringify(ns.args));
    ns.disableLog('ALL');

    if (ns.args.includes('--help')) {
        ns.tprint('Usage: run dnet-scan.js');
        ns.tprint('  Probes darknet servers visible from current host.');
        return;
    }

    const dnet        = ns.dnet;
    const instability = dnet.getDarknetInstability();                                // Global auth speed penalty from backdoor overuse
    const stasisUsed  = dnet.getStasisLinkedServers().length;                        // How many stasis slots are consumed
    const stasisLimit = dnet.getStasisLinkLimit();                                   // Maximum stasis links allowed

    ns.tprint('Instability  : ' + instability.authenticationDurationMultiplier.toFixed(2) + 'x auth time'
        + '  |  timeout chance: ' + (instability.authenticationTimeoutChance * 100).toFixed(1) + '%');
    ns.tprint('Stasis links : ' + stasisUsed + ' / ' + stasisLimit);
    ns.tprint('');

    const hosts = dnet.probe();                                                      // All darknet servers directly connected to this host

    if (hosts.length === 0) {
        ns.tprint('No darknet servers visible from ' + ns.getHostname());
        return;
    }

    for (const host of hosts) {
        const d = dnet.getServerDetails(host);
        if (!d.isOnline) {
            ns.tprint('[OFFLINE] ' + host);
            continue;
        }

        ns.tprint('--- ' + host + ' ---');
        ns.tprint('  Depth        : ' + d.depth);
        ns.tprint('  Difficulty   : ' + d.difficulty);
        ns.tprint('  Model        : ' + d.modelId);
        ns.tprint('  Charisma req : ' + d.requiredCharismaSkill);
        ns.tprint('  Password     : ' + d.passwordLength + ' chars  [' + d.passwordFormat + ']');
        ns.tprint('  Hint         : ' + (d.passwordHint || '(none)'));
        ns.tprint('  Hint data    : ' + (d.data || '(none)'));
        ns.tprint('  Blocked RAM  : ' + d.blockedRam + ' GB');
        ns.tprint('  Session      : ' + (d.hasSession ? 'YES' : 'no'));
        ns.tprint('  Stationary   : ' + (d.isStationary ? 'yes' : 'no'));
        ns.tprint('  Log interval : ' + d.logTrafficInterval + 's');
        ns.tprint('');
    }
}
