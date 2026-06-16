# PhlanxOS — Architecture Document

## Overview

PhlanxOS is a fully automated BitBurner hacking suite.
It is self-managing, RAM-tier-aware, GitHub-deployed, and designed to operate
from the first seconds of a fresh reset through to late-game augmentation.

All scripts run on home except worker.js, which is distributed to and executed
on worker servers. Home is the control plane only.

---

## Guiding Principles

1. Home is the control plane. Workers run elsewhere.
2. All scripts are RAM-tier aware. One script handles early and late game.
3. Graceful degradation. Unavailable features are skipped silently and
   activated automatically when they become available.
4. GitHub is the source of truth. One installer command restores everything.
5. Scripts are silent after startup. They announce version/args once, then
   log internally. The dashboard is the only live UI.
6. Port-based IPC only. Scripts communicate via ports. No file polling.
7. 10% money floor. Any script spending player money must retain at least
   10% of current balance at time of spend.
8. lib-utils.js is the only shared library. No logic is duplicated across scripts.

---

## RAM Tiers (Home)

Tier is calculated from ns.getServerMaxRam('home').

| Tier | Home RAM | Scripts Active |
|------|----------|----------------|
| 0    | 8GB      | orchestrate (early mode), auto-root |
| 1    | 16GB     | + buy-servers |
| 2    | 32GB     | + upgrade-servers, hacknet-manager |
| 3    | 64GB+    | + status dashboard |

Bootstrap launches only scripts appropriate to the detected tier.
Scripts that exceed available RAM are skipped with a logged reason.

---

## Port Allocation

| Port | Owner (clears on startup)        | Readers                                          | Content |
|------|----------------------------------|--------------------------------------------------|---------|
| 1    | orchestrate.js                   | status.js, dashboard.js                          | Cycle timing, target state, mode |
| 2    | auto-root.js                     | orchestrate.js                                   | New root events `{ host }` |
| 3    | hacknet-manager.js               | status.js, dashboard.js                          | Node count, income rate, spend events |
| 4    | buy-servers.js / upgrade-servers.js | status.js, dashboard.js                       | Server purchase/upgrade events |
| 5    | singularity.js                   | dashboard.js                                     | Active faction, rep, favour `{ faction, rep, favour }` |
| 6    | dnet-orchestrate.js / dnet-crack.js | dnet-orchestrate.js, dnet-watch.js, dnet-crack.js | Cracked darknet creds `[{ host, password }]` — peek-safe (non-consuming) |
| 7    | dnet-orchestrate.js (clears on startup) | dnet-orchestrate.js                      | Crack worker results `[{ host, password\|null }]` — drained each cycle |

### Rules
- Each port has exactly one **owner** script that calls `clearPort()` on startup and is responsible for writing.
- Other scripts may **peek** (non-consuming) but must not clear.
- `dnet-crack.js` is an exception on port 6 — it appends creds when run standalone; orchestrate owns the clear.
- All port data is JSON. `lib-utils.writePort` / `readPort` / `clearPort` enforce encode/decode/drain.
- Never add a new script that writes to ports 1–7 without updating this table.

---

## Money Protection Rule

Any script that spends player money must:
- Read ns.getPlayer().money at time of intended spend
- Calculate 10% floor: floor = money * 0.10
- Only spend if: (money - cost) >= floor
- Log and skip if floor would be breached

Applies to: buy-servers.js, upgrade-servers.js, hacknet-manager.js

---

## Script Inventory

### Active Scripts

