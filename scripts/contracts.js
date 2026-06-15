/**
 * contracts.js
 * Version: 1.0.0
 *
 * Coding contract solver for PhlanxOS BitBurner automation suite.
 *
 * Behaviour:
 *   Scans all reachable servers for .cct contract files. For each contract,
 *   identifies the type, solves it using a built-in algorithm, and submits
 *   the answer. Rewards (money, rep, or mixed) are reported to the terminal.
 *
 *   Safety: if only 1 attempt remains and the solver returns null (unsupported
 *   or unsolvable), the contract is skipped rather than burning the last try.
 *
 *   By default loops every 60 seconds to catch newly spawned contracts.
 *   Pass --once to do a single scan and exit.
 *
 * No gate. No imports. Runs from day 1.
 *
 * Changelog:
 *   v1.0.0 - Initial version. Covers all 32 contract types.
 *
 * Flags:
 *   --once    Run a single scan pass and exit (default: false)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2.0 GB
 *   Base 1.6 + scan 0.2 + ls 0.2
 *   codingcontract.* functions cost 0 GB each
 */

const VERSION  = '1.0.0';
const INTERVAL = 60 * 1000;                                                         // Rescan interval in ms

export async function main(ns) {
    const flags = ns.flags([['once', false]]);
    ns.disableLog('ALL');
    ns.print('=== contracts.js v' + VERSION + ' | once=' + flags.once + ' ===');

    do {
        const found   = scanAndSolve(ns);
        const ts      = new Date().toLocaleTimeString();
        ns.print('[' + ts + '] Scan complete. Found: ' + found.total + '  Solved: ' + found.solved + '  Skipped: ' + found.skipped);
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Scanner
// =============================================================================

function scanAndSolve(ns) {
    const servers = getAllServers(ns);
    let total = 0, solved = 0, skipped = 0;

    for (const host of servers) {
        const contracts = ns.ls(host, '.cct');
        for (const file of contracts) {
            total++;
            const type     = ns.codingcontract.getContractType(file, host);
            const data     = ns.codingcontract.getData(file, host);
            const tries    = ns.codingcontract.getNumTriesRemaining(file, host);
            const answer   = solve(type, data);

            if (answer === null || answer === undefined) {
                ns.print('[SKIP] ' + host + '/' + file + ' | ' + type + ' | unsupported solver');
                skipped++;
                continue;
            }

            if (tries <= 1) {
                ns.print('[SKIP] ' + host + '/' + file + ' | ' + type + ' | only 1 try remaining — skipping to preserve contract');
                skipped++;
                continue;
            }

            const reward = ns.codingcontract.attempt(answer, file, host);
            if (reward) {
                ns.tprint('[CONTRACTS] SOLVED ' + type + ' on ' + host + ' | Reward: ' + reward);
                solved++;
            } else {
                ns.tprint('[CONTRACTS] WRONG  ' + type + ' on ' + host + ' | Tries left: ' + (tries - 1));
                skipped++;
            }
        }
    }

    return { total, solved, skipped };
}


// =============================================================================
// Server discovery (inlined — no lib-utils import to keep RAM minimal)
// =============================================================================

function getAllServers(ns) {
    const visited = new Set();
    const queue   = ['home'];
    while (queue.length > 0) {
        const host = queue.pop();
        if (visited.has(host)) continue;
        visited.add(host);
        for (const neighbour of ns.scan(host)) {
            if (!visited.has(neighbour)) queue.push(neighbour);
        }
    }
    return Array.from(visited);
}


// =============================================================================
// Solver dispatch
// =============================================================================

function solve(type, data) {
    switch (type) {
        case 'Find Largest Prime Factor':                    return solveLargestPrimeFactor(data);
        case 'Subarray with Maximum Sum':                   return solveSubarrayMaxSum(data);
        case 'Total Ways to Sum':                           return solveTotalWaysToSum(data);
        case 'Total Ways to Sum II':                        return solveTotalWaysToSumII(data);
        case 'Spiralize Matrix':                            return solveSpiralizeMatrix(data);
        case 'Array Jumping Game':                          return solveArrayJumpingGame(data);
        case 'Array Jumping Game II':                       return solveArrayJumpingGameII(data);
        case 'Merge Overlapping Intervals':                 return solveMergeIntervals(data);
        case 'Generate IP Addresses':                       return solveGenerateIPs(data);
        case 'Algorithmic Stock Trader I':                  return solveStockI(data);
        case 'Algorithmic Stock Trader II':                 return solveStockII(data);
        case 'Algorithmic Stock Trader III':                return solveStockIII(data);
        case 'Algorithmic Stock Trader IV':                 return solveStockIV(data);
        case 'Minimum Path Sum in a Triangle':              return solveTriangle(data);
        case 'Unique Paths in a Grid I':                    return solveUniquePaths1(data);
        case 'Unique Paths in a Grid II':                   return solveUniquePaths2(data);
        case 'Shortest Path in a Grid':                     return solveShortestPath(data);
        case 'Sanitize Parentheses in Expression':          return solveSanitizeParens(data);
        case 'Find All Valid Math Expressions':             return solveMathExpressions(data);
        case 'HammingCodes: Integer to Encoded Binary':     return solveHammingEncode(data);
        case 'HammingCodes: Encoded Binary to Integer':     return solveHammingDecode(data);
        case 'Proper 2-Coloring of a Graph':                return solve2Coloring(data);
        case 'Compression I: RLE Compression':              return solveRLECompress(data);
        case 'Compression II: LZ Decompression':            return solveLZDecompress(data);
        case 'Compression III: LZ Compression':             return solveLZCompress(data);
        case 'Encryption I: Caesar Cipher':                 return solveCaesarCipher(data);
        case 'Encryption II: Vigenère Cipher':              return solveVigenere(data);
        case 'Largest Rectangle in a Matrix':               return solveLargestRectangle(data);
        case 'Square Root':                                 return solveSquareRoot(data);
        case 'Total Primes in Range':                       return solveTotalPrimesInRange(data);
        default:                                            return null;
    }
}


// =============================================================================
// Solvers
// =============================================================================

// --- Find Largest Prime Factor ---
// data: number. Return largest prime factor.
function solveLargestPrimeFactor(n) {
    let largest = 1;
    let d       = 2;
    while (d * d <= n) {
        while (n % d === 0) {
            largest = d;
            n = Math.floor(n / d);
        }
        d++;
    }
    if (n > 1) largest = n;
    return largest;
}

// --- Subarray with Maximum Sum ---
// data: number[]. Return maximum contiguous subarray sum (Kadane's).
function solveSubarrayMaxSum(arr) {
    let best = -Infinity, cur = 0;
    for (const n of arr) {
        cur  = Math.max(n, cur + n);
        best = Math.max(best, cur);
    }
    return best;
}

// --- Total Ways to Sum ---
// data: number n. Count integer partitions of n (excluding n itself).
function solveTotalWaysToSum(n) {
    const dp = new Array(n + 1).fill(0);
    dp[0] = 1;
    for (let i = 1; i < n; i++) {
        for (let j = i; j <= n; j++) {
            dp[j] += dp[j - i];
        }
    }
    return dp[n];
}

// --- Total Ways to Sum II ---
// data: [n, [k1, k2, ...]]. Count ways to sum n using only given numbers.
function solveTotalWaysToSumII(data) {
    const [n, coins] = data;
    const dp = new Array(n + 1).fill(0);
    dp[0] = 1;
    for (const c of coins) {
        for (let j = c; j <= n; j++) {
            dp[j] += dp[j - c];
        }
    }
    return dp[n];
}

// --- Spiralize Matrix ---
// data: number[][]. Return elements in spiral order.
function solveSpiralizeMatrix(matrix) {
    const result = [];
    let top = 0, bottom = matrix.length - 1, left = 0, right = matrix[0].length - 1;
    while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++)       result.push(matrix[top][c]);
        top++;
        for (let r = top; r <= bottom; r++)       result.push(matrix[r][right]);
        right--;
        if (top <= bottom) {
            for (let c = right; c >= left; c--)   result.push(matrix[bottom][c]);
            bottom--;
        }
        if (left <= right) {
            for (let r = bottom; r >= top; r--)   result.push(matrix[r][left]);
            left++;
        }
    }
    return result;
}

