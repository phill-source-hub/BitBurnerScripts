/**
 * lib-sf-utils.js
 * Version: 1.0.0
 *
 * Source-File / Singularity utility library for PhlanxOS.
 *
 * Behaviour:
 *   Isolated from lib-utils.js intentionally. Without SF4, BitBurner applies
 *   a 16x RAM multiplier to every singularity function call. Keeping these
 *   utilities here means only scripts that actually need SF4 behaviour pay
 *   the RAM cost — all other scripts import lib-utils.js only.
 *
 *   Import this file only when a script conditionally uses singularity functions
 *   (e.g. auto-root.js for backdooring) or needs to detect SF ownership.
 *
 *   Functions:
 *     hasSF   — detects whether the player owns a specific Source-File
 *     getPath — BFS hop path from home to a target (needed for connect())
 *
 * Changelog:
 *   v1.0.0 - Extracted from lib-utils.js v1.2.0. Isolates singularity RAM cost.
 *
 * Dependencies:
 *   None. This file has no imports.
 */


// =============================================================================
// Source-File Detection
// =============================================================================

/**
 * Detects whether the player has a specific Source-File.
 * Singularity functions require SF4 and throw without it.
 * Wraps detection in try/catch so callers can safely gate SF behaviour.
 * @param {NS} ns
 * @param {number} n - Source-File number (e.g. 4 for SF4)
 * @returns {boolean}
 */
export function hasSF(ns, n) {
    try {
        const sourceFiles = ns.singularity.getOwnedSourceFiles();                   // Throws if SF4 not owned
        return sourceFiles.some(sf => sf.n === n);
    } catch {
        return false;
    }
}


// =============================================================================
// Navigation
// =============================================================================

/**
 * Finds the hop-by-hop path from home to a target server using BFS.
 * Required for ns.singularity.connect() which moves exactly one hop at a time.
 * Returns empty array if target is unreachable.
 * @param {NS} ns
 * @param {string} target - Destination hostname
 * @returns {string[]} Ordered hostnames from home to target (inclusive)
 */
export function getPath(ns, target) {
    const queue   = [['home']];
    const visited = new Set(['home']);

    while (queue.length > 0) {
        const path = queue.shift();
        const node = path[path.length - 1];

        if (node === target) return path;

        for (const neighbour of ns.scan(node)) {
            if (!visited.has(neighbour)) {
                visited.add(neighbour);
                queue.push(path.concat([neighbour]));
            }
        }
    }

    return [];
}
