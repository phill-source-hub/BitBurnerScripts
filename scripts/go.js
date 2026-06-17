/**
 * go.js
 * Version: 2.0.0
 *
 * Netburner Protocol (Go) automation for PhlanxOS.
 *
 * Behaviour:
 *   Plays games of Go against the AI to earn faction rep and progress toward
 *   Source-File bonus. Loops: play game to completion, reset, repeat.
 *
 *   Strategy per turn (uses ns.go.analysis API):
 *     1. Capture: fill the last liberty of any enemy group (valid move required)
 *     2. Defend:  fill the last liberty of any of our groups (valid move required)
 *     3. Expand:  best valid move scored by territory control + positional value
 *     4. Pass:    no valid move found
 *
 *   Opponent selection: starts at easiest ('Netburners'), advances after
 *   WIN_THRESHOLD consecutive wins to the next opponent. Tracks wins/losses
 *   per session.
 *
 *   Board size: 7x7 by default (fastest games). Use --size 9 or --size 13 for
 *   larger boards (slower but more territory = more reward per win).
 *
 * Changelog:
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

const VERSION       = '2.0.0';
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
    const capture = findGroupLastLiberty(board, validMoves, liberties, size, 'O');
    if (capture) return capture;

    // --- 2. Defend: fill last liberty of our group ---
    const defend = findGroupLastLiberty(board, validMoves, liberties, size, 'X');
    if (defend) return defend;

    // --- 3. Expand: score all valid moves ---
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
 * Find the last liberty of any group of `color` stones, returning that node if it's a valid move.
 * Uses flood-fill validated by getLiberties() grid for accurate count.
 */
function findGroupLastLiberty(board, validMoves, liberties, size, color) {
    const visited = new Set();

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!board[x] || board[x][y] !== color) continue;
            const key = x + ',' + y;
            if (visited.has(key)) continue;

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

            // Only act when exactly 1 liberty AND engine confirms low liberties on a group stone
            const groupAtRisk = group.some(s => liberties[s.x] && liberties[s.x][s.y] === 1);
            if (groupAtRisk && libSet.size === 1) {
                const node = libSet.values().next().value;
                if (validMoves[node.x] && validMoves[node.x][node.y]) {
                    return node;
                }
            }
        }
    }

    return null;
}

/**
 * Score a candidate move. Higher = better.
 *
 * Factors:
 * - Positional value: 3rd-line positions score highest (good Go opening principle)
 * - Territory: adjacent contested ('?') = +3, adjacent enemy-controlled = +4, adjacent ours = +1
 * - Connectivity: adjacent to our stones = +2 each
 */
function moveScore(board, controlled, x, y, size) {
    let score = positionalScore(x, y, size);

    for (const n of getAdjacent(x, y, size)) {
        const cell = board[n.x] && board[n.x][n.y];
        const ctrl = controlled[n.x] && controlled[n.x][n.y];

        if (cell === '.') {
            if (ctrl === '?') score += 3;
            if (ctrl === 'O') score += 4;
            if (ctrl === 'X') score += 1;
        }
        if (cell === 'X') score += 2;
    }

    return score;
}

/**
 * Positional score: peaks at the 3rd line from each edge (ideal opening positions).
 * Corners (0 distance from edge) and deep centre both score lower.
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
