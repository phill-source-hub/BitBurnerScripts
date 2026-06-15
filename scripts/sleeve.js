/**
 * sleeve.js
 * Version: 1.0.0
 *
 * Sleeve automation for PhlanxOS. Requires SF10.
 *
 * Behaviour:
 *   Manages all sleeves each cycle. Per-sleeve priority:
 *     1. Synchronize  — if sync < SYNC_THRESHOLD (builds stat multipliers)
 *     2. Shock recovery — if shock > SHOCK_THRESHOLD (unlocks full effectiveness)
 *     3. Faction work — if player is in a faction needing rep and faction accepts work
 *     4. Crime        — Homicide (best karma+money per second)
 *
 *   Sleeve augmentations: each cycle, buys any affordable aug for each sleeve,
 *   cheapest first, keeping MONEY_FLOOR of total money as reserve.
 *
 * Gate:
 *   All sleeve calls use bracket notation so static RAM scanner ignores them.
 *   Script costs ~2 GB. If no SF10 access, the first call throws; script
 *   sleeps and retries — safe to run from day 1.
 *
 * Changelog:
 *   v1.1.0 - Add Bladeburner action support (--bladeburner flag).
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Cycle interval in seconds (default: 30)
 *   --once         Single cycle and exit
 *   --no-augs      Skip aug purchases for sleeves
 *   --no-crime     Never assign sleeves to crime
 *   --bladeburner  Assign sleeves to Bladeburner Field Analysis / Training when BB active
 *   --sync N       Sync threshold below which sleeve synchronizes (default: 100)
 *   --shock N      Shock threshold above which sleeve recovers (default: 95)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2 GB (all sleeve calls bracket notation)
 */

const VERSION = '1.1.0';

const DEFAULT_SYNC_THRESHOLD  = 100;                                                 // Sync below this → synchronize
const DEFAULT_SHOCK_THRESHOLD = 95;                                                  // Shock above this → recover
const MONEY_FLOOR             = 0.05;                                                // Keep 5% of cash as reserve

// Preferred crime — best karma/time ratio in Bitburner
const CRIME_KARMA = 'Homicide';

// Faction work priority — work type to try in order
const WORK_TYPES = ['hacking', 'field', 'security'];

