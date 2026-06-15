/**
 * stocks.js
 * Version: 1.9.0
 *
 * Progressive stock market trading automation.
 *
 * Behaviour:
 *   Detects which stock market access has been purchased and enables
 *   trading capability accordingly. Upgrades its own strategy automatically
 *   as access is purchased — no restart needed.
 *
 *   Access tiers (checked each cycle):
 *     No WSE account:    Report cost. Sleep.
 *     WSE only (no TIX): Cannot trade programmatically. Sleep.
 *     TIX API (no 4S):   Estimate forecast from up/down tick history.
 *                        Requires EST_MIN_TICKS ticks before trading begins.
 *                        Mode: LEARNING → EST
 *     4S Data TIX API:   Use exact forecast from ns.stock.getForecast().
 *                        Mode: 4S
 *
 *   4S mode logic:
 *     forecast > BUY_THRESHOLD  → buy long (highest forecast first, longShares=0 only)
 *     forecast < SELL_THRESHOLD → sell long (if profitIfSold > MIN_PROFIT)
 *     Price drops > PRICE_STOPLOSS_PCT below avgPx → emergency exit (unconditional)
 *
 *   Estimated forecast (pre-4S):
 *     Each price tick is an independent Bernoulli trial with probability
 *     chc = (50 ± otlkMag) / 100 of going up (from game source).
 *     MLE estimate: estimatedForecast = upTicks / totalTicks over last
 *     EST_WINDOW ticks. Accuracy improves with window size:
 *       10 ticks → ±0.16,  30 → ±0.09,  50 → ±0.07
 *
 * Guards:
 *   - MIN_ACCOUNT: no trading below £100M account balance
 *   - TRADE_CAP_FRAC: max 2% of account per single trade
 *   - MIN_POSITION_VALUE: min £1M position (commission ratio guard)
 *   - CHURN_COOLDOWN: 10 ticks between sell and re-buy of same symbol
 *   - Live bid re-check immediately before signal sells
 *
 * Changelog:
 *   v1.9.6 - Remove forecast stop-loss. Market cycle flips forecast 0.69→0.31 in
 *            one tick while price barely moves — unconditional sell wiped profitable
 *            positions. Price-based stop-loss (-15%) retained as safety backstop.
 *   v1.9.5 - Live re-check before signal sells. Raise SELL_THRESHOLD=0.55.
 *   v1.9.4 - One-entry-per-symbol guard restored for 4S mode.
 *   v1.9.0 - Replace trend mode with estimated forecast (MLE of chc from
 *            up/down tick history). Unified buy/sell logic for EST and 4S.
 *            Remove trend-specific take-profit/stop-loss targets.
 *   v1.8.x - Trade cap 2%, £100M minimum, take-profit +3%, stop-loss -5%,
 *            live bid re-checks, trend buy-the-dip logic.
 *   v1.6.0 - All 5 efficiency guards.
 *   v1.3.0 - --sell-all flag.
 *   v1.2.0 - Port 4 P&L reporting.
 *   v1.1.0 - RAM fix (direct ns.stock.* calls).
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --interval N   Tick interval in seconds (default: 6)
 *   --floor N      Minimum cash fraction to keep liquid (default: 0.30)
 *   --once         Single cycle and exit
 *   --sell-all     Sell all open long positions and exit (graceful shutdown)
 *
 * Ports:
 *   Writes port 4: { realised, unrealised, positions, buys, sells, mode }
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~7 GB
 */

const VERSION     = '1.9.6';
const PORT_STOCKS = 4;

// Forecast thresholds — used identically for estimated and 4S forecasts
const BUY_THRESHOLD  = 0.55;  // forecast above this → buy signal
const SELL_THRESHOLD = 0.55;  // forecast below this → sell signal (symmetric: exit when edge gone)
// STOPLOSS removed — SELL_THRESHOLD=0.55 exits when edge gone; forecast-only stop-loss
// caused unconditional sells when market cycle flipped forecast 0.69→0.31 in one tick

// Estimated forecast parameters (pre-4S)
const EST_WINDOW   = 50;  // rolling window of up/down ticks
const EST_MIN_TICKS = 10;  // minimum ticks before any buy signal considered

// Price-based emergency stop-loss (backstop when forecast estimate is wrong)
const PRICE_STOPLOSS_PCT = 0.15;  // sell if bid drops >15% below avgPx

