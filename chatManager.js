// chatManager.js (Refatorado para não controlar o 'upgrade')

const { WebSocketServer } = require('ws');
const { User, ChatMessage } = require('./models');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// A função agora apenas cria e configura o servidor WebSocket, sem se anexar ao 'upgrade'
const initializeChat = () => {
    const wssChat = new WebSocketServer({ noServer: true });

    const broadcastMessage = (message) => {
        const data = JSON.stringify(message);
        wssChat.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                client.send(data);
            }
        });
    };

    wssChat.on('connection', (ws, request) => {
        console.log(`Cliente conectado ao chat: ${ws.user.username}`);

        ws.on('message', async (data) => {
            try {
                const parsedData = JSON.parse(data);
                if (parsedData.type === 'text' && parsedData.message) {
                    const chatMessage = new ChatMessage({ sender: ws.user._id, message: parsedData.message.trim() });
                    await chatMessage.save();
                    broadcastMessage({ type: 'new_message', _id: chatMessage._id, sender: { username: ws.user.username, profilePicture: ws.user.profilePicture }, message: chatMessage.message, createdAt: chatMessage.createdAt });
                }
                if (parsedData.type === 'image' && parsedData.image) {
                    const uploadResponse = await cloudinary.uploader.upload(parsedData.image, { folder: 'brainskill_chat' });
                    const chatMessage = new ChatMessage({ sender: ws.user._id, imageUrl: uploadResponse.secure_url });
                    await chatMessage.save();
                    broadcastMessage({ type: 'new_message', _id: chatMessage._id, sender: { username: ws.user.username, profilePicture: ws.user.profilePicture }, imageUrl: chatMessage.imageUrl, createdAt: chatMessage.createdAt });
                }
            } catch (error) {
                console.error('Erro ao processar mensagem do chat:', error);
                ws.send(JSON.stringify({ type: 'error', message: 'Erro no servidor de chat.' }));
            }
        });

        ws.on('close', () => console.log(`Cliente desconectado do chat: ${ws.user.username}`));
        ws.on('error', (error) => console.error(`Erro no WebSocket do chat:`, error));
    });

    console.log('Gerenciador de Chat (WebSocket) inicializado.');
    return wssChat; // Retorna a instância para o server.js gerenciar
};

module.exports = { initializeChat };