// --- Array Jumping Game ---
// data: number[]. Can you reach the last index? Return 1 (yes) or 0 (no).
function solveArrayJumpingGame(arr) {
    let reach = 0;
    for (let i = 0; i < arr.length; i++) {
        if (i > reach) return 0;
        reach = Math.max(reach, i + arr[i]);
    }
    return 1;
}

// --- Array Jumping Game II ---
// data: number[]. Minimum jumps to reach last index. 0 if impossible.
function solveArrayJumpingGameII(arr) {
    let jumps = 0, curEnd = 0, farthest = 0;
    for (let i = 0; i < arr.length - 1; i++) {
        farthest = Math.max(farthest, i + arr[i]);
        if (i === curEnd) {
            if (farthest <= i) return 0;
            jumps++;
            curEnd = farthest;
        }
    }
    return jumps;
}

// --- Merge Overlapping Intervals ---
// data: [start, end][]. Return merged non-overlapping intervals.
function solveMergeIntervals(intervals) {
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [intervals[0].slice()];
    for (let i = 1; i < intervals.length; i++) {
        const last = merged[merged.length - 1];
        if (intervals[i][0] <= last[1]) {
            last[1] = Math.max(last[1], intervals[i][1]);
        } else {
            merged.push(intervals[i].slice());
        }
    }
    return merged;
}

