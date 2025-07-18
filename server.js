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
const { User, Game, ChatMessage } = require('./models'); // ChatMessage adicionado para a rota do dashboard
const { router: authRouter } = require('./auth');
const adminRouter = require('./adminController');
const { initializeChat } = require('./chatManager');
const gameLogic = require('./gameLogic');

// --- Configuração Inicial ---
const app = express();
const PORT = process.env.PORT || 3000; // Render usa a variável de ambiente PORT

// --- Conexão com o Banco de Dados ---
connectDB();

// --- Middlewares ---
app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '5mb' })); // Limite maior para imagens em base64
app.use(express.urlencoded({ extended: true }));
// Serve os arquivos HTML do frontend a partir do diretório raiz.
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

// Rota PÚBLICA para obter dados para o dashboard inicial
app.get('/api/dashboard', async (req, res) => {
    try {
        // Busca os 5 melhores jogadores pelo ranking (em ordem decrescente)
        const topPlayers = await User.find()
            .sort({ 'stats.rank': -1 })
            .limit(5)
            .select('username stats.rank');

        // Busca os 5 jogos em andamento mais recentes
        const liveGames = await Game.find({ status: 'inprogress' })
            .sort({ startTime: -1 })
            .limit(5)
            .populate('player1', 'username') // Pega o username do player1
            .populate('player2', 'username'); // Pega o username do player2

        // Busca as 5 últimas mensagens do chat
        const latestMessages = await ChatMessage.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('sender', 'username'); // Pega o username de quem enviou

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
// Usamos o módulo http para ter mais controle e poder vincular o WebSocket Server.
const server = http.createServer(app);


// --- Gerenciamento de Estado do Jogo (Em Memória) ---
// Para performance, mantemos os jogos ativos em memória.
// A chave é o ID do jogo (string), o valor é o objeto do jogo com as conexões WebSocket.
const activeGames = new Map();

// --- Servidor WebSocket para o Jogo ---
const wssGame = new WebSocketServer({ noServer: true });

wssGame.on('connection', ws => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const { gameId } = ws; // gameId é anexado durante o handshake
            const gameData = activeGames.get(gameId);

            if (!gameData || !gameData.game) {
                ws.send(JSON.stringify({ type: 'error', message: 'Jogo não encontrado ou expirado.' }));
                return;
            }
            
            // Valida se quem enviou a mensagem é um dos jogadores da partida
            if (ws.userId.toString() !== gameData.game.player1.toString() && ws.userId.toString() !== gameData.game.player2.toString()) {
                return;
            }

            switch (data.type) {
                case 'make_move':
                    // Validação de turno
                    if (gameData.game.currentPlayer.toString() !== ws.userId.toString()) {
                        return ws.send(JSON.stringify({ type: 'error', message: 'Não é a sua vez de jogar.' }));
                    }

                    const playerColor = gameData.game.player1.equals(ws.userId) ? 'white' : 'black';
                    const possibleCaptures = gameLogic.findAllCaptureSequences(gameData.game.boardState, playerColor);

                    let isValidMove = false;
                    let moveDetails = {};

                    if (possibleCaptures.length > 0) {
                        // Se há capturas obrigatórias, a jogada DEVE ser uma delas.
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
                        // Se não há capturas, valida como movimento simples.
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
                    
                    // Aplica o movimento
                    const newBoardState = gameLogic.applyMove(gameData.game.boardState, moveDetails);
                    gameData.game.boardState = newBoardState;
                    gameData.game.gameHistory.push({ move: `${data.move.from.r},${data.move.from.c} to ${data.move.to.r},${data.move.to.c}`, player: ws.user.username });
                    
                    // Troca o turno
                    gameData.game.currentPlayer = gameData.game.player1.equals(ws.userId) ? gameData.game.player2 : gameData.game.player1;
                    
                    // Verifica condição de vitória/fim de jogo
                    const nextPlayerColor = playerColor === 'white' ? 'black' : 'white';
                    const winCondition = gameLogic.checkWinCondition(newBoardState, nextPlayerColor);

                    if(winCondition && winCondition.isFinished){
                        gameData.game.status = 'finished';
                        gameData.game.winner = winCondition.winner === 'white' ? gameData.game.player1 : gameData.game.player2;
                        gameData.game.endTime = new Date();
                        // TODO: Atualizar stats dos jogadores
                    }
                    
                    await gameData.game.save();

                    // Transmite o novo estado para ambos os jogadores
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
                
                case 'surrender':
                    // Lógica de desistência
                    break;
            }
        } catch (error) {
            console.error('Erro no WebSocket do jogo:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Erro interno no servidor do jogo.' }));
        }
    });

    ws.on('close', () => {
        // Lógica para lidar com desconexão (ex: notificar oponente, iniciar timer)
        console.log(`Jogador ${ws.user.username} desconectado do jogo ${ws.gameId}`);
    });
});


