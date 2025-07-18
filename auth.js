// auth.js
// Lida com registro, login (usuário e admin), recuperação de senha e gerenciamento de sessão/token (JWT).

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto'); // Módulo nativo do Node.js para gerar tokens seguros
const nodemailer = require('nodemailer');
const { User } = require('./models');
require('dotenv').config();

// --- Middleware de Autenticação ---
// Verifica a validade do token JWT em rotas protegidas.
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

    if (!token) {
        return res.status(403).json({ message: 'Um token é necessário para a autenticação.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Adiciona os dados do usuário (id, username, role) ao objeto req
    } catch (err) {
        return res.status(401).json({ message: 'Token inválido ou expirado.' });
    }

    return next();
};

// --- Rota de Registro de Usuário ---
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validação básica de entrada
        if (!username || !email || !password) {
            return res.status(400).json({ message: 'Por favor, forneça todos os campos: nome de usuário, email e senha.' });
        }

        // Verifica se o email ou usuário já existem
        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(409).json({ message: 'Email ou nome de usuário já está em uso.' });
        }

        // Criptografa a senha antes de salvar
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Cria o novo usuário
        const newUser = new User({
            username,
            email,
            password: hashedPassword,
        });

        await newUser.save();

        res.status(201).json({ message: 'Usuário registrado com sucesso. Por favor, faça o login.' });

    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao tentar registrar o usuário.', error: error.message });
    }
});

// --- Rota de Login de Usuário ---
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Por favor, forneça email e senha.' });
        }

        // Procura o usuário pelo email
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ message: 'Credenciais inválidas.' }); // Mensagem genérica
        }

        // Compara a senha fornecida com a senha armazenada no banco
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciais inválidas.' }); // Mensagem genérica
        }

        // Cria o payload para o token JWT
        const payload = {
            id: user._id,
            username: user.username,
            role: user.role,
        };

        // Gera e assina o token
        const token = jwt.sign(payload, process.env.JWT_SECRET, {
            expiresIn: '24h', // Token expira em 24 horas
        });

        res.status(200).json({
            message: 'Login bem-sucedido!',
            token,
            user: {
                id: user._id,
                username: user.username,
                role: user.role
            }
        });

    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor durante o login.', error: error.message });
    }
});


// --- Rota de Recuperação de Senha (Esqueci a Senha) ---
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) {
            // Resposta genérica para não revelar se um email está ou não cadastrado
            return res.status(200).json({ message: 'Se um usuário com este email existir, um link de recuperação será enviado.' });
        }

        // Gera um token de reset seguro
        const resetToken = crypto.randomBytes(32).toString('hex');
        user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        user.resetPasswordExpires = Date.now() + 3600000; // Expira em 1 hora

        await user.save();

        // Configura o Nodemailer
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        // Cria a URL de reset
        const resetUrl = `${process.env.CORS_ORIGIN}/reset-password.html?token=${resetToken}`;

        // HTML personalizado para o email
        const emailHtml = `
            <div style="font-family: Arial, sans-serif; text-align: center; color: #333;">
                <h2 style="color: #000;">BRAINSKILL - Recuperação de Senha</h2>
                <p>Você solicitou a redefinição da sua senha. Por favor, clique no botão abaixo para criar uma nova senha.</p>
                <p>Este link é válido por 1 hora.</p>
                <a href="${resetUrl}" style="background-color: #4CAF50; color: white; padding: 14px 25px; text-align: center; text-decoration: none; display: inline-block; border-radius: 8px; font-size: 16px;">
                    Redefinir Senha
                </a>
                <p style="margin-top: 20px;">Se você não solicitou isso, por favor, ignore este email.</p>
                <p style="font-size: 12px; color: #888;">© BRAINSKILL</p>
            </div>
        `;

        // Opções do email
        const mailOptions = {
            from: `"BRAINSKILL" <${process.env.EMAIL_USER}>`,
            to: user.email,
            subject: 'Recuperação de Senha - BRAINSKILL',
            html: emailHtml
        };
        
        // Envia o email
        await transporter.sendMail(mailOptions);
        
        res.status(200).json({ message: 'Se um usuário com este email existir, um link de recuperação será enviado.' });

    } catch (error) {
        console.error("Erro em /forgot-password:", error);
        // Limpa o token em caso de falha no envio do email para permitir nova tentativa
        const user = await User.findOne({ email: req.body.email });
        if (user) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpires = undefined;
            await user.save();
        }
        res.status(500).json({ message: 'Erro no servidor ao tentar enviar o email de recuperação.' });
    }
});


// --- Rota para Redefinir a Senha com o Token ---
router.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if(!token || !newPassword) {
            return res.status(400).json({ message: 'Token e nova senha são obrigatórios.' });
        }

        // Criptografa o token recebido para comparar com o que está no banco
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpires: { $gt: Date.now() }, // Verifica se o token não expirou
        });

        if (!user) {
            return res.status(400).json({ message: 'Token de redefinição inválido ou expirado.' });
        }
        
        // Criptografa a nova senha
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        
        // Limpa os campos de reset do documento do usuário
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;

        await user.save();

        res.status(200).json({ message: 'Senha redefinida com sucesso. Você já pode fazer o login com a nova senha.' });

    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao tentar redefinir a senha.', error: error.message });
    }
});


// Exporta o router e o middleware para serem usados no server.js
module.exports = { router, verifyToken };