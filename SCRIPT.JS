/* ═══════════════════════════════════════════════════════════════════════
   NEXUS CHESS  —  Complete Chess Engine + AI + UI Controller
   
   Architecture (mirrors design.md):
     1. ChessEngine        — board state, rules, move generation
     2. MoveValidator      — legal-move checks, attack maps
     3. AIAgent            — Easy / Medium / Hard (minimax + alpha-beta)
     4. HintSystem         — best-move suggestion (depth-3 eval)
     5. GameController     — orchestrates turns, undo/redo, persist
     6. BoardRenderer      — DOM grid, highlights, piece glyphs
     7. AudioSystem        — Web-Audio tones for game events
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ─────────────────────────────────────────────────
   §1  CONSTANTS  &  HELPERS
   ───────────────────────────────────────────────── */

// Piece-type codes  (lowercase = black, UPPER = white)
const PIECE = {
  EMPTY: null,
  // white
  wP:'wP', wR:'wR', wN:'wN', wB:'wB', wQ:'wQ', wK:'wK',
  // black
  bP:'bP', bR:'bR', bN:'bN', bB:'bB', bQ:'bQ', bK:'bK'
};

// Unicode glyphs for rendering
const GLYPH = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟'
};

// Piece values for evaluation (centipawns)
const VALUE = { P:100, N:320, B:330, R:500, Q:900, K:20000 };

// Starting FEN
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Return color string from piece code */
function colorOf(piece) { return piece && piece[0] === 'w' ? 'white' : 'black'; }

/** Return type-letter from piece code  e.g. 'wP' → 'P' */
function typeOf(piece) { return piece ? piece[1] : null; }

/** Opposite color */
function opponent(color) { return color === 'white' ? 'black' : 'white'; }

/** Piece code from color + type  e.g. ('white','Q') → 'wQ' */
function makePiece(color, type) { return (color === 'white' ? 'w' : 'b') + type; }

/** Deep-clone a board (8×8 array) */
function cloneBoard(b) { return b.map(row => row.slice()); }

/* ─────────────────────────────────────────────────
   §2  CHESS ENGINE  — board representation & FEN
   ───────────────────────────────────────────────── */
class ChessEngine {
  constructor() {
    // board[0] = rank 8 (top), board[7] = rank 1 (bottom)
    this.board = this._emptyBoard();
    this.currentPlayer = 'white';
    this.castlingRights = { wK: true, wQ: true, bK: true, bQ: true };
    this.enPassantTarget = null;   // [row, col] or null
    this.halfMoveClock = 0;
    this.fullMoveNumber = 1;
    this.moveHistory = [];         // array of snapshot objects
    this.undoStack = [];
    this.redoStack = [];
    this.gameStatus = 'active';    // active | check | checkmate | stalemate | resigned
    this.capturedPieces = { white: [], black: [] };
    this.lastMove = null;          // { from:[r,c], to:[r,c] }

    this.loadFEN(START_FEN);
  }

  _emptyBoard() {
    return Array.from({ length: 8 }, () => Array(8).fill(null));
  }

  /* ── FEN import ── */
  loadFEN(fen) {
    const parts = fen.split(' ');
    const ranks = parts[0].split('/');
    this.board = this._emptyBoard();
    for (let r = 0; r < 8; r++) {
      let col = 0;
      for (const ch of ranks[r]) {
        if ('12345678'.includes(ch)) {
          col += parseInt(ch);
        } else {
          // uppercase → white, lowercase → black
          const isWhite = ch === ch.toUpperCase();
          this.board[r][col] = (isWhite ? 'w' : 'b') + ch.toUpperCase();
          col++;
        }
      }
    }
    this.currentPlayer = parts[1] === 'w' ? 'white' : 'black';

    // castling
    const c = parts[2];
    this.castlingRights = {
      wK: c.includes('K'), wQ: c.includes('Q'),
      bK: c.includes('k'), bQ: c.includes('q')
    };

    // en-passant
    if (parts[3] && parts[3] !== '-') {
      const file = parts[3].charCodeAt(0) - 97;  // a=0
      const rank = parseInt(parts[3][1]);
      this.enPassantTarget = [8 - rank, file];    // convert to row index
    } else {
      this.enPassantTarget = null;
    }

    this.halfMoveClock  = parseInt(parts[4]) || 0;
    this.fullMoveNumber = parseInt(parts[5]) || 1;
  }

  /* ── FEN export ── */
  toFEN() {
    let ranks = [];
    for (let r = 0; r < 8; r++) {
      let row = '';
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (!p) { empty++; }
        else {
          if (empty) { row += empty; empty = 0; }
          row += colorOf(p) === 'white' ? typeOf(p) : typeOf(p).toLowerCase();
        }
      }
      if (empty) row += empty;
      ranks.push(row);
    }

    const ep = this.enPassantTarget
      ? String.fromCharCode(97 + this.enPassantTarget[1]) + (8 - this.enPassantTarget[0])
      : '-';

    const cr = (this.castlingRights.wK ? 'K' : '') +
               (this.castlingRights.wQ ? 'Q' : '') +
               (this.castlingRights.bK ? 'k' : '') +
               (this.castlingRights.bQ ? 'q' : '') || '-';

    return [
      ranks.join('/'),
      this.currentPlayer === 'white' ? 'w' : 'b',
      cr,
      ep,
      this.halfMoveClock,
      this.fullMoveNumber
    ].join(' ');
  }

  /* ── Snapshot the full state (for undo) ── */
  _snapshot() {
    return {
      board:            cloneBoard(this.board),
      currentPlayer:    this.currentPlayer,
      castlingRights:   { ...this.castlingRights },
      enPassantTarget:  this.enPassantTarget ? [...this.enPassantTarget] : null,
      halfMoveClock:    this.halfMoveClock,
      fullMoveNumber:   this.fullMoveNumber,
      gameStatus:       this.gameStatus,
      capturedPieces:   { white: [...this.capturedPieces.white], black: [...this.capturedPieces.black] },
      lastMove:         this.lastMove ? { from: [...this.lastMove.from], to: [...this.lastMove.to] } : null
    };
  }

  _restoreSnapshot(snap) {
    this.board            = snap.board;
    this.currentPlayer    = snap.currentPlayer;
    this.castlingRights   = snap.castlingRights;
    this.enPassantTarget  = snap.enPassantTarget;
    this.halfMoveClock    = snap.halfMoveClock;
    this.fullMoveNumber   = snap.fullMoveNumber;
    this.gameStatus       = snap.gameStatus;
    this.capturedPieces   = snap.capturedPieces;
    this.lastMove         = snap.lastMove;
  }
}

