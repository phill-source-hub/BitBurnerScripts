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
 *   v1.9.9 - Cap position at 1% of maxShares per symbol. Selling huge volumes of
 *            low-priced shares triggers cascading game-engine price-down moves
 *            (shareTxForMovement threshold), crashing proceeds to near-zero.
 *   v1.9.8 - Cycle-spike guard: skip sell when forecast drops >0.10 in one tick
 *            (market cycle fires; getBidPrice is stale pre-crash while getForecast
 *            is already updated — sellStock uses actual price → guaranteed loss).
 *            Add take-profit at +20% of position cost regardless of forecast.
 *   v1.9.7 - Track ownedByUs set: only signal-sell positions bought this session.
 *            Auto-flush legacy positions at startup (unknown entry count = wrong
 *            commission math = false-positive profitOk = sell at loss).
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

const VERSION     = '1.9.9';
const PORT_STOCKS = 4;

// Forecast thresholds — used identically for estimated and 4S forecasts
const BUY_THRESHOLD  = 0.55;  // forecast above this → buy signal
const SELL_THRESHOLD = 0.55;  // forecast below this → sell signal (symmetric: exit when edge gone)
// STOPLOSS removed — SELL_THRESHOLD=0.55 exits when edge gone; forecast-only stop-loss
// caused unconditional sells when market cycle flipped forecast 0.69→0.31 in one tick

// Take-profit: sell if net profit exceeds this fraction of position cost, regardless of forecast
const TAKE_PROFIT_PCT = 0.20;   // +20% of position cost → take the win

// Forecast drop threshold for detecting a market cycle tick.
// When a stock's forecast drops >this much in one tick, getBidPrice is stale (pre-crash)
// while getForecast is already updated. Skip the sell; bid catches up next tick.
const CYCLE_SPIKE_THRESHOLD = 0.10;

// Estimated forecast parameters (pre-4S)
const EST_WINDOW   = 50;  // rolling window of up/down ticks
const EST_MIN_TICKS = 10;  // minimum ticks before any buy signal considered

// Price-based emergency stop-loss (backstop when forecast estimate is wrong)
const PRICE_STOPLOSS_PCT = 0.15;  // sell if bid drops >15% below avgPx

