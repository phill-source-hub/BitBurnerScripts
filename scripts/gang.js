/**
 * gang.js
 * Version: 1.0.0
 *
 * Gang automation for PhlanxOS BitBurner automation suite.
 *
 * Behaviour:
 *   Manages gang members, tasks, equipment, ascension, and territory.
 *   Works for both hacking and combat gang types — task selection is
 *   dynamic based on what ns.gang.getTaskStats() reports for money/wanted.
 *
 *   Each cycle, in order:
 *   1. Recruit new members when available
 *   2. Assign tasks:
 *        Compute wantedPenalty = respect / (respect + wantedLevel)
 *        If penalty < WANTED_THRESHOLD: assign VIGILANTE_RATIO members to
 *          the best wanted-reduction task.
 *        All other members: best money-generating task.
 *   3. Ascend members where next multiplier gain is significant
 *   4. Buy equipment for each member, cheapest first, if affordable
 *   5. Territory warfare: enable when our power exceeds all enemies by
 *      WARFARE_POWER_MARGIN; disable when any enemy is within margin
 *
 * Gate:
 *   Requires BN2 or SF2. All gang API calls use bracket notation
 *   (ns['gang']['fn']()) so static RAM scanner does not count them —
 *   script costs ~2GB regardless. On startup, attempts ns.gang.inGang()
 *   via bracket notation; if that throws (no gang access), sleeps and retries.
 *   If it returns false and gang creation is possible, creates the gang.
 *
 * Wanted level mechanic:
 *   wantedPenalty = respect / (respect + wantedLevel)
 *   Income and respect are multiplied by this. At 50/50 respect/wanted,
 *   you earn half income. Vigilante Justice and Ethical Hacking reduce wanted.
 *
 * Ascension strategy:
 *   Ascend when max stat ascension multiplier would increase by > ASCEND_THRESHOLD.
 *   Uses getAscensionResult() to preview before committing.
 *
 * Equipment strategy:
 *   Buy all equipment/augmentations for each member in ascending cost order.
 *   Keeps MONEY_FLOOR of total money as reserve.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Cycle interval in seconds (default: 20)
 *   --once         Single cycle and exit
 *   --no-warfare   Never enable territory warfare
 *   --no-ascend    Never ascend members automatically
 *   --no-equip     Never buy equipment
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2 GB (base 1.6; all gang calls via bracket notation)
 */

const VERSION = '1.0.0';

// Wanted penalty threshold below which we prioritise wanted reduction
const WANTED_THRESHOLD     = 0.90;                                                  // Below 90% income = act on wanted

// Fraction of members assigned to wanted reduction when penalty is low
const VIGILANTE_RATIO      = 0.25;                                                  // 25% of members on vigilante duty

// Ascend when best stat multiplier would improve by at least this factor
const ASCEND_THRESHOLD     = 0.20;                                                  // 20% better multiplier

// Territory warfare: only enable when we outpower nearest enemy by this margin
const WARFARE_POWER_MARGIN = 2.0;                                                   // 2× our power vs theirs

// Money floor: keep this fraction of cash free during equipment purchases
const MONEY_FLOOR          = 0.10;