/* ─────────────────────────────────────────────────
   §3  MOVE VALIDATOR  — raw & legal move generation
   ───────────────────────────────────────────────── */

/**
 * Generate all PSEUDO-legal moves for the piece at [row,col].
 * Pseudo-legal means the move follows piece-movement rules
 * but might leave own king in check.
 */
function pseudoLegalMoves(engine, row, col) {
  const board = engine.board;
  const piece = board[row][col];
  if (!piece) return [];

  const color = colorOf(piece);
  const type  = typeOf(piece);
  const moves = [];

  const inBounds = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const isEnemy  = (r, c) => board[r][c] && colorOf(board[r][c]) !== color;
  const isEmpty  = (r, c) => !board[r][c];

  /* helper: slide in a direction until blocked */
  function slide(dirs) {
    for (const [dr, dc] of dirs) {
      let r = row + dr, c = col + dc;
      while (inBounds(r, c)) {
        if (isEmpty(r, c))     moves.push([r, c]);
        else {
          if (isEnemy(r, c))   moves.push([r, c]);
          break;                // blocked
        }
        r += dr; c += dc;
      }
    }
  }

  /* helper: jump to fixed offsets */
  function jump(offsets) {
    for (const [dr, dc] of offsets) {
      const r = row + dr, c = col + dc;
      if (inBounds(r, c) && (isEmpty(r, c) || isEnemy(r, c)))
        moves.push([r, c]);
    }
  }

  switch (type) {
    case 'P': {
      const dir = color === 'white' ? -1 : 1;   // white moves up (row decreases)
      const startRow = color === 'white' ? 6 : 1;

      // forward one
      if (inBounds(row + dir, col) && isEmpty(row + dir, col)) {
        moves.push([row + dir, col]);
        // forward two from start
        if (row === startRow && isEmpty(row + 2 * dir, col))
          moves.push([row + 2 * dir, col]);
      }
      // diagonal captures
      for (const dc of [-1, 1]) {
        const nr = row + dir, nc = col + dc;
        if (inBounds(nr, nc)) {
          if (isEnemy(nr, nc)) moves.push([nr, nc]);
          // en-passant
          if (engine.enPassantTarget &&
              engine.enPassantTarget[0] === nr &&
              engine.enPassantTarget[1] === nc)
            moves.push([nr, nc]);
        }
      }
      break;
    }
    case 'R': slide([[-1,0],[1,0],[0,-1],[0,1]]); break;
    case 'B': slide([[-1,-1],[-1,1],[1,-1],[1,1]]); break;
    case 'Q': slide([[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]); break;
    case 'N': jump([[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]); break;
    case 'K': {
      jump([[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]);

      // ── Castling ──
      // King-side
      const ksRight = color === 'white' ? engine.castlingRights.wK : engine.castlingRights.bK;
      const qsRight = color === 'white' ? engine.castlingRights.wQ : engine.castlingRights.bQ;
      const kingRow = color === 'white' ? 7 : 0;

      if (row === kingRow && col === 4) {
        if (ksRight &&
            isEmpty(kingRow, 5) && isEmpty(kingRow, 6) &&
            board[kingRow][7] === makePiece(color, 'R'))
          moves.push([kingRow, 6]);  // king-side target

        if (qsRight &&
            isEmpty(kingRow, 3) && isEmpty(kingRow, 2) && isEmpty(kingRow, 1) &&
            board[kingRow][0] === makePiece(color, 'R'))
          moves.push([kingRow, 2]);  // queen-side target
      }
      break;
    }
  }
  return moves;
}

/**
 * Is the square [row,col] attacked by any piece of `attackerColor`?
 */
function isSquareAttacked(board, row, col, attackerColor) {
  // Check every square for an attacker
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || colorOf(p) !== attackerColor) continue;
      const type = typeOf(p);

      if (type === 'P') {
        const dir = attackerColor === 'white' ? -1 : 1;
        if (r + dir === row && (c - 1 === col || c + 1 === col)) return true;
      } else if (type === 'N') {
        const diffs = [[r-row, c-col]];
        const [dr, dc] = [Math.abs(r - row), Math.abs(c - col)];
        if ((dr === 2 && dc === 1) || (dr === 1 && dc === 2)) return true;
      } else if (type === 'K') {
        if (Math.abs(r - row) <= 1 && Math.abs(c - col) <= 1 && !(r === row && c === col)) return true;
      } else {
        // sliding pieces — trace rays
        const rays = {
          R: [[-1,0],[1,0],[0,-1],[0,1]],
          B: [[-1,-1],[-1,1],[1,-1],[1,1]],
          Q: [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]
        };
        const dirs = rays[type];
        if (!dirs) continue;
        for (const [dr2, dc2] of dirs) {
          let cr2 = r + dr2, cc2 = c + dc2;
          while (cr2 >= 0 && cr2 < 8 && cc2 >= 0 && cc2 < 8) {
            if (cr2 === row && cc2 === col) return true;
            if (board[cr2][cc2]) break;  // blocked
            cr2 += dr2; cc2 += dc2;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Find the king's position for a given color.
 */
function findKing(board, color) {
  const king = makePiece(color, 'K');
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] === king) return [r, c];
  return null;  // shouldn't happen
}

/**
 * Generate all LEGAL moves for `color`.
 * A move is legal if it doesn't leave the own king in check.
 */
function allLegalMoves(engine, color) {
  const moves = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = engine.board[r][c];
      if (!p || colorOf(p) !== color) continue;

      for (const [tr, tc] of pseudoLegalMoves(engine, r, c)) {
        // simulate the move on a cloned board
        if (isLegalMove(engine, r, c, tr, tc))
          moves.push({ from: [r, c], to: [tr, tc] });
      }
    }
  }
  return moves;
}

/**
 * Check whether moving [fr,fc]→[tr,tc] is legal (doesn't leave king in check).
 * Also validates castling "pass-through" squares.
 */
function isLegalMove(engine, fr, fc, tr, tc) {
  const board  = engine.board;
  const piece  = board[fr][fc];
  if (!piece) return false;
  const color  = colorOf(piece);
  const type   = typeOf(piece);

  // ── Castling pass-through check ──
  if (type === 'K' && Math.abs(fc - tc) === 2) {
    // king must not be in check currently
    if (isSquareAttacked(board, fr, fc, opponent(color))) return false;
    // intermediate square must not be attacked
    const midCol = fc < tc ? fc + 1 : fc - 1;
    if (isSquareAttacked(board, fr, midCol, opponent(color))) return false;
  }

  // Clone board and simulate
  const sim = cloneBoard(board);
  // en-passant capture removes the pawn behind
  if (type === 'P' && engine.enPassantTarget &&
      tr === engine.enPassantTarget[0] && tc === engine.enPassantTarget[1]) {
    const capturedRow = color === 'white' ? tr + 1 : tr - 1;
    sim[capturedRow][tc] = null;
  }
  // castling — move the rook too
  if (type === 'K' && Math.abs(fc - tc) === 2) {
    if (tc === 6) { sim[fr][5] = sim[fr][7]; sim[fr][7] = null; }  // king-side
    else          { sim[fr][3] = sim[fr][0]; sim[fr][0] = null; }  // queen-side
  }
  sim[tr][tc] = sim[fr][fc];
  sim[fr][fc] = null;

  // King must not be in check after the move
  const kingPos = findKing(sim, color);
  if (!kingPos) return false;  // edge case: king not found in simulation
  return !isSquareAttacked(sim, kingPos[0], kingPos[1], opponent(color));
}

/**
 * All legal destination squares for the piece at [row,col].
 */
function legalMovesFrom(engine, row, col) {
  const piece = engine.board[row][col];
  if (!piece) return [];
  return pseudoLegalMoves(engine, row, col)
    .filter(([tr, tc]) => isLegalMove(engine, row, col, tr, tc));
}

/* ─────────────────────────────────────────────────
   §4  EXECUTE & UNDO  MOVES
   ───────────────────────────────────────────────── */

/**
 * Execute a move on the engine.  Returns algebraic notation string.
 * Caller must have already validated legality.
 */
function executeMove(engine, fr, fc, tr, tc, promotionType) {
  const board = engine.board;
  const piece = board[fr][fc];
  const color = colorOf(piece);
  const type  = typeOf(piece);
  let captured = board[tr][tc];
  let notation = '';

  // ── Save undo snapshot ──
  engine.undoStack.push(engine._snapshot());
  engine.redoStack = [];  // clear redo on new move

  // ── En-passant capture ──
  if (type === 'P' && engine.enPassantTarget &&
      tr === engine.enPassantTarget[0] && tc === engine.enPassantTarget[1]) {
    const capturedRow = color === 'white' ? tr + 1 : tr - 1;
    captured = board[capturedRow][tc];
    board[capturedRow][tc] = null;
    notation = 'e.p.';
  }

  // ── Castling rook move ──
  let isCastle = false;
  if (type === 'K' && Math.abs(fc - tc) === 2) {
    isCastle = true;
    if (tc === 6) { board[fr][5] = board[fr][7]; board[fr][7] = null; notation = 'O-O'; }
    else          { board[fr][3] = board[fr][0]; board[fr][0] = null; notation = 'O-O-O'; }
  }

  // ── Move the piece ──
  board[tr][tc] = piece;
  board[fr][fc] = null;

  // ── Record captured piece ──
  if (captured) {
    engine.capturedPieces[opponent(color)].push(captured);
    if (!notation) notation = typeOf(piece) === 'P'
      ? String.fromCharCode(97 + fc) + 'x' + String.fromCharCode(97 + tc) + (8 - tr)
      : typeOf(piece) + 'x' + String.fromCharCode(97 + tc) + (8 - tr);
  }

  // ── Pawn promotion ──
  if (type === 'P' && (tr === 0 || tr === 7)) {
    const promType = promotionType || 'Q';
    board[tr][tc] = makePiece(color, promType);
    if (!notation) notation = String.fromCharCode(97 + tc) + (8 - tr) + '=' + promType;
  }

  // ── Update castling rights ──
  if (type === 'K') {
    if (color === 'white') { engine.castlingRights.wK = false; engine.castlingRights.wQ = false; }
    else                   { engine.castlingRights.bK = false; engine.castlingRights.bQ = false; }
  }
  if (type === 'R') {
    if (fr === 7 && fc === 0) engine.castlingRights.wQ = false;
    if (fr === 7 && fc === 7) engine.castlingRights.wK = false;
    if (fr === 0 && fc === 0) engine.castlingRights.bQ = false;
    if (fr === 0 && fc === 7) engine.castlingRights.bK = false;
  }
  // If a rook is captured on its starting square, remove that castling right too
  if (tr === 7 && tc === 0) engine.castlingRights.wQ = false;
  if (tr === 7 && tc === 7) engine.castlingRights.wK = false;
  if (tr === 0 && tc === 0) engine.castlingRights.bQ = false;
  if (tr === 0 && tc === 7) engine.castlingRights.bK = false;

  // ── En-passant target update ──
  if (type === 'P' && Math.abs(fr - tr) === 2) {
    engine.enPassantTarget = [(fr + tr) / 2, fc];
  } else {
    engine.enPassantTarget = null;
  }

  // ── Half-move clock ──
  if (type === 'P' || captured) engine.halfMoveClock = 0;
  else engine.halfMoveClock++;

  // ── Full-move number (increments after black moves) ──
  if (color === 'black') engine.fullMoveNumber++;

  // ── Last move record ──
  engine.lastMove = { from: [fr, fc], to: [tr, tc] };

  // ── Switch player ──
  engine.currentPlayer = opponent(color);

  // ── Check / checkmate / stalemate detection ──
  const nextMoves = allLegalMoves(engine, engine.currentPlayer);
  const kingPos   = findKing(board, engine.currentPlayer);
  const inCheck   = isSquareAttacked(board, kingPos[0], kingPos[1], color);

  if (nextMoves.length === 0) {
    engine.gameStatus = inCheck ? 'checkmate' : 'stalemate';
  } else {
    engine.gameStatus = inCheck ? 'check' : 'active';
  }

  // Build notation if not yet set
  if (!notation) {
    const prefix = type === 'P' ? '' : type;
    notation = prefix + String.fromCharCode(97 + tc) + (8 - tr);
  }
  if (inCheck && nextMoves.length > 0) notation += '+';
  if (engine.gameStatus === 'checkmate') notation = notation.replace(/\+$/, '#');

  // Push to move history
  engine.moveHistory.push({ notation, color, from: [fr, fc], to: [tr, tc] });

  return notation;
}

/* ── Undo ── */
function undoMove(engine) {
  if (engine.undoStack.length === 0) return false;
  engine.redoStack.push(engine._snapshot());
  const snap = engine.undoStack.pop();
  engine._restoreSnapshot(snap);
  engine.moveHistory.pop();
  engine.gameStatus = 'active';  // recalc done in renderer if needed
  // re-detect check for restored position
  const kingPos = findKing(engine.board, engine.currentPlayer);
  if (isSquareAttacked(engine.board, kingPos[0], kingPos[1], opponent(engine.currentPlayer)))
    engine.gameStatus = 'check';
  return true;
}

/* ── Redo ── */
function redoMove(engine) {
  if (engine.redoStack.length === 0) return false;
  engine.undoStack.push(engine._snapshot());
  const snap = engine.redoStack.pop();
  engine._restoreSnapshot(snap);
  // moveHistory is part of snapshot? No — rebuild from undoStack length
  // We store moveHistory entries separately; redo restores the snap which
  // already has the state *after* that move but we need the notation.
  // Simpler: re-derive.  For now, the renderer re-reads engine.moveHistory.
  return true;
}

/* ─────────────────────────────────────────────────
   §5  AI AGENT  — minimax with alpha-beta pruning
   ───────────────────────────────────────────────── */

// Piece-square tables for positional evaluation (from white's perspective)
// Values are bonuses in centipawns.  Flip row index for black.
const PST = {
  P: [
    [ 0, 0, 0, 0, 0, 0, 0, 0],
    [50,50,50,50,50,50,50,50],
    [10,10,20,30,30,20,10,10],
    [ 5, 5,10,25,25,10, 5, 5],
    [ 0, 0, 0,20,20, 0, 0, 0],
    [ 5,-5,-10, 0, 0,-10,-5, 5],
    [ 5,10,10,-20,-20,10,10, 5],
    [ 0, 0, 0, 0, 0, 0, 0, 0]
  ],
  N: [
    [-50,-40,-30,-30,-30,-30,-40,-50],
    [-40,-20, 0, 0, 0, 0,-20,-40],
    [-40, 5,10,15,15,10, 5,-40],
    [-40, 0,15,20,20,15, 0,-40],
    [-40, 5,15,20,20,15, 5,-40],
    [-40, 0,10,15,15,10, 0,-40],
    [-40,-20, 0, 5, 5, 0,-20,-40],
    [-50,-40,-30,-30,-30,-30,-40,-50]
  ],
  B: [
    [-20,-10,-10,-10,-10,-10,-10,-20],
    [-10, 0, 0, 0, 0, 0, 0,-10],
    [-10, 5, 5,10,10, 5, 5,-10],
    [-10, 0,10,10,10,10, 0,-10],
    [-10, 5, 5,10,10, 5, 5,-10],
    [-10, 0, 5,10,10, 5, 0,-10],
    [-10, 5, 0, 0, 0, 0, 5,-10],
    [-20,-10,-10,-10,-10,-10,-10,-20]
  ],
  R: [
    [ 0, 0, 0, 0, 0, 0, 0, 0],
    [ 5,10,10,10,10,10,10, 5],
    [-5, 0, 0, 0, 0, 0, 0,-5],
    [-5, 0, 0, 0, 0, 0, 0,-5],
    [-5, 0, 0, 0, 0, 0, 0,-5],
    [-5, 0, 0, 0, 0, 0, 0,-5],
    [-5, 0, 0, 0, 0, 0, 0,-5],
    [ 0, 0, 0, 5, 5, 0, 0, 0]
  ],
  Q: [
    [-20,-10,-10,-5,-5,-10,-10,-20],
    [-10, 0, 0, 0, 0, 0, 0,-10],
    [-10, 0, 5, 5, 5, 5, 0,-10],
    [ -5, 0, 5, 5, 5, 5, 0, -5],
    [  0, 0, 5, 5, 5, 5, 0, -5],
    [-10, 5, 5, 5, 5, 5, 0,-10],
    [-10, 0, 5, 0, 0, 0, 0,-10],
    [-20,-10,-10,-5,-5,-10,-10,-20]
  ],
  K: [
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-20,-30,-30,-40,-40,-30,-30,-20],
    [-10,-20,-20,-20,-20,-20,-20,-10],
    [ 20, 20,  0,  0,  0,  0, 20, 20],
    [ 20, 30, 10,  0,  0, 10, 30, 20]
  ]
};

/**
 * Static board evaluation from white's perspective (centipawns).
 */
function evaluate(board) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const color = colorOf(p);
      const type  = typeOf(p);
      const val   = VALUE[type];
      // PST row: white uses r directly, black flips
      const pstRow = color === 'white' ? r : 7 - r;
      const bonus  = PST[type] ? PST[type][pstRow][c] : 0;
      score += (color === 'white' ? 1 : -1) * (val + bonus);
    }
  }
  return score;
}

