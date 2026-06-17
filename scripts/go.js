/**
 * go.js
 * Version: 3.17.2
 *
 * Netburner Protocol (Go) automation for PhlanxOS.
 *
 * Behaviour:
 *   Plays games of Go against the AI to earn faction rep and progress toward
 *   Source-File bonus. Loops: play game to completion, reset, repeat.
 *
 *   Strategy per turn (uses ns.go.analysis API):
 *     1.   Capture:      fill the last liberty of any enemy group
 *     2.   Defend:       fill the last liberty of any of our groups
 *     3.   Defend early: fill liberty of our group at <=2 libs (enemy adjacent)
 *     3.5. Anchor:       first 3 moves build connected group near center (≥3 libs)
 *     4.   MCTS:         rank top-N by territory-aware heuristic via rollouts
 *     5.   Pass:         no valid moves remain (game engine ends naturally)
 *
 *   Opponent selection: starts at easiest ('Netburners'), advances after
 *   WIN_THRESHOLD consecutive wins to the next opponent. Tracks wins/losses
 *   per session.
 *
 *   Board size: 7x7 by default (fastest games). Use --size 9 or --size 13 for
 *   larger boards (slower but more territory = more reward per win).
 *
 * Changelog:
 *   v3.17.1 - Opening anchor (step 3.5): first 3 moves build connected group near
 *             center before MCTS territory contest. Move 1 = closest valid cell to
 *             center with ≥3 libs. Move 2-3 = best adjacent extension by liberty count.
 *             Prevents X=0 losses caused by isolated early stones being surrounded.
 *   v3.17.0 - Revert to v3.16.3 strategy (MCTS + original heuristic weights).
 *             v3.16.7–9 changes (≤1 lib filter, X×8 bonus, no-MCTS) all degraded
 *             performance. Code comment explicitly warns X>+2 degrades SS win rate.
 *             Keep: '#' fix, board logging on loss, opponent demotion.
 *   v3.16.9 - Drop MCTS rollout selection: random rollouts don't model systematic
 *             surrounding and override the heuristic with noise. Return top heuristic
 *             candidate directly. Heuristic: position + territory gain + X-adj×8 + '#'×2.
 *   v3.16.8 - Increase friendly-adjacency bonus: X+2→+8, add '#'+2 (wall bonus).
 *             Scattered isolated stones were getting surrounded; low +2 weight let
 *             territory/enemy-control bonuses dominate, discouraging group connection.
 *   v3.16.7 - Filter MCTS candidates with ≤1 liberty after placement: stones in atari
 *             immediately after being placed get captured next turn, causing the same
 *             cell to be replayed repeatedly (X=0 boards). Skip those candidates.
 *   v3.16.6 - Log every move/pass/error to diagnose persistent X=0 boards.
 *   v3.16.5 - Fix critical passing bug: remove bestRate<0.05 early-pass threshold.
 *             When MCTS was pessimistic, we passed every turn → X=0, O=~45 boards.
 *             Now always play MCTS best candidate; game ends naturally when both pass.
 *   v3.16.4 - Log final board state + score on every loss for pattern analysis.
 *   v3.16.3 - Remove smother (step 3.7): overrode MCTS even when territory move
 *             was better. SS win rate near 0% with smother active. Isolates
 *             v3.15.0 territory+MCTS as clean baseline to measure from.
 *   v3.16.2 - Opponent demotion: after WIN_THRESHOLD consecutive losses drop back one
 *             opponent. Removes --auto-advance/--no-advance flags (always on).
 *             Prevents getting stuck on TBH (9% win rate) after advancing from SS.
 *   v3.16.1 - Revert eye create/block (steps 3.5/3.6): caused 26% SS win rate (vs 37%
 *             baseline). Eye block played weak moves inside O-controlled territory.
 *             Functions retained for future refinement. Keep: '#' fix + smother.
 *   v3.16.0 - Four new improvements from doc review:
 *             1. Fix '#' dead cells in _toFlat (encoded as 0 = playable; now 3 = blocked).
 *             2. Eye creation (step 3.5): find moves that split our controlled territory
 *                into 2 separate enclosed regions — makes our group permanently uncapturable.
 *             3. Eye blocking (step 3.6): find the enemy's vital eye-splitting point inside
 *                their controlled territory and play there first.
 *             4. Smother (step 3.7): attack enemy groups at exactly 2 libs with safe
 *                placement — reduces them toward atari without exposing our stones.
 *   v3.15.0 - Territory completion scoring + improved MCTS.
 *             B: add TERR_WEIGHT * territoryGain to heuristic before top-8 filter.
 *             territoryGain = flood-fill delta (_score after move minus before).
 *             Deterministic; directly rewards moves that enclose empty space.
 *             A: MCTS_DEPTH 20→40, MCTS_ROLLOUTS 40→100 — deeper & less noisy.
 *             v3.14.0 MCTS-only dropped to 17% vs SS (too shallow, too few rollouts).
 *   v3.14.0 - Replace greedy expand step with MCTS (Monte Carlo Tree Search):
 *             top-8 candidates by heuristic score each get MCTS_ROLLOUTS random
 *             simulations; pick highest win rate. Pure JS board ops on Uint8Array
 *             (no NS calls in rollout) — fits within MOVE_DELAY budget.
 *             Goal: break 37% Slum Snakes ceiling that greedy scoring cannot exceed.
 *   v3.13.0 - Revert to pure v3.2.0 (no opening book, no opponent threading).
 *             Baseline: ~64% Netburners, ~37% Slum Snakes.
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
 *   --once           Play one game and exit
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~6 GB (ns.go.* + ns.go.analysis.* calls)
 */