// --- Rota para criar/entrar em jogos ---
// Esta rota HTTP cria a sala de jogo, depois o frontend conecta via WebSocket.
app.post('/api/game/find', async (req, res) => {
    try {
        const token = req.headers['authorization'].split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        // Tenta encontrar um jogo aguardando oponente
        let game = await Game.findOne({ status: 'waiting', player1: { $ne: userId } });

        if (game) {
            // Entra em um jogo existente
            game.player2 = userId;
            game.status = 'inprogress';
            await game.save();
        } else {
            // Cria um novo jogo
            game = new Game({
                player1: userId,
                currentPlayer: userId, // O criador (peças brancas) começa
                boardState: gameLogic.createInitialBoard(),
                status: 'waiting'
            });
            await game.save();
        }
        
        // Adiciona o jogo ao mapa de jogos ativos em memória
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
initializeChat(server); // O chat manager se anexa ao servidor HTTP

server.on('upgrade', async (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);

    try {
        const token = query.token;
        if (!token) throw new Error('Token não fornecido');
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('username');
        if (!user) throw new Error('Usuário do token não encontrado');

        // Distingue entre conexão de chat e de jogo
        if (pathname === '/game') {
            const gameId = query.gameId;
            if(!gameId) throw new Error('GameId não fornecido');

            const gameData = activeGames.get(gameId);
            if(!gameData || !gameData.game) throw new Error('Jogo inválido ou não encontrado.');
            
            const game = gameData.game;

            // Delega o handshake para o WebSocket Server do jogo
            wssGame.handleUpgrade(request, socket, head, (ws) => {
                ws.userId = user._id;
                ws.user = user;
                ws.gameId = gameId;

                // Armazena a conexão WebSocket do jogador correto
                if (game.player1.equals(user._id)) gameData.player1Ws = ws;
                if (game.player2 && game.player2.equals(user._id)) gameData.player2Ws = ws;
                
                // Se ambos os jogadores estão conectados, envia o estado inicial
                if(game.status === 'inprogress' && gameData.player1Ws && gameData.player2Ws) {
                    const payload = JSON.stringify({ type: 'game_start', game: game.toObject() });
                    gameData.player1Ws.send(payload);
                    gameData.player2Ws.send(payload);
                }

                wssGame.emit('connection', ws, request);
            });
        } else {
            // Se não for para o jogo, o socket é ignorado aqui (o chatManager tem seu próprio 'upgrade' handler)
        }
    } catch (error) {
        console.error(`Falha no upgrade do WebSocket: ${error.message}`);
        socket.destroy();
    }
});

// --- Iniciar o Servidor ---
server.listen(PORT, () => {
    console.log(`Servidor BRAINSKILL rodando na porta ${PORT}`);
    console.log(`Frontend acessível em http://localhost:${PORT}`);
    console.log('Backend de API e WebSockets estão ativos.');
});