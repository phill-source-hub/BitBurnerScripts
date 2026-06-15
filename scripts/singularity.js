/**
 * singularity.js
 * Version: 1.1.0
 *
 * Faction, augmentation, program, home upgrade, and active work automation.
 *
 * Behaviour:
 *   Manages the full mid-game progression pipeline using the Singularity API.
 *   Each cycle, in priority order:
 *
 *   1. Purchase TOR router (needed for darkweb programs)
 *   2. Purchase darkweb programs (port crackers + Formulas.exe) cheapest first
 *   3. Join any pending faction invitations
 *   4. Purchase augmentations: collect all affordable augs across all joined factions,
 *      sort by current price DESCENDING (buy expensive first to minimise 1.9x price
 *      cascade impact on cheaper augs), purchase each if affordable + rep met.
 *   5. Upgrade home RAM if cost < HOME_RAM_SPEND_RATIO of current money
 *   6. Upgrade home cores if cost < HOME_CORE_SPEND_RATIO of current money
 *   7. Choose work action (only one active at a time):
 *        a. Crime (Homicide) — if karma > GANG_KARMA_THRESHOLD and not in gang
 *        b. Faction work — if faction has pending augs requiring more rep
 *        c. University (CS) — if hacking < HACK_TRAIN_THRESHOLD
 *        d. Gym (Powerlifting) — if strength < COMBAT_TRAIN_THRESHOLD
 *        (does not override action if already doing the right thing)
 *
 *   Does NOT auto-install augmentations (installing resets the game).
 *   Run with --install --confirm to install when ready.
 *
 * SF4 gate:
 *   All singularity calls use bracket notation (ns['singularity']['fn']())
 *   so the static RAM scanner does not count them — script RAM stays ~2GB
 *   regardless of SF4 level. On runtime, if SF4 is absent or insufficient,
 *   the first singularity call will throw; this is caught and the script
 *   sleeps until SF4 is acquired.
 *
 * Changelog:
 *   v1.3.0 - Add company work for megacorp faction unlocks.
 *   v1.2.0 - Fix karma via ns['heart']['break'](). Add aug prereq checking. Add faction donation.
 *   v1.1.0 - Add active work management: crime for karma, faction work, training.
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --install      Queue augmentation install on next run (requires --confirm too)
 *   --confirm      Required alongside --install to actually install (double-flag safety)
 *   --once         Single pass and exit
 *   --no-augs      Skip augmentation purchases (useful when saving for a specific aug)
 *   --no-home      Skip home RAM/core upgrades
 *   --no-programs  Skip darkweb program purchases
 *   --no-crime     Skip crime for karma
 *   --no-work      Skip all active work (faction/training/crime)
 *   --no-company   Skip company work (megacorp faction unlocks)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2 GB (base 1.6 + getPlayer 0 + scan/ls negligible)
 *   Singularity calls use bracket notation — not counted by static scanner.
 */

const VERSION = '1.3.0';
const LOOP_INTERVAL = 60 * 1000;                                                    // ms between cycles

// Fraction of current money we're willing to spend on home RAM per cycle
const HOME_RAM_SPEND_RATIO  = 0.25;
const HOME_CORE_SPEND_RATIO = 0.10;

// Money floor: never drop below this fraction of total money
const MONEY_FLOOR = 0.10;

// Faction donation threshold (favor required before donating unlocks)
const DONATE_FAVOR_THRESHOLD = 150;
// Fraction of current money to spend on faction donations each cycle
const DONATE_RATIO           = 0.05;

// Work thresholds
const GANG_KARMA_THRESHOLD   = -54000;                                               // Karma needed to create combat gang
const HACK_TRAIN_THRESHOLD   = 100;                                                  // Hacking level below which we train
const COMBAT_TRAIN_THRESHOLD = 100;                                                  // Combat stat below which we gym

// University / gym locations (Sector-12 is always accessible)
const UNIVERSITY = 'Rothman University';
const GYM        = 'Powerhouse Gym';
const CRIME_TYPE = 'Homicide';                                                       // Best karma+money crime