/**
 * Minimax with alpha-beta pruning.
 * Returns { score, move } where move is { from:[r,c], to:[r,c] }.
 */
function minimax(engine, depth, alpha, beta, maximizing) {
  // Terminal / depth-0 → static eval
  if (depth === 0 || engine.gameStatus === 'checkmate' || engine.gameStatus === 'stalemate') {
    if (engine.gameStatus === 'checkmate')
      return { score: maximizing ? -99999 + depth : 99999 - depth, move: null };
    if (engine.gameStatus === 'stalemate')
      return { score: 0, move: null };
    return { score: evaluate(engine.board), move: null };
  }

  const color = engine.currentPlayer;
  const moves = allLegalMoves(engine, color);
  let bestMove = moves[0] || null;

  if (maximizing) {
    let bestScore = -Infinity;
    for (const m of moves) {
      const snap = engine._snapshot();
      const histLen = engine.moveHistory.length;
      executeMove(engine, m.from[0], m.from[1], m.to[0], m.to[1]);
      const result = minimax(engine, depth - 1, alpha, beta, false);
      engine._restoreSnapshot(snap);
      engine.moveHistory.length = histLen;
      if (result.score > bestScore) { bestScore = result.score; bestMove = m; }
      alpha = Math.max(alpha, bestScore);
      if (beta <= alpha) break;
    }
    return { score: bestScore, move: bestMove };
  } else {
    let bestScore = Infinity;
    for (const m of moves) {
      const snap = engine._snapshot();
      const histLen = engine.moveHistory.length;
      executeMove(engine, m.from[0], m.from[1], m.to[0], m.to[1]);
      const result = minimax(engine, depth - 1, alpha, beta, true);
      engine._restoreSnapshot(snap);
      engine.moveHistory.length = histLen;
      if (result.score < bestScore) { bestScore = result.score; bestMove = m; }
      beta = Math.min(beta, bestScore);
      if (beta <= alpha) break;
    }
    return { score: bestScore, move: bestMove };
  }
}