export async function main(ns) {
    const flags = ns.flags([
        ['interval',    20],
        ['once',        false],
        ['no-warfare',  false],
        ['no-ascend',   false],
        ['no-equip',    false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== gang.js v' + VERSION + ' | interval=' + flags.interval + 's ===');

    const INTERVAL = flags.interval * 1000;

    do {
        const ok = runCycle(ns, flags);
        if (!ok) {
            ns.print('[GANG] No gang access (BN2/SF2 required) — sleeping ' + flags.interval + 's, will retry');
        }
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Main cycle
// =============================================================================

function runCycle(ns, flags) {
    const gang = ns['gang'];                                                        // Bracket alias — no static RAM cost

    // Runtime gate: check gang access
    let inGang;
    try {
        inGang = gang['inGang']();
    } catch (_) {
        return false;                                                               // No gang API access (no BN2/SF2)
    }

    // Attempt to create a gang if not already in one
    if (!inGang) {
        tryCreateGang(ns, gang);
        // Re-check after creation attempt
        try { inGang = gang['inGang'](); } catch (_) { return false; }
        if (!inGang) {
            ns.print('[GANG] Not in a gang and could not create one. Ensure karma < -54000 for combat gang or meet hacking requirements.');
            return true;                                                            // Access is available, just not ready yet
        }
    }

    const info     = gang['getGangInformation']();
    const members  = gang['getMemberNames']();

    // Cache task stats on first call
    const taskNames = gang['getTaskNames']();
    const taskStats = {};
    for (const t of taskNames) {
        taskStats[t] = gang['getTaskStats'](t);
    }

    // Determine best money task and best wanted-reduction task
    const moneyTask    = getBestMoneyTask(taskStats);
    const vigilanteTask = getBestVigilanteTask(taskStats);

    const wantedPenalty = info.respect / (info.respect + info.wantedLevel);
    const penaltyLow    = wantedPenalty < WANTED_THRESHOLD && info.wantedLevel > 1;

    // 1. Recruit
    while (gang['canRecruitMember']()) {
        const name = generateMemberName(ns, members.length);
        const ok   = gang['recruitMember'](name);
        if (ok) {
            members.push(name);
            ns.tprint('[GANG] Recruited: ' + name);
        } else { break; }
    }

    // 2. Assign tasks
    if (members.length > 0) {
        const vigilanteCount = penaltyLow
            ? Math.max(1, Math.floor(members.length * VIGILANTE_RATIO))
            : 0;

        for (let i = 0; i < members.length; i++) {
            const task = (i < vigilanteCount && vigilanteTask) ? vigilanteTask : moneyTask;
            if (task) gang['setMemberTask'](members[i], task);
        }

        if (penaltyLow) {
            ns.print('[GANG] Wanted penalty: ' + (wantedPenalty * 100).toFixed(1) + '% — ' + vigilanteCount + ' member(s) on ' + vigilanteTask);
        }
    }

    // 3. Ascend members
    if (!flags['no-ascend']) {
        for (const name of members) {
            tryAscend(ns, gang, name);
        }
    }

    // 4. Buy equipment
    if (!flags['no-equip']) {
        buyEquipment(ns, gang, members);
    }

    // 5. Territory warfare
    if (!flags['no-warfare']) {
        manageWarfare(ns, gang, info);
    }

    // Status log
    const penalty = (wantedPenalty * 100).toFixed(1);
    ns.print('[GANG] Members: ' + members.length + ' | Respect: ' + ns.format.number(info.respect) + ' | Wanted: ' + info.wantedLevel.toFixed(1) + ' | Penalty: ' + penalty + '% | Territory: ' + (info.territory * 100).toFixed(1) + '%');

    return true;
}


// =============================================================================
// Gang creation
// =============================================================================

function tryCreateGang(ns, gang) {
    // Faction name varies — attempt common ones
    // Combat gangs: Slum Snakes, Tetrads, The Syndicate, Speakers for the Dead, The Dark Army, NiteSec
    // Hacking gangs: NiteSec, The Black Hand
    const factions = ns.getPlayer().factions;

    const gangFactions = [
        'Slum Snakes',
        'Tetrads',
        'The Syndicate',
        'Speakers for the Dead',
        'The Dark Army',
        'NiteSec',
        'The Black Hand',
    ];

    for (const faction of gangFactions) {
        if (!factions.includes(faction)) continue;
        try {
            const ok = gang['createGang'](faction);
            if (ok) {
                ns.tprint('[GANG] Created gang in: ' + faction);
                return;
            }
        } catch (_) {}
    }
}


// =============================================================================
// Task selection
// =============================================================================

function getBestMoneyTask(taskStats) {
    let best = null, bestMoney = -Infinity;
    for (const [name, stats] of Object.entries(taskStats)) {
        // Skip idle, territory warfare, and wanted-reduction tasks for money selection
        if (stats.baseMoney > bestMoney && stats.baseWanted >= 0) {
            bestMoney = stats.baseMoney;
            best = name;
        }
    }
    return best;
}

function getBestVigilanteTask(taskStats) {
    let best = null, bestReduction = Infinity;
    for (const [name, stats] of Object.entries(taskStats)) {
        if (stats.baseWanted < bestReduction) {
            bestReduction = stats.baseWanted;
            best = name;
        }
    }
    return bestReduction < 0 ? best : null;                                        // Only return if it actually reduces wanted
}


// =============================================================================
// Ascension
// =============================================================================

function tryAscend(ns, gang, name) {
    let result;
    try { result = gang['getAscensionResult'](name); } catch (_) { return; }
    if (!result) return;                                                            // Not enough exp to ascend

    // result contains multiplier improvements per stat. Check if any is significant.
    const stats    = ['hack', 'str', 'def', 'dex', 'agi', 'cha'];
    const maxGain  = Math.max(...stats.map(s => result[s] || 1));

    if (maxGain - 1 >= ASCEND_THRESHOLD) {
        try {
            const asc = gang['ascendMember'](name);
            if (asc) {
                ns.tprint('[GANG] Ascended: ' + name + ' | max mult gain: +' + ((maxGain - 1) * 100).toFixed(1) + '%');
            }
        } catch (_) {}
    }
}


// =============================================================================
// Equipment purchasing
// =============================================================================

function buyEquipment(ns, gang, members) {
    const equipNames = gang['getEquipmentNames']();
    const money      = ns.getPlayer().money;
    const budget     = money * (1 - MONEY_FLOOR);

    // Sort equipment cheapest first — maximise items bought per cycle
    const equip = equipNames
        .map(n => ({ name: n, cost: gang['getEquipmentCost'](n) }))
        .sort((a, b) => a.cost - b.cost);

    let spent = 0;

    for (const member of members) {
        let memberInfo;
        try { memberInfo = gang['getMemberInformation'](member); } catch (_) { continue; }

        const owned = new Set([
            ...memberInfo.upgrades,
            ...memberInfo.augmentations,
        ]);

        for (const e of equip) {
            if (owned.has(e.name)) continue;
            if (spent + e.cost > budget) continue;

            try {
                const ok = gang['purchaseEquipment'](member, e.name);
                if (ok) {
                    spent += e.cost;
                    owned.add(e.name);
                }
            } catch (_) {}
        }
    }

    if (spent > 0) {
        ns.print('[GANG] Equipment: spent $' + ns.format.number(spent) + ' this cycle');
    }
}


// =============================================================================
// Territory warfare
// =============================================================================

function manageWarfare(ns, gang, info) {
    const gang_ = ns['gang'];
    let allGangs;
    try { allGangs = gang_['getAllGangInformation'](); } catch (_) { return; }

    const ourPower   = info.power;
    const ourName    = info.faction;

    // Find the most powerful enemy
    let maxEnemyPower = 0;
    for (const [name, data] of Object.entries(allGangs)) {
        if (name === ourName) continue;
        if (data.power > maxEnemyPower) maxEnemyPower = data.power;
    }

    const shouldFight = maxEnemyPower > 0 && (ourPower / maxEnemyPower) >= WARFARE_POWER_MARGIN;

    try {
        gang_['setTerritoryWarfare'](shouldFight);
        if (shouldFight) {
            ns.print('[GANG] Territory warfare ENABLED | our power: ' + ns.format.number(ourPower) + ' | max enemy: ' + ns.format.number(maxEnemyPower));
        }
    } catch (_) {}
}


// =============================================================================
// Utilities
// =============================================================================

const MEMBER_NAMES = [
    'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo',
    'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet',
    'Kilo', 'Lima', 'Mike', 'November', 'Oscar',
    'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango',
    'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu',
];

function generateMemberName(ns, index) {
    return index < MEMBER_NAMES.length
        ? MEMBER_NAMES[index]
        : 'Member-' + index;
}