const VERSION       = '3.18.1';
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

function logBoard(ns, size) {
    const board = ns.go.getBoardState();
    const score = ns.go.getGameState ? ns.go.getGameState() : null;
    ns.print('[GO] --- final board ---');
    for (let y = size - 1; y >= 0; y--) {
        let row = y + ' ';
        for (let x = 0; x < size; x++) {
            row += (board[x] ? board[x][y] : '?') + ' ';
        }
        ns.print(row);
    }
    ns.print('    ' + Array.from({ length: size }, (_, i) => i).join(' '));
    if (score) ns.print('[GO] score X=' + score.blackScore + ' O=' + score.whiteScore);
}

export async function main(ns) {
    const flags = ns.flags([
        ['opponent',     'Netburners'],
        ['size',         7],
        ['once',         false],
    ]);

    ns.disableLog('ALL');
    ns.print('=== go.js v' + VERSION + ' | opponent=' + flags.opponent + ' size=' + flags.size + ' ===');

    let opponentIdx       = Math.max(0, OPPONENTS.indexOf(flags.opponent));
    let consecutiveWins   = 0;
    let consecutiveLosses = 0;
    let totalWins         = 0;
    let totalLosses       = 0;

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
            consecutiveLosses = 0;
            ns.tprint('[GO] WIN vs ' + opponent + ' | streak=' + consecutiveWins + ' | total ' + totalWins + 'W/' + totalLosses + 'L');

            if (consecutiveWins >= WIN_THRESHOLD && opponentIdx < OPPONENTS.length - 1) {
                opponentIdx++;
                consecutiveWins   = 0;
                consecutiveLosses = 0;
                ns.tprint('[GO] Advanced to opponent: ' + OPPONENTS[opponentIdx]);
            }
        } else {
            totalLosses++;
            consecutiveWins = 0;
            consecutiveLosses++;
            ns.print('[GO] LOSS vs ' + opponent + ' | streak=' + consecutiveLosses + ' | total ' + totalWins + 'W/' + totalLosses + 'L');
            logBoard(ns, flags.size);

            if (consecutiveLosses >= WIN_THRESHOLD && opponentIdx > 0) {
                opponentIdx--;
                consecutiveWins   = 0;
                consecutiveLosses = 0;
                ns.tprint('[GO] Demoted to opponent: ' + OPPONENTS[opponentIdx]);
            }
        }

    } while (!flags.once);
}