/**
 * Get AI move for current position.
 * Easy  = random legal move
 * Medium = minimax depth 3
 * Hard   = minimax depth 5
 */
function getAIMove(engine, difficulty) {
  const color = engine.currentPlayer;
  const moves = allLegalMoves(engine, color);
  if (moves.length === 0) return null;

  if (difficulty === 'easy') {
    // 70 % random, 30 % depth-1 (slight preference for captures)
    if (Math.random() < 0.7) {
      return moves[Math.floor(Math.random() * moves.length)];
    }
    const maximizing = color === 'white';
    const result = minimax(engine, 1, -Infinity, Infinity, maximizing);
    return result.move || moves[0];
  }

  const depthMap = { medium: 3, hard: 5 };
  const depth = depthMap[difficulty] || 3;
  const maximizing = color === 'white';
  const result = minimax(engine, depth, -Infinity, Infinity, maximizing);
  return result.move || moves[0];
}

/* ─────────────────────────────────────────────────
   §6  HINT SYSTEM  — depth-3 best move suggestion
   ───────────────────────────────────────────────── */
function getHint(engine) {
  const color      = engine.currentPlayer;
  const maximizing = color === 'white';
  const result     = minimax(engine, 3, -Infinity, Infinity, maximizing);
  if (!result.move) return null;

  // Build a short explanation
  const piece  = engine.board[result.move.from[0]][result.move.from[1]];
  const target = engine.board[result.move.to[0]][result.move.to[1]];
  const fromSq = String.fromCharCode(97 + result.move.from[1]) + (8 - result.move.from[0]);
  const toSq   = String.fromCharCode(97 + result.move.to[0])   + (8 - result.move.to[0]);  // intentional: we show dest
  const toSqFix = String.fromCharCode(97 + result.move.to[1]) + (8 - result.move.to[0]);

  let explanation = '';
  if (target) {
    explanation = `Capture the ${typeOf(target).toLowerCase() === 'q' ? 'queen' : typeOf(target).toLowerCase() === 'r' ? 'rook' : typeOf(target).toLowerCase() === 'b' ? 'bishop' : typeOf(target).toLowerCase() === 'n' ? 'knight' : 'pawn'} on ${toSqFix}.`;
  } else if (typeOf(piece) === 'K') {
    explanation = 'Move your king to a safer square.';
  } else if (engine.gameStatus === 'check') {
    explanation = 'Get out of check with this move.';
  } else {
    explanation = `Develop your ${typeOf(piece) === 'P' ? 'pawn' : typeOf(piece) === 'N' ? 'knight' : typeOf(piece) === 'B' ? 'bishop' : typeOf(piece) === 'R' ? 'rook' : typeOf(piece) === 'Q' ? 'queen' : 'piece'} to ${toSqFix}.`;
  }

  return { move: result.move, explanation, score: result.score };
}

