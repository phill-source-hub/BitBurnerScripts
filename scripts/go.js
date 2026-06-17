/**
 * go.js
 * Version: 3.8.0
 *
 * Netburner Protocol (Go) automation for PhlanxOS.
 *
 * Behaviour:
 *   Plays games of Go against the AI to earn faction rep and progress toward
 *   Source-File bonus. Loops: play game to completion, reset, repeat.
 *
 *   Strategy per turn (uses ns.go.analysis API):
 *     1. Capture:       fill the last liberty of any enemy group (valid move)
 *     2. Defend:        fill the last liberty of any of our groups (valid move)
 *     3. Defend early:  fill a liberty of any of our groups at ≤2 libs
 *                       (prevents Black Hand's surround→atari combo)
 *     4. Expand:        best valid move scored by territory + threats + connectivity
 *     5. Pass:          no valid move or all remaining moves score very low
 *
 *   Opponent selection: starts at easiest ('Netburners'), advances after
 *   WIN_THRESHOLD consecutive wins to the next opponent. Tracks wins/losses
 *   per session.
 *
 *   Board size: 7x7 by default (fastest games). Use --size 9 or --size 13 for
 *   larger boards (slower but more territory = more reward per win).
 *
 * Changelog:
 *   v3.7.0 - Revert to v3.2.0 pure territory scoring. All chain-based experiments
 *            (v3.3–v3.6) degraded Slum Snakes from 37% to 24–25%; interdict put
 *            isolated stones adjacent to enemy chain = easy captures. v3.2.0 remains
 *            the best baseline. Slum Snakes ceiling is ~37% with this approach.
 *   v3.6.0 - Replace own-chain-grow step with enemy-chain-interdict step: play at the
 *            best liberty of the enemy's largest chain (blocks growth() AIs without
 *            abandoning territory). Revert moveScore to pure v3.2.0 (no chain bonus).
 *            Own-chain-grow gave 50% vs Netburners (down from 64%); interdict tested next.
 *   v3.5.0 - Add findChainLiberty() as dedicated step 4: always extend our largest
 *            chain (mirrors Slum Snakes' growth() exactly) before territory expand.
 *            Revert positional to 2nd-line (floor(size/4)) — 3rd-line made it worse.
 *            Chain bonus in moveScore fallback reduced back to +3 (step 4 handles it).
 *   v3.4.0 - Chain growth bonus +3→+6; positional ideal floor(size/4)→floor(size/3).
 *            Both changes hurt Slum Snakes win rate (24% vs 27%); reverted in v3.5.0.
 *   v3.3.0 - Chain growth: getLargestChainId() from getChains(); moves adjacent to
 *            our largest connected group score +3 extra, mirroring Slum Snakes'
 *            growth() priority. Helps build one strong group vs both chain-growth
 *            and surround-based opponents.
 *   v3.2.0 - Revert moveScore to v2.0.0 simplicity — atari bonuses (+7/+3) and
 *            isolation penalty were causing territory-chasing behaviour that hurt
 *            win rate vs passive opponents. Structural defend-at-2-libs step
 *            (with requirePressure) retained as the TBH counter-measure.
 *   v3.1.0 - Early defend (step 3) now requires enemy adjacency — prevents wasting
 *            moves defending groups that face no actual threat. Fixes regression
 *            vs Netburners where early defend fired on every stone in open play.
 *   v3.0.0 - Defend at ≤2 liberties (not just ≤1) to counter TBH surround combos.
 *            moveScore now uses liberties grid: +7 for putting enemy in atari,
 *            +3 for threatening atari, -6 penalty for isolated exposed moves.
 *            findGroupLastLiberty → findGroupAtLiberties(threshold) with best-liberty
 *            selection when multiple candidates exist.
 *   v2.0.0 - Use ns.go.analysis API for valid moves, liberties, territory control.
 *            Fix edgeScore (was preferring corners; now prefers 3rd-line positions).
 *            Prioritise capturing/defending by exact liberty count from getLiberties().
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --opponent S     Starting opponent (default: 'Netburners')
 *   --size N         Board size 5/7/9/13 (default: 7)
 *   --auto-advance   Advance to harder opponent after WIN_THRESHOLD wins (default: true)
 *   --no-advance     Stay on current opponent forever
 *   --once           Play one game and exit
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~6 GB (ns.go.* + ns.go.analysis.* calls)
 */

const VERSION       = '3.8.0';
const WIN_THRESHOLD = 3;

const OPPONENTS = [
    'Netburners',
    'Slum Snakes',
    'The Black Hand',
    'Tetrads',
    'Daedalus',
    'Illuminati',
];

const MOVE_DELAY = 200;

