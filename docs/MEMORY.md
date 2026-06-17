# PhlanxOS — Claude Code Memory

This file provides all context needed to continue development of the
PhlanxOS BitBurner automation suite in a Claude Code session.

Read ARCHITECTURE.md and CODING_RULES.md before writing any code.

---

## What This Project Is

A fully automated BitBurner (v3.0.1) hacking suite in JavaScript using
the Netscript (NS) API. Goal: fully automated network exploitation,
resource management, and income maximisation via HWGW batch scheduling.
The suite must work from the first seconds of an augmentation reset
through to late-game multi-target HWGW batching.

---

## Repository

GitHub: https://github.com/phill-source-hub/BitBurnerScripts
In-game script path: /scripts/
All scripts live in /scripts/ in-game and in /scripts/ in the repo.

---

## Critical NS API Facts (v3.0.1)

These are confirmed correct. Do not deviate.

- ns.hackAnalyzeChance(host)        — hack success probability (NOT ns.hackChance)
- ns.format.number(n)               — format numbers (NOT ns.formatNumber)
- ns.cloud.getServerNames()         — purchased server list (NOT ns.getPurchasedServers)
- ns.cloud.getServerLimit()         — max purchasable servers
- ns.ps(host)                       — returns filenames WITHOUT leading slash
- ns.hacknet.numNodes()             — hacknet node count
- Hacknet constants (not in API):   MaxLevel=200, MaxRam=64, MaxCores=16
- Worker script RAM cost:           1.75GB per thread
- Singularity functions (SF4+):     require Source-File 4. Always wrap in try/catch.

---

## Architecture Summary

### Home is the control plane
All management scripts run on home.
worker.js is the only script distributed to and run on other servers.
After early mode, orchestrate.js must NOT use home RAM for worker threads.

### RAM Tiers
Tier 0 = 8GB home  → orchestrate (early mode) + auto-root only
Tier 1 = 16GB      → + buy-servers
Tier 2 = 32GB      → + upgrade-servers + hacknet-manager
Tier 3 = 64GB+     → + status dashboard

Scripts detect their own tier each cycle and adjust behaviour.
bootstrap.js launches only scripts appropriate to detected tier.

### 10% Money Floor
Any script spending player money must call canAfford(ns, cost) from
lib-utils.js before every spend. canAfford returns false if the spend
would leave the player with less than 10% of current balance.
This applies to: buy-servers.js, upgrade-servers.js, hacknet-manager.js.

### Port Allocation
Port 1 — orchestrate.js writes, status.js reads       (cycle timing, target state)
Port 2 — auto-root.js writes, orchestrate.js reads    (new root events)
Port 3 — hacknet-manager.js writes, status.js reads   (node stats)
Port 4 — buy/upgrade-servers write, status.js reads   (server events)
Port 5 — Reserved

All port I/O uses writePort/readPort/clearPort helpers from lib-utils.js.
Port data is always JSON. Writers clear their port on startup.
Readers that do not own a port use peek only (non-consuming).

---

## Script Inventory (10 active scripts)

| Script              | Purpose |
|---------------------|---------|
| lib-utils.js        | Shared library — the ONLY shared file |
| orchestrate.js      | HWGW batch scheduler, tier-aware (replaces orchestrate + early-orchestrate) |
| auto-root.js        | Root servers, SF4 backdoor, notify orchestrate |
| buy-servers.js      | Purchase cloud servers |
| upgrade-servers.js  | Upgrade cloud server RAM |
| hacknet-manager.js  | Manage hacknet nodes |
| status.js           | Realtime dashboard (tier 3 only) |
| bootstrap.js        | Post-reset launcher, tier-aware |
| worker.js           | Single worker: hack/grow/weaken via arg |
| installer.js        | Pull all scripts from GitHub via wget |

---

## lib-utils.js Exports (full list)

Existing (confirmed working):
- getAllServers(ns)
- getRootAccess(ns, host)
- canHack(ns, host)
- log(ns, msg)
- getPath(ns, target)
- getWorkerServers(ns)
- getRankedTargets(ns)
- isPrepped(ns, host)
- formatTime(ms)

New (to be added):
- getRamTier(ns)          — returns 0-3 based on ns.getServerMaxRam('home')
- hasSF(ns, n)            — try/catch detection of Source-File n
- writePort(ns, port, data) — JSON.stringify and write to port
- readPort(ns, port)      — peek and JSON.parse port data
- clearPort(ns, port)     — drain port fully on script startup
- canAfford(ns, cost)     — true if spend keeps balance above 10% floor
- getScriptRam(ns, script) — safe RAM cost check before exec

---

## orchestrate.js Behaviour