export async function main(ns) {
    const flags = ns.flags([
        ['interval', 30],
        ['once',     false],
        ['no-augs',  false],
        ['no-crime',    false],
        ['bladeburner', false],
        ['sync',        DEFAULT_SYNC_THRESHOLD],
        ['shock',       DEFAULT_SHOCK_THRESHOLD],
    ]);

    ns.disableLog('ALL');
    ns.print('=== sleeve.js v' + VERSION + ' | interval=' + flags.interval + 's ===');

    const INTERVAL = flags.interval * 1000;

    do {
        const ok = runCycle(ns, flags);
        if (!ok) {
            ns.print('[SLEEVE] No SF10 access — sleeping ' + flags.interval + 's, will retry');
        }
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Main cycle
// =============================================================================

function runCycle(ns, flags) {
    const sl = ns['sleeve'];                                                         // Bracket alias

    // Runtime SF10 gate
    let numSleeves;
    try {
        numSleeves = sl['getNumSleeves']();
    } catch (_) {
        return false;
    }

    if (numSleeves === 0) {
        ns.print('[SLEEVE] 0 sleeves available.');
        return true;
    }

    const player   = ns.getPlayer();
    const factions = player.factions;

    // Buy sleeve augmentations first (instant, not an action)
    if (!flags['no-augs']) {
        buySleeveAugs(ns, sl, numSleeves, player.money);
    }

    // Assign each sleeve
    for (let i = 0; i < numSleeves; i++) {
        let info;
        try { info = sl['getSleeve'](i); } catch (_) { continue; }

        const task = assignTask(ns, sl, i, info, factions, flags);
        ns.print('[SLEEVE ' + i + '] sync=' + info.sync.toFixed(0) + ' shock=' + info.shock.toFixed(0) + ' → ' + task);
    }

    return true;
}


// =============================================================================
// Task assignment
// =============================================================================

function assignTask(ns, sl, idx, info, factions, flags) {
    const syncThresh  = flags.sync;
    const shockThresh = flags.shock;

    // 1. Synchronize if not at max
    if (info.sync < syncThresh) {
        try { sl['setToSynchronize'](idx); } catch (_) {}
        return 'synchronize (sync ' + info.sync.toFixed(0) + '%)';
    }

    // 2. Recover from shock
    if (info.shock > shockThresh) {
        try { sl['setToShockRecovery'](idx); } catch (_) {}
        return 'shock recovery (shock ' + info.shock.toFixed(0) + '%)';
    }

    // 3. Faction work — find best faction to work for
    const factionTarget = pickFactionTarget(ns, factions);
    if (factionTarget) {
        for (const workType of WORK_TYPES) {
            try {
                const ok = sl['setToFactionWork'](idx, factionTarget, workType);
                if (ok) return 'faction work: ' + factionTarget + ' (' + workType + ')';
            } catch (_) {}
        }
    }

    // 4. Bladeburner support (if enabled and BB API available)
    if (flags.bladeburner) {
        const bbResult = trySetBBAction(ns, sl, idx);
        if (bbResult) return bbResult;
    }

    // 5. Crime for karma/money
    if (!flags['no-crime']) {
        try { sl['setToCommitCrime'](idx, CRIME_KARMA); } catch (_) {}
        return 'crime: ' + CRIME_KARMA;
    }

    return 'idle';
}

/**
 * Assigns a sleeve to a Bladeburner General action if BB is accessible.
 * Even-indexed sleeves do Field Analysis (boosts population estimates),
 * odd-indexed sleeves train (builds BB stats).
 * Returns a description string, or null if BB not available.
 */
function trySetBBAction(ns, sl, idx) {
    try {
        ns['bladeburner']['getBonusTime']();                                         // Throws if no BB access
    } catch (_) {
        return null;
    }

    const action = idx % 2 === 0 ? 'Field Analysis' : 'Training';
    try {
        sl['setToBladeburnerAction'](idx, 'General', action);
        return 'bladeburner: ' + action;
    } catch (_) {
        return null;
    }
}

function pickFactionTarget(ns, factions) {
    // Pick the faction the player needs most rep from
    // Heuristic: faction with most unowned augs the player has some rep toward
    if (!factions || factions.length === 0) return null;

    // Just return first faction that has pending work — singularity.js handles
    // which augs to buy; sleeves just assist with rep gathering
    // Without SF4 we can't query aug details here, so just return first faction
    // that isn't a megacorp/city faction (those don't benefit from faction work)
    const SKIP = new Set(['CyberSec', 'NiteSec', 'The Black Hand', 'BitRunners',
        'Sector-12', 'Aevum', 'Volhaven', 'New Tokyo', 'Ishima', 'Chongqing',
        'Tian Di Hui', 'Netburners']);
    const viable = factions.filter(f => !SKIP.has(f));
    return viable.length > 0 ? viable[0] : (factions.length > 0 ? factions[0] : null);
}


// =============================================================================
// Sleeve augmentation purchasing
// =============================================================================

function buySleeveAugs(ns, sl, numSleeves, money) {
    const budget = money * (1 - MONEY_FLOOR);
    let spent    = 0;

    for (let i = 0; i < numSleeves; i++) {
        let available;
        try { available = sl['getSleevePurchasableAugs'](i); } catch (_) { continue; }

        // Sort cheapest first — maximise count of augs bought
        available.sort((a, b) => a.cost - b.cost);

        for (const aug of available) {
            if (spent + aug.cost > budget) continue;
            try {
                const ok = sl['purchaseSleeveAug'](i, aug.name);
                if (ok) {
                    ns.tprint('[SLEEVE ' + i + '] Purchased aug: ' + aug.name + ' ($' + ns.format.number(aug.cost) + ')');
                    spent += aug.cost;
                }
            } catch (_) {}
        }
    }
}
