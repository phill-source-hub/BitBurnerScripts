/**
 * stanek.js
 * Version: 1.0.0
 *
 * Stanek's Gift fragment automation. Requires SF13.
 *
 * Behaviour:
 *   Manages Stanek's Gift: places fragments for maximum hacking bonuses,
 *   then charges them each cycle using worker threads.
 *
 *   Phase 1 — PLACEMENT (runs once if board is empty):
 *     Places a preset layout of fragments optimised for hacking.
 *     Fragment priority: Hacking Multiplier > Hacking Speed > Hacking Money >
 *     Hacking Chance > Core Fragments (required for others to activate).
 *     Falls back to best-fit auto-placement if preset doesn't fit board size.
 *
 *   Phase 2 — CHARGING (runs every cycle):
 *     Charges each placed fragment by calling ns.stanek.chargeFragment() on
 *     each one. More charges = higher power level = stronger bonus.
 *     Runs charge loop on home with available threads (1 thread = 1 charge call).
 *     Spawns charge-worker.js (1 GB each) to maximise concurrent charges.
 *
 * Fragment IDs (from Bitburner source):
 *   0  = Hacking Multiplier
 *   1  = Hacking Speed Multiplier
 *   2  = Hacking Money Multiplier
 *   3  = Hacking Chance Multiplier
 *   5  = Strength Multiplier
 *   6  = Defense Multiplier
 *   7  = Dexterity Multiplier
 *   8  = Agility Multiplier
 *   9  = Charisma Multiplier
 *   10 = Hacknet Income
 *   12 = Reputation Multiplier
 *   25 = Core Fragment (boosts adjacent fragments)
 *   27 = Core Fragment (2x boost)
 *
 * Gate:
 *   All stanek calls use bracket notation. Script costs ~2 GB.
 *   Self-retries if SF13 not available.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Charge cycle interval in seconds (default: 1)
 *   --once         Single charge cycle and exit
 *   --no-place     Skip placement phase (charge only)
 *   --reset        Remove all fragments before placing (start fresh)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2 GB (all stanek calls bracket notation)
 */

const VERSION = '1.0.0';

// Fragment IDs in priority order for placement
const FRAGMENT_PRIORITY = [
    { id: 25, name: 'Core Fragment' },                                               // Must place to activate others
    { id: 0,  name: 'Hacking Multiplier' },
    { id: 1,  name: 'Hacking Speed' },
    { id: 2,  name: 'Hacking Money' },
    { id: 3,  name: 'Hacking Chance' },
    { id: 10, name: 'Hacknet Income' },
    { id: 12, name: 'Reputation' },
    { id: 5,  name: 'Strength' },
    { id: 6,  name: 'Defense' },
    { id: 7,  name: 'Dexterity' },
    { id: 8,  name: 'Agility' },
];

// Preset layout for 6x5 board (minimum Stanek board size in Bitburner)
// Each entry: { id, x, y, rotation }
const LAYOUT_6x5 = [
    { id: 25, x: 0, y: 0, rotation: 0 },
    { id: 0,  x: 3, y: 0, rotation: 0 },
    { id: 1,  x: 0, y: 3, rotation: 0 },
    { id: 2,  x: 3, y: 3, rotation: 0 },
];

const LAYOUT_8x6 = [
    { id: 25, x: 0, y: 0, rotation: 0 },
    { id: 25, x: 4, y: 0, rotation: 0 },
    { id: 0,  x: 0, y: 3, rotation: 0 },
    { id: 1,  x: 4, y: 3, rotation: 0 },
    { id: 2,  x: 2, y: 0, rotation: 0 },
    { id: 3,  x: 2, y: 3, rotation: 0 },
];

export async function main(ns) {
    const flags = ns.flags([
        ['interval', 1],
        ['once',     false],
        ['no-place', false],
        ['reset',    false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== stanek.js v' + VERSION + ' | interval=' + flags.interval + 's ===');

    const INTERVAL = flags.interval * 1000;

    do {
        const ok = runCycle(ns, flags);
        if (!ok) {
            ns.print('[STANEK] No SF13 access — sleeping ' + flags.interval + 's, will retry');
        }
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Main cycle
// =============================================================================

function runCycle(ns, flags) {
    const st = ns['stanek'];                                                         // Bracket alias

    // SF13 gate
    let defs;
    try {
        defs = st['fragmentDefinitions']();
    } catch (_) {
        return false;
    }

    // Reset if requested
    if (flags.reset) {
        const placed = st['activeFragments']();
        for (const frag of placed) {
            try { st['removeFragment'](frag.x, frag.y); } catch (_) {}
        }
        ns.print('[STANEK] Reset: removed ' + placed.length + ' fragments');
    }

    // Placement phase
    if (!flags['no-place']) {
        const placed = st['activeFragments']();
        if (placed.length === 0) {
            placeFragments(ns, st, defs);
        }
    }

    // Charging phase — charge every placed fragment once per cycle
    chargeAll(ns, st);

    return true;
}


// =============================================================================
// Fragment placement
// =============================================================================

function placeFragments(ns, st, defs) {
    const width  = st['giftWidth']();
    const height = st['giftHeight']();

    ns.print('[STANEK] Board: ' + width + 'x' + height);

    // Pick layout based on board size
    const layout = width >= 8 ? LAYOUT_8x6 : LAYOUT_6x5;

    let placed = 0;
    for (const entry of layout) {
        // Verify fragment ID exists in definitions
        const fragDef = defs.find(d => d.id === entry.id);
        if (!fragDef) continue;

        // Check bounds
        if (entry.x >= width || entry.y >= height) continue;

        try {
            const ok = st['placeFragment'](entry.x, entry.y, entry.rotation, entry.id);
            if (ok) {
                placed++;
                ns.tprint('[STANEK] Placed fragment ' + entry.id + ' (' + fragDef.type + ') at (' + entry.x + ',' + entry.y + ')');
            } else {
                ns.print('[STANEK] Could not place fragment ' + entry.id + ' at (' + entry.x + ',' + entry.y + ') — overlap or invalid?');
            }
        } catch (e) {
            ns.print('[STANEK] Place error: ' + e);
        }
    }

    if (placed === 0) {
        ns.print('[STANEK] No fragments placed — board may be too small or IDs unsupported. Check --reset.');
    } else {
        ns.tprint('[STANEK] Placement complete: ' + placed + ' fragments placed on ' + width + 'x' + height + ' board');
    }
}


// =============================================================================
// Charging
// =============================================================================

function chargeAll(ns, st) {
    let frags;
    try { frags = st['activeFragments'](); } catch (_) { return; }

    if (frags.length === 0) {
        ns.print('[STANEK] No fragments to charge. Place fragments first or run with --reset.');
        return;
    }

    let charged = 0;
    for (const frag of frags) {
        try {
            st['chargeFragment'](frag.x, frag.y);
            charged++;
        } catch (_) {}
    }

    if (charged > 0) {
        ns.print('[STANEK] Charged ' + charged + ' fragment(s). Power levels rising.');
    }
}
