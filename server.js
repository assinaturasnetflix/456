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
app.use(express.static(__dirname)); // Serve os arquivos HTML a partir do diretório raiz

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
        // Busca os 10 melhores jogadores
        const topPlayers = await User.find()
            .sort({ 'stats.rank': -1 })
            .limit(10)
            .select('username stats.rank profilePicture');

        // Busca os 10 jogos em andamento
        const liveGames = await Game.find({ status: 'inprogress' })
            .sort({ startTime: -1 })
            .limit(10)
            .populate('player1', 'username profilePicture')
            .populate('player2', 'username profilePicture');

        // Busca as 10 últimas mensagens
        const latestMessages = await ChatMessage.find()
            .sort({ createdAt: -1 })
            .limit(10)
            .populate('sender', 'username profilePicture');

        res.status(200).json({
            topPlayers,
            liveGames,
            latestMessages
        });

    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao buscar dados para o dashboard.', error: error.message });
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
            
            if (ws.userId.toString() !== gameData.game.player1.toString() && ws.userId.toString() !== gameData.game.player2.toString()) {
                return;
            }

            switch (data.type) {
                case 'make_move':
                    if (gameData.game.currentPlayer.toString() !== ws.userId.toString()) {
                        return ws.send(JSON.stringify({ type: 'error', message: 'Não é a sua vez de jogar.' }));
                    }

                    const playerColor = gameData.game.player1.equals(ws.userId) ? 'white' : 'black';
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
                    
                    gameData.game.currentPlayer = gameData.game.player1.equals(ws.userId) ? gameData.game.player2 : gameData.game.player1;
                    
                    const nextPlayerColor = playerColor === 'white' ? 'black' : 'white';
                    const winCondition = gameLogic.checkWinCondition(newBoardState, nextPlayerColor);

                    if(winCondition && winCondition.isFinished){
                        gameData.game.status = 'finished';
                        gameData.game.winner = winCondition.winner === 'white' ? gameData.game.player1 : gameData.game.player2;
                        gameData.game.endTime = new Date();
                    }
                    
                    await gameData.game.save();

                    const payload = {
                        type: 'game_update',
                        boardState: gameData.game.boardState,
                        currentPlayer: gameData.game.currentPlayer,
                        winCondition: winCondition
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
        console.log(`Jogador ${ws.user.username} desconectado do jogo ${ws.gameId}`);
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
        activeGames.get(game._id.toString()).game = game;

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
        const user = await User.findById(decoded.id).select('username');
        if (!user) throw new Error('Usuário do token não encontrado');

        if (pathname === '/game') {
            const gameId = query.gameId;
            if(!gameId) throw new Error('GameId não fornecido');

            const gameData = activeGames.get(gameId);
            if(!gameData || !gameData.game) throw new Error('Jogo inválido ou não encontrado.');
            
            const game = gameData.game;

            wssGame.handleUpgrade(request, socket, head, (ws) => {
                ws.userId = user._id;
                ws.user = user;
                ws.gameId = gameId;

                if (game.player1.equals(user._id)) gameData.player1Ws = ws;
                if (game.player2 && game.player2.equals(user._id)) gameData.player2Ws = ws;
                
                if(game.status === 'inprogress' && gameData.player1Ws && gameData.player2Ws) {
                    const payload = JSON.stringify({ type: 'game_start', game: game.toObject() });
                    gameData.player1Ws.send(payload);
                    gameData.player2Ws.send(payload);
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