// =============================================================================
// Game loop
// =============================================================================

async function playGame(ns, boardSize) {
    let moveNum = 0;
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

        const move       = pickMove(ns, board, validMoves, liberties, controlled, boardSize, moveNum);

        try {
            if (move) {
                moveNum++;
                await ns.go.makeMove(move.x, move.y);
            } else {
                ns.print('[GO] pass (no move)');
                await ns.go.passTurn();
            }
        } catch (e) {
            ns.print('[GO] makeMove error: ' + e + ' — passing');
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
// Opening anchor
// =============================================================================

const ANCHOR_STONES = 5;    // connected opening; MCTS takes over but stays adjacent to group

/**
 * Opening book: build a connected anchor group near center for the first ANCHOR_STONES moves.
 *
 * Move 1 (no X on board): pick valid cell closest to center with ≥3 liberties.
 * Move 2-N (X exists, group < ANCHOR_STONES): pick valid cell adjacent to our group
 *   with the highest post-placement liberty count for the resulting group (≥2 libs).
 * Returns null once we have ANCHOR_STONES stones placed (MCTS takes over).
 */
function findAnchorMove(board, validMoves, size) {
    // Count X stones and collect their positions
    const xStones = [];
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (board[x] && board[x][y] === 'X') xStones.push({ x, y });
        }
    }

    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;

    if (xStones.length === 0) {
        // Move 1: closest valid cell to center with ≥3 liberties
        let best = null, bestDist = Infinity;
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if (!validMoves[x] || !validMoves[x][y]) continue;
                const libs = getAdjacent(x, y, size).filter(
                    n => board[n.x] && board[n.x][n.y] === '.'
                ).length;
                if (libs < 3) continue;
                const dist = Math.abs(x - cx) + Math.abs(y - cy);
                if (dist < bestDist) { bestDist = dist; best = { x, y }; }
            }
        }
        return best;
    }

    // Moves 2-N: extend our existing group — pick valid adjacent cell with most resulting libs
    const xSet = new Set(xStones.map(s => s.x * size + s.y));
    let best = null, bestScore = -1;
    for (const stone of xStones) {
        for (const n of getAdjacent(stone.x, stone.y, size)) {
            if (!validMoves[n.x] || !validMoves[n.x][n.y]) continue;
            const candidateLibs = getAdjacent(n.x, n.y, size).filter(
                a => (board[a.x] && board[a.x][a.y] === '.') ||
                     xSet.has(a.x * size + a.y)
            ).length;
            if (candidateLibs < 2) continue;
            const edgeDist = Math.min(n.x, size - 1 - n.x, n.y, size - 1 - n.y);
            const score = candidateLibs * 10 + edgeDist;
            if (score > bestScore) { bestScore = score; best = { x: n.x, y: n.y }; }
        }
    }
    return best;
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
function pickMove(ns, board, validMoves, liberties, controlled, size, moveNum) {
    // --- 1. Capture: fill last liberty of an enemy group ---
    const capture = findGroupAtLiberties(board, validMoves, liberties, size, 'O', 1);
    if (capture) return capture;

    // --- 2. Defend critical: fill last liberty of our group ---
    const defend1 = findGroupAtLiberties(board, validMoves, liberties, size, 'X', 1);
    if (defend1) return defend1;

    // --- 3. Connected growth: extend our group toward interior high-liberty cells.
    //     Runs for first ANCHOR_STONES moves (move 1 picks closest-to-center cell with ≥3 libs;
    //     subsequent moves extend from existing X stones by libs+edgeDist score).
    //     Keeps all stones in one connected blob — isolated MCTS stones get surrounded and die. ---
    const anchor = moveNum < ANCHOR_STONES ? findAnchorMove(board, validMoves, size) : null;
    if (anchor) {
        ns.print('[GO] anchor → (' + anchor.x + ',' + anchor.y + ')');
        return anchor;
    }

    // --- 4. Defend early: extend our group at ≤3 libs when under pressure ---
    const defend2 = findGroupAtLiberties(board, validMoves, liberties, size, 'X', 3, true);
    if (defend2) return defend2;

    // --- 5. Territory-scored MCTS: candidates ranked by heuristic + territory gain,
    //        then final selection via Monte Carlo rollouts. ---
    const t      = _adj(size);
    const flat   = _toFlat(board, size);
    const baseXs = _score(flat, t).xs;  // our territory before any move (shared baseline)

    const candidates = [];
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!validMoves[x] || !validMoves[x][y]) continue;
            const idx   = x * size + y;
            const after = _applyMove(flat, idx, 1, t);
            const terr  = after ? Math.max(0, _score(after, t).xs - baseXs) : 0;
            const h     = moveScore(board, controlled, x, y, size) + TERR_WEIGHT * terr;
            candidates.push({ x, y, idx, h });
        }
    }

    if (candidates.length === 0) { ns.print('[GO] MCTS: 0 candidates (validMoves empty?)'); return null; }

    candidates.sort((a, b) => b.h - a.h);
    const top = candidates.slice(0, Math.min(MCTS_CANDIDATES, candidates.length));
    ns.print('[GO] MCTS: ' + candidates.length + ' candidates, top=' + top.length);

    let bestMove = top[0];
    let bestRate = -1;

    for (const cand of top) {
        const after = _applyMove(flat, cand.idx, 1, t);
        if (!after) continue;
        let wins = 0;
        for (let r = 0; r < MCTS_ROLLOUTS; r++) {
            if (_rollout(after, 2, t, size)) wins++;
        }
        const rate = wins / MCTS_ROLLOUTS;
        if (rate > bestRate) { bestRate = rate; bestMove = cand; }
    }

    // Always play best candidate — game ends naturally when both players pass.
    return bestMove;
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
function findGroupAtLiberties(board, validMoves, liberties, size, color, threshold, requirePressure = false, safeOnly = false) {
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

                // safeOnly: skip moves where our placed stone would have <2 free neighbours
                // and no adjacent friendly X group with 3+ libs (would be immediately vulnerable)
                if (safeOnly) {
                    const xAdj        = adj2.filter(n => board[n.x] && board[n.x][n.y] === 'X');
                    const strongFriend = xAdj.some(n => liberties[n.x] && liberties[n.x][n.y] >= 3);
                    if (emptyNeighbors < 2 && !strongFriend) continue;
                }

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
 * Opponent-aware weights:
 * v3.2.0 territory weights — proven ~64% vs Netburners, ~37% vs Slum Snakes.
 * Playing near enemy territory creates boundary walls that limit chain expansion.
 * All modifications tried (moyo O=-3, neutral O=0, high X=+4, corner opening book)
 * degraded Slum Snakes below 37% baseline. This is the ceiling for greedy scoring.
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


// =============================================================================
// Eye moves
// =============================================================================

/**
 * Returns true if placing a stone at (bx, by) would disconnect `cells` into
 * two or more connected components (cells are all the same controlled colour).
 * Uses numeric cell indices (x*size+y) for fast Set membership.
 */
function _splitsCells(cells, bx, by, size, board, controlled, ctrlColor) {
    const visited = new Set();
    let components = 0;
    for (const start of cells) {
        const k = start.x * size + start.y;
        if (visited.has(k)) continue;
        components++;
        if (components >= 2) return true;
        const queue = [start];
        visited.add(k);
        while (queue.length) {
            const curr = queue.pop();
            for (const n of getAdjacent(curr.x, curr.y, size)) {
                if (n.x === bx && n.y === by) continue;              // pretend (bx,by) is blocked
                const nk = n.x * size + n.y;
                if (visited.has(nk)) continue;
                if (board[n.x]      && board[n.x][n.y]      === '.' &&
                    controlled[n.x] && controlled[n.x][n.y] === ctrlColor) {
                    visited.add(nk);
                    queue.push(n);
                }
            }
        }
    }
    return components >= 2;
}

/**
 * Find a move that splits our controlled empty territory into two separate
 * enclosed regions — creating two eyes makes the surrounding group uncapturable.
 * Returns { x, y } or null.
 */
function findEyeCreationMove(board, validMoves, controlled, size) {
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!validMoves[x] || !validMoves[x][y]) continue;

            // Collect adjacent X-controlled empty nodes
            const ctrlAdj = getAdjacent(x, y, size).filter(
                n => board[n.x] && board[n.x][n.y] === '.' &&
                     controlled[n.x] && controlled[n.x][n.y] === 'X'
            );
            if (ctrlAdj.length < 2) continue;

            // If placing here disconnects those nodes → we create 2 separate eye regions
            if (_splitsCells(ctrlAdj, x, y, size, board, controlled, 'X')) return { x, y };
        }
    }
    return null;
}