// Maximum share count per position as a fraction of maxShares.
// Selling too many low-priced shares in one call triggers cascading game-engine
// price-down moves (shareTxForMovement threshold), crashing proceeds to near-zero.
const MAX_SHARES_FRAC = 0.01;  // buy at most 1% of maxShares per symbol

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

    const lastPrice    = {};   // sym → last seen price (for detecting tick direction)
    const upHistory    = {};   // sym → boolean[] ring buffer (true = up tick)
    const cooldown     = {};   // sym → ticks remaining before re-buy allowed
    const ownedByUs    = new Set(); // symbols bought this session (single-entry, 2 commissions)
    const lastForecast = {};   // sym → forecast from previous tick (for cycle-spike detection)

    const MONEY_FLOOR = flags.floor;
    const INTERVAL    = flags.interval * 1000;
    const stats       = { realised: 0, buys: 0, sells: 0 };

    ns.clearPort(PORT_STOCKS);
    ns.atExit(() => ns.clearPort(PORT_STOCKS));

    do {
        tick(ns, lastPrice, upHistory, cooldown, ownedByUs, lastForecast, MONEY_FLOOR, stats);
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Tick
// =============================================================================

function tick(ns, lastPrice, upHistory, cooldown, ownedByUs, lastForecast, moneyFloor, stats) {
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

    // Flush any positions that existed before this session started.
    // Legacy positions may have multiple entry commissions not in our profitIfSold formula,
    // causing false-positive profitOk and sell-at-a-loss. Sell them once at startup.
    for (const d of symData) {
        if (d.longShares <= 0) continue;
        if (ownedByUs.has(d.sym)) continue; // bought this session — safe
        // Legacy position: sell unconditionally and log the real P&L
        const proceeds = ns.stock.sellStock(d.sym, d.longShares);
        if (proceeds > 0) {
            const profit = proceeds - d.longShares * d.longAvgPx - COMMISSION;
            stats.realised += profit;
            stats.sells++;
            ns.print('[STOCKS] SELL ' + d.sym + ' (LEGACY FLUSH)' +
                ' | profit:' + (profit >= 0 ? '+' : '') + ns.format.number(profit));
        }
    }

    const mode = '4S';
    let cashLeft   = player.money * (1 - moneyFloor);
    const tradeCap = player.money * TRADE_CAP_FRAC;
    let cycleBuys = 0, cycleSells = 0;
    let unrealised = 0, openPositions = 0;

    // --- Pass 1: Sells and unrealised P&L ---
    for (const d of symData) {
        const { sym, bid, longShares, longAvgPx, forecast, signal } = d;

        // Re-read position after potential legacy flush
        const [currentShares, currentAvgPx,,] = ns.stock.getPosition(sym);

        if (currentShares > 0) {
            unrealised += (bid - currentAvgPx) * currentShares - 2 * COMMISSION;
            openPositions++;
        }

        // Update lastForecast regardless of whether we hold this symbol
        const prevForecast    = lastForecast[sym];
        lastForecast[sym]     = forecast;
        const forecastDrop    = prevForecast !== undefined ? prevForecast - forecast : 0;
        const cycleSpiked     = forecastDrop > CYCLE_SPIKE_THRESHOLD;

        if (currentShares <= 0 || !ownedByUs.has(sym)) continue;

        const profitIfSold  = (bid - currentAvgPx) * currentShares - 2 * COMMISSION;
        const profitOk      = profitIfSold > MIN_PROFIT;
        const positionCost  = currentAvgPx * currentShares;
        const takeProfit    = profitIfSold > positionCost * TAKE_PROFIT_PCT;

        // Price stop-loss: emergency exit if bid drops >PRICE_STOPLOSS_PCT below avgPx.
        const priceStopLoss = currentAvgPx > 0 && bid <= currentAvgPx * (1 - PRICE_STOPLOSS_PCT);

        const shouldSell = ((signal === 'sell' && profitOk) || takeProfit) || priceStopLoss;

        if (!shouldSell) continue;

        // If forecast just dropped sharply this tick (market cycle signature), getBidPrice
        // is stale — it returns the pre-crash price while getForecast is already updated.
        // sellStock uses the actual post-crash price, so we'd sell at a loss.
        // Skip this tick; bid catches up on the next tick and profitOk will gate correctly.
        if (cycleSpiked && !priceStopLoss) {
            ns.print('[STOCKS] SKIP ' + sym + ' (cycle spike Δf=' + forecastDrop.toFixed(2) + ') — waiting for bid update');
            continue;
        }

        // Re-read bid immediately before executing (reduce race window for non-spike sells).
        // Price stop-loss executes unconditionally.
        if (!priceStopLoss) {
            const liveBid          = ns.stock.getBidPrice(sym);
            const liveProfitIfSold = (liveBid - currentAvgPx) * currentShares - 2 * COMMISSION;
            if (liveProfitIfSold <= 0) continue;
        }

        const proceeds = ns.stock.sellStock(sym, currentShares);
        if (proceeds > 0) {
            const profit = proceeds - currentShares * currentAvgPx - COMMISSION;
            stats.realised += profit;
            stats.sells++;
            cycleSells++;
            cashLeft += proceeds;
            cooldown[sym] = CHURN_COOLDOWN;
            ownedByUs.delete(sym);

            const reason = priceStopLoss
                ? 'STOPLOSS -' + (PRICE_STOPLOSS_PCT * 100).toFixed(0) + '%'
                : takeProfit
                ? 'TAKEPROFIT +' + (TAKE_PROFIT_PCT * 100).toFixed(0) + '%'
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
            const safeShares      = Math.floor(maxShares * MAX_SHARES_FRAC);
            const affordShares    = Math.floor((budget - COMMISSION) / ask);
            const sharesToBuy     = Math.min(remainingShares, affordShares, safeShares);

            if (sharesToBuy <= 0) continue;
            if (sharesToBuy * ask < MIN_POSITION_VALUE) continue;

            const cost = ns.stock.buyStock(sym, sharesToBuy);
            if (cost > 0) {
                cashLeft -= cost;
                stats.buys++;
                cycleBuys++;
                ownedByUs.add(sym);
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
            const [cs, cAvg,,] = ns.stock.getPosition(d.sym);
            const profitIfSold = (d.bid - cAvg) * cs - 2 * COMMISSION;
            const prev = lastForecast[d.sym];
            const drop = prev !== undefined ? prev - d.forecast : 0;
            ns.print('  ' + d.sym
                + ' f=' + d.forecast.toFixed(2) + (drop > 0.05 ? '(Δ-' + drop.toFixed(2) + ')' : '')
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
