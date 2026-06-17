# stocks.js Handover — 2026-06-16

## Current State
`scripts/stocks.js` v2.0.0 — committed and pushed to `main` (`3d14ab7`).
**Sells are now profitable.** All major bugs resolved.

## What the Script Does
Progressive stock market automation for BitBurner (PhlanxOS suite).

Access tiers checked each cycle:
- No WSE → report cost, sleep
- WSE only / no TIX → sleep
- TIX, no 4S → build price history silently (LEARNING mode)
- TIX + 4S → trade using exact forecast

4S trading logic:
- `forecast > 0.55` → buy long (highest forecast first, one entry per symbol)
- `forecast < 0.55` → sell if `profitIfSold > 0` after both commissions
- `profitIfSold > 20% of position cost` → take-profit regardless of forecast
- `bid < avgPx × 0.85` → emergency price stop-loss (unconditional)

## Key API Facts (confirmed from bitburner-src)
- `buyStock(sym, shares)` → returns **ask price PER SHARE** (not total cost)
- `sellStock(sym, shares)` → returns **bid price PER SHARE** (not total proceeds)
- `getPurchaseCost(sym, shares, 'L')` → true total order cost (shares × ask + commission)
- `getSaleGain(sym, shares, 'L')` → total net proceeds (shares × bid − commission)
- `nextUpdate()` → 0 GB RAM, resolves after game engine completes next price tick
- PositionType enum values: `'L'` (Long), `'S'` (Short) — NOT `'Long'`/`'Short'`

## Profit Formula
```
// Pre-check (conservative, 2 commissions):
profitIfSold = (bid - avgPx) × shares - 2 × COMMISSION

// Actual profit after sell (avgPx includes entry commission via game's weighted avg):
profit = (bidPx - avgPx) × shares - COMMISSION

// cashLeft credit after sell:
cashLeft += bidPx × shares - COMMISSION   // total net proceeds
```

## Key Constants
```javascript
BUY_THRESHOLD      = 0.55
SELL_THRESHOLD     = 0.55
TAKE_PROFIT_PCT    = 0.20   // +20% of position cost → sell regardless of forecast
PRICE_STOPLOSS_PCT = 0.15   // bid drops >15% below avgPx → emergency sell
MAX_SHARES_FRAC    = 0.01   // max 1% of maxShares per position (market depth guard)
COMMISSION         = 100_000
TRADE_CAP_FRAC     = 0.02   // max 2% of account per single buy
MIN_ACCOUNT        = 100e6  // no buys below $100M balance
CHURN_COOLDOWN     = 10     // ticks before re-buying same symbol after sell
MIN_POSITION_VALUE = 1e6    // min position size (commission ratio guard)
```

## Architecture
- **Main loop**: `while(true) { await ns.stock.nextUpdate(); tick(); if (flags.once) break; }`
  - Falls back to `sleep(6000)` when TIX not yet purchased
  - `nextUpdate()` guarantees bid/forecast always consistent (no stale-bid race)
- **`ownedByUs` Set**: tracks symbols bought this session; only sells positions in this set (single-entry commission math is correct)
- **Legacy flush**: positions found at startup not in `ownedByUs` → sold unconditionally at start of first tick (unknown entry count → wrong commission math)
- **Port 4**: writes `{ realised, unrealised, positions, buys, sells, mode }` each tick

## Bug History (resolved)
| Bug | Fix | Version |
|-----|-----|---------|
| Wrong profit formula: `proceeds - shares×avgPx` (proceeds = per-share price) | `(proceeds - avgPx) × shares - COMMISSION` | v1.9.11 |
| `cashLeft` budget: `+= bidPerShare` (one share) | `+= bidPx × shares - COMMISSION` | v2.0.0 |
| Stale bid/forecast race (game tick between NS calls) | `nextUpdate()` | v2.0.0 |
| Forecast stop-loss sold into cycle flips (0.69→0.31 in one tick) | Removed forecastStopLoss entirely | v1.9.6 |
| Legacy multi-entry positions: false-positive profitOk | `ownedByUs` set + legacy flush | v1.9.7 |
| `getPurchaseCost` arg `'Long'` → rejected | Fixed to `'L'` | v2.0.0 hotfix |
| MIN_PROFIT=100k forced 15%+ gain on small positions | MIN_PROFIT=0 | v1.9.10 |

## Flags
- `--floor N` — minimum cash fraction to keep liquid (default: 0.30)
- `--once` — single cycle and exit
- `--sell-all` — sell all open long positions and exit

## Files
- `scripts/stocks.js` — the script (standalone, no imports)
- `bitburner-src/` — READ ONLY reference repo, never edit

## Possible Next Work
- Nothing critical outstanding. Script is stable and profitable.
- Optional: use `getSaleGain()` instead of manual `bidPx × shares - COMMISSION` for sell proceeds (equivalent but cleaner)
- Optional: short positions (requires BN8 or SF8 Lv2)
- Optional: dashboard.js integration for live P&L display
