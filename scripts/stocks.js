/**
 * stocks.js
 * Version: 1.6.0
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
 *     TIX API (no 4S):        Hold — trend trading disabled by default (--trend to override).
 *     4S Data TIX API:        Trade on forecast threshold:
 *                             forecast > BUY_THRESHOLD  → buy long
 *                             forecast < SELL_THRESHOLD → sell long (if profitable)
 *                             forecast < STOPLOSS_4S    → sell long (stop-loss override)
 *
 *   Guards applied every cycle:
 *     - Never sell at a loss unless 4S stop-loss fires (forecast < STOPLOSS_4S)
 *     - Minimum profit threshold: profit > COMMISSION before exiting
 *     - Per-symbol position cap: max POSITION_CAP_FRAC of deployable cash per symbol
 *     - Capital depletes correctly across buys in same tick
 *     - Churn prevention: CHURN_COOLDOWN ticks between sell and re-buy of same symbol
 *     - 4S buy order: highest forecast first so best opportunities get most capital
 *
 * Changelog:
 *   v1.7.0 - Trend mode sell fixes: profit threshold relaxed to profitIfSold>0,
 *            percentage-based stop-loss (TREND_STOPLOSS_PCT=10%) when no 4S.
 *   v1.6.0 - All 5 efficiency guards: position cap, profit threshold, 4S stop-loss,
 *            forecast-sorted buys, churn prevention cooldown.
 *   v1.5.0 - Never sell at a loss: only sell when profitIfSold > 0.
 *   v1.4.0 - Gate trading on 4S by default (--trend to opt into trend mode).
 *            Fix cashAvail not decrementing between buys in same tick.
 *   v1.3.0 - Add --sell-all flag: liquidate all open long positions and exit.
 *   v1.2.0 - Track session P&L. Write stats to port 4 for dashboard.
 *   v1.1.0 - Replace bracket notation with direct ns.stock.* calls (RAM fix).
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Tick interval in seconds (default: 6)
 *   --floor N      Minimum cash fraction to keep liquid (default: 0.30)
 *   --once         Single cycle and exit
 *   --sell-all     Sell all open long positions and exit (graceful shutdown)
 *   --trend        Enable trend trading even without 4S data (risky, off by default)
 *
 * Ports:
 *   Writes port 4: { realised, unrealised, positions, buys, sells, mode } each cycle
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~7 GB
 */

const VERSION   = '1.7.3';
const PORT_STOCKS = 4;

// 4S trading thresholds
const BUY_THRESHOLD   = 0.55;  // forecast above this → buy signal
const SELL_THRESHOLD  = 0.50;  // forecast below this → sell signal (if profitable)
const STOPLOSS_4S     = 0.35;  // forecast below this → sell regardless of P&L (stop-loss)

// Trend-tracking (no 4S) parameters
const TREND_WINDOW   = 5;
const TREND_UP_MIN   = 4;
const TREND_DOWN_MIN = 3;

// Commission per transaction
const COMMISSION = 100e3;

// Minimum profit over commissions required before exiting (4S mode only)
const MIN_PROFIT_OVER_COMMISSION = COMMISSION;

// Trend mode stop-loss: sell if position is down more than this fraction from avg cost
const TREND_STOPLOSS_PCT = 0.10;

// Maximum fraction of deployable cash to put into any single symbol
const POSITION_CAP_FRAC = 0.20;

// Ticks to wait before re-buying a symbol after selling it
const CHURN_COOLDOWN = 10;

// Minimum position value (covers entry + exit commission)
const MIN_POSITION_VALUE = 1e6;


// =============================================================================
// Sell-all (graceful shutdown)
// =============================================================================

