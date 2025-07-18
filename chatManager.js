// chatManager.js
// Gerencia as conexões WebSocket para o chat, o envio de mensagens e o upload de imagens.

const { WebSocketServer } = require('ws');
const { User, ChatMessage } = require('./models');
const jwt = require('jsonwebtoken');
const url = require('url');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

// Configuração do Cloudinary com as credenciais do arquivo .env
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Inicializa o servidor WebSocket para o chat e gerencia as conexões e mensagens.
 * @param {http.Server} server - A instância do servidor HTTP para anexar o WebSocket Server.
 */
const initializeChat = (server) => {
    // Cria uma instância do WebSocketServer vinculada ao servidor HTTP principal.
    const wss = new WebSocketServer({ noServer: true });

    // Função para transmitir uma mensagem para todos os clientes conectados.
    const broadcastMessage = (message) => {
        const data = JSON.stringify(message);
        wss.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                client.send(data);
            }
        });
    };

    // Evento 'upgrade' do servidor HTTP é usado para autenticar o usuário antes de estabelecer a conexão WebSocket.
    server.on('upgrade', async (request, socket, head) => {
        try {
            // Extrai o token JWT dos parâmetros da URL de conexão.
            const { query } = url.parse(request.url, true);
            const token = query.token;

            if (!token) {
                // Se não houver token, destrói o socket e encerra a tentativa de conexão.
                socket.destroy();
                return;
            }

            // Verifica o token JWT.
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.id).select('username profilePicture');

            if (!user) {
                // Se o usuário não for encontrado no banco de dados, encerra a conexão.
                socket.destroy();
                return;
            }

            // Se a autenticação for bem-sucedida, completa o handshake do WebSocket.
            wss.handleUpgrade(request, socket, head, (ws) => {
                // Anexa as informações do usuário ao objeto do WebSocket para uso posterior.
                ws.user = user;
                // Emite o evento 'connection' para o novo WebSocket.
                wss.emit('connection', ws, request);
            });
        } catch (error) {
            console.error('Falha na autenticação do WebSocket:', error.message);
            socket.destroy();
        }
    });

    // Evento 'connection' é acionado após um handshake bem-sucedido.
    wss.on('connection', (ws) => {
        console.log(`Cliente conectado ao chat: ${ws.user.username}`);

        // Evento 'message' é acionado quando o servidor recebe dados do cliente.
        ws.on('message', async (data) => {
            try {
                const parsedData = JSON.parse(data);

                // --- Gerencia mensagens de texto ---
                if (parsedData.type === 'text' && parsedData.message) {
                    const messageContent = parsedData.message.trim();
                    if (messageContent) {
                        const chatMessage = new ChatMessage({
                            sender: ws.user._id,
                            message: messageContent,
                        });
                        await chatMessage.save();

                        // Prepara a mensagem para ser enviada aos clientes.
                        const broadcastData = {
                            type: 'new_message',
                            _id: chatMessage._id,
                            sender: {
                                username: ws.user.username,
                                profilePicture: ws.user.profilePicture,
                            },
                            message: chatMessage.message,
                            createdAt: chatMessage.createdAt,
                        };
                        broadcastMessage(broadcastData);
                    }
                }

                // --- Gerencia upload de imagens ---
                if (parsedData.type === 'image' && parsedData.image) {
                    // Faz o upload da imagem (em formato base64) para o Cloudinary.
                    const uploadResponse = await cloudinary.uploader.upload(parsedData.image, {
                        folder: 'brainskill_chat', // Organiza as imagens em uma pasta no Cloudinary.
                        resource_type: 'image',
                    });

                    const chatMessage = new ChatMessage({
                        sender: ws.user._id,
                        imageUrl: uploadResponse.secure_url, // Salva a URL segura da imagem.
                    });
                    await chatMessage.save();

                    // Prepara a mensagem com a imagem para ser enviada aos clientes.
                    const broadcastData = {
                        type: 'new_message',
                        _id: chatMessage._id,
                        sender: {
                            username: ws.user.username,
                            profilePicture: ws.user.profilePicture,
                        },
                        imageUrl: chatMessage.imageUrl,
                        createdAt: chatMessage.createdAt,
                    };
                    broadcastMessage(broadcastData);
                }
            } catch (error) {
                console.error('Erro ao processar a mensagem do WebSocket:', error);
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem inválido ou erro no servidor.' }));
            }
        });

        // Evento 'close' é acionado quando uma conexão é fechada.
        ws.on('close', () => {
            console.log(`Cliente desconectado do chat: ${ws.user.username}`);
        });

        // Evento 'error' para capturar erros na conexão.
        ws.on('error', (error) => {
            console.error(`Erro no WebSocket do cliente ${ws.user.username}:`, error);
        });
    });

    console.log('Gerenciador de Chat (WebSocket) inicializado e pronto.');
    return wss;
};

module.exports = { initializeChat };