# PhlanxOS — Coding Rules

These rules apply to every script in the project without exception.

---

## 1. File Header

Every script must begin with a JSDoc block containing:
- Script filename
- Version (semver: major.minor.patch)
- One-line description
- Detailed behaviour description
- Changelog (all versions, newest first)
- Flags (if applicable)
- Dependencies (imports used)
- Port usage (if applicable)

Example:
```js
/**
 * script-name.js
 * Version: 1.0.0
 *
 * One-line description.
 *
 * Behaviour:
 *   Detailed explanation of what this script does, how it works,
 *   and any important decisions or constraints.
 *
 * Changelog:
 *   v1.0.0 - Initial version
 *
 * Flags:
 *   --flag-name   Description of flag (default: value)
 *
 * Ports:
 *   Writes port 1: JSON cycle data for status.js
 *   Reads  port 2: Root events from auto-root.js
 *
 * Dependencies:
 *   import { fn } from '/scripts/lib-utils.js';
 */
```

---

## 2. Startup Banner

Every script must print a startup banner as its first action:
```js
ns.tprint('=== script-name.js v1.0.0 ===');
ns.tprint('Args: ' + JSON.stringify(args));
```
After this, scripts operate silently. All runtime output goes to ns.print()
(internal log), never ns.tprint() (terminal), except critical errors.

---

## 3. Comments

Every function must have a JSDoc block explaining:
- What it does
- Each parameter (type + description)
- Return value (type + description)

Every non-trivial line or block must have an inline comment explaining
what it does and why. Comments explain intent, not syntax.

```js
// BAD: increment counter
i++;

// GOOD: advance to next batch slot so landing windows do not collide
batchIndex++;
```

---

## 4. Versioning

Semver: major.minor.patch

- patch: bug fix, no behaviour change
- minor: new feature, backwards compatible
- major: breaking change or full rewrite

Every meaningful change gets a version bump and a changelog entry.
Version is in the file header and in the startup banner.

---

## 5. Imports

Only import from lib-utils.js. No other shared files.
All imports must be explicitly listed (no wildcard imports).
Import path is always: '/scripts/lib-utils.js'

```js
import { getAllServers, log, getRamTier } from '/scripts/lib-utils.js';
```

---

## 6. NS API Usage

Always use the correct current API names. Known corrections:
- ns.hackAnalyzeChance(host)     NOT ns.hackChance(host)
- ns.format.number(n)            NOT ns.formatNumber(n)
- ns.cloud.getServerNames()      NOT ns.getPurchasedServers()
- ns.cloud.getServerLimit()      NOT ns.getPurchasedServerLimit()

When in doubt about an API name, check BitBurner v3 documentation.
Never assume an API name from memory.

---

## 7. RAM Discipline

Every NS function call adds to a script's RAM cost.
Before adding a new NS call, consider:
- Is it already available via lib-utils?
- Can it be called once and cached rather than called in a loop?
- Is there a lower-cost alternative?

Worker scripts (worker.js) are RAM-critical. They must remain at 1.75GB.
Do not add any NS calls to worker.js beyond the single operation call.

---

## 8. Error Handling

All NS calls that can fail must be guarded:
- ns.exec() — check return PID > 0
- ns.scp() — check return value
- ns.wget() — check return value
- Port reads — handle NULL / empty string
- Feature detection (SF4 etc.) — wrap in try/catch

Never let an unguarded failure crash a long-running script.
Log the failure with context and continue or retry next cycle.

---

## 9. Money Protection

Any script spending player money must call canAfford(ns, cost) from
lib-utils before spending. canAfford enforces the 10% floor.
Never inline the floor calculation — always use the shared function.

```js
if (!canAfford(ns, cost)) {
    log(ns, 'Skipping purchase — would breach 10% money floor');
    continue;
}
```

---

## 10. Port Usage

Always use writePort / readPort / clearPort from lib-utils.
Never write raw strings to ports — always JSON.
Always clear owned ports on script startup.
Never consume (read and discard) a port you do not own — use peek only.

---

## 11. Flags

All scripts that accept flags must define them with ns.flags([]) and
document every flag in the file header.
Default values must be sensible for early-game use.

---

## 12. Sleep and Loops

Long-running scripts must call await ns.sleep() in every loop iteration.
Minimum sleep: 200ms to avoid game engine lockup.
Prefer cycle-aware sleep (sleep until next expected event) over fixed intervals.
Never use while(true) without a sleep inside.

---

## 13. Script Exit Conditions

Scripts that should self-exit when their job is done must do so cleanly:
```js
log(ns, 'All servers purchased. Exiting.');
return;
```
Do not leave idle loops running. Self-exit frees home RAM for other scripts.

---

## 14. Naming Conventions

- Constants: SCREAMING_SNAKE_CASE at top of file, after imports
- Functions: camelCase
- Variables: camelCase
- Script paths: string constants at top of file (e.g. SCRIPT_ORCHESTRATE)
- Port numbers: named constants (e.g. PORT_ORCHESTRATE = 1)

---

## 15. No Magic Numbers

Every numeric constant that has a meaning must be named:
```js
// BAD
if (ns.getServerMaxRam('home') >= 64) { ... }

// GOOD
const RAM_TIER_3 = 64;
if (ns.getServerMaxRam('home') >= RAM_TIER_3) { ... }
```

Exceptions: 0, 1, 100 when used as obvious math operands.

---

## 16. Single Responsibility

Each script does one thing. Logic that is reused belongs in lib-utils.
If you find yourself copying a function between scripts, it belongs in lib-utils.

---

## 17. Disabling Logs

Every script must call ns.disableLog('ALL') immediately after the startup
banner. Individual log categories may be re-enabled selectively if needed.

```js
ns.tprint('=== script-name.js v1.0.0 ===');
ns.disableLog('ALL');
```