function sellAll(ns) {
    if (!ns.stock.hasWseAccount() || !ns.stock.hasTixApiAccess()) {
        ns.tprint('[STOCKS] No WSE/TIX access — nothing to sell.');
        return;
    }
    const symbols = ns.stock.getSymbols();
    let totalProceeds = 0;
    let sold = 0;
    for (const sym of symbols) {
        const [shares, avgPx] = ns.stock.getPosition(sym);
        if (shares <= 0) continue;
        const proceeds = ns.stock.sellStock(sym, shares);
        const profit   = proceeds - shares * avgPx - COMMISSION;
        totalProceeds += proceeds;
        sold++;
        ns.tprint('[STOCKS] SELL ' + sym + ' | shares:' + shares +
            ' | profit:' + (profit >= 0 ? '+' : '') + ns.format.number(profit));
    }
    if (sold === 0) {
        ns.tprint('[STOCKS] No open positions to sell.');
    } else {
        ns.tprint('[STOCKS] Sold ' + sold + ' positions | total proceeds: ' + ns.format.number(totalProceeds));
    }
    ns.clearPort(PORT_STOCKS);
}


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['interval', 6],
        ['floor',    0.30],
        ['once',     false],
        ['sell-all', false],
        ['trend',    false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== stocks.js v' + VERSION + ' | interval=' + flags.interval + 's | floor=' + (flags.floor * 100).toFixed(0) + '% ===');

    if (flags['sell-all']) {
        sellAll(ns);
        return;
    }

    const priceHistory = {};                // symbol → number[] ring buffer
    const cooldown     = {};                // symbol → ticks remaining before re-buy allowed
    const MONEY_FLOOR  = flags.floor;
    const INTERVAL     = flags.interval * 1000;
    const allowTrend   = flags['trend'];

    const stats = { realised: 0, buys: 0, sells: 0 };

    ns.clearPort(PORT_STOCKS);
    ns.atExit(() => ns.clearPort(PORT_STOCKS));

    do {
        tick(ns, priceHistory, cooldown, MONEY_FLOOR, stats, allowTrend);
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Tick
// =============================================================================

function tick(ns, priceHistory, cooldown, moneyFloor, stats, allowTrend) {
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
    if (!has4S && !allowTrend) {
        ns.print('[STOCKS] Waiting for 4S data — trend trading disabled. Use --trend to override.');
        writePort(ns, { realised: stats.realised, unrealised: 0, positions: 0, buys: stats.buys, sells: stats.sells, mode: 'WAIT_4S' });
        return;
    }

    const symbols = ns.stock.getSymbols();
    const player  = ns.getPlayer();
    let cashLeft  = player.money * (1 - moneyFloor);
    const perSymCap = player.money * (1 - moneyFloor) * POSITION_CAP_FRAC;

    // Tick down churn cooldowns
    for (const sym of Object.keys(cooldown)) {
        cooldown[sym] = Math.max(0, cooldown[sym] - 1);
    }

    // Build enriched symbol list with signals and positions
    const symData = symbols.map(sym => {
        const ask                       = ns.stock.getAskPrice(sym);
        const bid                       = ns.stock.getBidPrice(sym);
        const price                     = ns.stock.getPrice(sym);
        const [longShares, longAvgPx,,] = ns.stock.getPosition(sym);
        const maxShares                 = ns.stock.getMaxShares(sym);
        const forecast                  = has4S ? ns.stock.getForecast(sym) : null;

        // Update price history
        if (!priceHistory[sym]) priceHistory[sym] = [];
        priceHistory[sym].push(price);
        if (priceHistory[sym].length > TREND_WINDOW) priceHistory[sym].shift();

        const signal = has4S
            ? get4SSignal(forecast)
            : getTrendSignal(priceHistory[sym]);

        return { sym, ask, bid, longShares, longAvgPx, maxShares, forecast, signal };
    });

    let cycleBuys = 0, cycleSells = 0;
    let unrealised = 0, openPositions = 0;

    // --- Pass 1: Sells and unrealised P&L ---
    for (const d of symData) {
        const { sym, bid, longShares, longAvgPx, forecast, signal } = d;

        if (longShares > 0) {
            unrealised += (bid - longAvgPx) * longShares - 2 * COMMISSION;
            openPositions++;
        }

        if (longShares <= 0) continue;

        const profitIfSold   = (bid - longAvgPx) * longShares - 2 * COMMISSION;
        const stopLoss4S     = has4S && forecast < STOPLOSS_4S;
        const stopLossTrend  = !has4S && longAvgPx > 0 && bid < longAvgPx * (1 - TREND_STOPLOSS_PCT);
        const profitOk       = has4S
            ? profitIfSold > MIN_PROFIT_OVER_COMMISSION
            : profitIfSold > 0;

        const shouldSell = (signal === 'sell' && profitOk)
                        || stopLoss4S
                        || stopLossTrend;

        if (shouldSell) {
            // Re-check bid immediately before selling — a market tick may have fired
            // between our getBidPrice read and now, making profitOk stale.
            if (!stopLoss4S && !stopLossTrend) {
                const liveBid          = ns.stock.getBidPrice(sym);
                const liveProfitIfSold = (liveBid - longAvgPx) * longShares - 2 * COMMISSION;
                const liveProfitOk     = has4S
                    ? liveProfitIfSold > MIN_PROFIT_OVER_COMMISSION
                    : liveProfitIfSold > 0;
                if (!liveProfitOk) continue;
            }
            const proceeds = ns.stock.sellStock(sym, longShares);
            if (proceeds > 0) {
                const profit = proceeds - longShares * longAvgPx - COMMISSION;
                stats.realised += profit;
                stats.sells++;
                cycleSells++;
                cashLeft += proceeds;
                cooldown[sym] = CHURN_COOLDOWN;
                const reason = stopLoss4S    ? 'STOPLOSS f=' + forecast.toFixed(2)
                             : stopLossTrend ? 'STOPLOSS -' + (TREND_STOPLOSS_PCT * 100).toFixed(0) + '%'
                             : 'signal';
                ns.print('[STOCKS] SELL ' + sym + ' (' + reason + ')' +
                    ' | profit:' + (profit >= 0 ? '+' : '') + ns.format.number(profit) +
                    ' | session:' + (stats.realised >= 0 ? '+' : '') + ns.format.number(stats.realised));
            }
        }
    }

    // --- Pass 2: Buys — sorted by forecast descending (best opportunity first) ---
    // Trend mode: never add to existing position — one entry per symbol, so profitIfSold
    // accounts for exactly 2 commissions (1 entry + 1 exit). Adding more lots would
    // accumulate entry commissions that profitIfSold doesn't track.
    const buyable = symData
        .filter(d => d.signal === 'buy')
        .filter(d => has4S ? d.longShares < d.maxShares : d.longShares === 0)
        .filter(d => !cooldown[d.sym])
        .sort((a, b) => (b.forecast || 0) - (a.forecast || 0));

    for (const d of buyable) {
        if (cashLeft <= COMMISSION) break;

        const { sym, ask, longShares, maxShares } = d;
        const budget          = Math.min(cashLeft, perSymCap);
        const remainingShares = maxShares - longShares;
        const affordShares    = Math.floor((budget - COMMISSION) / ask);
        const sharesToBuy     = Math.min(remainingShares, affordShares);

        if (sharesToBuy <= 0) continue;
        if (sharesToBuy * ask < MIN_POSITION_VALUE) continue;

        const cost = ns.stock.buyStock(sym, sharesToBuy);
        if (cost > 0) {
            cashLeft -= cost;
            stats.buys++;
            cycleBuys++;
            ns.print('[STOCKS] BUY  ' + sym + ' | shares:' + sharesToBuy +
                ' | cost:' + ns.format.number(cost) +
                (d.forecast !== null ? ' | f=' + d.forecast.toFixed(2) : ' | trend'));
        }
    }

    if (cycleBuys > 0 || cycleSells > 0) {
        ns.print('[STOCKS] Cycle: ' + cycleBuys + ' buys, ' + cycleSells + ' sells');
    } else {
        ns.print('[STOCKS] Cycle: no trades | mode:' + (has4S ? '4S' : 'trend') +
            ' | open:' + openPositions +
            ' | unrealised:' + (unrealised >= 0 ? '+' : '') + ns.format.number(unrealised));
        // Per-position signal debug (only when open positions exist)
        for (const d of symData) {
            if (d.longShares <= 0) continue;
            const profitIfSold = (d.bid - d.longAvgPx) * d.longShares - 2 * COMMISSION;
            const stopLossTrend = !has4S && d.longAvgPx > 0 && d.bid < d.longAvgPx * (1 - TREND_STOPLOSS_PCT);
            ns.print('  ' + d.sym + ' sig:' + d.signal
                + ' profit:' + (profitIfSold >= 0 ? '+' : '') + ns.format.number(profitIfSold)
                + (stopLossTrend ? ' STOPLOSS' : ''));
        }
    }

    writePort(ns, {
        realised:  stats.realised,
        unrealised,
        positions: openPositions,
        buys:      stats.buys,
        sells:     stats.sells,
        mode:      has4S ? '4S' : 'TREND',
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

function get4SSignal(forecast) {
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
