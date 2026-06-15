/**
 * stocks.js
 * Version: 1.0.0
 *
 * Progressive stock market trading automation.
 *
 * Behaviour:
 *   Detects which stock market access has been purchased and enables
 *   trading capability accordingly. Upgrades its own strategy automatically
 *   as access is purchased — no restart needed.
 *
 *   Access tiers (checked each cycle):
 *     No WSE account:         Report cost to purchase WSE. Sleep.
 *     WSE only (no TIX API):  Cannot trade programmatically. Sleep.
 *     TIX API (no 4S):        Track price history per symbol. Trade on
 *                             trend signal: 3+ consecutive rises = long,
 *                             3+ consecutive falls = sell/short.
 *     4S Data TIX API:        Trade on forecast threshold:
 *                             forecast > BUY_THRESHOLD  → buy long
 *                             forecast < SELL_THRESHOLD → sell long
 *                             (Short positions require SF8.2+ — skipped otherwise)
 *
 *   Commission: $100,000 per transaction. Never enter a position too small
 *   to recover both commissions from a realistic price move.
 *
 *   Money floor: never spend more than (1 - MONEY_FLOOR) of liquid money
 *   on stocks in any single cycle.
 *
 * No external gate. WSE/TIX/4S access checks are runtime, not static.
 * Script costs ~2GB. Safe to run from day 1 (sleeps harmlessly until WSE purchased).
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Tick interval in seconds (default: 6)
 *   --floor N      Minimum cash fraction to keep liquid (default: 0.30)
 *   --once         Single cycle and exit
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2.5 GB
 *   Base 1.6 + getPlayer (negligible) + stock functions (no static cost
 *   since all access-gated calls use bracket notation)
 */

const VERSION = '1.0.0';

// 4S trading thresholds
const BUY_THRESHOLD  = 0.55;                                                        // Forecast > this → buy long
const SELL_THRESHOLD = 0.50;                                                        // Forecast < this → sell long

// Trend-tracking (no 4S) parameters
const TREND_WINDOW   = 5;                                                           // Price history ticks to track
const TREND_UP_MIN   = 4;                                                           // Consecutive rises required to go long
const TREND_DOWN_MIN = 3;                                                           // Consecutive falls to sell

// Commission per transaction
const COMMISSION = 100e3;

// Minimum position value to bother entering (covers 2x commission + spread)
const MIN_POSITION_VALUE = 1e6;

export async function main(ns) {
    const flags = ns.flags([
        ['interval', 6],
        ['floor',    0.30],
        ['once',     false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== stocks.js v' + VERSION + ' | interval=' + flags.interval + 's | floor=' + (flags.floor * 100).toFixed(0) + '% ===');

    const priceHistory = {};                                                        // symbol → number[] (ring buffer of recent prices)
    const MONEY_FLOOR  = flags.floor;
    const INTERVAL     = flags.interval * 1000;

    do {
        tick(ns, priceHistory, MONEY_FLOOR);
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Tick
// =============================================================================

function tick(ns, priceHistory, moneyFloor) {
    const stock = ns['stock'];                                                      // Bracket notation — no static RAM cost

    // --- Access detection ---
    const hasWSE    = stock['hasWseAccount']();
    const hasTIX    = stock['hasTixApiAccess']();
    const has4S     = hasTIX && stock['has4SDataTixApi']();

    if (!hasWSE) {
        ns.print('[STOCKS] No WSE account. Purchase at World Stock Exchange for ~$200M.');
        return;
    }

    if (!hasTIX) {
        ns.print('[STOCKS] WSE active but no TIX API. Purchase TIX API for $5B to enable trading.');
        return;
    }

    const symbols   = stock['getSymbols']();
    const player    = ns.getPlayer();
    const cashAvail = player.money * (1 - moneyFloor);                             // Cash we can deploy

    let bought = 0, sold = 0, totalGain = 0;

    for (const sym of symbols) {
        const price     = stock['getPrice'](sym);
        const ask       = stock['getAskPrice'](sym);
        const bid       = stock['getBidPrice'](sym);
        const [longShares, longAvgPx, , ] = stock['getPosition'](sym);
        const maxShares = stock['getMaxShares'](sym);

        // Update price history
        if (!priceHistory[sym]) priceHistory[sym] = [];
        priceHistory[sym].push(price);
        if (priceHistory[sym].length > TREND_WINDOW) priceHistory[sym].shift();

        const signal = has4S
            ? get4SSignal(stock, sym)
            : getTrendSignal(priceHistory[sym]);

        // --- Sell existing long position ---
        if (longShares > 0 && signal === 'sell') {
            const gain = stock['sellStock'](sym, longShares);
            if (gain > 0) {
                totalGain += gain - longShares * longAvgPx - COMMISSION;
                sold++;
                ns.print('[STOCKS] SELL ' + sym + ' | shares:' + longShares + ' | gain:$' + ns.format.number(gain));
            }
        }

        // --- Buy long position ---
        if (signal === 'buy') {
            // Already have maximum position
            if (longShares >= maxShares) continue;

            const remainingShares = maxShares - longShares;
            const affordShares    = Math.floor((cashAvail - COMMISSION) / ask);
            const sharesToBuy     = Math.min(remainingShares, affordShares);

            if (sharesToBuy <= 0) continue;

            const positionValue = sharesToBuy * ask;
            if (positionValue < MIN_POSITION_VALUE) continue;                      // Too small — commission would dominate

            const cost = stock['buyStock'](sym, sharesToBuy);
            if (cost > 0) {
                bought++;
                ns.print('[STOCKS] BUY  ' + sym + ' | shares:' + sharesToBuy + ' | cost:$' + ns.format.number(cost) + ' | ' + (has4S ? 'forecast' : 'trend'));
            }
        }
    }

    if (bought > 0 || sold > 0) {
        ns.print('[STOCKS] Cycle: ' + bought + ' buys, ' + sold + ' sells | net gain est: $' + ns.format.number(totalGain));
    } else {
        ns.print('[STOCKS] Cycle: no trades | mode: ' + (has4S ? '4S' : 'trend'));
    }
}


// =============================================================================
// Signal generators
// =============================================================================

/**
 * 4S signal: buy when forecast > BUY_THRESHOLD, sell when < SELL_THRESHOLD.
 * @returns {'buy'|'sell'|'hold'}
 */
function get4SSignal(stock, sym) {
    const forecast = stock['getForecast'](sym);
    if (forecast > BUY_THRESHOLD)  return 'buy';
    if (forecast < SELL_THRESHOLD) return 'sell';
    return 'hold';
}

/**
 * Trend signal: track consecutive price direction.
 * Requires TREND_WINDOW ticks of history.
 * @returns {'buy'|'sell'|'hold'}
 */
function getTrendSignal(history) {
    if (history.length < TREND_WINDOW) return 'hold';

    let rises = 0, falls = 0;
    for (let i = 1; i < history.length; i++) {
        if (history[i] > history[i - 1]) rises++;
        else if (history[i] < history[i - 1]) falls++;
    }

    if (rises >= TREND_UP_MIN)   return 'buy';
    if (falls >= TREND_DOWN_MIN) return 'sell';
    return 'hold';
}
