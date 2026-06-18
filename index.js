const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors({
    origin: '*', // Permitir todas as origens ou configurar a do seu frontend
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

let qrCode = null;
let connectionStatus = 'disconnected';
let userInfo = null;
let initError = null;

console.log('Iniciando cliente WhatsApp...');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    puppeteer: {
        headless: true,
        // Configurações cruciais para rodar no Docker e ambientes Linux como Render
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
            '--js-flags="--max-old-space-size=150"'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    }
});

// Eventos do whatsapp-web.js
client.on('qr', (qr) => {
    console.log('QR Code recebido. Pronto para escaneamento!');
    qrCode = qr;
    connectionStatus = 'qr';
    initError = null;
});

client.on('ready', () => {
    console.log('Cliente WhatsApp está conectado e pronto!');
    qrCode = null;
    connectionStatus = 'connected';
    userInfo = client.info;
    initError = null;
});

client.on('authenticated', () => {
    console.log('Autenticação realizada com sucesso.');
});

client.on('auth_failure', (msg) => {
    console.error('Falha na autenticação:', msg);
    connectionStatus = 'disconnected';
    qrCode = null;
    initError = 'Falha na autenticação: ' + msg;
});

client.on('disconnected', async (reason) => {
    console.log('Cliente WhatsApp foi desconectado:', reason);
    connectionStatus = 'disconnected';
    qrCode = null;
    userInfo = null;
    initError = 'Desconectado: ' + reason;
    
    // Tenta re-inicializar
    try {
        console.log('Tentando reinicializar cliente após desconexão...');
        await client.initialize();
    } catch (err) {
        console.error('Erro ao re-inicializar após desconexão:', err);
    }
});

// Inicializa o cliente
client.initialize().catch(err => {
    console.error('Erro na inicialização do WhatsApp Client:', err);
    connectionStatus = 'disconnected';
    initError = err.message || 'Erro desconhecido na inicialização';
});

// Endpoints da API
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: qrCode,
        error: initError,
        user: userInfo ? {
            wid: userInfo.wid,
            pushname: userInfo.pushname
        } : null
    });
});

// Novo endpoint para solicitar o código de pareamento por telefone (sem QR Code)
app.get('/pairing-code', async (req, res) => {
    const { phone } = req.query;
    
    if (!phone) {
        return res.status(400).json({ error: 'Parâmetro "phone" é obrigatório.' });
    }

    try {
        // Limpa formatação do telefone
        let cleanPhone = phone.replace(/\D/g, '');
        if (!cleanPhone.startsWith('55') && (cleanPhone.length === 10 || cleanPhone.length === 11)) {
            cleanPhone = '55' + cleanPhone;
        }

        console.log(`Solicitando código de pareamento para: ${cleanPhone}`);
        const code = await client.requestPairingCode(cleanPhone);
        res.json({ success: true, code });
    } catch (error) {
        console.error('Erro ao solicitar código de pareamento:', error);
        res.status(500).json({ error: error.message || 'Erro ao gerar código de pareamento.' });
    }
});

app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Campos "phone" e "message" são obrigatórios.' });
    }

    if (connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp não está conectado. Por favor, conecte via QR Code ou código de pareamento.' });
    }

    try {
        // Limpa formatação do telefone
        let cleanPhone = phone.replace(/\D/g, '');
        if (!cleanPhone.startsWith('55') && (cleanPhone.length === 10 || cleanPhone.length === 11)) {
            cleanPhone = '55' + cleanPhone;
        }

        const formattedNumber = cleanPhone + '@c.us';
        console.log(`Enviando mensagem para: ${formattedNumber}`);
        
        const isRegistered = await client.isRegisteredUser(formattedNumber);
        if (!isRegistered) {
            if (cleanPhone.startsWith('55') && cleanPhone.length === 13) {
                const alternativePhone = cleanPhone.slice(0, 4) + cleanPhone.slice(5);
                const alternativeFormatted = alternativePhone + '@c.us';
                console.log(`Tentando número alternativo sem o 9º dígito: ${alternativeFormatted}`);
                const isAlternativeRegistered = await client.isRegisteredUser(alternativeFormatted);
                if (isAlternativeRegistered) {
                    const response = await client.sendMessage(alternativeFormatted, message);
                    return res.json({ success: true, messageId: response.id.id, numberUsed: alternativePhone });
                }
            }
            return res.status(404).json({ error: 'O número informado não está registrado no WhatsApp.' });
        }

        const response = await client.sendMessage(formattedNumber, message);
        res.json({ success: true, messageId: response.id.id, numberUsed: cleanPhone });
    } catch (error) {
        console.error('Erro ao enviar mensagem via WhatsApp:', error);
        res.status(500).json({ error: error.message || 'Erro desconhecido ao enviar mensagem.' });
    }
});

app.post('/logout', async (req, res) => {
    try {
        if (connectionStatus === 'connected') {
            await client.logout();
        }
        res.json({ success: true, message: 'Desconectado com sucesso!' });
    } catch (error) {
        console.error('Erro ao desconectar:', error);
        res.status(500).json({ error: error.message || 'Erro ao desconectar.' });
    }
});

app.post('/restart', async (req, res) => {
    try {
        console.log('Reiniciando serviço WhatsApp...');
        connectionStatus = 'connecting';
        qrCode = null;
        userInfo = null;
        initError = null;
        
        try {
            await client.destroy();
        } catch (e) {
            console.log('Cliente já destruído ou erro ao destruir:', e.message);
        }
        
        await client.initialize();
        res.json({ success: true, message: 'Serviço reiniciado e inicializado com sucesso.' });
    } catch (error) {
        console.error('Erro ao reiniciar serviço:', error);
        res.status(500).json({ error: error.message || 'Erro ao reiniciar serviço.' });
    }
});

app.post('/reset', async (req, res) => {
    try {
        console.log('Resetando e limpando cache do WhatsApp...');
        connectionStatus = 'connecting';
        qrCode = null;
        userInfo = null;
        initError = null;
        
        try {
            await client.destroy();
        } catch (e) {
            console.log('Erro ao destruir cliente (talvez já inativo):', e.message);
        }

        // Deleta pasta do cache de sessão
        try {
            if (fs.existsSync('./.wwebjs_auth')) {
                fs.rmSync('./.wwebjs_auth', { recursive: true, force: true });
                console.log('Pasta .wwebjs_auth deletada com sucesso.');
            }
        } catch (fsErr) {
            console.error('Erro ao deletar pasta .wwebjs_auth:', fsErr.message);
        }
        
        await client.initialize();
        res.json({ success: true, message: 'Serviço resetado e cache limpo com sucesso.' });
    } catch (error) {
        console.error('Erro ao resetar serviço:', error);
        res.status(500).json({ error: error.message || 'Erro ao resetar serviço.' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${port}`);
});
