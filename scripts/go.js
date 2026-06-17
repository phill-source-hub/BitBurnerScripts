/**
 * go.js
 * Version: 3.0.0
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

const VERSION       = '3.0.0';
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

    // --- 3. Defend early: extend our group at ≤2 libs before TBH reduces to atari ---
    const defend2 = findGroupAtLiberties(board, validMoves, liberties, size, 'X', 2);
    if (defend2) return defend2;

    // --- 4. Expand: score all valid moves ---
    const candidates = [];
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!validMoves[x] || !validMoves[x][y]) continue;
            candidates.push({ x, y, score: moveScore(board, liberties, controlled, x, y, size) });
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
 * threshold=1 → capture/defend (group has 1 lib left — immediate action needed)
 * threshold=2 → early defend (group has 2 libs — prevent TBH's surround-to-atari next turn)
 */
function findGroupAtLiberties(board, validMoves, liberties, size, color, threshold) {
    const visited = new Set();
    let bestMove  = null;
    let bestScore = -Infinity;

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!board[x] || board[x][y] !== color) continue;
            if (!liberties[x] || liberties[x][y] > threshold) continue;   // quick filter
            const key = x + ',' + y;
            if (visited.has(key)) continue;

            // Flood-fill the connected group
            const queue  = [{ x, y }];
            const group  = [];
            const libSet = new Map();

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
                    }
                }
            }

            // Engine must confirm at least one stone in this group is at risk
            const groupAtRisk = group.some(s => liberties[s.x] && liberties[s.x][s.y] <= threshold);
            if (!groupAtRisk) continue;

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
 * Factors (in rough order of weight):
 * - Atari threat:   +7 if reduces enemy group to 1 lib (we can capture next turn)
 * - Extend ally:    +4 if adjacent to our group at ≤2 libs (stabilises threatened group)
 * - Threaten:       +3 if reduces enemy group to 2 libs (threatens atari in 2 moves)
 * - Connectivity:   +2 per adjacent friendly stone
 * - Territory:      +3 adjacent enemy-controlled empty, +2 contested, +1 ours
 * - Positional:     3rd-line positions preferred (ideal = floor(size/4))
 * - Isolation:      -6 for no friendly neighbors AND ≤2 empty neighbors (TBH magnets)
 */
function moveScore(board, liberties, controlled, x, y, size) {
    let score = positionalScore(x, y, size);

    const adj = getAdjacent(x, y, size);

    const emptyNeighbors    = adj.filter(n => board[n.x] && board[n.x][n.y] === '.').length;
    const friendlyNeighbors = adj.filter(n => board[n.x] && board[n.x][n.y] === 'X').length;

    // Isolated stones on an open board are trivially surrounded by TBH
    if (friendlyNeighbors === 0 && emptyNeighbors <= 2) score -= 6;
    else if (friendlyNeighbors === 0 && emptyNeighbors === 3) score -= 2;

    for (const n of adj) {
        const cell = board[n.x] && board[n.x][n.y];
        const ctrl = controlled[n.x] && controlled[n.x][n.y];
        const lib  = liberties[n.x] ? liberties[n.x][n.y] : -1;

        if (cell === '.') {
            if (ctrl === '?') score += 2;
            if (ctrl === 'O') score += 3;
            if (ctrl === 'X') score += 1;
        }

        if (cell === 'X') {
            score += 2;                              // Connectivity
            if (lib > 0 && lib <= 2) score += 4;   // Extending a threatened group
        }

        if (cell === 'O') {
            // Reducing enemy liberties — key against TBH's methodical surround strategy
            if (lib === 2) score += 7;              // Puts them in atari (1 lib left)
            else if (lib === 3) score += 3;         // Threatens atari next move
            else if (lib > 0 && lib <= 5) score += 1;
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
    const ideal = Math.floor(size / 4);
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