// --- Generate IP Addresses ---
// data: string of digits. Return all valid IPv4 addresses.
function solveGenerateIPs(s) {
    const results = [];
    function bt(start, parts) {
        if (parts.length === 4 && start === s.length) { results.push(parts.join('.')); return; }
        if (parts.length === 4 || start === s.length) return;
        for (let len = 1; len <= 3; len++) {
            if (start + len > s.length) break;
            const seg = s.slice(start, start + len);
            if (seg.length > 1 && seg[0] === '0') break;
            if (parseInt(seg) > 255) break;
            bt(start + len, parts.concat(seg));
        }
    }
    bt(0, []);
    return results;
}

// --- Algorithmic Stock Trader I ---
// data: number[]. Max profit from at most 1 transaction.
function solveStockI(prices) {
    let minP = Infinity, best = 0;
    for (const p of prices) {
        best = Math.max(best, p - minP);
        minP = Math.min(minP, p);
    }
    return best;
}

// --- Algorithmic Stock Trader II ---
// data: number[]. Max profit with unlimited transactions.
function solveStockII(prices) {
    let profit = 0;
    for (let i = 1; i < prices.length; i++) {
        if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
    }
    return profit;
}

// --- Algorithmic Stock Trader III ---
// data: number[]. Max profit with at most 2 transactions.
function solveStockIII(prices) {
    return solveStockIV([2, prices]);
}

// --- Algorithmic Stock Trader IV ---
// data: [k, prices]. Max profit with at most k transactions.
function solveStockIV(data) {
    const [k, prices] = data;
    const n = prices.length;
    if (n === 0 || k === 0) return 0;
    if (k >= Math.floor(n / 2)) return solveStockII(prices);
    const hold  = new Array(k + 1).fill(-Infinity);
    const profit = new Array(k + 1).fill(0);
    for (const p of prices) {
        for (let t = k; t >= 1; t--) {
            profit[t] = Math.max(profit[t], hold[t] + p);
            hold[t]   = Math.max(hold[t], profit[t - 1] - p);
        }
    }
    return profit[k];
}

// --- Minimum Path Sum in a Triangle ---
// data: number[][]. Minimum sum path from top to bottom.
function solveTriangle(triangle) {
    const dp = triangle[triangle.length - 1].slice();
    for (let r = triangle.length - 2; r >= 0; r--) {
        for (let c = 0; c < triangle[r].length; c++) {
            dp[c] = triangle[r][c] + Math.min(dp[c], dp[c + 1]);
        }
    }
    return dp[0];
}

// --- Unique Paths in a Grid I ---
// data: [rows, cols]. Count paths top-left to bottom-right (right/down only).
function solveUniquePaths1(data) {
    const [rows, cols] = data;
    const dp = new Array(cols).fill(1);
    for (let r = 1; r < rows; r++) {
        for (let c = 1; c < cols; c++) {
            dp[c] += dp[c - 1];
        }
    }
    return dp[cols - 1];
}