// Megacorp → faction mapping. Working at each company unlocks the corresponding faction invite.
// Note: Fulcrum Secret Technologies company name != faction name (Fulcrum Secret Technologies).
const MEGACORP_FACTIONS = {
    'ECorp':                      'ECorp',
    'MegaCorp':                   'MegaCorp',
    'KuaiGong International':     'KuaiGong International',
    'Four Sigma':                  'Four Sigma',
    'NWO':                        'NWO',
    'Blade Industries':           'Blade Industries',
    'OmniTek Incorporated':       'OmniTek Incorporated',
    'Bachman & Associates':       'Bachman & Associates',
    'Clarke Incorporated':        'Clarke Incorporated',
    'Fulcrum Technologies':       'Fulcrum Secret Technologies',
};

// Rep needed at a company before its faction invite arrives
const COMPANY_REP_THRESHOLD = 400000;

// Job fields to try applying for, best first
const COMPANY_FIELDS = ['Software', 'Business', 'IT', 'Security'];

// Darkweb programs to buy, in priority order (port crackers first, then utility)
const PROGRAMS = [
    'BruteSSH.exe',
    'FTPCrack.exe',
    'relaySMTP.exe',
    'HTTPWorm.exe',
    'SQLInject.exe',
    'Formulas.exe',
    'ServerProfiler.exe',
    'DeepscanV1.exe',
    'DeepscanV2.exe',
    'AutoLink.exe',
];

