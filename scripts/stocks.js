/**
 * stocks.js
 * Version: 1.2.0
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
 * Changelog:
 *   v1.2.0 - Track session P&L (realised + unrealised). Write stats to port 4
 *            each cycle for dashboard display.
 *   v1.1.0 - Replace bracket notation with direct ns.stock.* calls to fix
 *            dynamic RAM overflow crash.
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Tick interval in seconds (default: 6)
 *   --floor N      Minimum cash fraction to keep liquid (default: 0.30)
 *   --once         Single cycle and exit
 *
 * Ports:
 *   Writes port 4: { realised, unrealised, positions, buys, sells, mode } each cycle
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~7 GB
 *   Base 1.6 + getSymbols 2.0 + getPrice/Ask/Bid/Position/MaxShares/Forecast ~0.25 each
 *   + buyStock/sellStock ~0.5 each + access checks ~0.15
 */

const VERSION = '1.2.0';
const PORT_STOCKS = 4;

// 4S trading thresholds
const BUY_THRESHOLD  = 0.55;
const SELL_THRESHOLD = 0.50;

// Trend-tracking (no 4S) parameters
const TREND_WINDOW   = 5;
const TREND_UP_MIN   = 4;
const TREND_DOWN_MIN = 3;

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

    const priceHistory = {};
    const MONEY_FLOOR  = flags.floor;
    const INTERVAL     = flags.interval * 1000;

    // Session accumulators — reset on script restart
    const stats = { realised: 0, buys: 0, sells: 0 };

    ns.clearPort(PORT_STOCKS);
    ns.atExit(() => ns.clearPort(PORT_STOCKS));

    do {
        tick(ns, priceHistory, MONEY_FLOOR, stats);
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Tick
// =============================================================================

function tick(ns, priceHistory, moneyFloor, stats) {
    const hasWSE = ns.stock.hasWseAccount();
    const hasTIX = ns.stock.hasTixApiAccess();
    const has4S  = hasTIX && ns.stock.has4SDataTixApi();

    if (!hasWSE) {
        ns.print('[STOCKS] No WSE account. Purchase at World Stock Exchange for ~$200M.');
        writePort(ns, { realised: 0, unrealised: 0, positions: 0, buys: 0, sells: 0, mode: 'NO_WSE' });
        return;
    }

    if (!hasTIX) {
        ns.print('[STOCKS] WSE active but no TIX API. Purchase TIX API for $5B to enable trading.');
        writePort(ns, { realised: 0, unrealised: 0, positions: 0, buys: 0, sells: 0, mode: 'NO_TIX' });
        return;
    }

    const symbols   = ns.stock.getSymbols();
    const player    = ns.getPlayer();
    const cashAvail = player.money * (1 - moneyFloor);

    let cycleBuys = 0, cycleSells = 0;
    let unrealised = 0;
    let openPositions = 0;

    for (const sym of symbols) {
        const price     = ns.stock.getPrice(sym);
        const ask       = ns.stock.getAskPrice(sym);
        const bid       = ns.stock.getBidPrice(sym);
        const [longShares, longAvgPx, , ] = ns.stock.getPosition(sym);
        const maxShares = ns.stock.getMaxShares(sym);

        // Accumulate unrealised P&L across open positions
        if (longShares > 0) {
            unrealised += (bid - longAvgPx) * longShares - COMMISSION;
            openPositions++;
        }

        // Update price history
        if (!priceHistory[sym]) priceHistory[sym] = [];
        priceHistory[sym].push(price);
        if (priceHistory[sym].length > TREND_WINDOW) priceHistory[sym].shift();

        const signal = has4S
            ? get4SSignal(ns, sym)
            : getTrendSignal(priceHistory[sym]);

        // --- Sell existing long position ---
        if (longShares > 0 && signal === 'sell') {
            const proceeds = ns.stock.sellStock(sym, longShares);
            if (proceeds > 0) {
                const profit = proceeds - longShares * longAvgPx - COMMISSION;
                stats.realised += profit;
                stats.sells++;
                cycleSells++;
                ns.print('[STOCKS] SELL ' + sym + ' | shares:' + longShares +
                    ' | profit:' + (profit >= 0 ? '+' : '') + ns.format.number(profit) +
                    ' | session:' + (stats.realised >= 0 ? '+' : '') + ns.format.number(stats.realised));
            }
        }

        // --- Buy long position ---
        if (signal === 'buy') {
            if (longShares >= maxShares) continue;

            const remainingShares = maxShares - longShares;
            const affordShares    = Math.floor((cashAvail - COMMISSION) / ask);
            const sharesToBuy     = Math.min(remainingShares, affordShares);

            if (sharesToBuy <= 0) continue;

            const positionValue = sharesToBuy * ask;
            if (positionValue < MIN_POSITION_VALUE) continue;

            const cost = ns.stock.buyStock(sym, sharesToBuy);
            if (cost > 0) {
                stats.buys++;
                cycleBuys++;
                ns.print('[STOCKS] BUY  ' + sym + ' | shares:' + sharesToBuy +
                    ' | cost:' + ns.format.number(cost) + ' | ' + (has4S ? 'forecast' : 'trend'));
            }
        }
    }

    if (cycleBuys > 0 || cycleSells > 0) {
        ns.print('[STOCKS] Cycle: ' + cycleBuys + ' buys, ' + cycleSells + ' sells');
    } else {
        ns.print('[STOCKS] Cycle: no trades | mode:' + (has4S ? '4S' : 'trend') +
            ' | open:' + openPositions + ' | unrealised:' + (unrealised >= 0 ? '+' : '') + ns.format.number(unrealised));
    }

    writePort(ns, {
        realised:    stats.realised,
        unrealised,
        positions:   openPositions,
        buys:        stats.buys,
        sells:       stats.sells,
        mode:        has4S ? '4S' : 'TREND',
    });
}


// =============================================================================
// Port write
// =============================================================================

function writePort(ns, data) {
    ns.clearPort(PORT_STOCKS);
    ns.writePort(PORT_STOCKS, JSON.stringify(data));
}


// =============================================================================
// Signal generators
// =============================================================================

function get4SSignal(ns, sym) {
    const forecast = ns.stock.getForecast(sym);
    if (forecast > BUY_THRESHOLD)  return 'buy';
    if (forecast < SELL_THRESHOLD) return 'sell';
    return 'hold';
}

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