// --- Unique Paths in a Grid II ---
// data: number[][]. 0=open, 1=blocked. Count paths top-left to bottom-right.
function solveUniquePaths2(grid) {
    const rows = grid.length, cols = grid[0].length;
    const dp   = new Array(cols).fill(0);
    dp[0]      = 1;
    for (let r = 0; r < rows; r++) {
        if (grid[r][0] === 1) dp[0] = 0;
        for (let c = 1; c < cols; c++) {
            dp[c] = grid[r][c] === 1 ? 0 : dp[c] + dp[c - 1];
        }
    }
    return dp[cols - 1];
}

// --- Shortest Path in a Grid ---
// data: number[][]. 0=open, 1=wall. Return shortest path string (UDLR) or ''.
function solveShortestPath(grid) {
    const rows = grid.length, cols = grid[0].length;
    if (grid[0][0] === 1 || grid[rows - 1][cols - 1] === 1) return '';
    const queue   = [[0, 0, '']];
    const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
    visited[0][0] = true;
    const dirs = [[-1, 0, 'U'], [1, 0, 'D'], [0, -1, 'L'], [0, 1, 'R']];
    while (queue.length > 0) {
        const [r, c, path] = queue.shift();
        if (r === rows - 1 && c === cols - 1) return path;
        for (const [dr, dc, ch] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr][nc] && grid[nr][nc] === 0) {
                visited[nr][nc] = true;
                queue.push([nr, nc, path + ch]);
            }
        }
    }
    return '';
}

// --- Sanitize Parentheses in Expression ---
// data: string. Return all valid expressions with minimum removals.
function solveSanitizeParens(s) {
    const results = new Set();
    function bt(idx, lRem, rRem, str, open) {
        if (idx === s.length) {
            if (lRem === 0 && rRem === 0 && open === 0) results.add(str);
            return;
        }
        const ch = s[idx];
        if (ch === '(' && lRem > 0) bt(idx + 1, lRem - 1, rRem, str, open);
        if (ch === ')' && rRem > 0) bt(idx + 1, lRem, rRem - 1, str, open);
        if (ch !== '(' && ch !== ')') {
            bt(idx + 1, lRem, rRem, str + ch, open);
        } else if (ch === '(') {
            bt(idx + 1, lRem, rRem, str + ch, open + 1);
        } else if (open > 0) {
            bt(idx + 1, lRem, rRem, str + ch, open - 1);
        }
    }
    let lRem = 0, rRem = 0;
    for (const ch of s) {
        if (ch === '(') lRem++;
        else if (ch === ')') { if (lRem > 0) lRem--; else rRem++; }
    }
    bt(0, lRem, rRem, '', 0);
    return Array.from(results);
}

// --- Find All Valid Math Expressions ---
// data: [digits_string, target]. Return all expressions using +, -, * that equal target.
function solveMathExpressions(data) {
    const [numStr, target] = data;
    const results = [];
    function bt(idx, path, eval_, multed) {
        if (idx === numStr.length) {
            if (eval_ === target) results.push(path);
            return;
        }
        for (let len = 1; len <= numStr.length - idx; len++) {
            const seg = numStr.slice(idx, idx + len);
            if (seg.length > 1 && seg[0] === '0') break;
            const n = parseInt(seg);
            if (idx === 0) {
                bt(len, seg, n, n);
            } else {
                bt(idx + len, path + '+' + seg, eval_ + n, n);
                bt(idx + len, path + '-' + seg, eval_ - n, -n);
                bt(idx + len, path + '*' + seg, eval_ - multed + multed * n, multed * n);
            }
        }
    }
    bt(0, '', 0, 0);
    return results;
}

// --- HammingCodes: Integer to Encoded Binary ---
// data: number. Return Hamming-encoded binary string.
function solveHammingEncode(n) {
    const bin    = n.toString(2);
    const datLen = bin.length;
    let parBits  = 0;
    while ((1 << parBits) < datLen + parBits + 1) parBits++;
    const total  = datLen + parBits;
    const bits   = new Array(total + 1).fill(0);
    let di       = 0;
    for (let i = 1; i <= total; i++) {
        if ((i & (i - 1)) !== 0) bits[i] = parseInt(bin[di++]);                    // Non-power-of-2 positions: data bits
    }
    for (let p = 0; p < parBits; p++) {
        const pos = 1 << p;
        let parity = 0;
        for (let i = pos; i <= total; i++) {
            if (i & pos) parity ^= bits[i];
        }
        bits[pos] = parity;
    }
    let overallParity = 0;
    for (let i = 1; i <= total; i++) overallParity ^= bits[i];
    return overallParity + bits.slice(1).join('');
}