| Script                | Location                      | Purpose |
|-----------------------|-------------------------------|---------|
| lib-utils.js          | /scripts/lib-utils.js         | Shared library |
| orchestrate.js        | /scripts/orchestrate.js       | HWGW batch scheduler, tier-aware |
| auto-root.js          | /scripts/auto-root.js         | Root servers, backdoor (SF4), notify orchestrate |
| buy-servers.js        | /scripts/buy-servers.js       | Purchase cloud servers |
| upgrade-servers.js    | /scripts/upgrade-servers.js   | Upgrade cloud server RAM |
| hacknet-manager.js    | /scripts/hacknet-manager.js   | Manage hacknet nodes |
| status.js             | /scripts/status.js            | Realtime dashboard (tier 3 only) |
| bootstrap.js          | /scripts/bootstrap.js         | Post-reset launcher, tier-aware |
| worker.js             | /scripts/worker.js            | Single worker: hack/grow/weaken |
| installer.js          | /scripts/installer.js         | Pull all scripts from GitHub |
| **Darknet**           |                               | |
| dnet-orchestrate.js   | /scripts/dnet-orchestrate.js  | Master darknet controller — runs on home, propagates to hub; crack → memfree → phish → stasis |
| dnet-crack-worker.js  | /scripts/dnet-crack-worker.js | Exec'd by orchestrate with N threads; more threads = faster authenticate(); writes result to port 7 |
| dnet-crack.js         | /scripts/dnet-crack.js        | Manual one-shot cracker with heartbleed hints; standalone use |
| dnet-watch.js         | /scripts/dnet-watch.js        | Monitors mutations, reconnects sessions from port 6 creds |
| dnet-phish.js         | /scripts/dnet-phish.js        | Phishing attack loop — **must run ON a darknet server** |
| dnet-memfree.js       | /scripts/dnet-memfree.js      | Frees blocked RAM via memoryReallocation() — needs active session |
| dnet-stasis-set.js    | /scripts/dnet-stasis-set.js   | One-shot worker exec'd onto target to apply/remove stasis link (12 GB cost) |
| dnet-scan.js          | /scripts/dnet-scan.js         | One-shot: probe darknet and print all server details |

### Retired from v2

| Script                        | Reason |
|-------------------------------|--------|
| early-orchestrate.js          | Merged into orchestrate.js tier 0 mode |
| worker-hack/grow/weaken.js    | Replaced by single worker.js |
| calc-threads.js               | Already retired |
| backdoor.js                   | Merged into auto-root.js, SF4-gated |
| deploy.js                     | Replaced by installer.js |
| scan-network.js               | Functionality lives in lib-utils.js |

---

## Darknet Architecture

### Topology & Visibility
- `home` sees only `darkweb` (the hub, depth=-1)
- `darkweb` sees depth-0 servers directly
- Deeper servers visible only from deeper hosts — orchestrator propagates inward layer by layer

### Session Model
- `authenticate()` and `connectToSession()` sessions are **PID-bound** — only the calling script's PID holds the session
- On mutation, sessions are lost; orchestrator calls `connectToSession(host, password)` each cycle to restore them
- `dnet-crack-worker.js` cracks on behalf of the orchestrator; orchestrator then calls `connectToSession()` with the discovered password to get its own session

### Propagation Chain
```
home:dnet-orchestrate.js
  → SCP stasis worker to darkweb, exec (12 GB), wait one cycle
  → RAM freed, stasis confirmed
  → SCP + exec dnet-orchestrate.js onto darkweb
  → propagateToStasisLinked(): for each stasis-linked server with known password
      → connectToSession(host, pw) at any distance (stasis enables this)
      → exec dnet-orchestrate.js onto depth-0 / depth-1 / deeper servers

       darkweb:dnet-orchestrate.js
         → crackInline() depth-0 servers (ZeroLogon → "" or numeric brute-force)
         → exec dnet-phish.js onto depth-0 server (reserves ORCH_RAM_GB)
         → exec dnet-stasis-set.js onto depth-0 server
         → propagateToStasisLinked() (for depth-1+ servers, home handles these)

       depth-0:dnet-orchestrate.js  (exec'd by home via stasis remote exec)
         → crackInline() depth-1 servers
         → exec dnet-phish.js onto depth-1 server
         → exec dnet-stasis-set.js onto depth-1 server
         → propagateToStasisLinked() triggers home to push into depth-2
         → (recursive — each layer enables the next)
```

### Darknet Port Conventions
| Port | Owner                    | Content |
|------|--------------------------|---------|
| 6    | dnet-orchestrate.js      | `[{ host, password }]` — all cracked creds; peek-safe |
| 7    | dnet-orchestrate.js      | `[{ host, password\|null }]` — crack worker results; drained each cycle |

