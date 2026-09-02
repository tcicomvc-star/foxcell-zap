import express from "express";
import cors from "cors";
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import axios from "axios";
import pino from "pino";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "foxcell123";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://www.avenda.online/sistema/api/whatsapp_ia.php";
const AUTH_FOLDER = "./auth_info_baileys";

let sock = null;
let currentQrCodeBase64 = null;
let connectionStatus = "desconectado"; // "desconectado" | "aguardando_qrcode" | "conectado"
let connectedNumber = null;
let isInitializing = false;

const logger = pino({ level: "silent" });

async function limparSessao() {
    try {
        if (sock) {
            try { await sock.logout(); } catch (e) {}
            try { sock.end(); } catch (e) {}
        }
    } catch (e) {}
    try {
        if (fs.existsSync(AUTH_FOLDER)) {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
    } catch (e) {}
    connectionStatus = "desconectado";
    currentQrCodeBase64 = null;
    connectedNumber = null;
    sock = null;
    console.log("[FOXCELL] Sessao limpa com sucesso.");
}

async function iniciarWhatsApp() {
    if (isInitializing) return;
    isInitializing = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    currentQrCodeBase64 = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
                    connectionStatus = "aguardando_qrcode";
                    console.log("[FOXCELL] Novo QR Code gerado para conexao.");
                } catch (err) {
                    console.error("[FOXCELL] Erro ao converter QR Code:", err);
                }
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[FOXCELL] Conexao fechada (code: ${statusCode}).`);

                connectionStatus = "desconectado";
                currentQrCodeBase64 = null;
                connectedNumber = null;

                // Se foi desconectado pelo WhatsApp (logout, rejeicao 401/403/428)
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403 || statusCode === 428) {
                    console.log("[FOXCELL] Sessao rejeitada ou encerrada. Limpando credenciais antigas...");
                    try {
                        if (fs.existsSync(AUTH_FOLDER)) {
                            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                        }
                    } catch (e) {}
                }

                // Sempre agenda nova tentativa para nao deixar o servidor inativo
                setTimeout(() => {
                    isInitializing = false;
                    iniciarWhatsApp();
                }, 3000);
            } else if (connection === "open") {
                connectionStatus = "conectado";
                currentQrCodeBase64 = null;
                connectedNumber = sock.user?.id?.split(":")[0] || "FoxCell";
                console.log(`[FOXCELL] WhatsApp Conectado com sucesso! Numero: ${connectedNumber}`);
            }
        });

        // Recebimento de Mensagens
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.includes("@g.us")) continue; // Ignorar grupos

                const phone = remoteJid.replace(/\D/g, "");
                const senderName = msg.pushName || "Cliente";

                // Desembrulhar mensagens modernas do WhatsApp
                let m = msg.message;
                if (m.ephemeralMessage) m = m.ephemeralMessage.message;
                if (m.viewOnceMessage) m = m.viewOnceMessage.message;
                if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;

                // Extrair texto da mensagem
                const text =
                    m?.conversation ||
                    m?.extendedTextMessage?.text ||
                    m?.imageMessage?.caption ||
                    m?.videoMessage?.caption ||
                    "";

                if (!text.trim()) continue;

                console.log(`[FOXCELL] Mensagem recebida de ${senderName} (${phone}): "${text}"`);

                // Enviar para o Webhook do Sistema na HostGator
                try {
                    const resp = await axios.post(
                        WEBHOOK_URL,
                        {
                            phone,
                            senderName,
                            message: text,
                            fromMe: false,
                            isGroup: false
                        },
                        { 
                            headers: { "Content-Type": "application/json" },
                            timeout: 25000 
                        }
                    );
                    console.log(`[FOXCELL] Webhook HostGator respondeu status ${resp.status}`);
                } catch (webhookErr) {
                    console.error("[FOXCELL] Erro ao repassar para webhook HostGator:", webhookErr.message);
                }
            }
        });
    } catch (err) {
        console.error("[FOXCELL] Erro ao iniciar socket:", err);
        setTimeout(() => {
            isInitializing = false;
            iniciarWhatsApp();
        }, 5000);
    } finally {
        isInitializing = false;
    }
}

// ==========================================
// ROTAS DA API
// ==========================================

// 1. Healthcheck
app.get("/", (req, res) => {
    res.json({
        app: "FoxCell WhatsApp Microservice",
        status: connectionStatus,
        connectedNumber,
        uptime: process.uptime()
    });
});

// 2. Status
app.get("/status", (req, res) => {
    res.json({
        sucesso: true,
        status: connectionStatus,
        numero: connectedNumber
    });
});

// 3. QR Code
app.get("/qrcode", (req, res) => {
    if (connectionStatus === "conectado") {
        return res.json({
            sucesso: true,
            status: "conectado",
            numero: connectedNumber
        });
    }

    if (currentQrCodeBase64) {
        return res.json({
            sucesso: true,
            status: "aguardando_qrcode",
            qrcode: currentQrCodeBase64
        });
    }

    // Se estiver desconectado e sem QR Code, forcar inicializacao
    if (!sock || connectionStatus === "desconectado") {
        iniciarWhatsApp();
    }

    return res.json({
        sucesso: false,
        status: "desconectado",
        mensagem: "Gerando novo QR Code limpo... Aguarde 3 segundos e tente novamente."
    });
});

// 4. Enviar Mensagem de Texto
app.post("/send-text", async (req, res) => {
    const { phone, message } = req.body;

    if (!sock || connectionStatus !== "conectado") {
        return res.status(400).json({ sucesso: false, erro: "WhatsApp nao esta conectado" });
    }

    if (!phone || !message) {
        return res.status(400).json({ sucesso: false, erro: "Telefone e mensagem sao obrigatorios" });
    }

    try {
        const cleanPhone = phone.replace(/\D/g, "");
        let jid = `${cleanPhone}@s.whatsapp.net`;

        // Resolver JID oficial no WhatsApp (trata variacao de 8 ou 9 digitos no Brasil)
        try {
            const results = await sock.onWhatsApp(cleanPhone);
            if (results && results[0] && results[0].jid) {
                jid = results[0].jid;
            }
        } catch (waErr) {}

        await sock.sendMessage(jid, { text: message });
        console.log(`[FOXCELL] Resposta da Agatha enviada para ${jid}`);

        return res.json({ sucesso: true, mensagem: "Enviado com sucesso", jid });
    } catch (err) {
        console.error("[FOXCELL] Erro ao enviar mensagem:", err);
        return res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 5. Desconectar
app.post("/disconnect", async (req, res) => {
    try {
        await limparSessao();
        setTimeout(iniciarWhatsApp, 1500);
        res.json({ sucesso: true, mensagem: "Desconectado e resetado com sucesso" });
    } catch (err) {
        res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 6. Resetar Sessao (Gera QR Code 100% novo)
app.get("/reset", async (req, res) => {
    try {
        await limparSessao();
        setTimeout(iniciarWhatsApp, 1500);
        res.json({
            sucesso: true,
            mensagem: "Sessao antiga limpa com sucesso! Aguarde 5 segundos e gere o novo QR Code."
        });
    } catch (err) {
        res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 7. Teste de conexao com Webhook HostGator
app.get("/test-webhook", async (req, res) => {
    try {
        const resp = await axios.post(
            WEBHOOK_URL,
            {
                phone: "558588599960",
                senderName: "Teste Webhook",
                message: "Oi",
                fromMe: false,
                isGroup: false
            },
            { headers: { "Content-Type": "application/json" }, timeout: 25000 }
        );
        res.json({ sucesso: true, webhookUrl: WEBHOOK_URL, statusWebhook: resp.status, data: resp.data });
    } catch (e) {
        res.status(500).json({ sucesso: false, webhookUrl: WEBHOOK_URL, erro: e.message });
    }
});

// Iniciar servidor e conexao
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`FOXCELL WHATSAPP SERVER RODANDO NA PORTA ${PORT}`);
    console.log(`=================================================`);
    iniciarWhatsApp();
});