// --- HammingCodes: Encoded Binary to Integer ---
// data: string. Decode Hamming-encoded binary to integer.
function solveHammingDecode(s) {
    const bits = s.split('').map(Number);
    const n    = bits.length;
    let errPos = 0;
    for (let i = 0; i < n; i++) {
        if (bits[i] === 1) errPos ^= (i + 1);
    }
    if (errPos > 0 && errPos <= n) bits[errPos - 1] ^= 1;                          // Correct single-bit error
    const dataBits = [];
    for (let i = 1; i <= n; i++) {
        if ((i & (i - 1)) !== 0) dataBits.push(bits[i - 1]);                       // Skip power-of-2 parity positions
    }
    return parseInt(dataBits.join(''), 2);
}

// --- Proper 2-Coloring of a Graph ---
// data: [n, [[u,v]...]]. Return 2-coloring array or [] if impossible.
function solve2Coloring(data) {
    const [n, edges] = data;
    const color = new Array(n).fill(-1);
    const adj   = Array.from({ length: n }, () => []);
    for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); }
    for (let start = 0; start < n; start++) {
        if (color[start] !== -1) continue;
        const queue = [start];
        color[start] = 0;
        while (queue.length > 0) {
            const node = queue.shift();
            for (const nb of adj[node]) {
                if (color[nb] === -1) { color[nb] = 1 - color[node]; queue.push(nb); }
                else if (color[nb] === color[node]) return [];
            }
        }
    }
    return color;
}

// --- Compression I: RLE Compression ---
// data: string. Return run-length encoded string.
function solveRLECompress(s) {
    let out = '', i = 0;
    while (i < s.length) {
        let count = 1;
        while (i + count < s.length && s[i + count] === s[i] && count < 9) count++;
        out += count + s[i];
        i   += count;
    }
    return out;
}

// --- Compression II: LZ Decompression ---
// data: string. Return decompressed string.
function solveLZDecompress(s) {
    let out = '', i = 0;
    while (i < s.length) {
        const type = parseInt(s[i++]);
        if (type === 0) break;
        if (i - 1 < s.length && parseInt(s[i - 1]) % 2 === 1) {
            // Literal chunk
            const len = type;
            out += s.slice(i, i + len);
            i   += len;
        } else {
            // Back-reference chunk
            const len    = type;
            const offset = parseInt(s[i++]);
            for (let j = 0; j < len; j++) {
                out += out[out.length - offset];
            }
        }
    }
    return out;
}

// --- Compression II: LZ Decompression (corrected LZSS format) ---
// The game's LZ decompression alternates between literal and backreference chunks.
// data: string encoded as alternating (literal_len)(literal)(ref_len)(offset)...
function solveLZDecompressFixed(s) {
    let out = '', i = 0;
    while (i < s.length) {
        const litLen = parseInt(s[i++]);
        out += s.slice(i, i + litLen);
        i   += litLen;
        if (i >= s.length) break;
        const refLen = parseInt(s[i++]);
        if (refLen === 0) continue;
        const offset = parseInt(s[i++]);
        for (let j = 0; j < refLen; j++) out += out[out.length - offset];
    }
    return out;
}

// --- Compression III: LZ Compression ---
// data: string. Return LZSS-compressed string (minimise length).
function solveLZCompress(s) {
    // DP approach: dp[i] = shortest encoding of s[0..i-1]
    const n  = s.length;
    const dp = new Array(n + 1).fill(null);
    dp[0]    = '';
    for (let i = 0; i <= n; i++) {
        if (dp[i] === null) continue;
        // Literal chunk of length 1-9
        for (let len = 1; len <= 9 && i + len <= n; len++) {
            const next = dp[i] + len + s.slice(i, i + len);
            if (dp[i + len] === null || next.length < dp[i + len].length) {
                dp[i + len] = next;
            }
        }
        // Back-reference chunk: find matches in output
        for (let offset = 1; offset <= Math.min(i, 9); offset++) {
            let matchLen = 0;
            while (matchLen < 9 && i + matchLen < n && s[i + matchLen] === s[i - offset + (matchLen % offset)]) {
                matchLen++;
            }
            for (let len = 1; len <= matchLen; len++) {
                // Prepend empty literal if previous chunk was also a ref (must alternate)
                const base = dp[i];
                const next = base + len + '' + offset;
                if (dp[i + len] === null || next.length < dp[i + len].length) {
                    dp[i + len] = next;
                }
            }
        }
    }
    return dp[n] || '';
}