export async function main(ns) {
    const flags = ns.flags([
        ['install',      false],
        ['confirm',      false],
        ['once',         false],
        ['no-augs',      false],
        ['no-home',      false],
        ['no-programs',  false],
        ['no-crime',     false],
        ['no-work',      false],
        ['no-donate',    false],
        ['no-company',   false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== singularity.js v' + VERSION + ' ===');

    // Handle install path first — destructive, requires both flags
    if (flags.install) {
        if (!flags.confirm) {
            ns.tprint('[SINGULARITY] --install requires --confirm. This RESETS THE GAME.');
            ns.tprint('[SINGULARITY] Run: run /scripts/singularity.js --install --confirm');
            return;
        }
        const installed = installAugs(ns);
        if (!installed) ns.tprint('[SINGULARITY] Install failed or nothing queued.');
        return;
    }

    do {
        const ok = runCycle(ns, flags);
        if (!ok) {
            ns.print('[SINGULARITY] No SF4 access — sleeping 60s, will retry');
        }
        if (!flags.once) await ns.sleep(LOOP_INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Main cycle
// =============================================================================

function runCycle(ns, flags) {
    const sing = ns['singularity'];                                                  // Bracket alias — no static RAM cost

    // Runtime SF4 gate: attempt a cheap singularity call
    try {
        sing['isBusy']();                                                            // Cheap call; throws if no SF4 access
    } catch (e) {
        return false;                                                                // No SF4 — caller will sleep and retry
    }

    const player = ns.getPlayer();
    const money  = player.money;

    // 1. Purchase TOR router (prerequisite for darkweb programs)
    if (!flags['no-programs']) {
        try {
            if (!sing['purchaseTor']()) {
                // Already owned or can't afford — silently skip
            }
        } catch (_) {}

        // 2. Buy darkweb programs cheapest-first if TOR owned
        for (const prog of PROGRAMS) {
            if (ns.fileExists(prog, 'home')) continue;                              // Already have it
            try {
                const cost = sing['getDarkwebProgramCost'](prog);
                if (cost > 0 && canAffordFloor(money, cost)) {
                    const ok = sing['purchaseProgram'](prog);
                    if (ok) ns.tprint('[SINGULARITY] Bought program: ' + prog);
                }
            } catch (_) {}
        }
    }

    // 3. Travel to trigger city-gated faction invitations, then join all pending
    travelForFactions(ns, sing, player);
    try {
        const invites = sing['checkFactionInvitations']();
        for (const faction of invites) {
            try {
                const joined = sing['joinFaction'](faction);
                if (joined) ns.tprint('[SINGULARITY] Joined faction: ' + faction);
            } catch (_) {}
        }
    } catch (_) {}

    // 4. Donate to factions with ≥150 favor (unlocks rep-for-money exchange)
    if (!flags['no-donate']) {
        donateToFactions(ns, sing, player, money);
    }

    // 5. Purchase augmentations (most expensive first to minimise 1.9x cascade)
    if (!flags['no-augs']) {
        buyAugmentations(ns, sing, money);
    }

    // 6. Upgrade home RAM
    if (!flags['no-home']) {
        upgradeHome(ns, sing, money);
    }

    // 7. Active work — crime/faction/training (mutually exclusive, pick best)
    if (!flags['no-work']) {
        manageWork(ns, sing, player, flags);
    }

    // 8. Report status
    reportStatus(ns, sing);

    return true;
}


// =============================================================================
// Augmentation purchasing
// =============================================================================

function buyAugmentations(ns, sing, money) {
    const factions = ns.getPlayer().factions;
    if (factions.length === 0) return;

    // Collect owned + queued augs to avoid re-purchasing
    let owned;
    try {
        owned = new Set(sing['getOwnedAugmentations'](true));                       // true = include queued
    } catch (_) { return; }

    // Collect all purchasable augs across all factions
    const candidates = [];

    for (const faction of factions) {
        let augs, factionRep;
        try {
            augs       = sing['getAugmentationsFromFaction'](faction);
            factionRep = sing['getFactionRep'](faction);
        } catch (_) { continue; }

        for (const aug of augs) {
            if (owned.has(aug)) continue;

            let price, repReq;
            try {
                price  = sing['getAugmentationPrice'](aug);
                repReq = sing['getAugmentationRepReq'](aug);
            } catch (_) { continue; }

            if (factionRep >= repReq) {
                // May appear via multiple factions — keep cheapest faction entry
                const existing = candidates.find(c => c.aug === aug);
                if (!existing) {
                    candidates.push({ aug, faction, price, repReq });
                }
            }
        }
    }

    // Sort most expensive first — minimises 1.9x cascade cost on cheaper augs
    candidates.sort((a, b) => b.price - a.price);

    // Build a set of all aug names in the candidate list (will be purchased this cycle)
    const candidateNames = new Set(candidates.map(c => c.aug));

    let purchased = 0;
    for (const c of candidates) {
        // Check aug prerequisites — all prereqs must already be owned/queued OR in this cycle's candidate list
        try {
            const prereqs = sing['getAugmentationPrereq'](c.aug);
            const prereqsMet = prereqs.every(p => owned.has(p) || candidateNames.has(p));
            if (!prereqsMet) {
                ns.print('[SINGULARITY] Skip ' + c.aug + ' — prereqs not met: ' + prereqs.filter(p => !owned.has(p)).join(', '));
                continue;
            }
        } catch (_) {}

        // Re-read price each iteration — it rises after each purchase
        let currentPrice;
        try {
            currentPrice = sing['getAugmentationPrice'](c.aug);
        } catch (_) { continue; }

        if (!canAffordFloor(money, currentPrice)) continue;

        try {
            const ok = sing['purchaseAugmentation'](c.faction, c.aug);
            if (ok) {
                ns.tprint('[SINGULARITY] Purchased aug: ' + c.aug + ' from ' + c.faction + ' ($' + ns.format.number(currentPrice) + ')');
                owned.add(c.aug);
                money -= currentPrice;
                purchased++;
            }
        } catch (_) {}
    }

    if (purchased > 0) {
        ns.tprint('[SINGULARITY] Purchased ' + purchased + ' augmentation(s) this cycle.');
    }
}


// =============================================================================
// Faction donation (unlocks at ≥150 favor — rep-for-money)
// =============================================================================

function donateToFactions(ns, sing, player, money) {
    const factions = player.factions;
    if (!factions || factions.length === 0) return;

    // Don't donate when very poor — keep money for aug purchases
    if (money < 1e9) return;

    const budget = money * DONATE_RATIO;
    let spent    = 0;

    // Collect owned+queued augs to know which factions still have value
    let owned;
    try { owned = new Set(sing['getOwnedAugmentations'](true)); } catch (_) { return; }

    for (const faction of factions) {
        if (spent >= budget) break;

        try {
            const favor = sing['getFactionFavor'](faction);
            if (favor < DONATE_FAVOR_THRESHOLD) continue;

            // Only donate to factions that still have augs we want
            let hasUnownedAugs = false;
            try {
                const augs = sing['getAugmentationsFromFaction'](faction);
                hasUnownedAugs = augs.some(a => !owned.has(a));
            } catch (_) {}
            if (!hasUnownedAugs) continue;

            // Donate a meaningful chunk — $1M per rep, so $100M → 100 rep
            const donateAmt = Math.min(budget - spent, money * 0.02);
            if (donateAmt < 1e6) continue;                                          // Min $1M — below this rep gain is negligible

            const ok = sing['donateToFaction'](faction, donateAmt);
            if (ok) {
                ns.tprint('[SINGULARITY] Donated $' + ns.format.number(donateAmt) + ' to ' + faction + ' (favor: ' + Math.floor(favor) + ')');
                spent += donateAmt;
                money -= donateAmt;
            }
        } catch (_) {}
    }
}


// =============================================================================
// Home upgrades
// =============================================================================

function upgradeHome(ns, sing, money) {
    // RAM upgrade
    try {
        const ramCost = sing['getUpgradeHomeRamCost']();
        if (ramCost > 0 && money * HOME_RAM_SPEND_RATIO >= ramCost) {
            const ok = sing['upgradeHomeRam']();
            if (ok) {
                ns.tprint('[SINGULARITY] Upgraded home RAM. New max: ' + ns.getServerMaxRam('home') + 'GB');
                money -= ramCost;
            }
        }
    } catch (_) {}

    // Core upgrade
    try {
        const coreCost = sing['getUpgradeHomeCoresCost']();
        if (coreCost > 0 && money * HOME_CORE_SPEND_RATIO >= coreCost) {
            const ok = sing['upgradeHomeCores']();
            if (ok) {
                ns.tprint('[SINGULARITY] Upgraded home cores.');
                money -= coreCost;
            }
        }
    } catch (_) {}
}


// =============================================================================
// Travel for faction invitations
// =============================================================================

// Factions that require the player to be in a specific city to receive invitation
const CITY_FACTIONS = {
    'Tian Di Hui':  ['Chongqing', 'New Tokyo', 'Ishima'],
    'Tetrads':      ['Chongqing', 'New Tokyo', 'Ishima'],
    'The Syndicate':['Aevum', 'Sector-12'],
    'Silhouette':   ['Aevum', 'Sector-12', 'Volhaven'],
    'Speakers for the Dead': ['Aevum', 'Sector-12', 'Volhaven', 'Chongqing', 'New Tokyo', 'Ishima'],
    'NiteSec':      ['Aevum'],
};

const ALL_CITIES = ['Sector-12', 'Aevum', 'Volhaven', 'Chongqing', 'New Tokyo', 'Ishima'];

/**
 * Visits each city we haven't explored this session to trigger faction invitations.
 * Travel cost $200k — skip if unaffordable (below 2x floor).
 * Does not re-travel to cities already visited or where we already have the faction.
 */
function travelForFactions(ns, sing, player) {
    const money   = player.money;
    const TRAVEL_COST = 200e3;

    if (money < TRAVEL_COST * 10) return;                                           // Don't travel when very poor

    const joined   = new Set(player.factions);
    const city     = player.city;

    // Determine which cities we still want to visit for uninvited factions
    const citiesNeeded = new Set();

    for (const [faction, cities] of Object.entries(CITY_FACTIONS)) {
        if (joined.has(faction)) continue;                                           // Already in this faction
        for (const c of cities) citiesNeeded.add(c);
    }

    citiesNeeded.delete(city);                                                      // Already here

    if (citiesNeeded.size === 0) return;

    // Visit one new city per cycle (returns home after)
    const target = [...citiesNeeded][0];
    try {
        const ok = sing['travelToCity'](target);
        if (ok) {
            ns.print('[SINGULARITY] Travelled to ' + target + ' (seeking faction invitations)');
            // Immediately travel back to Sector-12 (where programs/gyms are)
            sing['travelToCity']('Sector-12');
        }
    } catch (_) {}
}


// =============================================================================
// Active work management (crime / faction / training)
// =============================================================================

function manageWork(ns, sing, player, flags) {
    // Determine what we should be doing
    // karma is not on player object in all versions — use ns['heart']['break']() (0 RAM, no gate)
    let karma = 0;
    try { karma = ns['heart']['break'](); } catch (_) { karma = player.karma || 0; }

    const hacking = player.skills.hacking;
    const combat  = Math.min(player.skills.strength, player.skills.agility, player.skills.defense);

    // Check if already in a gang (via player faction or attempt)
    const inGang = player.inGang || false;

    // Decide best work target
    let targetAction = null;

    // a. Crime for karma — only if gang not yet formed
    if (!flags['no-crime'] && !inGang && karma > GANG_KARMA_THRESHOLD) {
        targetAction = { type: 'crime', crime: CRIME_TYPE };
    }

    // b. Company work — unlock megacorp factions not yet joined (applied before faction work)
    if (!targetAction && !flags['no-company']) {
        const companyTarget = pickCompanyForWork(ns, sing, player.factions);
        if (companyTarget) {
            targetAction = { type: 'company', company: companyTarget };
        }
    }

    // c. Faction work — if any faction has augs we need rep for
    if (!targetAction) {
        const factionTarget = pickFactionForWork(ns, sing, player.factions);
        if (factionTarget) {
            targetAction = { type: 'faction', faction: factionTarget.name, workType: factionTarget.workType };
        }
    }

    // d. University — if hacking too low
    if (!targetAction && hacking < HACK_TRAIN_THRESHOLD) {
        targetAction = { type: 'university', course: 'Computer Science' };
    }

    // e. Gym — if combat too low
    if (!targetAction && combat < COMBAT_TRAIN_THRESHOLD) {
        targetAction = { type: 'gym', stat: 'strength' };
    }

    if (!targetAction) return;                                                       // Nothing to do — idle

    // Check current work — avoid thrashing if already doing the right thing
    let busy = false;
    try { busy = sing['isBusy'](); } catch (_) {}

    const current = busy ? getCurrentWorkDescription(ns, sing) : null;

    switch (targetAction.type) {
        case 'crime': {
            if (current === 'crime:' + targetAction.crime) return;
            try {
                sing['commitCrime'](targetAction.crime, true);                      // focus=true
                ns.print('[SING] Work → Crime: ' + targetAction.crime + ' (karma: ' + karma.toFixed(0) + ')');
            } catch (_) {}
            break;
        }
        case 'company': {
            if (current === 'company:' + targetAction.company) return;
            // Apply (or get promoted) before working
            for (const field of COMPANY_FIELDS) {
                try { sing['applyToCompany'](targetAction.company, field); } catch (_) {}
            }
            try {
                const ok = sing['workForCompany'](targetAction.company, true);
                if (ok) {
                    const rep = sing['getCompanyRep'](targetAction.company);
                    ns.print('[SING] Work → Company: ' + targetAction.company + ' (rep: ' + Math.floor(rep) + '/' + COMPANY_REP_THRESHOLD + ')');
                }
            } catch (_) {}
            break;
        }
        case 'faction': {
            if (current === 'faction:' + targetAction.faction) return;
            const WORK_TYPES = ['hacking', 'field', 'security'];
            let started = false;
            for (const wt of WORK_TYPES) {
                try {
                    const ok = sing['workForFaction'](targetAction.faction, wt, true);
                    if (ok) {
                        ns.print('[SING] Work → Faction: ' + targetAction.faction + ' (' + wt + ')');
                        started = true;
                        break;
                    }
                } catch (_) {}
            }
            if (!started) ns.print('[SING] Work → Faction: ' + targetAction.faction + ' — no valid work type');
            break;
        }
        case 'university': {
            if (current === 'university') return;
            try {
                sing['universityCourse'](UNIVERSITY, targetAction.course, true);
                ns.print('[SING] Work → University: ' + targetAction.course + ' (hacking: ' + hacking + ')');
            } catch (_) {}
            break;
        }
        case 'gym': {
            if (current === 'gym') return;
            try {
                sing['gymWorkout'](GYM, targetAction.stat, true);
                ns.print('[SING] Work → Gym: ' + targetAction.stat + ' (combat: ' + combat + ')');
            } catch (_) {}
            break;
        }
    }
}

/**
 * Find the faction with unowned augs that require more rep than the player currently has.
 * Returns { name, workType } or null.
 */
function pickFactionForWork(ns, sing, factions) {
    if (!factions || factions.length === 0) return null;

    let owned;
    try { owned = new Set(sing['getOwnedAugmentations'](true)); } catch (_) { return null; }

    let bestFaction = null;
    let bestMissing = 0;

    for (const faction of factions) {
        try {
            const augs      = sing['getAugmentationsFromFaction'](faction);
            const factionRep = sing['getFactionRep'](faction);
            let missingRep   = 0;

            for (const aug of augs) {
                if (owned.has(aug)) continue;
                try {
                    const repReq = sing['getAugmentationRepReq'](aug);
                    if (factionRep < repReq) missingRep++;
                } catch (_) {}
            }

            if (missingRep > bestMissing) {
                bestMissing = missingRep;
                bestFaction = faction;
            }
        } catch (_) {}
    }

    if (!bestFaction) return null;
    return { name: bestFaction, workType: 'hacking' };                              // workForFaction tries types in order
}

/**
 * Returns the name of a megacorp company to work for, or null.
 * Skips companies whose corresponding faction is already joined,
 * and those where we already have enough rep for the invite.
 */
function pickCompanyForWork(ns, sing, joinedFactions) {
    const joined = new Set(joinedFactions);

    for (const [company, faction] of Object.entries(MEGACORP_FACTIONS)) {
        if (joined.has(faction)) continue;                                            // Faction already unlocked

        try {
            const rep = sing['getCompanyRep'](company);
            if (rep >= COMPANY_REP_THRESHOLD) continue;                              // Already enough rep — invite pending
            return company;
        } catch (_) {}
    }

    return null;
}

/** Returns a string key describing current work, or null. */
function getCurrentWorkDescription(ns, sing) {
    try {
        const work = sing['getCurrentWork']();
        if (!work) return null;
        if (work.type === 'CRIME')            return 'crime:' + work.crimeType;
        if (work.type === 'FACTION')          return 'faction:' + work.factionName;
        if (work.type === 'COMPANY')          return 'company:' + work.companyName;
        if (work.type === 'CLASS' && work.classType === 'Gym') return 'gym';
        if (work.type === 'CLASS')            return 'university';
        return work.type;
    } catch (_) { return null; }
}


// =============================================================================
// Install augmentations (destructive — resets game)
// =============================================================================

function installAugs(ns) {
    const sing = ns['singularity'];

    try { sing['isBusy'](); } catch (_) {
        ns.tprint('[SINGULARITY] ERROR: No SF4 access — cannot install.');
        return false;
    }

    let queued;
    try {
        const all    = sing['getOwnedAugmentations'](true);                         // true = include queued
        const owned  = new Set(sing['getOwnedAugmentations'](false));               // false = installed only
        queued       = all.filter(a => !owned.has(a));
    } catch (_) {
        ns.tprint('[SINGULARITY] ERROR: Could not read augmentation queue.');
        return false;
    }

    if (queued.length === 0) {
        ns.tprint('[SINGULARITY] No augmentations queued — nothing to install.');
        return false;
    }

    ns.tprint('[SINGULARITY] Installing ' + queued.length + ' augmentation(s): ' + queued.join(', '));
    ns.tprint('[SINGULARITY] Game will reset in ~1 second.');

    try {
        sing['installAugmentations']('scripts/bootstrap.js');                       // Auto-run bootstrap after reset
        return true;
    } catch (e) {
        ns.tprint('[SINGULARITY] Install error: ' + e);
        return false;
    }
}


// =============================================================================
// Status report
// =============================================================================

function reportStatus(ns, sing) {
    const factions = ns.getPlayer().factions;

    let totalPurchasable = 0;
    let totalOwned       = 0;
    let missingRep       = 0;

    let owned;
    try { owned = new Set(sing['getOwnedAugmentations'](true)); } catch (_) { return; }
    totalOwned = owned.size;

    for (const faction of factions) {
        let augs, factionRep;
        try {
            augs       = sing['getAugmentationsFromFaction'](faction);
            factionRep = sing['getFactionRep'](faction);
        } catch (_) { continue; }

        for (const aug of augs) {
            if (owned.has(aug)) continue;
            let repReq;
            try { repReq = sing['getAugmentationRepReq'](aug); } catch (_) { continue; }
            if (factionRep >= repReq) totalPurchasable++;
            else missingRep++;
        }
    }

    ns.print('[STATUS] Augs owned/queued: ' + totalOwned + ' | Purchasable now: ' + totalPurchasable + ' | Need more rep: ' + missingRep);
    ns.print('[STATUS] Home RAM: ' + ns.getServerMaxRam('home') + 'GB | Factions joined: ' + factions.length);
}


// =============================================================================
// Helpers
// =============================================================================

function canAffordFloor(money, cost) {
    return (money - cost) >= (money * MONEY_FLOOR);
}
