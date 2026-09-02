import express from "express";
import cors from "cors";
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import axios from "axios";
import pino from "pino";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "foxcell123";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://www.avenda.online/sistema/api/whatsapp_ia.php";

let sock = null;
let currentQrCodeBase64 = null;
let connectionStatus = "desconectado"; // "desconectado" | "aguardando_qrcode" | "conectado"
let connectedNumber = null;

const logger = pino({ level: "silent" });

async function iniciarWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
            browser: ["FoxCell Assistencia", "Chrome", "1.0.0"],
            syncFullHistory: false
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    currentQrCodeBase64 = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
                    connectionStatus = "aguardando_qrcode";
                    console.log("[FOXCELL] Novo QR Code gerado para conexão.");
                } catch (err) {
                    console.error("[FOXCELL] Erro ao converter QR Code:", err);
                }
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                connectionStatus = "desconectado";
                currentQrCodeBase64 = null;
                connectedNumber = null;

                console.log(`[FOXCELL] Conexao fechada (code: ${statusCode}). Reconectar: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(iniciarWhatsApp, 4000);
                }
            } else if (connection === "open") {
                connectionStatus = "conectado";
                currentQrCodeBase64 = null;
                connectedNumber = sock.user?.id?.split(":")[0] || "FoxCell";
                console.log(`[FOXCELL] ✅ WhatsApp Conectado com sucesso! Numero: ${connectedNumber}`);
            }
        });

        // Recebimento de Mensagens
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.includes("@g.us")) continue; // Ignorar grupos

                const phone = remoteJid.replace(/\D/g, "");
                const senderName = msg.pushName || "Cliente";

                // Extrair texto da mensagem
                const text =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    "";

                if (!text.trim()) continue;

                console.log(`[FOXCELL] Mensagem recebida de ${senderName} (${phone}): "${text}"`);

                // Enviar para o Webhook do Sistema na HostGator
                try {
                    await axios.post(
                        WEBHOOK_URL,
                        {
                            phone,
                            senderName,
                            message: text,
                            fromMe: false,
                            isGroup: false
                        },
                        { timeout: 15000 }
                    );
                } catch (webhookErr) {
                    console.error("[FOXCELL] Erro ao repassar para webhook HostGator:", webhookErr.message);
                }
            }
        });
    } catch (err) {
        console.error("[FOXCELL] Erro ao iniciar socket:", err);
        setTimeout(iniciarWhatsApp, 5000);
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

    return res.json({
        sucesso: false,
        status: "desconectado",
        mensagem: "Gerando QR Code... Aguarde alguns segundos e tente novamente."
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
        const jid = `${cleanPhone}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        console.log(`[FOXCELL] Resposta enviada com sucesso para ${cleanPhone}`);

        return res.json({ sucesso: true, mensagem: "Enviado com sucesso" });
    } catch (err) {
        console.error("[FOXCELL] Erro ao enviar mensagem:", err);
        return res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 5. Desconectar
app.post("/disconnect", async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        connectionStatus = "desconectado";
        currentQrCodeBase64 = null;
        connectedNumber = null;
        res.json({ sucesso: true, mensagem: "Desconectado com sucesso" });
    } catch (err) {
        res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// Iniciar servidor e conexao
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🦊 FOXCELL WHATSAPP SERVER RODANDO NA PORTA ${PORT}`);
    console.log(`=================================================`);
    iniciarWhatsApp();
});