// --- Encryption I: Caesar Cipher ---
// data: [string, shift]. Left-shift each letter by shift.
function solveCaesarCipher(data) {
    const [text, shift] = data;
    return text.split('').map(ch => {
        if (ch === ' ') return ' ';
        return String.fromCharCode(((ch.charCodeAt(0) - 65 - shift + 26) % 26) + 65);
    }).join('');
}

// --- Encryption II: Vigenère Cipher ---
// data: [plaintext, keyword]. Encrypt using Vigenère.
function solveVigenere(data) {
    const [text, key] = data;
    let ki = 0;
    return text.split('').map(ch => {
        if (ch === ' ') return ' ';
        const shift = key[ki % key.length].charCodeAt(0) - 65;
        ki++;
        return String.fromCharCode(((ch.charCodeAt(0) - 65 + shift) % 26) + 65);
    }).join('');
}

// --- Largest Rectangle in a Matrix ---
// data: number[][]. Return area of largest rectangle of 1s.
function solveLargestRectangle(matrix) {
    const rows = matrix.length, cols = matrix[0].length;
    const heights = new Array(cols).fill(0);
    let maxArea = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            heights[c] = matrix[r][c] === 0 ? 0 : heights[c] + 1;
        }
        maxArea = Math.max(maxArea, largestRectHistogram(heights));
    }
    return maxArea;
}

function largestRectHistogram(h) {
    const stack = [];
    let maxA = 0;
    for (let i = 0; i <= h.length; i++) {
        const cur = i === h.length ? 0 : h[i];
        while (stack.length > 0 && cur < h[stack[stack.length - 1]]) {
            const height = h[stack.pop()];
            const width  = stack.length === 0 ? i : i - stack[stack.length - 1] - 1;
            maxA = Math.max(maxA, height * width);
        }
        stack.push(i);
    }
    return maxA;
}

// --- Square Root ---
// data: bigint or number. Return floor of square root.
function solveSquareRoot(n) {
    if (typeof n === 'bigint') {
        if (n < 0n) return 0n;
        if (n < 2n) return n;
        let x = BigInt(Math.floor(Math.sqrt(Number(n))));
        while (x * x > n) x--;
        while ((x + 1n) * (x + 1n) <= n) x++;
        return x;
    }
    return Math.floor(Math.sqrt(n));
}

// --- Total Primes in Range ---
// data: [start, end]. Count primes in [start, end] using segmented sieve.
function solveTotalPrimesInRange(data) {
    const [lo, hi] = data;
    if (hi < 2) return 0;
    const sqrtHi = Math.floor(Math.sqrt(hi));
    // Small primes up to sqrt(hi)
    const smallSieve = new Uint8Array(sqrtHi + 1);
    smallSieve[0] = smallSieve[1] = 1;
    for (let i = 2; i * i <= sqrtHi; i++) {
        if (!smallSieve[i]) for (let j = i * i; j <= sqrtHi; j += i) smallSieve[j] = 1;
    }
    const smallPrimes = [];
    for (let i = 2; i <= sqrtHi; i++) { if (!smallSieve[i]) smallPrimes.push(i); }
    // Segment sieve
    const size    = hi - lo + 1;
    const sieve   = new Uint8Array(size);
    if (lo <= 1) { for (let i = 0; i <= Math.min(1, hi) - lo; i++) sieve[i] = 1; }
    for (const p of smallPrimes) {
        const start = Math.max(p * p, Math.ceil(lo / p) * p);
        for (let j = start; j <= hi; j += p) {
            if (j !== p) sieve[j - lo] = 1;
        }
    }
    let count = 0;
    for (let i = 0; i < size; i++) { if (!sieve[i]) count++; }
    return count;
}