export async function main(ns) {
    const flags = ns.flags([
        ['opponent',     'Netburners'],
        ['size',         7],
        ['auto-advance', true],
        ['no-advance',   false],
        ['once',         false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== go.js v' + VERSION + ' | opponent=' + flags.opponent + ' size=' + flags.size + ' ===');

    const autoAdvance   = flags['auto-advance'] && !flags['no-advance'];
    let opponentIdx     = Math.max(0, OPPONENTS.indexOf(flags.opponent));
    let consecutiveWins = 0;
    let totalWins       = 0;
    let totalLosses     = 0;

    do {
        const opponent = OPPONENTS[opponentIdx];

        try {
            await ns.go.resetBoardState(opponent, flags.size);
        } catch (e) {
            ns.print('[GO] resetBoardState error: ' + e + ' — sleeping 5s');
            await ns.sleep(5000);
            continue;
        }

        ns.print('[GO] New game vs ' + opponent + ' (' + flags.size + 'x' + flags.size + ')');

        const result = await playGame(ns, flags.size);

        if (result === 'win') {
            totalWins++;
            consecutiveWins++;
            ns.tprint('[GO] WIN vs ' + opponent + ' | streak=' + consecutiveWins + ' | total ' + totalWins + 'W/' + totalLosses + 'L');

            if (autoAdvance && consecutiveWins >= WIN_THRESHOLD && opponentIdx < OPPONENTS.length - 1) {
                opponentIdx++;
                consecutiveWins = 0;
                ns.tprint('[GO] Advanced to opponent: ' + OPPONENTS[opponentIdx]);
            }
        } else {
            totalLosses++;
            consecutiveWins = 0;
            ns.print('[GO] ' + result.toUpperCase() + ' vs ' + opponent + ' | total ' + totalWins + 'W/' + totalLosses + 'L');
        }

    } while (!flags.once);
}


// =============================================================================
// Game loop
// =============================================================================

async function playGame(ns, boardSize) {
    while (true) {
        let state;
        try {
            state = ns.go.getGameState();
        } catch (e) {
            ns.print('[GO] getGameState error: ' + e);
            return 'loss';
        }

        if (state.currentPlayer === 'None') {
            return interpretResult(state);
        }

        if (state.currentPlayer !== 'Black') {
            await ns.sleep(MOVE_DELAY);
            continue;
        }

        const board      = ns.go.getBoardState();
        const validMoves = ns.go.analysis.getValidMoves();
        const liberties  = ns.go.analysis.getLiberties();
        const controlled = ns.go.analysis.getControlledEmptyNodes();
        const move       = pickMove(board, validMoves, liberties, controlled, boardSize);

        try {
            if (move) {
                await ns.go.makeMove(move.x, move.y);
            } else {
                await ns.go.passTurn();
            }
        } catch (e) {
            try { await ns.go.passTurn(); } catch (_) {}
        }

        await ns.sleep(MOVE_DELAY);
    }
}

function interpretResult(state) {
    if (!state) return 'loss';
    if (state.blackScore > state.whiteScore) return 'win';
    if (state.blackScore < state.whiteScore) return 'loss';
    return 'tie';
}


// =============================================================================
// Move selection
// =============================================================================

/**
 * Returns { x, y } for best move, or null to pass.
 *
 * board      — string[] from getBoardState(). board[x][y]: '.' empty, 'X' us, 'O' enemy, '#' dead
 * validMoves — boolean[][] from getValidMoves(). validMoves[x][y] = true if legal
 * liberties  — number[][] from getLiberties(). liberties[x][y] = count for stone, -1 for empty/dead
 * controlled — string[] from getControlledEmptyNodes(). controlled[x][y] = 'X'/'O'/'?'/'#'
 */
function pickMove(board, validMoves, liberties, controlled, size) {
    // --- 1. Capture: fill last liberty of an enemy group ---
    const capture = findGroupAtLiberties(board, validMoves, liberties, size, 'O', 1);
    if (capture) return capture;

    // --- 2. Defend critical: fill last liberty of our group ---
    const defend1 = findGroupAtLiberties(board, validMoves, liberties, size, 'X', 1);
    if (defend1) return defend1;

    // --- 3. Defend early: extend our group at ≤2 libs, but ONLY when an enemy stone
    //        is already adjacent — no point defending groups under no actual pressure ---
    const defend2 = findGroupAtLiberties(board, validMoves, liberties, size, 'X', 2, true);
    if (defend2) return defend2;

    // --- 4. Expand: score all valid moves ---
    const candidates = [];
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!validMoves[x] || !validMoves[x][y]) continue;
            candidates.push({ x, y, score: moveScore(board, controlled, x, y, size) });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Pass if best move scores very low
    if (best.score < -5) return null;

    return best;
}

/**
 * Find the best liberty to fill for any group of `color` at exactly `threshold` (or fewer) liberties.
 * When multiple candidates exist, picks the one giving the most empty breathing room.
 *
 * threshold=1      → capture/defend (group has 1 lib left — immediate action needed)
 * threshold=2      → early defend (group has 2 libs — prevent TBH's surround-to-atari next turn)
 * requirePressure  → when true, only act if an enemy stone is already adjacent to the group;
 *                    prevents wasting moves defending groups that face no actual threat
 */
function findGroupAtLiberties(board, validMoves, liberties, size, color, threshold, requirePressure = false) {
    const visited = new Set();
    let bestMove  = null;
    let bestScore = -Infinity;
    const enemy   = color === 'X' ? 'O' : 'X';

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!board[x] || board[x][y] !== color) continue;
            if (!liberties[x] || liberties[x][y] > threshold) continue;   // quick filter
            const key = x + ',' + y;
            if (visited.has(key)) continue;

            // Flood-fill the connected group
            const queue          = [{ x, y }];
            const group          = [];
            const libSet         = new Map();
            let   hasEnemyAdjacent = false;

            while (queue.length > 0) {
                const curr = queue.pop();
                const k    = curr.x + ',' + curr.y;
                if (visited.has(k)) continue;
                visited.add(k);
                group.push(curr);

                for (const adj of getAdjacent(curr.x, curr.y, size)) {
                    const cell = board[adj.x] && board[adj.x][adj.y];
                    if (cell === '.') {
                        libSet.set(adj.x + ',' + adj.y, adj);
                    } else if (cell === color) {
                        queue.push(adj);
                    } else if (cell === enemy) {
                        hasEnemyAdjacent = true;
                    }
                }
            }

            // Engine must confirm at least one stone in this group is at risk
            const groupAtRisk = group.some(s => liberties[s.x] && liberties[s.x][s.y] <= threshold);
            if (!groupAtRisk) continue;

            // When requirePressure is set, skip groups with no adjacent enemy — no real threat yet
            if (requirePressure && !hasEnemyAdjacent) continue;

            // For threshold=1: group has exactly 1 liberty (immediate capture/defend)
            // For threshold=2: group may have 1 or 2 liberties
            if (libSet.size > threshold) continue;

            // Score each candidate liberty by how much room it gives after placement
            for (const node of libSet.values()) {
                if (!validMoves[node.x] || !validMoves[node.x][node.y]) continue;

                const adj2           = getAdjacent(node.x, node.y, size);
                const emptyNeighbors = adj2.filter(n => board[n.x] && board[n.x][n.y] === '.').length;
                const ownNeighbors   = adj2.filter(n => board[n.x] && board[n.x][n.y] === color).length;
                // More empty = more future liberties; more own = better connectivity
                const score = emptyNeighbors * 2 + ownNeighbors;

                if (score > bestScore) {
                    bestScore = score;
                    bestMove  = node;
                }
            }
        }
    }

    return bestMove;
}

