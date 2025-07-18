// gameLogic.js
// Contém toda a lógica e regras do jogo de Damas Brasileiras (8x8).
// Este módulo é 'puro', não depende de Express ou WebSockets, apenas do estado do jogo.

const PIECE_TYPES = {
    BLACK_PAWN: 'b',
    WHITE_PAWN: 'w',
    BLACK_KING: 'B',
    WHITE_KING: 'W',
    EMPTY: 'e',
};

/**
 * Cria e retorna o estado inicial do tabuleiro de Damas Brasileiras 8x8.
 * @returns {Array<Array<string>>} Uma matriz 8x8 representando o tabuleiro.
 */
const createInitialBoard = () => {
    return [
        ['e', 'b', 'e', 'b', 'e', 'b', 'e', 'b'],
        ['b', 'e', 'b', 'e', 'b', 'e', 'b', 'e'],
        ['e', 'b', 'e', 'b', 'e', 'b', 'e', 'b'],
        ['e', 'e', 'e', 'e', 'e', 'e', 'e', 'e'],
        ['e', 'e', 'e', 'e', 'e', 'e', 'e', 'e'],
        ['w', 'e', 'w', 'e', 'w', 'e', 'w', 'e'],
        ['e', 'w', 'e', 'w', 'e', 'w', 'e', 'w'],
        ['w', 'e', 'w', 'e', 'w', 'e', 'w', 'e'],
    ];
};

/**
 * Verifica se uma determinada posição está dentro dos limites do tabuleiro.
 * @param {number} row - A linha.
 * @param {number} col - A coluna.
 * @returns {boolean} - True se a posição for válida.
 */
const isWithinBoard = (row, col) => row >= 0 && row < 8 && col >= 0 && col < 8;

/**
 * Verifica se uma peça pertence a um jogador específico.
 * @param {string} piece - O tipo da peça ('b', 'w', 'B', 'W').
 * @param {string} playerColor - A cor do jogador ('black' ou 'white').
 * @returns {boolean} - True se a peça pertence ao jogador.
 */
const isPlayerPiece = (piece, playerColor) => {
    if (playerColor === 'black') {
        return piece === PIECE_TYPES.BLACK_PAWN || piece === PIECE_TYPES.BLACK_KING;
    }
    if (playerColor === 'white') {
        return piece === PIECE_TYPES.WHITE_PAWN || piece === PIECE_TYPES.WHITE_KING;
    }
    return false;
};

/**
 * Encontra todas as sequências de captura possíveis para um jogador (recursivamente).
 * Esta é a função central para impor a captura obrigatória e a lei da maioria.
 * @param {Array<Array<string>>} board - O estado atual do tabuleiro.
 * @param {string} playerColor - A cor do jogador que está a mover.
 * @returns {Array<Object>} Um array de sequências de captura. Ex: [{ path: [[r1,c1], [r3,c3]], captures: 1 }]
 */
const findAllCaptureSequences = (board, playerColor) => {
    let allSequences = [];
    let maxCaptures = 0;

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (isPlayerPiece(piece, playerColor)) {
                findCaptureSequencesForPiece(board, r, c, piece, [{ r, c }], []).forEach(seq => {
                    const capturesCount = seq.capturedPieces.length;
                    if (capturesCount > 0) {
                        if (capturesCount > maxCaptures) {
                            maxCaptures = capturesCount;
                            allSequences = [seq];
                        } else if (capturesCount === maxCaptures) {
                            allSequences.push(seq);
                        }
                    }
                });
            }
        }
    }
    // Retorna apenas as sequências com o número máximo de capturas (lei da maioria).
    return allSequences.filter(seq => seq.capturedPieces.length === maxCaptures);
};


/**
 * Função recursiva auxiliar para encontrar sequências de captura para UMA peça específica.
 */