### Tier 0 (early mode, 8GB home)
- Runs entirely on home
- Calculates free home RAM after own script cost
- Dispatches grow + weaken threads on home (remaining RAM)
- Ratio: 60% grow, 40% weaken
- Single best target only
- Each cycle: checks for worker servers — if found, shifts threads there
- Each cycle: checks RAM tier — if risen, restarts in full mode
- Writes to port 1 each cycle

### Tier 1+ (full HWGW mode)
- Multi-target (up to 5)
- PREP mode: grow+weaken until isPrepped()
- HACK mode: 4-worker HWGW batches with landing delays
  - H lands first, WH second, G third, WG fourth
  - Landing spacing: LAND_SPACING ms between each
  - Consecutive batches staggered by BATCH_SPACING ms
- Phase 2: overflow spare RAM to best prepped target
- Cycle-aware sleep using cycleEnd timestamps
- Workers distributed via ns.scp each cycle
- Home excluded from worker pool entirely
- Writes to port 1 each cycle

---

## worker.js

Single file. Usage: run /scripts/worker.js [target] [operation]
Operation must be one of: 'hack', 'grow', 'weaken'
No imports. Standalone. Must remain at 1.75GB RAM cost.

---

## installer.js

On first install or post-reset:
```
wget https://raw.githubusercontent.com/phill-source-hub/BitBurnerScripts/main/scripts/installer.js /scripts/installer.js
run /scripts/installer.js
run /scripts/bootstrap.js
```

installer.js wget-pulls all 10 scripts to /scripts/.
bootstrap.js detects RAM tier and launches appropriate scripts.

---

## Known Bugs Fixed in v2 (do not reintroduce)

1. $0-money server bug: growthAnalyze with $0 money returns astronomically
   large thread counts. Fix: cap prep threads proportionally to available
   pool (min 1 each if non-zero). Never pass 1e9 to growthAnalyze.

2. API name bugs: ns.hackChance → ns.hackAnalyzeChance
                  ns.formatNumber → ns.format.number

3. Negative thread rollback: use freeAllocation() pattern, not negative-
   thread arithmetic to undo partial allocations.

4. SCP not checked: always check ns.scp() return value; skip servers
   that fail the copy.

5. calcBatchThreads must guard against hackAnalyzeThreads returning -1 or NaN.

---

## Coding Rules Summary

Full rules in CODING_RULES.md. Key points:

1. File header: JSDoc with version, description, changelog, flags, ports, deps
2. Startup banner: ns.tprint version + args, then ns.disableLog('ALL')
3. Comments: JSDoc on every function, inline comment on every non-trivial line
4. Versioning: semver, every change gets a bump + changelog entry
5. Imports: only from lib-utils.js, always explicit, never wildcard
6. API names: verify against v3.0.1 docs, never assume from memory
7. RAM discipline: cache NS calls, never add NS calls to worker.js
8. Error handling: guard all exec/scp/wget/port calls, never crash on failure
9. Money protection: always use canAfford() from lib-utils, never inline
10. Port usage: always use helpers, always JSON, always clear on startup
11. Flags: define with ns.flags([]), document in header, sensible defaults
12. Sleep: minimum 200ms in every loop, prefer cycle-aware sleep
13. Self-exit: scripts that complete their job must exit cleanly
14. Naming: SCREAMING_SNAKE for constants, camelCase for everything else
15. No magic numbers: name every meaningful constant
16. Single responsibility: one script, one job. Shared logic → lib-utils

---

## Build Order

When building scripts, follow this order to avoid dependency gaps:
1. lib-utils.js        (no dependencies)
2. worker.js           (no dependencies)
3. orchestrate.js      (depends on lib-utils + worker)
4. auto-root.js        (depends on lib-utils)
5. buy-servers.js      (depends on lib-utils)
6. upgrade-servers.js  (depends on lib-utils)
7. hacknet-manager.js  (depends on lib-utils)
8. status.js           (depends on lib-utils, reads ports)
9. bootstrap.js        (depends on all above existing)
10. installer.js       (standalone, no dependencies)

---

## Testing Checklist

Before marking any script complete:
- [ ] Startup banner prints version and args
- [ ] ns.disableLog('ALL') called immediately after banner
- [ ] Script does not crash when dependent feature unavailable
- [ ] canAfford() used before every player money spend (if applicable)
- [ ] Port cleared on startup (if script owns a port)
- [ ] Port data is valid JSON
- [ ] All NS calls guarded against failure
- [ ] No magic numbers — all constants named
- [ ] JSDoc on every function
- [ ] Inline comment on every non-trivial line
- [ ] Changelog entry added for this version
- [ ] Works at tier 0 (8GB home) without crashing
