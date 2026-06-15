/**
 * bladeburner.js
 * Version: 1.0.0
 *
 * Bladeburner automation for PhlanxOS. Requires SF6.
 *
 * Behaviour:
 *   Manages Bladeburner division actions, skill upgrades, and city selection.
 *   Each cycle, in order:
 *
 *   1. Join Bladeburner division if not already in it
 *   2. Upgrade skills if affordable (priority order below)
 *   3. Select best city — highest estimated population (more contracts available)
 *   4. Select best action:
 *        a. If stamina < STAMINA_THRESHOLD: Hyperbolic Regeneration Chamber
 *        b. If Black Op is available and success chance is good: attempt it
 *        c. Best Operation with success chance >= MIN_CHANCE, if available
 *        d. Best Contract with success chance >= MIN_CHANCE
 *        e. Field Analysis (maintains population accuracy, improves future chances)
 *
 *   Action selection picks highest rank-gain action above MIN_CHANCE threshold.
 *   Chaos management: if city chaos > CHAOS_THRESHOLD, assigns one cycle to Diplomacy.
 *
 * Skill upgrade priority:
 *   Blade's Intuition > Overclock > Reaper > Evasive System > Cyber's Edge >
 *   Digital Observer > Hyperdrive > Hands of Midas > Tracer > Cloak
 *
 * Gate:
 *   All bladeburner calls use bracket notation (ns['bladeburner']['fn']()).
 *   Script costs ~2 GB. On no-SF6 runtime, the first call throws — script
 *   sleeps and retries. Safe to run from day 1.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N      Cycle interval in seconds (default: 5)
 *   --once            Single cycle and exit
 *   --min-chance N    Minimum success chance 0–1 before doing lower-tier actions (default: 0.50)
 *   --no-blackops     Skip Black Ops (use when want to maintain rank without progressing)
 *   --no-city-switch  Disable automatic city switching
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2 GB (all bladeburner calls bracket notation)
 */

const VERSION = '1.0.0';

const STAMINA_THRESHOLD = 0.50;                                                      // Regen when stamina < 50%
const CHAOS_THRESHOLD   = 50;                                                        // Diplomacy when chaos > 50
const DEFAULT_MIN_CHANCE = 0.50;

// Skill upgrade priority (index 0 = highest priority)
const SKILL_PRIORITY = [
    "Blade's Intuition",
    'Overclock',
    'Reaper',
    'Evasive System',
    "Cyber's Edge",
    'Digital Observer',
    'Hyperdrive',
    'Hands of Midas',
    'Tracer',
    'Cloak',
    'Short-Circuit',
    'Datamancer',
];

const CITIES = ['Sector-12', 'Aevum', 'Volhaven', 'Chongqing', 'New Tokyo', 'Ishima'];

// Black Ops in order of rank requirement (ascending)
const BLACK_OPS_ORDER = [
    'Operation Typhoon',
    'Operation Zero',
    'Operation X',
    'Operation Titan',
    'Operation Ares',
    'Operation Archangel',
    'Operation Juggernaut',
    'Operation Red Dragon',
    'Operation K',
    'Operation Deckard',
    'Operation Tyrell',
    'Operation Wallace',
    'Operation Shoulder of Orion',
    'Operation Hyron',
    'Operation Morpheus',
    'Operation Ion Storm',
    'Operation Annihilus',
    'Operation Ultron',
    'Operation Centurion',
    'Operation Vindictus',
    'Operation Daedalus',
];

