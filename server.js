// server.js (Versão Completa e Unificada)

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
const LOBBY_TIMEOUT = 120 * 1000; // 2 minutos
const TURN_TIMEOUT = 60 * 1000; // 60 segundos
const RECONNECTION_TIMEOUT = 60 * 1000; // 60 segundos
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

// Rota pública para buscar dados de um perfil de usuário.
app.get('/api/profile/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username }).select('-password -resetPasswordToken -resetPasswordExpires');
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        res.json(user);
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.', error: error.message });
    }
});

// Rota para atualizar o perfil do usuário (requer autenticação)
app.put('/api/profile/update', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Acesso não autorizado' });
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        const { bio, image } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        if (bio !== undefined) user.bio = bio;
        if (image) {
            const uploadResponse = await cloudinary.uploader.upload(image, { folder: 'brainskill_avatars', resource_type: 'image' });
            user.profilePicture = uploadResponse.secure_url;
        }
        await user.save();
        res.status(200).json({ message: 'Perfil atualizado com sucesso!', updatedUser: { bio: user.bio, profilePicture: user.profilePicture } });
    } catch (error) {
        if (error.name === 'JsonWebTokenError') return res.status(401).json({ message: 'Token inválido' });
        console.error("Erro ao atualizar perfil:", error);
        res.status(500).json({ message: 'Erro no servidor ao atualizar o perfil.', error: error.message });
    }
});

// Rota PÚBLICA v2 para obter dados para o dashboard
app.get('/api/dashboard_v2', async (req, res) => {
    try {
        const topPlayers = await User.find().sort({ 'stats.rank': -1 }).limit(10).select('username stats.rank profilePicture');
        const liveGames = await Game.find({ status: 'inprogress' }).sort({ startTime: -1 }).limit(10).populate('player1', 'username profilePicture').populate('player2', 'username profilePicture');
        const latestMessages = await ChatMessage.find().sort({ createdAt: -1 }).limit(10).populate('sender', 'username profilePicture');
        res.status(200).json({ topPlayers, liveGames, latestMessages });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao buscar dados para o dashboard.', error: error.message });
    }
});

// Rota para buscar jogos disponíveis (usada pelo lobby)
app.get('/api/games/available', authModule.verifyToken, async (req, res) => {
    try {
        const games = await Game.find({ status: 'waiting' }).populate('player1', 'username profilePicture _id').sort({ startTime: -1 });
        res.json(games);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar jogos' });
    }
});

// Rota para CRIAR uma nova partida
app.post('/api/game/create', authModule.verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const existingGame = await Game.findOne({ player1: userId, status: 'waiting' });
        if (existingGame) {
            return res.status(400).json({ message: 'Você já tem uma partida aberta.' });
        }
        const game = new Game({ player1: userId, boardState: gameLogic.createInitialBoard(), status: 'waiting' });
        await game.save();
        const lobbyTimer = setTimeout(async () => {
            const freshGame = await Game.findById(game._id);
            if (freshGame && freshGame.status === 'waiting') {
                freshGame.status = 'cancelled';
                await freshGame.save();
                cleanupGame(game._id.toString());
            }
        }, LOBBY_TIMEOUT);
        activeGames.set(game._id.toString(), { game, lobbyTimer, turnTimer: null, p1ReconnectionTimer: null, p2ReconnectionTimer: null, player1Ready: false, player2Ready: false });
        res.status(201).json({ gameId: game._id });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao criar jogo', error: error.message });
    }
});

// Rota para um oponente ENTRAR em uma partida
app.post('/api/game/join/:gameId', authModule.verifyToken, async (req, res) => {
    try {
        const gameId = req.params.gameId;
        const userId = req.user.id;
        const gameData = activeGames.get(gameId);
        if (!gameData || gameData.game.status !== 'waiting') {
            return res.status(404).json({ message: 'Jogo não encontrado ou já iniciado.' });
        }
        clearTimeout(gameData.lobbyTimer);
        gameData.lobbyTimer = null;
        gameData.game.player2 = userId;
        gameData.game.status = 'readying';
        await gameData.game.save();
        const populatedGame = await Game.findById(gameId).populate('player1').populate('player2');
        gameData.game = populatedGame;
        broadcastToGame(gameId, { type: 'player_joined', game: populatedGame, p1_ready: false, p2_ready: false });
        res.status(200).json({ gameId });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao entrar no jogo', error: error.message });
    }
});

// Rota para o criador CANCELAR a partida
app.post('/api/game/cancel/:gameId', authModule.verifyToken, async (req, res) => {
    try {
        const gameId = req.params.gameId;
        const userId = req.user.id;
        const game = await Game.findById(gameId);
        if (!game) return res.status(404).json({ message: 'Jogo não encontrado.' });
        if (!game.player1.equals(userId) || game.status !== 'waiting') {
            return res.status(403).json({ message: 'Ação não permitida.' });
        }
        game.status = 'cancelled';
        await game.save();
        cleanupGame(gameId);
        res.status(200).json({ message: 'Jogo cancelado.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao cancelar o jogo.', error: error.message });
    }
});

// Rota para buscar o histórico do chat
app.get('/api/chat/history', authModule.verifyToken, async (req, res) => {
    try {
        const messages = await ChatMessage.find().sort({ createdAt: -1 }).limit(50).populate('sender', 'username profilePicture _id');
        res.status(200).json(messages.reverse());
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar histórico do chat', error: error.message });
    }
});

// Rota para buscar todos os usuários
app.get('/api/users/all', authModule.verifyToken, async (req, res) => {
    try {
        const allUsers = await User.find().select('username profilePicture');
        res.status(200).json(allUsers);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar usuários', error: error.message });
    }
});


// --- Servidor, WebSocket e Inicialização ---
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
    ws.on('message', async (message) => { /* ... lógica de 'message' ... */ });
    ws.on('close', () => { /* ... lógica de 'close' ... */ });
});

server.on('upgrade', async (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);
    if (pathname !== '/game') return;

    try {
        const { token, gameId } = query;
        if (!token || !gameId) throw new Error('Token ou GameId não fornecido.');
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        
        let gameData = activeGames.get(gameId);
        if (!gameData) {
            const gameFromDb = await Game.findById(gameId).populate('player1').populate('player2');
            if (!gameFromDb) throw new Error('Jogo não encontrado no DB.');
            activeGames.set(gameId, { game: gameFromDb, player1Ready: false, player2Ready: false });
            gameData = activeGames.get(gameId);
        }
        
        const game = gameData.game;
        if (!user || !game) throw new Error('Usuário ou Jogo inválido.');

        const isPlayer1 = game.player1._id.equals(user.id);
        const isPlayer2 = game.player2 && game.player2._id.equals(user.id);
        if (!isPlayer1 && !isPlayer2) throw new Error('Usuário não pertence a este jogo.');

        wssGame.handleUpgrade(request, socket, head, (ws) => {
            wssGame.emit('connection', ws, request, user, game);
            const payload = { game: game.toObject() };
            if (game.status === 'waiting') payload.type = 'waiting_opponent';
            else if (game.status === 'readying') {
                payload.type = 'player_joined';
                payload.p1_ready = gameData.player1Ready;
                payload.p2_ready = gameData.player2Ready;
            }
            else if (game.status === 'inprogress') payload.type = 'game_update';
            ws.send(JSON.stringify(payload));
        });
    } catch (err) {
        console.error('Upgrade de WebSocket falhou:', err.message);
        socket.destroy();
    }
});

initializeChat(server);
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));