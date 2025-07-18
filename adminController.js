// adminController.js
// Lida com a lógica do painel de administração, como a criação e gerenciamento de anúncios e usuários.

const express = require('express');
const router = express.Router();
const { Ad, User } = require('./models');
const { verifyToken } = require('./auth'); // Importa o middleware de verificação de token.

// --- Middleware de Autorização de Administrador ---
// Este middleware verifica se o usuário autenticado tem a permissão de 'admin'.
// Deve ser usado em conjunto com `verifyToken`.
const isAdmin = (req, res, next) => {
    // req.user é populado pelo middleware verifyToken
    if (req.user && req.user.role === 'admin') {
        next(); // O usuário é um admin, pode prosseguir.
    } else {
        res.status(403).json({ message: 'Acesso negado. Apenas administradores podem realizar esta ação.' });
    }
};

// --- ROTAS DE GERENCIAMENTO DE ANÚNCIOS (ADS) ---
// Todas as rotas de anúncios são protegidas e requerem privilégios de administrador.

// Rota para CRIAR um novo anúncio.
router.post('/ads', [verifyToken, isAdmin], async (req, res) => {
    try {
        const { type, contentUrl, htmlSnippet, linkUrl, buttonText, buttonColor, targetPages, isActive } = req.body;

        // Validação básica
        if (!type || (!contentUrl && type !== 'html') || (!htmlSnippet && type === 'html')) {
            return res.status(400).json({ message: 'Campos obrigatórios estão faltando para o tipo de anúncio especificado.' });
        }

        const newAd = new Ad({
            type,
            contentUrl,
            htmlSnippet,
            linkUrl,
            buttonText,
            buttonColor,
            targetPages,
            isActive,
            createdBy: req.user.id // ID do admin que está criando o anúncio.
        });

        await newAd.save();
        res.status(201).json({ message: 'Anúncio criado com sucesso!', ad: newAd });

    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao criar o anúncio.', error: error.message });
    }
});

// Rota para LISTAR todos os anúncios.
router.get('/ads', [verifyToken, isAdmin], async (req, res) => {
    try {
        const ads = await Ad.find().populate('createdBy', 'username'); // Popula com o nome de usuário do admin.
        res.status(200).json(ads);
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao buscar anúncios.', error: error.message });
    }
});

// Rota para ATUALIZAR um anúncio existente.
router.put('/ads/:id', [verifyToken, isAdmin], async (req, res) => {
    try {
        const updatedAd = await Ad.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!updatedAd) {
            return res.status(404).json({ message: 'Anúncio não encontrado.' });
        }
        res.status(200).json({ message: 'Anúncio atualizado com sucesso!', ad: updatedAd });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao atualizar o anúncio.', error: error.message });
    }
});

// Rota para DELETAR um anúncio.
router.delete('/ads/:id', [verifyToken, isAdmin], async (req, res) => {
    try {
        const ad = await Ad.findByIdAndDelete(req.params.id);
        if (!ad) {
            return res.status(404).json({ message: 'Anúncio não encontrado.' });
        }
        res.status(200).json({ message: 'Anúncio deletado com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao deletar o anúncio.', error: error.message });
    }
});

// --- ROTAS DE GERENCIAMENTO DE USUÁRIOS ---

// Rota para LISTAR todos os usuários.
router.get('/users', [verifyToken, isAdmin], async (req, res) => {
    try {
        // Retorna todos os usuários, mas exclui suas senhas da resposta.
        const users = await User.find().select('-password');
        res.status(200).json(users);
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao buscar usuários.', error: error.message });
    }
});

// Rota para BLOQUEAR/DELETAR um usuário do sistema.
router.delete('/users/:id', [verifyToken, isAdmin], async (req, res) => {
    try {
        const userId = req.params.id;
        
        // Impede que um admin delete a si próprio.
        if (req.user.id === userId) {
            return res.status(400).json({ message: 'Um administrador não pode deletar a própria conta.' });
        }

        const user = await User.findByIdAndDelete(userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        
        // Aqui, futuramente, pode-se adicionar a lógica para encerrar sessões de jogos
        // ou limpar dados relacionados ao usuário em outros modelos (ex: mensagens de chat).

        res.status(200).json({ message: `Usuário '${user.username}' deletado com sucesso.` });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao deletar o usuário.', error: error.message });
    }
});


// --- ROTAS DE GERENCIAMENTO DO SISTEMA ---
// (Placeholder para funcionalidades como desativar chat, etc.)

router.post('/system/toggle-feature', [verifyToken, isAdmin], async (req, res) => {
    const { feature, isEnabled } = req.body; // Ex: { feature: 'chat', isEnabled: false }
    
    // A lógica real aqui envolveria a modificação de um documento de configuração global no DB.
    // Por enquanto, é um endpoint de demonstração.
    console.log(`[Admin: ${req.user.username}] solicitou a alteração de '${feature}' para o estado '${isEnabled}'.`);

    res.status(200).json({ message: `A funcionalidade '${feature}' foi atualizada.` });
});


module.exports = router;