function findCaptureSequencesForPiece(board, r, c, piece, currentPath, capturedSoFar) {
    let sequences = [];
    const isKing = piece === 'B' || piece === 'W';
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]]; // Todas as 4 diagonais

    for (const [dr, dc] of directions) {
        let potentialCaptures = [];

        // Lógica para a Dama (King)
        if (isKing) {
            let pathIsClear = true;
            for (let i = 1; i < 8; i++) {
                const nextR = r + i * dr;
                const nextC = c + i * dc;
                const landR = nextR + dr;
                const landC = nextC + dc;

                if (!isWithinBoard(nextR, nextC) || !isWithinBoard(landR, landC)) break;
                
                const nextCell = board[nextR][nextC];
                const landCell = board[landR][landC];

                // Se a casa adjacente estiver ocupada
                if(nextCell !== PIECE_TYPES.EMPTY) {
                    if (pathIsClear && !isPlayerPiece(nextCell, isPlayerPiece(piece, 'white') ? 'white' : 'black') && landCell === PIECE_TYPES.EMPTY) {
                        potentialCaptures.push({ capR: nextR, capC: nextC, landR, landC });
                    }
                    pathIsClear = false; // Bloqueia o caminho para outras capturas nesta direção
                }
            }
        }
        // Lógica para o Peão (Pawn)
        else {
            const capR = r + dr;
            const capC = c + dc;
            const landR = r + 2 * dr;
            const landC = c + 2 * dc;

            if (isWithinBoard(landR, landC) && board[landR][landC] === PIECE_TYPES.EMPTY) {
                const capturedPiece = board[capR][capC];
                if (capturedPiece !== PIECE_TYPES.EMPTY && !isPlayerPiece(capturedPiece, isPlayerPiece(piece, 'white') ? 'white' : 'black')) {
                    potentialCaptures.push({ capR, capC, landR, landC });
                }
            }
        }
        
        // Para cada captura potencial encontrada, continua a busca recursivamente
        for (const { capR, capC, landR, landC } of potentialCaptures) {
            // Previne capturar a mesma peça duas vezes na mesma sequência
            if (capturedSoFar.some(p => p.r === capR && p.c === capC)) continue;

            const tempBoard = board.map(row => [...row]);
            tempBoard[landR][landC] = piece;
            tempBoard[r][c] = PIECE_TYPES.EMPTY;
            tempBoard[capR][capC] = PIECE_TYPES.EMPTY;

            const newPath = [...currentPath, {r: landR, c: landC}];
            const newCaptured = [...capturedSoFar, {r: capR, c: capC}];

            const deeperSequences = findCaptureSequencesForPiece(tempBoard, landR, landC, piece, newPath, newCaptured);
            if (deeperSequences.length > 0) {
                sequences.push(...deeperSequences);
            } else {
                sequences.push({ path: newPath, capturedPieces: newCaptured });
            }
        }
    }

    if (sequences.length === 0 && capturedSoFar.length > 0) {
        return [{ path: currentPath, capturedPieces: capturedSoFar }];
    }
    
    return sequences;
}


/**
 * Encontra todos os movimentos simples (não-captura) possíveis para um jogador.
 * @param {Array<Array<string>>} board - O estado do tabuleiro.
 * @param {string} playerColor - A cor do jogador.
 * @returns {Array<Object>} Um array de movimentos possíveis. Ex: [{ from: [r,c], to: [r,c] }]
 */
