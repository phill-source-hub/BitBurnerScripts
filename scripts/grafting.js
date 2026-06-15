/**
 * grafting.js
 * Version: 1.0.0
 *
 * Augmentation grafting automation. Requires SF10.
 *
 * Behaviour:
 *   Grafting lets you acquire augmentations without faction rep, at the cost
 *   of time and money. Each graft takes several minutes of in-game "work" time
 *   during which the player cannot do other active work.
 *
 *   Each cycle:
 *   1. Detect SF10 access (bracket notation gate)
 *   2. Skip if player is currently grafting (isBusy + getCurrentWork check)
 *   3. Build list of graftable augs not yet owned
 *   4. Sort by cost ascending (cheapest first — collect more augs sooner)
 *   5. Graft the first affordable aug above MIN_COST threshold
 *
 *   Grafting and singularity.js both touch "active work" — they co-exist by
 *   checking isBusy() before starting. If singularity.js started crime/faction
 *   work, grafting will wait. Grafting takes priority if nothing else is active.
 *
 *   Use --min-cost to avoid wasting time on trivial augs. Grafting time scales
 *   with aug complexity — cheap augs graft in ~30s game time, expensive ones
 *   in several minutes.
 *
 * Gate:
 *   All grafting calls use bracket notation. Script costs ~2 GB.
 *   Self-retries if SF10 not available.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N    Poll interval in seconds (default: 30)
 *   --once          Single cycle and exit
 *   --min-cost N    Skip augs below this cost in $ (default: 1e6 = $1M)
 *   --focus         Pass focus=true to graftAugmentation (default: true)
 *   --no-focus      Disable focus (allows other activities while grafting)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2 GB (all grafting calls bracket notation)
 */

const VERSION     = '1.0.0';
const MONEY_FLOOR = 0.10;

export async function main(ns) {
    const flags = ns.flags([
        ['interval',  30],
        ['once',      false],
        ['min-cost',  1e6],
        ['focus',     true],
        ['no-focus',  false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== grafting.js v' + VERSION + ' | interval=' + flags.interval + 's ===');

    const INTERVAL = flags.interval * 1000;
    const focus    = flags.focus && !flags['no-focus'];

    do {
        const ok = runCycle(ns, flags, focus);
        if (!ok) {
            ns.print('[GRAFT] No SF10 access — sleeping ' + flags.interval + 's, will retry');
        }
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Main cycle
// =============================================================================

function runCycle(ns, flags, focus) {
    const graft = ns['grafting'];                                                    // Bracket alias

    // SF10 gate
    let available;
    try {
        available = graft['getGraftableAugmentations']();
    } catch (_) {
        return false;
    }

    // Check if already grafting — don't interrupt active graft
    const sing = ns['singularity'];
    try {
        const busy = sing['isBusy']();
        if (busy) {
            try {
                const work = sing['getCurrentWork']();
                if (work && work.type === 'GRAFTING') {
                    ns.print('[GRAFT] Currently grafting: ' + (work.augmentation || '?') + ' — waiting');
                    return true;
                }
                // Busy with something else (crime/faction work) — yield to it
                ns.print('[GRAFT] Player busy (' + (work ? work.type : '?') + ') — waiting');
                return true;
            } catch (_) {}
        }
    } catch (_) {}

    // Build owned set
    let owned;
    try {
        owned = new Set(sing['getOwnedAugmentations'](true));
    } catch (_) {
        owned = new Set();
    }

    const player = ns.getPlayer();
    const money  = player.money;
    const budget = money * (1 - MONEY_FLOOR);
    const minCost = flags['min-cost'];

    // Filter: not owned, affordable, above min cost
    const candidates = available
        .filter(a => !owned.has(a.name) && a.cost <= budget && a.cost >= minCost)
        .sort((a, b) => a.cost - b.cost);                                           // Cheapest first — collect more augs sooner

    if (candidates.length === 0) {
        ns.print('[GRAFT] No affordable candidates (budget $' + ns.format.number(budget) + ', ' + available.length + ' total graftable)');
        return true;
    }

    const target = candidates[0];

    try {
        const ok = graft['graftAugmentation'](target.name, focus);
        if (ok) {
            ns.tprint('[GRAFT] Started grafting: ' + target.name + ' ($' + ns.format.number(target.cost) + ')');
        } else {
            ns.print('[GRAFT] Failed to start graft: ' + target.name);
        }
    } catch (e) {
        ns.print('[GRAFT] Error: ' + e);
    }

    return true;
}
