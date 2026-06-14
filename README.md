# PhlanxOS — BitBurner Automation Suite

Fully automated hacking, resource management, and income maximisation for BitBurner v3.0.1. One install command, then hands-off from early-game 8GB all the way through late-game HWGW batch farming.

---

## How it works

PhlanxOS detects your home RAM tier on every cycle and operates in the appropriate mode automatically. No manual switching required after a reset.

| Tier | Home RAM | Mode |
|------|----------|------|
| 0 | 8 GB | Grow + weaken on home only. Single best target. |
| 1 | 16 GB | Full HWGW on purchased/rooted servers. buy-servers starts. |
| 2 | 32 GB | upgrade-servers and hacknet-manager join. |
| 3 | 64 GB+ | Status dashboard activates. |

**Script roles:**

```
installer.js       — one-shot wget from GitHub, then hands off to bootstrap
bootstrap.js       — kills + relaunches the right scripts for the current tier
  │
  ├── orchestrate.js    — HWGW batch scheduler (tier 0 early mode → full mode)
  │     └── worker.js   — single-op worker: hack / grow / weaken
  │
  ├── auto-root.js      — scans network, roots servers, SF4 auto-backdoor (watch mode)
  ├── buy-servers.js    — fills cloud server slots at 8GB each, then exits
  ├── upgrade-servers.js— even-tier RAM upgrades across all cloud servers, then exits
  ├── hacknet-manager.js— buys and upgrades hacknet nodes continuously
  └── status.js         — live dashboard reading ports 1, 3, 4
```

**Ports used:**

| Port | Owner | Readers | Content |
|------|-------|---------|---------|
| 1 | orchestrate | status | Cycle timing, target modes |
| 2 | auto-root | orchestrate | New root events `{ host, time }` |
| 3 | hacknet-manager | status | Node stats `{ nodes, totalIncome, totalSpent }` |
| 4 | buy/upgrade-servers | status | Server events `{ event, host, ram }` |

---

## Installation

Open the BitBurner terminal on `home` and run:

```
wget https://raw.githubusercontent.com/phill-source-hub/BitBurnerScripts/main/scripts/installer.js /scripts/installer.js
run /scripts/installer.js
```

Expected output:

```
=== installer.js v1.0.0 ===
Downloading 10 scripts from GitHub...
[OK]   /scripts/lib-utils.js
[OK]   /scripts/worker.js
[OK]   /scripts/orchestrate.js
[OK]   /scripts/auto-root.js
[OK]   /scripts/buy-servers.js
[OK]   /scripts/upgrade-servers.js
[OK]   /scripts/hacknet-manager.js
[OK]   /scripts/status.js
[OK]   /scripts/bootstrap.js
[OK]   /scripts/installer.js

Install complete: 10 ok, 0 failed
All scripts installed. Run: run /scripts/bootstrap.js
```

**To update** — re-run installer at any time. All scripts are overwritten with the latest version from GitHub.

---

## Starting the suite

```
run /scripts/bootstrap.js
```

Bootstrap kills any running managed scripts, detects your RAM tier, then launches the appropriate set. Example output on a fresh 8GB home:

```
=== bootstrap.js v1.0.0 ===
[BOOTSTRAP] Home RAM tier: 0 (8GB)
[BOOTSTRAP] Killing managed scripts...
[BOOTSTRAP] Launching scripts for tier 0...
[BOOTSTRAP] OK   scripts/orchestrate.js (pid 1)
[BOOTSTRAP] OK   scripts/auto-root.js (pid 2)
[BOOTSTRAP] SKIP scripts/buy-servers.js — requires tier 1, current tier 0
[BOOTSTRAP] SKIP scripts/upgrade-servers.js — requires tier 2, current tier 0
[BOOTSTRAP] SKIP scripts/hacknet-manager.js — requires tier 2, current tier 0
[BOOTSTRAP] SKIP scripts/status.js — requires tier 3, current tier 0
[BOOTSTRAP] Done.
```

Re-run bootstrap any time you want a clean restart — after a reset, after buying RAM, or after installing updates.

### Bootstrap flags