/* ─────────────────────────────────────────────────
   §7  AUDIO SYSTEM  — Web Audio API tones
   ───────────────────────────────────────────────── */
class AudioSystem {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  _getCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  _play(freq, type, duration, gain = 0.15) {
    if (!this.enabled) return;
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      env.gain.setValueAtTime(gain, ctx.currentTime);
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(env);
      env.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) { /* audio not available */ }
  }

  move()     { this._play(440, 'sine', 0.12); }
  capture()  { this._play(220, 'sawtooth', 0.25, 0.2); }
  check()    { this._play(880, 'square', 0.3, 0.18); }
  gameEnd()  {
    // short descending chord
    this._play(523, 'sine', 0.4, 0.15);
    setTimeout(() => this._play(392, 'sine', 0.4, 0.15), 120);
    setTimeout(() => this._play(262, 'sine', 0.5, 0.18), 240);
  }
  invalid()  { this._play(150, 'sawtooth', 0.15, 0.08); }
}

/* ─────────────────────────────────────────────────
   §8  BOARD RENDERER  — DOM manipulation
   ───────────────────────────────────────────────── */
class BoardRenderer {
  constructor() {
    this.boardEl       = document.getElementById('chessboard');
    this.selectedSq    = null;   // [row, col] or null
    this.validMoves    = [];     // [[r,c], ...]
    this.flipped       = false;
    this.hintMove      = null;   // { from, to } or null
  }