export async function main(ns) {
    const flags = ns.flags([
        ['interval',       5],
        ['once',           false],
        ['min-chance',     DEFAULT_MIN_CHANCE],
        ['no-blackops',    false],
        ['no-city-switch', false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== bladeburner.js v' + VERSION + ' | interval=' + flags.interval + 's ===');

    const INTERVAL = flags.interval * 1000;

    do {
        const ok = runCycle(ns, flags);
        if (!ok) {
            ns.print('[BB] No SF6 access — sleeping ' + flags.interval + 's, will retry');
        }
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Main cycle
// =============================================================================

function runCycle(ns, flags) {
    const bb = ns['bladeburner'];                                                    // Bracket alias

    // Runtime SF6 gate
    let inBB;
    try {
        inBB = bb['inBladeburner']();
    } catch (_) {
        return false;
    }

    // Join if not in BB
    if (!inBB) {
        try {
            const ok = bb['joinBladeburnerDivision']();
            if (ok) {
                ns.tprint('[BB] Joined Bladeburner Division.');
            } else {
                ns.print('[BB] Cannot join yet — need 100 in each combat stat.');
            }
        } catch (_) {}
        return true;
    }

    const minChance = flags['min-chance'];

    // 1. Upgrade skills
    upgradeSkills(ns, bb);

    // 2. City selection
    if (!flags['no-city-switch']) {
        selectBestCity(ns, bb);
    }

    // 3. Chaos check — Diplomacy if chaos too high
    const currentCity = bb['getCityName']();
    let chaos;
    try { chaos = bb['getCityChaos'](currentCity); } catch (_) { chaos = 0; }
    if (chaos > CHAOS_THRESHOLD) {
        setAction(ns, bb, 'General', 'Diplomacy');
        ns.print('[BB] Chaos=' + chaos.toFixed(0) + ' — Diplomacy');
        return true;
    }

    // 4. Stamina check
    let stamina, maxStamina;
    try {
        [stamina, maxStamina] = bb['getStamina']();
    } catch (_) { stamina = 1; maxStamina = 1; }
    const staminaRatio = stamina / maxStamina;

    if (staminaRatio < STAMINA_THRESHOLD) {
        setAction(ns, bb, 'General', 'Hyperbolic Regeneration Chamber');
        ns.print('[BB] Stamina ' + (staminaRatio * 100).toFixed(0) + '% — regen');
        return true;
    }

    // 5. Black Ops — find next uncompleted one with good success chance
    if (!flags['no-blackops']) {
        const blackOpDone = tryBlackOp(ns, bb, minChance);
        if (blackOpDone) return true;
    }

    // 6. Best Operation
    const opAction = pickBestAction(ns, bb, 'Operations', bb['getOperationNames'](), minChance);
    if (opAction) {
        setAction(ns, bb, 'Operations', opAction);
        const rank = bb['getRank']();
        ns.print('[BB] Op: ' + opAction + ' | rank=' + rank.toFixed(0) + ' | stamina=' + (staminaRatio * 100).toFixed(0) + '%');
        return true;
    }

    // 7. Best Contract
    const contractAction = pickBestAction(ns, bb, 'Contracts', bb['getContractNames'](), minChance);
    if (contractAction) {
        setAction(ns, bb, 'Contracts', contractAction);
        ns.print('[BB] Contract: ' + contractAction);
        return true;
    }

    // 8. Field Analysis — keeps population estimate accurate, improves future success chances
    setAction(ns, bb, 'General', 'Field Analysis');
    ns.print('[BB] Field Analysis — no actions above ' + (minChance * 100).toFixed(0) + '% chance');
    return true;
}


// =============================================================================
// Action helpers
// =============================================================================

function setAction(ns, bb, category, name) {
    try {
        const current = bb['getCurrentAction']();
        if (current && current.type === category && current.name === name) return;   // Already doing it
        bb['startAction'](category, name);
    } catch (_) {}
}

/**
 * Picks the highest-rank-gain action from a list that has:
 *  - success chance >= minChance
 *  - count remaining > 0
 * Returns action name or null.
 */
function pickBestAction(ns, bb, category, names, minChance) {
    let bestName = null;
    let bestRep  = -1;

    for (const name of names) {
        try {
            const count = bb['getActionCountRemaining'](category, name);
            if (count <= 0) continue;

            const [lo, hi] = bb['getActionSuccessChance'](category, name);
            const chance    = (lo + hi) / 2;
            if (chance < minChance) continue;

            const rep = bb['getActionRepGain'](category, name, 1);                  // Level 1 rep gain as proxy for quality
            if (rep > bestRep) {
                bestRep  = rep;
                bestName = name;
            }
        } catch (_) {}
    }

    return bestName;
}

function tryBlackOp(ns, bb, minChance) {
    // Attempt the next un-completed Black Op in order
    for (const name of BLACK_OPS_ORDER) {
        try {
            const count = bb['getActionCountRemaining']('BlackOps', name);
            if (count <= 0) continue;                                                // Already completed

            const [lo, hi] = bb['getActionSuccessChance']('BlackOps', name);
            const chance    = (lo + hi) / 2;
            if (chance < minChance) {
                // Not ready yet — don't skip ahead
                break;
            }

            setAction(ns, bb, 'BlackOps', name);
            ns.print('[BB] Black Op: ' + name + ' (' + (chance * 100).toFixed(0) + '% chance)');
            return true;
        } catch (_) {}
    }
    return false;
}


// =============================================================================
// Skill upgrades
// =============================================================================

function upgradeSkills(ns, bb) {
    for (const skill of SKILL_PRIORITY) {
        try {
            const cost = bb['getSkillUpgradeCost'](skill);
            const sp   = bb['getSkillPoints']();
            if (sp >= cost) {
                bb['upgradeSkill'](skill);
                ns.print('[BB] Upgraded skill: ' + skill + ' (cost ' + cost + ' SP, remaining ' + (sp - cost) + ')');
                // Only upgrade one skill per cycle to re-evaluate priority after each
                return;
            }
        } catch (_) {}
    }
}


// =============================================================================
// City selection
// =============================================================================

function selectBestCity(ns, bb) {
    let bestCity = null;
    let bestPop  = -1;

    for (const city of CITIES) {
        try {
            const pop = bb['getCityEstimatedPopulation'](city);
            if (pop > bestPop) {
                bestPop  = pop;
                bestCity = city;
            }
        } catch (_) {}
    }

    if (bestCity) {
        try {
            const current = bb['getCityName']();
            if (current !== bestCity) {
                bb['switchCity'](bestCity);
                ns.print('[BB] Switched to ' + bestCity + ' (pop ~' + ns.format.number(bestPop) + ')');
            }
        } catch (_) {}
    }
}