```
run /scripts/bootstrap.js --all                    # launch everything regardless of tier
run /scripts/bootstrap.js --no-hacknet             # suppress hacknet-manager
run /scripts/bootstrap.js --server-reserve 5e9     # keep $5B floor for server purchases
run /scripts/bootstrap.js --hacknet-reserve 1e9    # keep $1B floor for hacknet purchases
run /scripts/bootstrap.js --no-buy-servers --no-upgrade-servers
```

---

## Status dashboard

`status.js` opens a tail window automatically when launched. Force-run below tier 3 with `--force`:

```
run /scripts/status.js --force
```

Dashboard output (refreshes every second):

```
======================================
 PhlanxOS Status  |  14:32:07
 Tier: 2  |  Home: 18.4/32GB
======================================

[ ORCHESTRATE ]
  Cycle data age: 00:00:02
  n00dles             HACK   01:23 remaining
  joesguns            PREP   02:41 remaining
  phantasy            HACK   00:58 remaining

[ HACKNET ]
  Nodes:  8
  Income: $142.50k/s
  Spent:  $4.21m this session

[ SERVERS ]
  Owned: 13 / 25
  13x 32GB
  Last event: upgrade cloud-server-4 (32GB)

[ HOME ]
  RAM: 18.4/32GB  [##########..........] 58%
  Free: 13.6GB
  Scripts (3):
    scripts/orchestrate.js [1t]
    scripts/auto-root.js [1t]
    scripts/hacknet-manager.js [1t]

======================================
```

---

## Script reference

### `orchestrate.js`
HWGW batch scheduler. Runs continuously on home. Workers execute on purchased and rooted servers only — home is never used as a worker host in tier 1+.

- **Tier 0:** dispatches grow (60%) + weaken (40%) on home using free RAM. Single best target. Auto-restarts in full mode when tier rises or worker servers appear.
- **Tier 1+:** up to 5 simultaneous targets. Binary search for optimal steal fraction per target. Weaken-first PREP strategy (Phase A: security > min+2 → weaken only; Phase B: grow + weaken). Round-robin overflow batches fill surplus RAM.

```
run /scripts/orchestrate.js --help
```

---

### `auto-root.js`
Scans all reachable servers and gains root access using available port crackers. In watch mode, re-attempts every 5 minutes and triggers immediately when new crackers are detected. With Source-File 4, newly rooted servers are auto-backdoored via singularity.

```
run /scripts/auto-root.js            # single pass
run /scripts/auto-root.js --watch    # continuous (bootstrap always uses --watch)
```

---

### `buy-servers.js`
Purchases cloud servers at 8GB until all slots are filled, then exits. Respects the 10% money floor plus any `--reserve` amount.

```
run /scripts/buy-servers.js
run /scripts/buy-servers.js --reserve 10e9    # keep $10B in reserve
```

---

### `upgrade-servers.js`
Upgrades all cloud servers by doubling RAM each cycle. Uses an **even-tier strategy**: finds the server with the lowest RAM and upgrades it before any server advances further. New servers purchased mid-run are caught and upgraded before the farm moves to the next tier. Self-exits when all slots are filled and all servers are at maximum RAM.

```
run /scripts/upgrade-servers.js
run /scripts/upgrade-servers.js --reserve 10e9
```

---

### `hacknet-manager.js`
Purchases and upgrades hacknet nodes continuously. Priority order each cycle: buy new node → upgrade level (cap 200) → upgrade RAM (cap 64GB) → upgrade cores (cap 16).

```
run /scripts/hacknet-manager.js
run /scripts/hacknet-manager.js --reserve 5e9
```

---

### `installer.js`
Downloads all scripts from GitHub. Re-running is the update mechanism — all files are overwritten.

```
wget https://raw.githubusercontent.com/phill-source-hub/BitBurnerScripts/main/scripts/installer.js /scripts/installer.js
run /scripts/installer.js
```

---

## After a BitNode reset

```
wget https://raw.githubusercontent.com/phill-source-hub/BitBurnerScripts/main/scripts/installer.js /scripts/installer.js
run /scripts/installer.js
run /scripts/bootstrap.js
```

Everything starts in tier 0 mode and scales up automatically as you buy home RAM.

---

## Money protection

All spending scripts enforce a **10% money floor** — they will never spend below 10% of your current balance. Use `--reserve N` to add an additional hard floor on top, useful for saving toward home RAM upgrades or augmentations.
