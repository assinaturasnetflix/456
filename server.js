// server.js
// Arquivo principal que inicializa o servidor, o Express, os WebSockets e gerencia as rotas principais e a lógica do jogo.

// --- Dependências ---
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const url = require('url');

// --- Módulos Internos ---
const connectDB = require('./db');
const { User, Game, ChatMessage } = require('./models');
const { router: authRouter } = require('./auth');
const adminRouter = require('./adminController');
const { initializeChat } = require('./chatManager');
const gameLogic = require('./gameLogic');

// --- Configuração Inicial ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- Conexão com o Banco de Dados ---
connectDB();

// --- Middlewares ---
app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// --- Rotas da API ---
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);

// Rota pública para buscar dados de um perfil de usuário.
app.get('/api/profile/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username }).select('-password -resetPasswordToken -resetPasswordExpires');
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        res.json(user);
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor.', error: error.message });
    }
});

// Rota PÚBLICA v2 para obter dados para o dashboard (com fotos de perfil)
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

// Rota para buscar jogos disponíveis (requer autenticação)
app.get('/api/games/available', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Acesso não autorizado' });
        jwt.verify(token, process.env.JWT_SECRET);

        const availableGames = await Game.find({ status: 'waiting' }).populate('player1', 'username _id').sort({ startTime: -1 });
        res.status(200).json(availableGames);
    } catch (error) {
        if (error.name === 'JsonWebTokenError') { return res.status(401).json({ message: 'Token inválido' }); }
        res.status(500).json({ message: 'Erro ao buscar jogos disponíveis', error: error.message });
    }
});

// Rota para buscar todos os usuários (requer autenticação)
app.get('/api/users/all', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Acesso não autorizado' });
        jwt.verify(token, process.env.JWT_SECRET);
        const allUsers = await User.find().select('username profilePicture');
        res.status(200).json(allUsers);
    } catch (error) {
        if (error.name === 'JsonWebTokenError') { return res.status(401).json({ message: 'Token inválido' }); }
        res.status(500).json({ message: 'Erro ao buscar usuários', error: error.message });
    }
});

// Rota para buscar o histórico do chat (requer autenticação)
app.get('/api/chat/history', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Acesso não autorizado' });
        jwt.verify(token, process.env.JWT_SECRET);

        const messages = await ChatMessage.find().sort({ createdAt: -1 }).limit(50).populate('sender', 'username profilePicture _id');
        res.status(200).json(messages.reverse());
    } catch (error) {
        if (error.name === 'JsonWebTokenError') { return res.status(401).json({ message: 'Token inválido' }); }
        res.status(500).json({ message: 'Erro ao buscar histórico do chat', error: error.message });
    }
});

// --- Criação do Servidor HTTP ---
const server = http.createServer(app);

// --- Gerenciamento de Estado do Jogo (Em Memória) ---
const activeGames = new Map();

// --- Servidor WebSocket para o Jogo ---
const wssGame = new WebSocketServer({ noServer: true });
// ... (Toda a lógica do wssGame permanece a mesma) ...

// --- Rota para criar/entrar em jogos ---
app.post('/api/game/find', async (req, res) => {
    try {
        const token = req.headers['authorization'].split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        let game = await Game.findOne({ status: 'waiting', player1: { $ne: userId } });

        if (game) {
            game.player2 = userId;
            game.status = 'inprogress';
            await game.save();
        } else {
            game = new Game({
                player1: userId,
                currentPlayer: userId,
                boardState: gameLogic.createInitialBoard(),
                status: 'waiting'
            });
            await game.save();
        }
        
        if (!activeGames.has(game._id.toString())) {
             activeGames.set(game._id.toString(), { game: null, player1Ws: null, player2Ws: null });
        }
        const gameWithPopulate = await Game.findById(game._id).populate('player1').populate('player2');
        activeGames.get(game._id.toString()).game = gameWithPopulate;

        res.status(200).json({ gameId: game._id });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao procurar partida.', error: error.message });
    }
});

// --- Inicialização dos WebSockets (Chat e Jogo) ---
initializeChat(server);

server.on('upgrade', async (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);

    try {
        const token = query.token;
        if (!token) throw new Error('Token não fornecido');
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('username profilePicture');
        if (!user) throw new Error('Usuário do token não encontrado');

        if (pathname === '/game') {
            const gameId = query.gameId;
            if(!gameId) throw new Error('GameId não fornecido');

            let gameData = activeGames.get(gameId);
            if(!gameData || !gameData.game) {
                const gameFromDb = await Game.findById(gameId).populate('player1').populate('player2');
                if (!gameFromDb) throw new Error('Jogo inválido ou não encontrado.');
                
                activeGames.set(gameId, { game: gameFromDb, player1Ws: null, player2Ws: null });
                gameData = activeGames.get(gameId);
            }
            
            const game = gameData.game;

            wssGame.handleUpgrade(request, socket, head, (ws) => {
                ws.userId = user._id;
                ws.user = user;
                ws.gameId = gameId;

                if (game.player1._id.equals(user._id)) gameData.player1Ws = ws;
                if (game.player2 && game.player2._id.equals(user._id)) gameData.player2Ws = ws;
                
                if(game.status === 'inprogress' && gameData.player1Ws && gameData.player2Ws) {
                    const payload = JSON.stringify({ type: 'game_start', game: game.toObject() });
                    gameData.player1Ws.send(payload);
                    gameData.player2Ws.send(payload);
                }
                 else if (game.status === 'waiting' && game.player1._id.equals(user._id)) {
                    ws.send(JSON.stringify({ type: 'waiting_opponent', game: game.toObject() }));
                }

                wssGame.emit('connection', ws, request);
            });
        }
    } catch (error) {
        console.error(`Falha no upgrade do WebSocket: ${error.message}`);
        socket.destroy();
    }
});

// --- Iniciar o Servidor ---
server.listen(PORT, () => {
    console.log(`Servidor BRAINSKILL rodando na porta ${PORT}`);
    console.log('Backend de API e WebSockets estão ativos.');
});