/**
 * Find and claim the enemy's "vital point" — the move they would play to split
 * their controlled territory into two eyes (making their group uncapturable).
 * Only considers moves INSIDE O-controlled space (valid per suicide rule only
 * when their territory has multiple empty nodes).
 * Returns { x, y } or null.
 */
function findEyeBlockingMove(board, validMoves, controlled, size) {
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!validMoves[x] || !validMoves[x][y]) continue;
            if (!controlled[x] || controlled[x][y] !== 'O') continue; // only inside enemy territory

            const ctrlAdj = getAdjacent(x, y, size).filter(
                n => board[n.x] && board[n.x][n.y] === '.' &&
                     controlled[n.x] && controlled[n.x][n.y] === 'O'
            );
            if (ctrlAdj.length < 2) continue;

            // This is where they would split — play it first
            if (_splitsCells(ctrlAdj, x, y, size, board, controlled, 'O')) return { x, y };
        }
    }
    return null;
}


// =============================================================================
// MCTS — Monte Carlo Tree Search helpers
// All board operations run on flat Uint8Arrays (no NS calls).
// Color encoding: 0=empty, 1=X(us/Black), 2=O(enemy/White), 3=dead('#').
// =============================================================================

/**
 * Count distinct empty (0) cells adjacent to the connected group containing
 * the stone at `idx` on the flat board. Returns liberty count of that group.
 */