  /** Build the 64-square grid from scratch */
  buildBoard(engine) {
    this.boardEl.innerHTML = '';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = document.createElement('div');
        sq.className = 'square ' + ((r + c) % 2 === 0 ? 'square--light' : 'square--dark');
        sq.dataset.row = r;
        sq.dataset.col = c;
        sq.setAttribute('role', 'gridcell');
        sq.setAttribute('aria-label', this._ariaLabel(engine, r, c));
        sq.setAttribute('tabindex', '0');
        sq.addEventListener('click', () => GameController.onSquareClick(r, c));
        sq.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            GameController.onSquareClick(r, c);
          }
        });
        this.boardEl.appendChild(sq);
      }
    }
  }

  _ariaLabel(engine, r, c) {
    const file  = String.fromCharCode(97 + c);
    const rank  = 8 - r;
    const piece = engine.board[r][c];
    if (!piece) return `${file}${rank}, empty`;
    const names = { P:'Pawn', R:'Rook', N:'Knight', B:'Bishop', Q:'Queen', K:'King' };
    return `${file}${rank}, ${colorOf(piece)} ${names[typeOf(piece)]}`;
  }

  /** Update piece glyphs + all highlight classes */
  render(engine) {
    const squares = this.boardEl.querySelectorAll('.square');
    squares.forEach(sq => {
      const r = parseInt(sq.dataset.row);
      const c = parseInt(sq.dataset.col);
      const piece = engine.board[r][c];

      // ── Clear old state classes ──
      sq.classList.remove('square--selected','square--valid-move','square--capture',
                          'square--last-move','square--check','square--hint');

      // ── Last move highlight ──
      if (engine.lastMove) {
        if ((r === engine.lastMove.from[0] && c === engine.lastMove.from[1]) ||
            (r === engine.lastMove.to[0]   && c === engine.lastMove.to[1]))
          sq.classList.add('square--last-move');
      }

      // ── Check highlight on king ──
      if (engine.gameStatus === 'check' || engine.gameStatus === 'checkmate') {
        const kingPos = findKing(engine.board, engine.currentPlayer);
        if (kingPos && r === kingPos[0] && c === kingPos[1])
          sq.classList.add('square--check');
      }

      // ── Selected square ──
      if (this.selectedSq && r === this.selectedSq[0] && c === this.selectedSq[1])
        sq.classList.add('square--selected');

      // ── Valid move targets ──
      const isValid = this.validMoves.some(m => m[0] === r && m[1] === c);
      if (isValid) {
        if (piece && colorOf(piece) !== engine.currentPlayer)
          sq.classList.add('square--capture');  // enemy piece → capture ring
        else if (!piece)
          sq.classList.add('square--valid-move'); // empty → dot
        else
          sq.classList.add('square--valid-move');
      }

      // ── Hint highlight ──
      if (this.hintMove) {
        if ((r === this.hintMove.from[0] && c === this.hintMove.from[1]) ||
            (r === this.hintMove.to[0]   && c === this.hintMove.to[1]))
          sq.classList.add('square--hint');
      }

      // ── Piece glyph ──
      // Remove old piece element
      const oldPiece = sq.querySelector('.piece');
      if (oldPiece) oldPiece.remove();

      if (piece) {
        const pieceEl = document.createElement('span');
        pieceEl.className = 'piece piece--' + colorOf(piece);
        pieceEl.textContent = GLYPH[piece];
        pieceEl.setAttribute('aria-hidden', 'true');
        sq.appendChild(pieceEl);
      }

      // Update aria-label
      sq.setAttribute('aria-label', this._ariaLabel(engine, r, c));
    });

    // ── Board flip ──
    if (this.flipped) this.boardEl.classList.add('board--flipped');
    else              this.boardEl.classList.remove('board--flipped');
  }
}

/* ─────────────────────────────────────────────────
   §9  GAME CONTROLLER  — orchestrates everything
   ───────────────────────────────────────────────── */