// Commission per transaction (entry or exit)
const COMMISSION = 100e3;

// Minimum net profit required for signal-driven sells (covers both commissions)
const MIN_PROFIT = COMMISSION;

// Maximum spend per single trade: 2% of total account balance
const TRADE_CAP_FRAC = 0.02;

// Minimum account balance before any new buys are placed
const MIN_ACCOUNT = 100e6;

// Ticks to wait before re-buying a symbol after selling it
const CHURN_COOLDOWN = 10;

// Minimum position value — guards against commission-dominated tiny positions
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
        ns.tprint('[STOCKS] Sold ' + sold + ' positions | proceeds:' + ns.format.number(totalProceeds));
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
        ['trend',    false],  // kept for backwards compat — no longer used
    ]);

    ns.disableLog('ALL');
    ns.print('=== stocks.js v' + VERSION + ' | interval=' + flags.interval + 's | floor=' + (flags.floor * 100).toFixed(0) + '% ===');

    if (flags['sell-all']) {
        sellAll(ns);
        return;
    }

    const lastPrice = {};   // sym → last seen price (for detecting tick direction)
    const upHistory = {};   // sym → boolean[] ring buffer (true = up tick)
    const cooldown  = {};   // sym → ticks remaining before re-buy allowed

    const MONEY_FLOOR = flags.floor;
    const INTERVAL    = flags.interval * 1000;
    const stats       = { realised: 0, buys: 0, sells: 0 };

    ns.clearPort(PORT_STOCKS);
    ns.atExit(() => ns.clearPort(PORT_STOCKS));

    do {
        tick(ns, lastPrice, upHistory, cooldown, MONEY_FLOOR, stats);
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Tick
// =============================================================================

function tick(ns, lastPrice, upHistory, cooldown, moneyFloor, stats) {
    const hasWSE = ns.stock.hasWseAccount();
    const hasTIX = ns.stock.hasTixApiAccess();
    const has4S  = hasTIX && ns.stock.has4SDataTixApi();

    if (!hasWSE) {
        ns.print('[STOCKS] No WSE account. Purchase at World Stock Exchange for ~£200M.');
        writePort(ns, { realised: 0, unrealised: 0, positions: 0, buys: 0, sells: 0, mode: 'NO_WSE' });
        return;
    }
    if (!hasTIX) {
        ns.print('[STOCKS] WSE active but no TIX API. Purchase TIX API for £5B to enable trading.');
        writePort(ns, { realised: 0, unrealised: 0, positions: 0, buys: 0, sells: 0, mode: 'NO_TIX' });
        return;
    }

    const symbols = ns.stock.getSymbols();
    const player  = ns.getPlayer();

    // Tick down churn cooldowns
    for (const sym of Object.keys(cooldown)) {
        cooldown[sym] = Math.max(0, cooldown[sym] - 1);
    }

    // Always update price history — even pre-4S, so window is full when 4S is purchased
    for (const sym of symbols) {
        const price = ns.stock.getPrice(sym);
        const prev  = lastPrice[sym];
        lastPrice[sym] = price;
        if (prev !== undefined && price !== prev) {
            if (!upHistory[sym]) upHistory[sym] = [];
            upHistory[sym].push(price > prev);
            if (upHistory[sym].length > EST_WINDOW) upHistory[sym].shift();
        }
    }

    const minHistory = symbols.reduce((m, sym) => Math.min(m, (upHistory[sym] || []).length), Infinity);

    // Without 4S: build history silently, no trading
    if (!has4S) {
        const pct = Math.min(minHistory, EST_WINDOW);
        ns.print('[STOCKS] LEARNING (' + pct + '/' + EST_WINDOW + ') — waiting for 4S data before trading.');
        writePort(ns, { realised: stats.realised, unrealised: 0, positions: 0, buys: stats.buys, sells: stats.sells, mode: 'LEARNING ' + pct + '/' + EST_WINDOW });
        return;
    }

    // 4S mode — build enriched symbol list with exact forecasts
    const symData = symbols.map(sym => {
        const ask                       = ns.stock.getAskPrice(sym);
        const bid                       = ns.stock.getBidPrice(sym);
        const [longShares, longAvgPx,,] = ns.stock.getPosition(sym);
        const maxShares                 = ns.stock.getMaxShares(sym);
        const forecast                  = ns.stock.getForecast(sym);
        const signal                    = getForecastSignal(forecast);
        return { sym, ask, bid, longShares, longAvgPx, maxShares, forecast, signal };
    });

    const mode = '4S';
    let cashLeft   = player.money * (1 - moneyFloor);
    const tradeCap = player.money * TRADE_CAP_FRAC;
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

        const profitIfSold = (bid - longAvgPx) * longShares - 2 * COMMISSION;
        const profitOk     = profitIfSold > MIN_PROFIT;

        // Price stop-loss: emergency exit if bid drops >PRICE_STOPLOSS_PCT below avgPx.
        // No forecast stop-loss — with SELL_THRESHOLD=0.55 we already exit when edge is
        // gone. Forecast can flip 0.69→0.31 in one market cycle tick while price barely
        // moves; a forecast-based stop-loss would unconditionally sell a profitable position.
        const priceStopLoss = longAvgPx > 0 && bid <= longAvgPx * (1 - PRICE_STOPLOSS_PCT);

        const shouldSell = (signal === 'sell' && profitOk) || priceStopLoss;

        if (!shouldSell) continue;

        // Re-read bid immediately before executing to guard against a market tick
        // firing between the check and sellStock. Price stop-loss executes unconditionally.
        if (!priceStopLoss) {
            const liveBid          = ns.stock.getBidPrice(sym);
            const liveProfitIfSold = (liveBid - longAvgPx) * longShares - 2 * COMMISSION;
            if (liveProfitIfSold <= 0) continue;
        }

        const proceeds = ns.stock.sellStock(sym, longShares);
        if (proceeds > 0) {
            const profit = proceeds - longShares * longAvgPx - COMMISSION;
            stats.realised += profit;
            stats.sells++;
            cycleSells++;
            cashLeft += proceeds;
            cooldown[sym] = CHURN_COOLDOWN;

            const reason = priceStopLoss
                ? 'STOPLOSS -' + (PRICE_STOPLOSS_PCT * 100).toFixed(0) + '%'
                : 'signal f=' + forecast.toFixed(2);

            ns.print('[STOCKS] SELL ' + sym + ' (' + reason + ')' +
                ' | profit:' + (profit >= 0 ? '+' : '') + ns.format.number(profit) +
                ' | session:' + (stats.realised >= 0 ? '+' : '') + ns.format.number(stats.realised));
        }
    }

    // --- Pass 2: Buys ---
    // Gate on minimum account size and sufficient history
    const canBuy = player.money >= MIN_ACCOUNT && (has4S || minHistory >= EST_MIN_TICKS);

    if (canBuy) {
        const buyable = symData
            .filter(d => d.signal === 'buy')
            .filter(d => d.longShares === 0)
            .filter(d => !cooldown[d.sym])
            .sort((a, b) => (b.forecast || 0) - (a.forecast || 0));

        for (const d of buyable) {
            if (cashLeft <= COMMISSION) break;

            const { sym, ask, longShares, maxShares, forecast } = d;
            const budget          = Math.min(cashLeft, tradeCap);
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
                    ' | f=' + forecast.toFixed(2));
            }
        }
    }

    if (cycleBuys > 0 || cycleSells > 0) {
        ns.print('[STOCKS] Cycle: ' + cycleBuys + ' buys, ' + cycleSells + ' sells');
    } else {
        ns.print('[STOCKS] Cycle: no trades | mode:4S' +
            ' | open:' + openPositions +
            ' | unrealised:' + (unrealised >= 0 ? '+' : '') + ns.format.number(unrealised));

        // Per-position debug on no-trade cycles
        for (const d of symData) {
            if (d.longShares <= 0) continue;
            const profitIfSold = (d.bid - d.longAvgPx) * d.longShares - 2 * COMMISSION;
            ns.print('  ' + d.sym
                + ' f=' + d.forecast.toFixed(2)
                + ' sig:' + d.signal
                + ' profit:' + (profitIfSold >= 0 ? '+' : '') + ns.format.number(profitIfSold));
        }
    }

    writePort(ns, {
        realised:  stats.realised,
        unrealised,
        positions: openPositions,
        buys:      stats.buys,
        sells:     stats.sells,
        mode,
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
// Signal generator (used for both estimated and 4S forecasts)
// =============================================================================

function getForecastSignal(forecast) {
    if (forecast > BUY_THRESHOLD)  return 'buy';
    if (forecast < SELL_THRESHOLD) return 'sell';
    return 'hold';
}