function _groupLibs(arr, idx, size, t) {
    const color   = arr[idx];
    if (!color) return 0;
    const visited = new Uint8Array(size * size);
    const libs    = new Set();
    const queue   = [idx];
    visited[idx]  = 1;
    while (queue.length) {
        const cur = queue.pop();
        for (const n of t[cur]) {
            if (arr[n] === 0)               { libs.add(n); }
            else if (arr[n] === color && !visited[n]) { visited[n] = 1; queue.push(n); }
        }
    }
    return libs.size;
}

const MCTS_CANDIDATES = 8;    // top-N moves by combined score to simulate
const MCTS_ROLLOUTS   = 100;  // random rollouts per candidate (↑ from 40 — tighter CI)
const MCTS_DEPTH      = 40;   // max plies per rollout (↑ from 20 — reaches near-endgame)
const TERR_WEIGHT     = 2;    // territory-gain bonus multiplier in candidate pre-scoring

/** Precomputed flat adjacency lists keyed by board size. */
const _adjCache = {};

function _adj(size) {
    if (_adjCache[size]) return _adjCache[size];
    const t = new Array(size * size);
    for (let i = 0; i < size * size; i++) {
        const x = (i / size) | 0, y = i % size;
        const a = [];
        if (x > 0)        a.push(i - size);
        if (x < size - 1) a.push(i + size);
        if (y > 0)        a.push(i - 1);
        if (y < size - 1) a.push(i + 1);
        t[i] = a;
    }
    return (_adjCache[size] = t);
}

/** Convert string[] board to flat Uint8Array. 1=X(us), 2=O(enemy), 3=dead('#'), 0=empty. */
function _toFlat(board, size) {
    const arr = new Uint8Array(size * size);
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            const c = board[x] && board[x][y];
            if (c === 'X')      arr[x * size + y] = 1;
            else if (c === 'O') arr[x * size + y] = 2;
            else if (c === '#') arr[x * size + y] = 3; // dead node — not playable, not territory
        }
    }
    return arr;
}