const findSimpleMoves = (board, playerColor) => {
    const moves = [];
    const forwardDir = playerColor === 'white' ? -1 : 1;

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (!isPlayerPiece(piece, playerColor)) continue;

            // Movimentos da Dama (King)
            if (piece === 'B' || piece === 'W') {
                const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
                for (const [dr, dc] of directions) {
                    for (let i = 1; i < 8; i++) {
                        const nextR = r + i * dr;
                        const nextC = c + i * dc;
                        if (!isWithinBoard(nextR, nextC) || board[nextR][nextC] !== PIECE_TYPES.EMPTY) break;
                        moves.push({ from: { r, c }, to: { r: nextR, c: nextC } });
                    }
                }
            }
            // Movimentos do Peão (Pawn)
            else {
                const directions = [[forwardDir, -1], [forwardDir, 1]];
                for (const [dr, dc] of directions) {
                    const nextR = r + dr;
                    const nextC = c + dc;
                    if (isWithinBoard(nextR, nextC) && board[nextR][nextC] === PIECE_TYPES.EMPTY) {
                        moves.push({ from: { r, c }, to: { r: nextR, c: nextC } });
                    }
                }
            }
        }
    }
    return moves;
};

/**
 * Aplica um movimento ao tabuleiro e retorna o novo estado.
 * @param {Array<Array<string>>} board - O estado atual do tabuleiro.
 * @param {Object} move - O objeto do movimento. Ex: { from: {r,c}, to: {r,c}, capturedPieces: [{r,c}] }
 * @returns {Array<Array<string>>} O novo estado do tabuleiro.
 */
const applyMove = (board, move) => {
    const newBoard = board.map(row => [...row]);
    const { from, to, capturedPieces } = move;

    let piece = newBoard[from.r][from.c];
    
    // Move a peça
    newBoard[to.r][to.c] = piece;
    newBoard[from.r][from.c] = PIECE_TYPES.EMPTY;

    // Remove peças capturadas
    if (capturedPieces && capturedPieces.length > 0) {
        for (const cap of capturedPieces) {
            newBoard[cap.r][cap.c] = PIECE_TYPES.EMPTY;
        }
    }
    
    // Promove a Dama
    piece = newBoard[to.r][to.c];
    const isWhitePawn = piece === PIECE_TYPES.WHITE_PAWN;
    const isBlackPawn = piece === PIECE_TYPES.BLACK_PAWN;
    
    if ( (isWhitePawn && to.r === 0) || (isBlackPawn && to.r === 7) ) {
        newBoard[to.r][to.c] = isWhitePawn ? PIECE_TYPES.WHITE_KING : PIECE_TYPES.BLACK_KING;
    }

    return newBoard;
};

/**
 * Verifica as condições de fim de jogo (vitória/derrota/empate).
 * @param {Array<Array<string>>} board - O estado do tabuleiro.
 * @param {string} nextPlayerColor - A cor do jogador que fará o próximo movimento.
 * @returns {Object|null} Retorna um objeto com o resultado se o jogo terminou, senão null.
 */
const checkWinCondition = (board, nextPlayerColor) => {
    // 1. Verifica se o próximo jogador tem alguma peça
    let hasPieces = false;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (isPlayerPiece(board[r][c], nextPlayerColor)) {
                hasPieces = true;
                break;
            }
        }
        if (hasPieces) break;
    }
    if (!hasPieces) {
        return {
            isFinished: true,
            winner: nextPlayerColor === 'white' ? 'black' : 'white',
            reason: `O jogador ${nextPlayerColor} não tem mais peças.`
        };
    }

    // 2. Verifica se o próximo jogador tem algum movimento legal
    const possibleCaptures = findAllCaptureSequences(board, nextPlayerColor);
    if (possibleCaptures.length > 0) return null; // Tem movimentos de captura, jogo continua.

    const possibleMoves = findSimpleMoves(board, nextPlayerColor);
    if (possibleMoves.length > 0) return null; // Tem movimentos simples, jogo continua.
    
    // Se não há peças E não há movimentos, o jogador perde.
    return {
        isFinished: true,
        winner: nextPlayerColor === 'white' ? 'black' : 'white',
        reason: `O jogador ${nextPlayerColor} não tem movimentos legais.`
    };
};


module.exports = {
    createInitialBoard,
    findAllCaptureSequences,
    findSimpleMoves,
    applyMove,
    checkWinCondition,
    isPlayerPiece
};