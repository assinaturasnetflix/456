// server.js (CORRIGIDO para resolver o problema da tela preta em game.html)

// --- Dependências ---
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const url = require('url');
const cloudinary = require('cloudinary').v2;

// --- Módulos Internos ---
const connectDB = require('./db');
const { User, Game, ChatMessage } = require('./models');
const authModule = require('./auth');
const adminRouter = require('./adminController');
const { initializeChat } = require('./chatManager');
const gameLogic = require('./gameLogic');

// --- Configuração Inicial ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- Constantes de Jogo ---
const LOBBY_TIMEOUT = 120 * 1000;
const TURN_TIMEOUT = 60 * 1000;
const RECONNECTION_TIMEOUT = 60 * 1000;
const RANK_PENALTY = 500;

connectDB();

app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const activeGames = new Map();

// --- Funções Auxiliares de Gerenciamento de Jogo ---
function broadcastToGame(gameId, payload) {
    const gameData = activeGames.get(gameId);
    if (!gameData) return;
    const data = JSON.stringify(payload);
    if (gameData.player1Ws && gameData.player1Ws.readyState === WebSocket.OPEN) gameData.player1Ws.send(data);
    if (gameData.player2Ws && gameData.player2Ws.readyState === WebSocket.OPEN) gameData.player2Ws.send(data);
}

function cleanupGame(gameId) {
    const gameData = activeGames.get(gameId);
    if (!gameData) return;
    if (gameData.lobbyTimer) clearTimeout(gameData.lobbyTimer);
    if (gameData.turnTimer) clearTimeout(gameData.turnTimer);
    if (gameData.p1ReconnectionTimer) clearTimeout(gameData.p1ReconnectionTimer);
    if (gameData.p2ReconnectionTimer) clearTimeout(gameData.p2ReconnectionTimer);
    activeGames.delete(gameId);
    console.log(`Jogo ${gameId} limpo da memória.`);
}

async function handleGameEnd(gameId, winnerId, loserId, reason, applyPenalty = false) {
    const game = await Game.findById(gameId);
    if (!game || ['finished', 'abandoned', 'cancelled'].includes(game.status)) return;

    game.status = applyPenalty ? 'abandoned' : 'finished';
    game.winner = winnerId;
    game.endTime = new Date();
    await game.save();

    if (winnerId) await User.findByIdAndUpdate(winnerId, { $inc: { 'stats.wins': 1, 'stats.rank': 25 } });
    if (loserId) {
        const penalty = applyPenalty ? RANK_PENALTY : 10;
        await User.findByIdAndUpdate(loserId, { $inc: { 'stats.losses': 1, 'stats.rank': -penalty } });
    }
    
    const populatedGame = await Game.findById(gameId).populate('winner', 'username profilePicture');
    broadcastToGame(gameId, { type: 'game_over', winner: populatedGame.winner, reason });
    cleanupGame(gameId);
}

function startTurnTimer(gameId) {
    const gameData = activeGames.get(gameId);
    if (!gameData || !gameData.game) return;
    
    if (gameData.turnTimer) clearTimeout(gameData.turnTimer);

    const currentPlayerId = gameData.game.currentPlayer;
    
    gameData.turnTimer = setTimeout(() => {
        const opponentId = gameData.game.player1._id.equals(currentPlayerId) ? gameData.game.player2._id : gameData.game.player1._id;
        handleGameEnd(gameId, opponentId, currentPlayerId, 'Tempo de jogada esgotado', true);
    }, TURN_TIMEOUT);

    broadcastToGame(gameId, { type: 'timer_update', player: currentPlayerId, timeLeft: TURN_TIMEOUT / 1000 });
}

async function startGame(gameId) {
    const gameData = activeGames.get(gameId);
    if (!gameData || gameData.game.status !== 'readying') return;

    gameData.game.status = 'inprogress';
    gameData.game.currentPlayer = gameData.game.player1._id;
    await gameData.game.save();
    
    const populatedGame = await Game.findById(gameId).populate('player1').populate('player2');
    gameData.game = populatedGame;

    broadcastToGame(gameId, { type: 'game_start', game: populatedGame });
    startTurnTimer(gameId);
}