/** Count liberties of the group containing cell `start`. */
function _libs(arr, start, t) {
    const color = arr[start];
    const seen  = new Uint8Array(arr.length);
    const stack = [start];
    seen[start]  = 1;
    let libs     = 0;
    while (stack.length) {
        const cur = stack.pop();
        for (const n of t[cur]) {
            if (seen[n]) continue;
            seen[n] = 1;
            if (arr[n] === 0)        libs++;
            else if (arr[n] === color) stack.push(n);
        }
    }
    return libs;
}

/** Return all cell indices belonging to the group containing `start`. */
function _flood(arr, start, t) {
    const color = arr[start];
    const seen  = new Uint8Array(arr.length);
    const stack = [start];
    const cells = [];
    seen[start]  = 1;
    while (stack.length) {
        const cur = stack.pop();
        cells.push(cur);
        for (const n of t[cur]) {
            if (!seen[n] && arr[n] === color) { seen[n] = 1; stack.push(n); }
        }
    }
    return cells;
}

/**
 * Place `color` at `idx`. Captures surrounded enemy groups.
 * Returns new board array, or null if the move is invalid (occupied or suicide).
 */
function _applyMove(arr, idx, color, t) {
    if (arr[idx] !== 0) return null;
    const next  = new Uint8Array(arr);
    next[idx]   = color;
    const enemy = color === 1 ? 2 : 1;
    let captured = false;
    for (const n of t[idx]) {
        if (next[n] === enemy && _libs(next, n, t) === 0) {
            for (const c of _flood(next, n, t)) next[c] = 0;
            captured = true;
        }
    }
    if (!captured && _libs(next, idx, t) === 0) return null; // suicide
    return next;
}

/**
 * Territory score via flood-fill of empty regions.
 * A region enclosed solely by color C scores for C; contested regions score 0.
 * Returns { xs, os } = territory + stone counts for Black(1) and White(2).
 */
function _score(arr, t) {
    let xs = 0, os = 0;
    const vis = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] === 1) { xs++; continue; }
        if (arr[i] === 2) { os++; continue; }
        if (arr[i] !== 0 || vis[i]) continue;
        const stack  = [i];
        const region = [];
        vis[i] = 1;
        let hasX = false, hasO = false;
        while (stack.length) {
            const cur = stack.pop();
            region.push(cur);
            for (const n of t[cur]) {
                if (!vis[n]) {
                    if (arr[n] === 0) { vis[n] = 1; stack.push(n); }
                    else if (arr[n] === 1) hasX = true;
                    else if (arr[n] === 2) hasO = true;
                }
            }
        }
        if (hasX && !hasO)      xs += region.length;
        else if (hasO && !hasX) os += region.length;
    }
    return { xs, os };
}

/**
 * Run one random rollout starting from `arr` with `toPlay` moving next.
 * Both players choose uniformly from valid (non-suicide) moves.
 * Returns true if X (us, color=1) wins.
 */
function _rollout(arr, toPlay, t, size) {
    let cur    = arr;
    let player = toPlay;
    let passes = 0;
    const N    = size * size;

    for (let depth = 0; depth < MCTS_DEPTH; depth++) {
        // Collect empty cells and Fisher-Yates shuffle for random order
        const empties = [];
        for (let i = 0; i < N; i++) if (cur[i] === 0) empties.push(i);
        for (let i = empties.length - 1; i > 0; i--) {
            const j   = (Math.random() * (i + 1)) | 0;
            const tmp = empties[i]; empties[i] = empties[j]; empties[j] = tmp;
        }

        let played = false;
        for (const idx of empties) {
            const next = _applyMove(cur, idx, player, t);
            if (next) { cur = next; played = true; passes = 0; break; }
        }
        if (!played) { if (++passes >= 2) break; }
        player = player === 1 ? 2 : 1;
    }

    const { xs, os } = _score(cur, t);
    return xs > os;
}
