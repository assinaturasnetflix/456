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
const cloudinary = require('cloudinary').v2; // Importante para o upload de fotos de perfil

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
app.use(express.json({ limit: '10mb' })); // Limite aumentado para imagens de perfil em base64
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// --- Rotas da API ---
app.use('/api/auth', authRouter);
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
            const uploadResponse = await cloudinary.uploader.upload(image, {
                folder: 'brainskill_avatars',
                resource_type: 'image',
            });
            user.profilePicture = uploadResponse.secure_url;
        }

        await user.save();
        res.status(200).json({
            message: 'Perfil atualizado com sucesso!',
            updatedUser: { bio: user.bio, profilePicture: user.profilePicture }
        });

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

// Rota para buscar jogos disponíveis (requer autenticação)
app.get('/api/games/available', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Acesso não autorizado' });
        jwt.verify(token, process.env.JWT_SECRET);
        const availableGames = await Game.find({ status: 'waiting' }).populate('player1', 'username _id').sort({ startTime: -1 });
        res.status(200).json(availableGames);
    } catch (error) {
        if (error.name === 'JsonWebTokenError') return res.status(401).json({ message: 'Token inválido' });
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
        if (error.name === 'JsonWebTokenError') return res.status(401).json({ message: 'Token inválido' });
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
        if (error.name === 'JsonWebTokenError') return res.status(401).json({ message: 'Token inválido' });
        res.status(500).json({ message: 'Erro ao buscar histórico do chat', error: error.message });
    }
});

// --- Criação do Servidor HTTP ---
const server = http.createServer(app);

// --- Gerenciamento de Estado do Jogo (Em Memória) ---
const activeGames = new Map();

// --- Servidor WebSocket para o Jogo ---
const wssGame = new WebSocketServer({ noServer: true });

wssGame.on('connection', ws => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const { gameId } = ws;
            const gameData = activeGames.get(gameId);

            if (!gameData || !gameData.game) {
                ws.send(JSON.stringify({ type: 'error', message: 'Jogo não encontrado ou expirado.' }));
                return;
            }
            
            if (ws.userId.toString() !== gameData.game.player1._id.toString() && ws.userId.toString() !== gameData.game.player2._id.toString()) {
                return;
            }

            switch (data.type) {
                case 'make_move':
                    if (gameData.game.currentPlayer.toString() !== ws.userId.toString()) {
                        return ws.send(JSON.stringify({ type: 'error', message: 'Não é a sua vez de jogar.' }));
                    }

                    const playerColor = gameData.game.player1._id.equals(ws.userId) ? 'white' : 'black';
                    const possibleCaptures = gameLogic.findAllCaptureSequences(gameData.game.boardState, playerColor);

                    let isValidMove = false;
                    let moveDetails = {};

                    if (possibleCaptures.length > 0) {
                        const sentMovePath = data.move.path.map(p => `${p.r},${p.c}`).join('->');
                        for (const validCapture of possibleCaptures) {
                           const validMovePath = validCapture.path.map(p => `${p.r},${p.c}`).join('->');
                           if(sentMovePath === validMovePath){
                               isValidMove = true;
                               moveDetails = {
                                   from: validCapture.path[0],
                                   to: validCapture.path[validCapture.path.length - 1],
                                   capturedPieces: validCapture.capturedPieces
                               };
                               break;
                           }
                        }
                    } else {
                        const simpleMoves = gameLogic.findSimpleMoves(gameData.game.boardState, playerColor);
                        for(const simpleMove of simpleMoves){
                            if(simpleMove.from.r === data.move.from.r && simpleMove.from.c === data.move.from.c &&
                               simpleMove.to.r === data.move.to.r && simpleMove.to.c === data.move.to.c){
                                isValidMove = true;
                                moveDetails = { from: simpleMove.from, to: simpleMove.to, capturedPieces: []};
                                break;
                            }
                        }
                    }

                    if (!isValidMove) {
                        return ws.send(JSON.stringify({ type: 'error', message: 'Movimento inválido.' }));
                    }
                    
                    const newBoardState = gameLogic.applyMove(gameData.game.boardState, moveDetails);
                    gameData.game.boardState = newBoardState;
                    gameData.game.gameHistory.push({ move: `${data.move.from.r},${data.move.from.c} to ${data.move.to.r},${data.move.to.c}`, player: ws.user.username });
                    
                    gameData.game.currentPlayer = gameData.game.player1._id.equals(ws.userId) ? gameData.game.player2._id : gameData.game.player1._id;
                    
                    const nextPlayerColor = playerColor === 'white' ? 'black' : 'white';
                    const winCondition = gameLogic.checkWinCondition(newBoardState, nextPlayerColor);

                    if(winCondition && winCondition.isFinished){
                        gameData.game.status = 'finished';
                        gameData.game.winner = winCondition.winner === 'white' ? gameData.game.player1._id : gameData.game.player2._id;
                        gameData.game.endTime = new Date();
                    }
                    
                    await gameData.game.save();
                    
                    const gameForBroadcast = await Game.findById(gameId).populate('player1').populate('player2');

                    const payload = {
                        type: 'game_update',
                        boardState: gameForBroadcast.boardState,
                        currentPlayer: gameForBroadcast.currentPlayer,
                        winCondition: winCondition,
                        game: gameForBroadcast // Enviando o objeto de jogo completo para garantir que a UI tenha todos os dados
                    };
                    
                    if(gameData.player1Ws) gameData.player1Ws.send(JSON.stringify(payload));
                    if(gameData.player2Ws) gameData.player2Ws.send(JSON.stringify(payload));

                    if(winCondition && winCondition.isFinished){
                         activeGames.delete(gameId);
                    }
                    break;
            }
        } catch (error) {
            console.error('Erro no WebSocket do jogo:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Erro interno no servidor do jogo.' }));
        }
    });

    ws.on('close', () => {
        if(ws.user) console.log(`Jogador ${ws.user.username} desconectado do jogo ${ws.gameId}`);
    });
});

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
            game = new Game({ player1: userId, currentPlayer: userId, boardState: gameLogic.createInitialBoard(), status: 'waiting' });
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
                } else if (game.status === 'waiting' && game.player1._id.equals(user._id)) {
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