### Hub Stability (darkweb)
Mutations can restart darkweb, killing the orchestrator mid-crack. Mitigation:
1. Stasis worker exec'd onto darkweb before propagating orchestrator
2. Stasis worker needs 12 GB; orchestrator needs 5 GB — cannot both fit simultaneously on darkweb (~14 GB)
3. Solution: exec stasis worker and `return` immediately (cycle 1); next cycle stasis is confirmed + 12 GB freed; then exec orchestrator (cycle 2)

### Crack Worker Threading
`authenticate()` speed scales with thread count. The orchestrator execs `dnet-crack-worker.js` with:
```
threads = floor(freeRam / CRACK_WORKER_RAM_GB)   // CRACK_WORKER_RAM_GB ≈ 1.1 GB
```
On darkweb (~14 GB total, ~5 GB used by orchestrator) this yields ~8 threads = ~8× speedup per attempt.

### stasis Link Constraints
- Global limit starts at 1, increases with deep-darknet augmentations
- Priority: hub nodes (darkweb) get stasis first to prevent orchestrator restarts
- `dnet-stasis-set.js` must be exec'd **on the target** (setStasisLink acts on the running script's host)
- Cost: 12 GB RAM on target while the worker runs (exits after one call)

---

## Script Designs

### lib-utils.js
Exports:
- getAllServers(ns) — recursive scan of all reachable servers
- getRootAccess(ns, host) — attempt root using available crackers + NUKE
- canHack(ns, host) — player hack level >= server requirement
- log(ns, msg) — internal print with [BB] prefix
- getPath(ns, target) — BFS path from home to target (for SF4 connect)
- getWorkerServers(ns) — rooted non-home servers with RAM >= 1.75GB, sorted largest first
- getRankedTargets(ns) — scored target list: (maxMoney/weakenTime)*hackChance*hackPercent
- isPrepped(ns, host) — security <= min+1 AND money >= 99% max
- formatTime(ms) — ms to "Xm Ys" string
- getRamTier(ns) — returns 0-3 based on home max RAM
- hasSF(ns, n) — true if player has Source-File n (try/catch guarded)
- writePort(ns, port, data) — JSON encode and write to port
- readPort(ns, port) — JSON decode port read (non-consuming peek)
- clearPort(ns, port) — drain port completely on startup
- canAfford(ns, cost) — true if spend keeps balance above 10% floor
- getScriptRam(ns, script) — safe RAM cost check before exec

### orchestrate.js
Tier 0 (early mode, 8GB home):
- Detects tier 0 on start
- Calculates free home RAM after own script cost
- Dispatches grow/weaken threads on home using remaining RAM
- Fixed ratio: 60% grow threads, 40% weaken threads
- Single best target only
- Monitors for worker servers each cycle; when found, shifts threads there
- Monitors RAM tier each cycle; when tier rises, restarts in full mode
- Writes to port 1 each cycle

Tier 1+ (full HWGW mode):
- Multi-target (up to 5)
- PREP mode: grow+weaken until sec<=min+1 and money>=99% max
- HACK mode: 4-worker HWGW batches with landing delays
- Phase 2: overflow spare RAM to best prepped target
- Cycle-aware sleep via cycleEnd timestamps
- Workers distributed via ns.scp each cycle
- Home excluded from worker pool
- Writes to port 1 each cycle

### auto-root.js
- Scans all servers each cycle
- Attempts getRootAccess on all unrooted reachable servers
- On new root: writes event to port 2
- SF4 detected (hasSF(ns, 4)): auto-backdoors newly rooted hackable servers
- --watch flag: continuous loop. Without flag: single pass and exit.

### worker.js
Usage: run /scripts/worker.js [target] [operation]
- operation: 'hack' | 'grow' | 'weaken'
- Executes ns.hack / ns.grow / ns.weaken on target
- 1.75GB RAM
- No imports. Standalone.

### buy-servers.js
- Purchases cloud servers up to ns.cloud.getServerLimit()
- Default RAM: 8GB (smallest purchasable)
- Respects canAfford() — 10% money floor
- Writes purchase event to port 4
- Self-exits when all slots full