/**
 * Score a candidate move. Higher = better.
 *
 * Factors:
 * - Positional: 2nd-line preferred (ideal = floor(size/4))
 * - Territory:  extend own ('X' ctrl) +3, neutral ('?') +2, enemy ('O') -3 — build our moyo, don't walk into theirs
 * - Connectivity: adjacent own stone +2
 * - Openness: +0.5 per empty cell within Manhattan-2 — prefer open space over contested zones
 */
function moveScore(board, controlled, x, y, size) {
    let score = positionalScore(x, y, size);

    for (const n of getAdjacent(x, y, size)) {
        const cell = board[n.x] && board[n.x][n.y];
        const ctrl = controlled[n.x] && controlled[n.x][n.y];

        if (cell === '.') {
            if (ctrl === 'X') score += 3;
            if (ctrl === '?') score += 2;
            if (ctrl === 'O') score -= 3;
        }
        if (cell === 'X') score += 2;
    }

    // Openness: empty cells within Manhattan distance 2 — more open space = more future potential
    for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
            if (Math.abs(dx) + Math.abs(dy) > 2) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
            if (board[nx] && board[nx][ny] === '.') score += 0.5;
        }
    }

    return score;
}

/**
 * Positional score: peaks at the ideal line from each edge.
 * ideal = floor(size/4): 7→1 (2nd line), 9→2 (3rd line), 13→3 (4th line).
 * On a 7x7 board, 2nd-line play provides edge-backed groups harder for TBH to surround.
 */
function positionalScore(x, y, size) {
    const ideal = Math.floor(size / 4);                                             // 2nd-line preferred (7→1, 9→2, 13→3) — edge-backed groups harder to surround
    const dx    = Math.min(x, size - 1 - x);
    const dy    = Math.min(y, size - 1 - y);
    return 6 - Math.abs(dx - ideal) - Math.abs(dy - ideal);
}

function getAdjacent(x, y, size) {
    const result = [];
    if (x > 0)        result.push({ x: x - 1, y });
    if (x < size - 1) result.push({ x: x + 1, y });
    if (y > 0)        result.push({ x, y: y - 1 });
    if (y < size - 1) result.push({ x, y: y + 1 });
    return result;
}