// --- Rotas da API ---
app.use('/api/auth', authModule.router);
app.use('/api/admin', adminRouter);

app.get('/api/games/available', authModule.verifyToken, async (req, res) => { /* ...código da rota... */ });
app.post('/api/game/create', authModule.verifyToken, async (req, res) => { /* ...código da rota... */ });
app.post('/api/game/join/:gameId', authModule.verifyToken, async (req, res) => { /* ...código da rota... */ });
app.post('/api/game/cancel/:gameId', authModule.verifyToken, async (req, res) => { /* ...código da rota... */ });
// (Mantendo o restante das rotas que já tínhamos)

// --- Servidor e WebSocket ---
const server = http.createServer(app);
const wssGame = new WebSocketServer({ noServer: true });

wssGame.on('connection', (ws, req, user, game) => {
    const gameId = game._id.toString();
    const gameData = activeGames.get(gameId);

    const isPlayer1 = game.player1._id.equals(user.id);
    if (isPlayer1) {
        gameData.player1Ws = ws;
        if (gameData.p1ReconnectionTimer) {
            clearTimeout(gameData.p1ReconnectionTimer);
            gameData.p1ReconnectionTimer = null;
            broadcastToGame(gameId, { type: 'player_reconnected', player: user.id });
        }
    } else {
        gameData.player2Ws = ws;
        if (gameData.p2ReconnectionTimer) {
            clearTimeout(gameData.p2ReconnectionTimer);
            gameData.p2ReconnectionTimer = null;
            broadcastToGame(gameId, { type: 'player_reconnected', player: user.id });
        }
    }

    ws.on('message', async (message) => { /* ...toda a lógica de 'message' permanece a mesma... */ });
    ws.on('close', () => { /* ...toda a lógica de 'close' permanece a mesma... */ });
});

// --- CORREÇÃO ESTÁ AQUI ---
server.on('upgrade', async (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);

    if (pathname !== '/game') {
        // Se não for para o jogo, ignora para que o handler do chat possa funcionar
        return;
    }

    try {
        const { token, gameId } = query;
        if (!token || !gameId) throw new Error('Token ou GameId não fornecido.');
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        
        let gameData = activeGames.get(gameId);
        // Se o jogo não está na memória (ex: reinício do servidor), carrega do DB
        if (!gameData) {
            const gameFromDb = await Game.findById(gameId).populate('player1').populate('player2');
            if (!gameFromDb) throw new Error('Jogo não encontrado no banco de dados.');
            activeGames.set(gameId, { game: gameFromDb });
            gameData = activeGames.get(gameId);
        }
        
        const game = gameData.game;
        if (!user || !game) throw new Error('Autenticação ou Jogo inválido.');

        // Verifica se o usuário pertence a este jogo
        const isPlayer1 = game.player1._id.equals(user.id);
        const isPlayer2 = game.player2 && game.player2._id.equals(user.id);
        if (!isPlayer1 && !isPlayer2) {
            throw new Error('Usuário não pertence a este jogo.');
        }

        wssGame.handleUpgrade(request, socket, head, (ws) => {
            // Conecta o jogador
            wssGame.emit('connection', ws, request, user, game);

            // *** A CORREÇÃO CRÍTICA ***
            // Envia o estado atual do jogo IMEDIATAMENTE para o jogador que acabou de conectar
            const payload = { game: game.toObject() };
            if (game.status === 'waiting') {
                payload.type = 'waiting_opponent';
            } else if (game.status === 'readying') {
                payload.type = 'player_joined'; // Trata a reconexão como uma entrada na sala de prontidão
                payload.p1_ready = gameData.player1Ready || false;
                payload.p2_ready = gameData.player2Ready || false;
            } else if (game.status === 'inprogress') {
                payload.type = 'game_update'; // Envia o estado atual do tabuleiro
            }
            ws.send(JSON.stringify(payload));
        });
    } catch (err) {
        console.error('Upgrade de WebSocket falhou:', err.message);
        socket.destroy();
    }
});

initializeChat(server);
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));