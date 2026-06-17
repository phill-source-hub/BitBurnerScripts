/**
 * stocks.js
 * Version: 2.1.0
 *
 * Progressive stock market trading automation.
 *
 * Behaviour:
 *   Waits for ns.stock.nextUpdate() so every tick runs immediately after the game
 *   engine finishes a price update — bid price and forecast are always in sync,
 *   eliminating the stale-bid race condition that caused false-positive sells.
 *
 *   Access tiers (checked each cycle):
 *     No WSE account:    Report cost. Sleep 6s.
 *     WSE only (no TIX): Cannot trade programmatically. Sleep 6s.
 *     TIX API (no 4S):   Build price history silently. Await nextUpdate().
 *     4S Data TIX API:   Trade using exact forecast. Await nextUpdate().
 *
 *   4S mode logic:
 *     forecast > BUY_THRESHOLD  → buy long (highest forecast first, single entry per symbol)
 *     forecast < SELL_THRESHOLD → sell long (if profitIfSold > 0 after both commissions)
 *     profitIfSold > 20% of position cost → take-profit regardless of forecast
 *     bid drops >15% below avgPx → emergency price stop-loss (unconditional)
 *
 * Profit formula:
 *   sellStock() returns bid price PER SHARE. Total profit:
 *     (bidPrice - avgPx) × shares - COMMISSION   (avgPx includes entry commission)
 *   profitIfSold pre-check:
 *     (bid - avgPx) × shares - 2×COMMISSION      (conservative: explicit both commissions)
 *
 * Guards:
 *   - MAX_INVEST_FRAC: max 40% of startup cash invested at any time
 *   - TRADE_CAP_FRAC: max 2% of account per single buy
 *   - MAX_SHARES_FRAC: max 1% of maxShares per position (market-depth guard)
 *   - MIN_POSITION_VALUE: min $1M position (commission ratio guard)
 *   - CHURN_COOLDOWN: 10 ticks between sell and re-buy of same symbol
 *   - ownedByUs: only sell positions bought this session (known single-entry commission math)
 *   - Legacy flush: positions found at startup not in ownedByUs sold unconditionally
 *
 * Changelog:
 *   v2.1.0 - Replace fixed £100M MIN_ACCOUNT with dynamic invest cap: capture cash
 *             at startup, invest at most 40% of that at any time. Removes --floor flag.
 *   v2.0.0 - Switch to ns.stock.nextUpdate() — runs immediately after each game
 *            engine tick so bid/forecast are always consistent. Eliminates the
 *            stale-bid race that required the now-removed cycle-spike guard.
 *            Also fix cashLeft sell credit: was += bidPerShare, now += total proceeds.
 *   v1.9.11 - Fix profit formula: sellStock returns bidPrice PER SHARE not total
 *             proceeds. Was: proceeds - shares×avgPx. Now: (proceeds-avgPx)×shares.
 *             Also fix cashLeft budget tracking: use getPurchaseCost for true cost.
 *   v1.9.10 - MIN_PROFIT = 0: sell on any net profit after both commissions.
 *   v1.9.9 - Cap position at 1% of maxShares per symbol.
 *   v1.9.8 - Cycle-spike guard (now removed) + 20% take-profit.
 *   v1.9.7 - Track ownedByUs set; auto-flush legacy positions at startup.
 *   v1.9.6 - Remove forecast stop-loss.
 *   v1.9.0 - Replace trend mode with estimated forecast (MLE).
 *   v1.8.x - Trade cap 2%, £100M minimum, live bid re-checks.
 *   v1.6.0 - All 5 efficiency guards.
 *   v1.3.0 - --sell-all flag.
 *   v1.0.0 - Initial version.
 *
 * Flags:
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

const VERSION     = '2.1.0';
const PORT_STOCKS = 4;

// Forecast thresholds
const BUY_THRESHOLD  = 0.55;  // forecast above this → buy signal
const SELL_THRESHOLD = 0.55;  // forecast below this → sell signal (exit when edge gone)

// Take-profit: sell if net profit exceeds this fraction of position cost
const TAKE_PROFIT_PCT = 0.20;  // +20% → take the win regardless of forecast

// Estimated forecast parameters (pre-4S history building)
const EST_WINDOW    = 50;
const EST_MIN_TICKS = 10;

// Price-based emergency stop-loss
const PRICE_STOPLOSS_PCT = 0.15;  // sell if bid drops >15% below avgPx

// Maximum share count per position as a fraction of maxShares.
// Large sell volumes push forecast toward neutral (shareTxForMovement) but do NOT move price.
const MAX_SHARES_FRAC = 0.01;  // buy at most 1% of maxShares per symbol

// Commission per transaction (entry or exit)
const COMMISSION = 100e3;

// Maximum spend per single buy: 2% of total account balance
const TRADE_CAP_FRAC = 0.02;

// Maximum fraction of startup cash to keep invested at any time
const MAX_INVEST_FRAC = 0.40;

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
        const bidPx  = ns.stock.sellStock(sym, shares);  // returns bid price per share
        const profit = (bidPx - avgPx) * shares - COMMISSION;
        totalProceeds += bidPx * shares - COMMISSION;
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
        ['once',     false],
        ['sell-all', false],
        ['interval', 6],   // kept for backwards compat — ignored when TIX available
        ['trend',    false], // kept for backwards compat — no longer used
    ]);

    ns.disableLog('ALL');
    ns.print('=== stocks.js v' + VERSION + ' ===');

    if (flags['sell-all']) {
        sellAll(ns);
        return;
    }

    const lastPrice    = {};  // sym → last seen price
    const upHistory    = {};  // sym → boolean[] ring buffer (true = up tick)
    const cooldown     = {};  // sym → ticks remaining before re-buy allowed
    const ownedByUs    = new Set();  // symbols bought this session (single-entry)
    const lastForecast = {};  // sym → forecast from previous tick (debug delta display)

    const startCash   = ns.getPlayer().money;
    const investLimit = startCash * MAX_INVEST_FRAC;
    const stats       = { realised: 0, buys: 0, sells: 0 };

    ns.print('[STOCKS] startup cash=' + ns.format.number(startCash) +
             ' | invest cap=' + ns.format.number(investLimit) + ' (40%)');

    ns.clearPort(PORT_STOCKS);
    ns.atExit(() => ns.clearPort(PORT_STOCKS));

    while (true) {
        // Wait for next game tick if TIX available; otherwise poll every 6s
        if (ns.stock.hasTixApiAccess()) {
            await ns.stock.nextUpdate();
        } else {
            await ns.sleep(6000);
        }

        tick(ns, lastPrice, upHistory, cooldown, ownedByUs, lastForecast, investLimit, stats);
        if (flags.once) break;
    }
}


// =============================================================================
// Tick
// =============================================================================

function tick(ns, lastPrice, upHistory, cooldown, ownedByUs, lastForecast, investLimit, stats) {
    const hasWSE = ns.stock.hasWseAccount();
    const hasTIX = ns.stock.hasTixApiAccess();
    const has4S  = hasTIX && ns.stock.has4SDataTixApi();

    if (!hasWSE) {
        ns.print('[STOCKS] No WSE account. Purchase at World Stock Exchange for ~$200M.');
        writePort(ns, { realised: 0, unrealised: 0, positions: 0, buys: 0, sells: 0, mode: 'NO_WSE' });
        return;
    }
    if (!hasTIX) {
        ns.print('[STOCKS] WSE active but no TIX API. Purchase TIX API to enable trading.');
        writePort(ns, { realised: 0, unrealised: 0, positions: 0, buys: 0, sells: 0, mode: 'NO_TIX' });
        return;
    }

    const symbols = ns.stock.getSymbols();
    const player  = ns.getPlayer();

    // Tick down churn cooldowns
    for (const sym of Object.keys(cooldown)) {
        cooldown[sym] = Math.max(0, cooldown[sym] - 1);
    }

    // Always update price history — even pre-4S, so window is full when 4S purchased
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

    // 4S mode — build enriched symbol list (all reads post-tick, guaranteed consistent)
    const symData = symbols.map(sym => {
        const ask                       = ns.stock.getAskPrice(sym);
        const bid                       = ns.stock.getBidPrice(sym);
        const [longShares, longAvgPx,,] = ns.stock.getPosition(sym);
        const maxShares                 = ns.stock.getMaxShares(sym);
        const forecast                  = ns.stock.getForecast(sym);
        const signal                    = getForecastSignal(forecast);
        return { sym, ask, bid, longShares, longAvgPx, maxShares, forecast, signal };
    });

    // Flush positions that existed before this session started.
    // Unknown entry count → wrong commission math → false-positive profitOk.
    for (const d of symData) {
        if (d.longShares <= 0 || ownedByUs.has(d.sym)) continue;
        const bidPx  = ns.stock.sellStock(d.sym, d.longShares);  // bid price per share
        if (bidPx > 0) {
            const profit = (bidPx - d.longAvgPx) * d.longShares - COMMISSION;
            stats.realised += profit;
            stats.sells++;
            ns.print('[STOCKS] SELL ' + d.sym + ' (LEGACY FLUSH)' +
                ' | profit:' + (profit >= 0 ? '+' : '') + ns.format.number(profit));
        }
    }

    const mode = '4S';
    const tradeCap = player.money * TRADE_CAP_FRAC;
    let cycleBuys = 0, cycleSells = 0;
    let unrealised = 0, openPositions = 0;

    // Compute available buy budget upfront so Pass 1 sells can credit proceeds into it
    let currentlyInvested = 0;
    for (const sym of symbols) {
        const [shares, avgPx] = ns.stock.getPosition(sym);
        currentlyInvested += shares * avgPx;
    }
    let cashLeft = Math.max(0, investLimit - currentlyInvested);

    // --- Pass 1: Sells and unrealised P&L ---
    for (const d of symData) {
        const { sym, bid, forecast, signal } = d;

        // Re-read position after potential legacy flush above
        const [currentShares, currentAvgPx,,] = ns.stock.getPosition(sym);

        // Track forecast delta for debug display
        const prevForecast = lastForecast[sym];
        lastForecast[sym]  = forecast;

        if (currentShares > 0) {
            unrealised += (bid - currentAvgPx) * currentShares - 2 * COMMISSION;
            openPositions++;
        }

        if (currentShares <= 0 || !ownedByUs.has(sym)) continue;

        // profitIfSold: conservative (2×COMMISSION); avgPx already includes entry commission
        const profitIfSold = (bid - currentAvgPx) * currentShares - 2 * COMMISSION;
        const profitOk     = profitIfSold > 0;
        const positionCost = currentAvgPx * currentShares;
        const takeProfit   = profitIfSold > positionCost * TAKE_PROFIT_PCT;
        const priceStopLoss = currentAvgPx > 0 && bid <= currentAvgPx * (1 - PRICE_STOPLOSS_PCT);

        const shouldSell = (signal === 'sell' && profitOk) || takeProfit || priceStopLoss;
        if (!shouldSell) continue;

        const bidPx  = ns.stock.sellStock(sym, currentShares);  // bid price per share
        if (bidPx > 0) {
            const profit      = (bidPx - currentAvgPx) * currentShares - COMMISSION;
            const netProceeds = bidPx * currentShares - COMMISSION;
            stats.realised += profit;
            stats.sells++;
            cycleSells++;
            cashLeft += netProceeds;
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

    if (cashLeft > COMMISSION) {
        const buyable = symData
            .filter(d => d.signal === 'buy')
            .filter(d => d.longShares === 0)
            .filter(d => !cooldown[d.sym])
            .sort((a, b) => b.forecast - a.forecast);

        for (const d of buyable) {
            if (cashLeft <= COMMISSION) break;

            const { sym, ask, longShares, maxShares, forecast } = d;
            const budget       = Math.min(cashLeft, tradeCap);
            const safeShares   = Math.floor(maxShares * MAX_SHARES_FRAC);
            const affordShares = Math.floor((budget - COMMISSION) / ask);
            const sharesToBuy  = Math.min(maxShares - longShares, affordShares, safeShares);

            if (sharesToBuy <= 0) continue;
            if (sharesToBuy * ask < MIN_POSITION_VALUE) continue;

            const totalCost = ns.stock.getPurchaseCost(sym, sharesToBuy, 'L');
            const bidPx     = ns.stock.buyStock(sym, sharesToBuy);  // ask price per share; 0 on failure
            if (bidPx > 0) {
                cashLeft -= totalCost;
                stats.buys++;
                cycleBuys++;
                ownedByUs.add(sym);
                ns.print('[STOCKS] BUY  ' + sym + ' | shares:' + sharesToBuy +
                    ' | cost:' + ns.format.number(totalCost) +
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

        for (const d of symData) {
            if (d.longShares <= 0) continue;
            const [cs, cAvg,,] = ns.stock.getPosition(d.sym);
            const profitIfSold = (d.bid - cAvg) * cs - 2 * COMMISSION;
            const prev  = lastForecast[d.sym];
            const delta = prev !== undefined ? prev - d.forecast : 0;
            ns.print('  ' + d.sym
                + ' f=' + d.forecast.toFixed(2) + (Math.abs(delta) > 0.05 ? '(Δ' + (delta > 0 ? '-' : '+') + Math.abs(delta).toFixed(2) + ')' : '')
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
// Signal generator
// =============================================================================

function getForecastSignal(forecast) {
    if (forecast > BUY_THRESHOLD)  return 'buy';
    if (forecast < SELL_THRESHOLD) return 'sell';
    return 'hold';
}