### upgrade-servers.js
- Iterates owned cloud servers, upgrades RAM if affordable
- Doubles RAM each upgrade step
- Respects canAfford() — 10% money floor
- Writes upgrade event to port 4
- --reserve flag: minimum balance to maintain (additional to 10% floor)
- Self-exits when all servers at max RAM

### hacknet-manager.js
- Buys new nodes when affordable
- Upgrades level, RAM, cores on existing nodes in priority order
- Hardcoded caps: MaxLevel=200, MaxRam=64, MaxCores=16
- Respects canAfford() — 10% money floor
- --reserve flag: minimum balance to maintain
- Writes node stats to port 3 each cycle

### status.js
- Only active at tier 3 (64GB+ home RAM) or --force flag
- Reads ports 1, 3, 4 each refresh (1000ms cycle)
- Sections:
  - Orchestrate: targets, mode (PREP/HACK), cycle timing, $/s estimate
  - Hacknet: node count, total income rate
  - Servers: owned count, RAM distribution
  - Home: RAM used/free, tier, script list
- ns.clearLog() + ns.print() each cycle for clean refresh
- Does not consume ports — uses peek only

### bootstrap.js
- Detects RAM tier on start
- Kills all managed scripts before relaunch (clean state)
- Launches scripts in dependency order for detected tier
- Reports each launch/skip with reason
- Flags:
  - --all: force launch everything regardless of tier
  - --no-[script]: suppress specific script
  - --hacknet-reserve N: passed to hacknet-manager
  - --server-reserve N: passed to upgrade-servers

### installer.js
- Hardcoded GitHub raw base URL
- File list hardcoded: all 10 active scripts
- wget each file to correct /scripts/ path
- Reports success/fail per file
- Usage: run /scripts/installer.js

---

## Install Flow (post-reset)

```
# Step 1: pull installer (only manual wget needed)
wget https://raw.githubusercontent.com/phill-source-hub/BitBurnerScripts/main/scripts/installer.js /scripts/installer.js

# Step 2: pull all scripts
run /scripts/installer.js

# Step 3: launch everything appropriate to current tier
run /scripts/bootstrap.js
```

Three commands. Full operation restored.

---

## Orchestrate Early Mode — RAM Budget (8GB Home)

Orchestrate.js RAM cost (estimated): ~3.5GB with NS function imports
Available for threads: ~2.5GB
worker.js thread cost: 1.75GB
Maximum home threads in tier 0: 1 (grow) + 1 (weaken) = 2 threads

This is intentionally minimal. The value of tier 0 is maintaining
momentum on a single target until purchased servers arrive.
As soon as worker servers exist, threads shift there and home RAM is freed.

---

## Testing Approach

### Unit (per script)
- Launch script, confirm startup banner printed (version, name, args)
- Confirm script does not crash when feature is unavailable (no SF4, no hacknet, etc.)
- Confirm 10% money floor respected (buy nothing when balance is low)
- Confirm port written correctly (use ns.peek to verify JSON structure)

### RAM Tier
- Test bootstrap at 8GB: confirm only orchestrate + auto-root launch
- Test bootstrap at 16GB: confirm buy-servers added
- Test bootstrap at 32GB: confirm upgrade-servers + hacknet-manager added
- Test bootstrap at 64GB: confirm status launches

### Integration
- Fresh reset: run 3-command install, confirm correct tier scripts start
- auto-root → orchestrate: root a new server, confirm port 2 written, orchestrate picks up next cycle
- orchestrate → status: confirm port 1 data visible in dashboard each cycle
- hacknet-manager → status: confirm port 3 data visible

### Regression
- After any single script change: run bootstrap, confirm all other scripts unaffected
- Confirm lib-utils exports all expected functions before deploying (check import statements compile)

### Post-augmentation reset
- Install fresh, confirm tier 0 mode activates correctly on 8GB home
- Confirm scripts self-upgrade behaviour as RAM increases (buy home RAM upgrade, confirm tier shifts)