const GameController = (() => {
  let engine        = new ChessEngine();
  let renderer      = new BoardRenderer();
  let audio         = new AudioSystem();
  let gameMode      = 'pvp';          // 'pvp' | 'pve'
  let difficulty    = 'easy';         // 'easy' | 'medium' | 'hard'
  let playerColor   = 'white';        // which side the human plays
  let hintsLeft     = 3;
  let aiThinking    = false;

  /* ── DOM references ── */
  const setupModal     = document.getElementById('setupModal');
  const gameOverModal  = document.getElementById('gameOverModal');
  const gameOverIcon   = document.getElementById('gameOverIcon');
  const gameOverTitle  = document.getElementById('gameOverTitle');
  const gameOverResult = document.getElementById('gameOverResult');
  const btnStartGame   = document.getElementById('btnStartGame');
  const btnPlayAgain   = document.getElementById('btnPlayAgain');
  const btnUndo        = document.getElementById('btnUndo');
  const btnRedo        = document.getElementById('btnRedo');
  const btnRestart     = document.getElementById('btnRestart');
  const btnResign      = document.getElementById('btnResign');
  const btnHint        = document.getElementById('btnHint');
  const btnSound       = document.getElementById('btnSound');
  const btnFlipBoard   = document.getElementById('btnFlipBoard');
  const statusTurn     = document.getElementById('statusTurn');
  const statusCheck    = document.getElementById('statusCheck');
  const hintCounter    = document.getElementById('hintCounter');
  const hintBox        = document.getElementById('hintBox');
  const hintText       = document.getElementById('hintText');
  const aiStatus       = document.getElementById('aiStatus');
  const moveHistoryEl  = document.getElementById('moveHistory');
  const capturedWhiteEl= document.getElementById('capturedWhite');
  const capturedBlackEl= document.getElementById('capturedBlack');
  const difficultyField= document.getElementById('difficultyField');
  const colorField     = document.getElementById('colorField');

  /* ── Show / hide setup modal ── */
  function showSetupModal() {
    setupModal.classList.remove('hidden');
    gameOverModal.classList.add('hidden');
  }

  function hideSetupModal() {
    setupModal.classList.add('hidden');
  }

  /* ── Initialize on first load ── */
  function init() {
    showSetupModal();
    // Wire radio visibility
    document.querySelectorAll('input[name="gameMode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const val = document.querySelector('input[name="gameMode"]:checked').value;
        difficultyField.classList.toggle('hidden', val !== 'pve');
        colorField.classList.toggle('hidden', val !== 'pve');
      });
    });
    // Initially hide difficulty & color if PvP is default
    difficultyField.classList.add('hidden');
    colorField.classList.add('hidden');

    // Start game button
    btnStartGame.addEventListener('click', startGame);
    btnPlayAgain.addEventListener('click', () => { gameOverModal.classList.add('hidden'); showSetupModal(); });

    // Game controls
    btnUndo.addEventListener('click', handleUndo);
    btnRedo.addEventListener('click', handleRedo);
    btnRestart.addEventListener('click', () => showSetupModal());
    btnResign.addEventListener('click', handleResign);
    btnHint.addEventListener('click', handleHint);
    btnSound.addEventListener('click', toggleSound);
    btnFlipBoard.addEventListener('click', flipBoard);
  }

  /* ── Start a new game ── */
  function startGame() {
    // Read settings
    gameMode    = document.querySelector('input[name="gameMode"]:checked').value;
    difficulty  = document.querySelector('input[name="difficulty"]:checked')?.value || 'easy';
    playerColor = document.querySelector('input[name="playerColor"]:checked')?.value || 'white';

    // Reset engine
    engine = new ChessEngine();
    renderer.selectedSq = null;
    renderer.validMoves  = [];
    renderer.hintMove    = null;
    hintsLeft = 3;
    aiThinking = false;

    hideSetupModal();
    gameOverModal.classList.add('hidden');
    hintBox.classList.add('hidden');

    // Build & render board
    renderer.buildBoard(engine);
    fullRender();

    // If PvE and AI plays first (player chose black), trigger AI
    if (gameMode === 'pve' && playerColor === 'black') {
      triggerAI();
    }
  }

  /* ── Full UI update ── */
  function fullRender() {
    renderer.render(engine);
    updateStatusBar();
    updateMoveHistory();
    updateCapturedPieces();
    updateHintCounter();
    updateButtons();

    // Auto-save
    saveToLocalStorage();
  }

  /* ── Status bar ── */
  function updateStatusBar() {
    const dot  = statusTurn.querySelector('.status-dot');
    const text = statusTurn.querySelector('.status-text');
    dot.className = 'status-dot status-dot--' + engine.currentPlayer;
    text.textContent = engine.currentPlayer.charAt(0).toUpperCase() + engine.currentPlayer.slice(1) + "'s Turn";

    if (engine.gameStatus === 'check' || engine.gameStatus === 'checkmate')
      statusCheck.classList.remove('hidden');
    else
      statusCheck.classList.add('hidden');
  }

  /* ── Move history panel ── */
  function updateMoveHistory() {
    moveHistoryEl.innerHTML = '';
    const history = engine.moveHistory;
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const isLatest = i === history.length - 1;

      if (entry.color === 'white') {
        const num  = document.createElement('span');
        num.className = 'move-entry--number';
        num.textContent = Math.floor(i / 2) + 1 + '.';
        moveHistoryEl.appendChild(num);
      }
      const span = document.createElement('span');
      span.className = 'move-entry move-entry--' + entry.color + (isLatest ? ' move-entry--latest' : '');
      span.textContent = entry.notation;
      moveHistoryEl.appendChild(span);
    }
    // Auto-scroll to end
    moveHistoryEl.scrollLeft = moveHistoryEl.scrollWidth;
  }

  /* ── Captured pieces ── */
  function updateCapturedPieces() {
    // capturedWhite = pieces captured BY white (i.e. black pieces taken)
    capturedWhiteEl.innerHTML = engine.capturedPieces.white.map(p => GLYPH[p]).join('');
    capturedBlackEl.innerHTML = engine.capturedPieces.black.map(p => GLYPH[p]).join('');
  }

  /* ── Hint counter ── */
  function updateHintCounter() {
    hintCounter.textContent = '💡 ' + hintsLeft + ' hint' + (hintsLeft !== 1 ? 's' : '') + ' left';
    btnHint.disabled = hintsLeft <= 0 || engine.gameStatus === 'checkmate' || engine.gameStatus === 'stalemate';
  }

  /* ── Enable / disable buttons based on state ── */
  function updateButtons() {
    const gameOver = engine.gameStatus === 'checkmate' || engine.gameStatus === 'stalemate' || engine.gameStatus === 'resigned';
    btnUndo.disabled  = engine.undoStack.length === 0 || gameOver;
    btnRedo.disabled  = engine.redoStack.length === 0 || gameOver;
    btnResign.disabled = gameOver;
    btnHint.disabled   = hintsLeft <= 0 || gameOver;
  }

  /* ── Square click handler ── */
  function onSquareClick(row, col) {
    if (engine.gameStatus === 'checkmate' || engine.gameStatus === 'stalemate' || engine.gameStatus === 'resigned')
      return;
    if (aiThinking) return;  // block input while AI is moving

    // In PvE mode, block if it's not the player's turn
    if (gameMode === 'pve' && engine.currentPlayer !== playerColor) return;

    const piece = engine.board[row][col];

    // ── Case A: A valid move is selected ──
    if (renderer.selectedSq && renderer.validMoves.some(m => m[0] === row && m[1] === col)) {
      // Perform the move
      const [fr, fc] = renderer.selectedSq;
      const captured = engine.board[row][col];

      // Determine promotion (auto-queen for simplicity & UX speed)
      let promo = undefined;
      const movingPiece = engine.board[fr][fc];
      if (typeOf(movingPiece) === 'P' && (row === 0 || row === 7)) promo = 'Q';

      const notation = executeMove(engine, fr, fc, row, col, promo);

      // Audio
      if (captured || (typeOf(movingPiece) === 'P' && engine.lastMove && fc !== col)) {
        audio.capture();
      } else {
        audio.move();
      }
      if (engine.gameStatus === 'check')     audio.check();
      if (engine.gameStatus === 'checkmate' || engine.gameStatus === 'stalemate') audio.gameEnd();

      // Clear selection
      renderer.selectedSq = null;
      renderer.validMoves  = [];
      renderer.hintMove    = null;
      hintBox.classList.add('hidden');

      fullRender();

      // ── Game-over check ──
      if (engine.gameStatus === 'checkmate') {
        showGameOver('checkmate', opponent(engine.currentPlayer));
        return;
      }
      if (engine.gameStatus === 'stalemate') {
        showGameOver('stalemate', null);
        return;
      }

      // ── Trigger AI if PvE ──
      if (gameMode === 'pve' && engine.currentPlayer !== playerColor) {
        triggerAI();
      }
      return;
    }

    // ── Case B: Selecting own piece ──
    if (piece && colorOf(piece) === engine.currentPlayer) {
      renderer.selectedSq = [row, col];
      renderer.validMoves  = legalMovesFrom(engine, row, col);
      renderer.hintMove    = null;
      hintBox.classList.add('hidden');
      fullRender();
      return;
    }

    // ── Case C: Clicking empty / enemy without prior selection → deselect ──
    if (renderer.selectedSq) {
      audio.invalid();
      renderer.selectedSq = null;
      renderer.validMoves  = [];
      fullRender();
    }
  }

  /* ── Undo ── */
  function handleUndo() {
    if (aiThinking) return;
    if (undoMove(engine)) {
      renderer.selectedSq = null;
      renderer.validMoves  = [];
      renderer.hintMove    = null;
      hintBox.classList.add('hidden');
      fullRender();
    }
  }

  /* ── Redo ── */
  function handleRedo() {
    if (aiThinking) return;
    if (redoMove(engine)) {
      renderer.selectedSq = null;
      renderer.validMoves  = [];
      fullRender();

      // If PvE and it's now AI's turn, trigger AI
      if (gameMode === 'pve' && engine.currentPlayer !== playerColor &&
          engine.gameStatus !== 'checkmate' && engine.gameStatus !== 'stalemate') {
        triggerAI();
      }
    }
  }

  /* ── Resign ── */
  function handleResign() {
    engine.gameStatus = 'resigned';
    engine.lastMove   = null;
    renderer.selectedSq = null;
    renderer.validMoves  = [];
    fullRender();
    showGameOver('resigned', opponent(engine.currentPlayer));
  }

  /* ── Hint ── */
  function handleHint() {
    if (hintsLeft <= 0) return;
    if (engine.gameStatus !== 'active' && engine.gameStatus !== 'check') return;

    const hint = getHint(engine);
    if (!hint) return;

    hintsLeft--;
    renderer.hintMove = hint.move;
    hintBox.classList.remove('hidden');
    hintText.textContent = hint.explanation;
    fullRender();
  }

  /* ── Sound toggle ── */
  function toggleSound() {
    audio.enabled = !audio.enabled;
    btnSound.querySelector('.btn-icon-svg').textContent = audio.enabled ? '🔊' : '🔇';
  }

  /* ── Board flip ── */
  function flipBoard() {
    renderer.flipped = !renderer.flipped;
    fullRender();
  }

  /* ── Trigger AI move (with delay for realism) ── */
  function triggerAI() {
    if (engine.gameStatus === 'checkmate' || engine.gameStatus === 'stalemate') return;
    aiThinking = true;
    aiStatus.classList.remove('hidden');

    // Delay: easy 400ms, medium 700ms, hard 1200ms (hard also takes longer to compute)
    const delays = { easy: 400, medium: 700, hard: 1200 };
    const delay  = delays[difficulty] || 600;

    setTimeout(() => {
      const move = getAIMove(engine, difficulty);
      if (!move) { aiThinking = false; aiStatus.classList.add('hidden'); return; }

      const captured = engine.board[move.to[0]][move.to[1]];
      const movingPiece = engine.board[move.from[0]][move.from[1]];

      // Determine promotion
      let promo;
      if (typeOf(movingPiece) === 'P' && (move.to[0] === 0 || move.to[0] === 7)) promo = 'Q';

      executeMove(engine, move.from[0], move.from[1], move.to[0], move.to[1], promo);

      // Audio
      if (captured) audio.capture();
      else          audio.move();
      if (engine.gameStatus === 'check')     audio.check();
      if (engine.gameStatus === 'checkmate' || engine.gameStatus === 'stalemate') audio.gameEnd();

      renderer.selectedSq = null;
      renderer.validMoves  = [];
      aiThinking = false;
      aiStatus.classList.add('hidden');

      fullRender();

      if (engine.gameStatus === 'checkmate') { showGameOver('checkmate', opponent(engine.currentPlayer)); return; }
      if (engine.gameStatus === 'stalemate') { showGameOver('stalemate', null); return; }
    }, delay);
  }

  /* ── Game-over overlay ── */
  function showGameOver(reason, winner) {
    if (reason === 'checkmate') {
      gameOverIcon.textContent  = '🏆';
      gameOverTitle.textContent = 'CHECKMATE';
      gameOverResult.textContent = winner.charAt(0).toUpperCase() + winner.slice(1) + ' Wins!';
    } else if (reason === 'stalemate') {
      gameOverIcon.textContent  = '🤝';
      gameOverTitle.textContent = 'STALEMATE';
      gameOverResult.textContent = "It's a Draw!";
    } else if (reason === 'resigned') {
      gameOverIcon.textContent  = '🏳';
      gameOverTitle.textContent = 'RESIGNED';
      gameOverResult.textContent = winner.charAt(0).toUpperCase() + winner.slice(1) + ' Wins!';
    }
    gameOverModal.classList.remove('hidden');
  }

  /* ── Local storage persistence ── */
  function saveToLocalStorage() {
    try {
      const data = {
        fen:            engine.toFEN(),
        moveHistory:    engine.moveHistory,
        capturedPieces: engine.capturedPieces,
        lastMove:       engine.lastMove,
        gameMode,
        difficulty,
        playerColor,
        hintsLeft,
        gameStatus:     engine.gameStatus,
        undoStack:      engine.undoStack.map(s => ({
          fen: (() => {
            // Build a mini FEN from snapshot for restore
            const tmp = new ChessEngine();
            tmp._restoreSnapshot(s);
            return tmp.toFEN();
          })(),
          capturedPieces: s.capturedPieces,
          lastMove:       s.lastMove,
          gameStatus:     s.gameStatus
        }))
      };
      localStorage.setItem('nexus_chess_state', JSON.stringify(data));
    } catch (e) {
      // localStorage unavailable — silent fail
    }
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem('nexus_chess_state');
      if (!raw) return false;
      const data = JSON.parse(raw);

      engine = new ChessEngine();
      engine.loadFEN(data.fen);
      engine.moveHistory    = data.moveHistory || [];
      engine.capturedPieces = data.capturedPieces || { white: [], black: [] };
      engine.lastMove       = data.lastMove || null;
      engine.gameStatus     = data.gameStatus || 'active';

      gameMode    = data.gameMode    || 'pvp';
      difficulty  = data.difficulty  || 'easy';
      playerColor = data.playerColor || 'white';
      hintsLeft   = data.hintsLeft   !== undefined ? data.hintsLeft : 3;

      // Rebuild undo stack from saved snapshots
      engine.undoStack = (data.undoStack || []).map(s => {
        const tmp = new ChessEngine();
        tmp.loadFEN(s.fen);
        tmp.capturedPieces = s.capturedPieces;
        tmp.lastMove       = s.lastMove;
        tmp.gameStatus     = s.gameStatus;
        return tmp._snapshot();
      });

      renderer.buildBoard(engine);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ── Public interface ── */
  return {
    init,
    onSquareClick,
    startGame,
    loadFromLocalStorage
  };
})();

/* ─────────────────────────────────────────────────
   §10  BOOTSTRAP
   ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  GameController.init();

  // Attempt to restore a previous session
  if (GameController.loadFromLocalStorage()) {
    // Successfully restored — hide setup modal and show the board
    document.getElementById('setupModal').classList.add('hidden');
  }
  // Otherwise the setup modal stays visible (shown by init)
});
