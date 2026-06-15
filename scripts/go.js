/**
 * go.js
 * Version: 1.0.0
 *
 * Netburner Protocol (Go) automation for PhlanxOS.
 *
 * Behaviour:
 *   Plays games of Go against the AI to earn faction rep and progress toward
 *   Source-File bonus. Loops: play game to completion, reset, repeat.
 *
 *   Strategy per turn:
 *     1. Defend: if any of our stone groups has only 1 liberty, fill it
 *     2. Attack: if any enemy group has only 1 liberty, capture it
 *     3. Expand:  play the empty node closest to our existing stones that
 *                 would not immediately be captured (has ≥2 liberties after)
 *     4. Pass:    no good move found
 *
 *   Opponent selection: starts at easiest ('Netburners'), advances after
 *   WIN_THRESHOLD consecutive wins to the next opponent. Tracks wins/losses
 *   per session.
 *
 *   Board size: 7x7 by default (fastest games). Use --size 9 or --size 13 for
 *   larger boards (slower but more territory = more reward per win).
 *
 * Changelog:
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
 * RAM: ~4 GB (ns.go.* calls have RAM cost in game)
 */

const VERSION       = '1.0.0';
const WIN_THRESHOLD = 3;                                                             // Wins before advancing to harder opponent

const OPPONENTS = [
    'Netburners',
    'Slum Snakes',
    'The Black Hand',
    'Tetrads',
    'Daedalus',
    'Illuminati',
];

const MOVE_DELAY = 200;                                                              // ms between moves (avoid hammering game loop)

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

    const autoAdvance  = flags['auto-advance'] && !flags['no-advance'];
    let opponentIdx    = Math.max(0, OPPONENTS.indexOf(flags.opponent));
    let consecutiveWins = 0;
    let totalWins      = 0;
    let totalLosses    = 0;

    do {
        const opponent = OPPONENTS[opponentIdx];

        // Start a new game
        try {
            await ns.go.resetBoardState(opponent, flags.size);
        } catch (e) {
            ns.print('[GO] resetBoardState error: ' + e + ' — sleeping 5s');
            await ns.sleep(5000);
            continue;
        }

        ns.print('[GO] New game vs ' + opponent + ' (' + flags.size + 'x' + flags.size + ')');

        // Play until game ends
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
// Game loop — returns 'win', 'loss', or 'tie'
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

        // Game ended — currentPlayer is 'None' when both players have passed
        if (state.currentPlayer === 'None') {
            return interpretResult(state);
        }

        // Not our turn (opponent is thinking)
        if (state.currentPlayer !== 'Black') {
            await ns.sleep(MOVE_DELAY);
            continue;
        }

        // Our turn — pick a move
        const board = ns.go.getBoardState();
        const move  = pickMove(board, boardSize);

        try {
            if (move) {
                await ns.go.makeMove(move.x, move.y);
            } else {
                await ns.go.passTurn();
            }
        } catch (e) {
            // Move rejected (invalid) — pass instead
            try { await ns.go.passTurn(); } catch (_) {}
        }

        await ns.sleep(MOVE_DELAY);
    }
}

function interpretResult(state) {
    // state.blackScore vs state.whiteScore — we're Black
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
 * Board is array of strings, each char: '.' empty, 'X' us (Black), 'O' enemy (White), '#' dead
 */
function pickMove(board, size) {
    const empty   = getEmptyNodes(board, size);
    const ourStones = getStones(board, size, 'X');
    const theirStones = getStones(board, size, 'O');

    if (empty.length === 0) return null;

    // 1. Defend: fill our group's last liberty
    const defendMove = findLastLiberty(board, size, ourStones, 'X');
    if (defendMove && isSafe(board, size, defendMove.x, defendMove.y)) {
        return defendMove;
    }

    // 2. Attack: fill enemy group's last liberty (capture)
    const attackMove = findLastLiberty(board, size, theirStones, 'O');
    if (attackMove && isSafe(board, size, attackMove.x, attackMove.y)) {
        return attackMove;
    }

    // 3. Expand: play adjacent to our stones, safe moves only
    const expansionMoves = empty.filter(n =>
        isAdjacentTo(n, ourStones) && isSafe(board, size, n.x, n.y)
    );
    if (expansionMoves.length > 0) {
        // Pick the one adjacent to most of our stones (consolidate groups)
        expansionMoves.sort((a, b) => countAdjacent(b, ourStones) - countAdjacent(a, ourStones));
        return expansionMoves[0];
    }

    // 4. Any safe empty node in corners/edges first
    const safeMoves = empty.filter(n => isSafe(board, size, n.x, n.y));
    if (safeMoves.length > 0) {
        safeMoves.sort((a, b) => edgeScore(b, size) - edgeScore(a, size));
        return safeMoves[0];
    }

    return null;                                                                     // Pass
}

function getEmptyNodes(board, size) {
    const nodes = [];
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (board[x] && board[x][y] === '.') nodes.push({ x, y });
        }
    }
    return nodes;
}

function getStones(board, size, color) {
    const stones = [];
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (board[x] && board[x][y] === color) stones.push({ x, y });
        }
    }
    return stones;
}

function getLiberties(board, size, x, y) {
    const adj = getAdjacent(x, y, size);
    return adj.filter(n => board[n.x] && board[n.x][n.y] === '.');
}

function getAdjacent(x, y, size) {
    const result = [];
    if (x > 0)        result.push({ x: x - 1, y });
    if (x < size - 1) result.push({ x: x + 1, y });
    if (y > 0)        result.push({ x, y: y - 1 });
    if (y < size - 1) result.push({ x, y: y + 1 });
    return result;
}

/**
 * Find a group with exactly 1 liberty (about to die).
 * Returns that liberty node (the move that would fill/defend it).
 */
function findLastLiberty(board, size, stones, color) {
    const visited = new Set();

    for (const stone of stones) {
        const key = stone.x + ',' + stone.y;
        if (visited.has(key)) continue;

        // Flood-fill to find whole connected group
        const group    = [];
        const queue    = [stone];
        const libSet   = new Set();

        while (queue.length > 0) {
            const curr = queue.pop();
            const k    = curr.x + ',' + curr.y;
            if (visited.has(k)) continue;
            visited.add(k);
            group.push(curr);

            for (const adj of getAdjacent(curr.x, curr.y, size)) {
                const cell = board[adj.x] && board[adj.x][adj.y];
                if (cell === '.') libSet.add(adj.x + ',' + adj.y + ':' + adj.x + ':' + adj.y);
                else if (cell === color) queue.push(adj);
            }
        }

        if (libSet.size === 1) {
            const [, xs, ys] = libSet.values().next().value.split(':');
            return { x: parseInt(xs), y: parseInt(ys) };
        }
    }

    return null;
}

/**
 * Returns true if placing a stone at (x, y) won't immediately be captured.
 * (i.e., after placement the stone/group has ≥2 liberties, OR it captures an enemy group)
 */
function isSafe(board, size, x, y) {
    const adj = getAdjacent(x, y, size);

    // Count liberties this placement would have
    let libs = 0;
    let capturesEnemy = false;

    for (const n of adj) {
        const cell = board[n.x] && board[n.x][n.y];
        if (cell === '.') {
            libs++;
        } else if (cell === 'O') {
            // Check if this adjacent enemy group has only 1 liberty (we capture it)
            const enemyLibs = getLiberties(board, size, n.x, n.y);
            if (enemyLibs.length === 1) capturesEnemy = true;
        }
    }

    return libs >= 2 || capturesEnemy;
}

function isAdjacentTo(node, stones) {
    return stones.some(s => Math.abs(s.x - node.x) + Math.abs(s.y - node.y) === 1);
}

function countAdjacent(node, stones) {
    return stones.filter(s => Math.abs(s.x - node.x) + Math.abs(s.y - node.y) === 1).length;
}

function edgeScore(node, size) {
    // Prefer corners > edges > centre for territory
    const distToEdge = Math.min(node.x, size - 1 - node.x, node.y, size - 1 - node.y);
    return -distToEdge;                                                              // Negative: closer to edge scores higher
}
