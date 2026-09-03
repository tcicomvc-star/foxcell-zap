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
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://www.avenda.online/sistema/api/whatsapp_ia.php";
const AUTH_FOLDER = "./auth_info_baileys";

let sock = null;
let currentQrCodeBase64 = null;
let connectionStatus = "desconectado"; // "desconectado" | "aguardando_qrcode" | "conectado"
let connectedNumber = null;
let reconnectTimeout = null;
let isStarting = false;

const logger = pino({ level: "silent" });

const SYNC_URL = process.env.SYNC_URL || "https://www.avenda.online/sistema/api/whatsapp_auth_sync.php";
let syncTimeout = null;

// Cache para rastrear tentativas de reenvio do Baileys e evitar loops
const msgRetryCounterCache = {
    _cache: new Map(),
    get(key) { return this._cache.get(key); },
    set(key, value) { this._cache.set(key, value); },
    del(key) { this._cache.delete(key); }
};

// Armazenamento em memória das mensagens enviadas recentemente para responder a pedidos de chave/retry do WhatsApp
// Isso resolve o problema de "Aguardando mensagem. Essa ação pode levar alguns instantes..."
const recentMessagesStore = new Map();

// Salvar todos os arquivos de autenticação no banco da HostGator
async function salvarSessaoRemota() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
        try {
            if (!fs.existsSync(AUTH_FOLDER)) return;
            const files = fs.readdirSync(AUTH_FOLDER);
            if (!files.includes("creds.json")) return;

            const sessionData = {};
            for (const file of files) {
                const filePath = path.join(AUTH_FOLDER, file);
                if (fs.statSync(filePath).isFile()) {
                    sessionData[file] = fs.readFileSync(filePath, "utf-8");
                }
            }

            await axios.post(SYNC_URL, { session_data: sessionData }, { timeout: 15000 });
            console.log(`[FOXCELL] 💾 Sessão do WhatsApp SINCRONIZADA no banco da HostGator (${Object.keys(sessionData).length} arquivos salvos).`);
        } catch (err) {
            console.error("[FOXCELL] Aviso ao salvar sessão na HostGator:", err.message);
        }
    }, 3000);
}

// Restaurar os arquivos de autenticação a partir do banco da HostGator
async function restaurarSessaoRemota() {
    try {
        console.log("[FOXCELL] 📥 Verificando se existe sessão salva no MySQL da HostGator...");
        const resp = await axios.get(SYNC_URL, { timeout: 15000 });
        if (resp.data && resp.data.sucesso && resp.data.session_data) {
            if (!fs.existsSync(AUTH_FOLDER)) {
                fs.mkdirSync(AUTH_FOLDER, { recursive: true });
            }

            const sessionData = resp.data.session_data;
            const filenames = Object.keys(sessionData);

            if (filenames.includes("creds.json")) {
                for (const filename of filenames) {
                    const filePath = path.join(AUTH_FOLDER, filename);
                    fs.writeFileSync(filePath, sessionData[filename], "utf-8");
                }
                console.log(`[FOXCELL] ✅ Sessão restaurada com sucesso do banco! (${filenames.length} arquivos gravados).`);
                return true;
            }
        }
    } catch (err) {
        console.log("[FOXCELL] Nenhuma sessão prévia restaurada do MySQL:", err.message);
    }
    return false;
}

// Limpar sessão local e banco
async function limparSessao() {
    try {
        if (fs.existsSync(AUTH_FOLDER)) {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
        await axios.post(SYNC_URL, { action: "limpar" }, { timeout: 10000 });
    } catch (e) {}
    connectionStatus = "desconectado";
    currentQrCodeBase64 = null;
    connectedNumber = null;
    console.log("[FOXCELL] Sessão limpa completamente (local e banco da HostGator).");
}

function encerrarSocketAtual() {
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            if (sock.ws) {
                sock.ws.close();
            }
        } catch (e) {}
        sock = null;
    }
}

function agendarReconexao(ms = 5000) {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        iniciarWhatsApp();
    }, ms);
}

// Resolve e valida o JID canônico no WhatsApp (trata DDI 55 e a variação do 9º dígito no Brasil)
async function resolverJidValido(numeroOuJid) {
    if (!numeroOuJid) return null;
    let raw = String(numeroOuJid).trim();

    // Se já é LID
    if (raw.endsWith("@lid")) return raw;

    // Se já veio com @s.whatsapp.net, extrai o número para validação
    if (raw.endsWith("@s.whatsapp.net")) {
        raw = raw.replace("@s.whatsapp.net", "");
    }

    let clean = raw.replace(/\D/g, "");
    if (!clean) return null;

    if (clean.length > 13) return `${clean}@lid`;

    // Se número brasileiro sem DDI 55 (10 ou 11 dígitos), prefixa 55
    if (clean.length === 10 || clean.length === 11) {
        clean = "55" + clean;
    }

    if (sock && connectionStatus === "conectado") {
        try {
            // 1. Consulta com o número exato fornecido
            const r1 = await sock.onWhatsApp(clean);
            if (r1 && r1.length > 0 && r1[0].exists && r1[0].jid) {
                return r1[0].jid;
            }

            // 2. No Brasil, se tiver 13 dígitos (55 + DDD + 9 + 8 dígitos)
            // No WhatsApp, muitas contas antigas foram registradas SEM o 9º dígito (12 dígitos)
            if (clean.startsWith("55") && clean.length === 13 && clean[4] === "9") {
                const sem9 = clean.slice(0, 4) + clean.slice(5);
                const r2 = await sock.onWhatsApp(sem9);
                if (r2 && r2.length > 0 && r2[0].exists && r2[0].jid) {
                    console.log(`[FOXCELL] JID ajustado (sem nono dígito): ${clean} -> ${r2[0].jid}`);
                    return r2[0].jid;
                }
            }

            // 3. No Brasil, se tiver 12 dígitos (55 + DDD + 8 dígitos), tenta COM o nono dígito
            if (clean.startsWith("55") && clean.length === 12) {
                const com9 = clean.slice(0, 4) + "9" + clean.slice(4);
                const r3 = await sock.onWhatsApp(com9);
                if (r3 && r3.length > 0 && r3[0].exists && r3[0].jid) {
                    console.log(`[FOXCELL] JID ajustado (com nono dígito): ${clean} -> ${r3[0].jid}`);
                    return r3[0].jid;
                }
            }
        } catch (err) {
            console.error("[FOXCELL] Falha na consulta onWhatsApp:", err.message);
        }
    }

    return `${clean}@s.whatsapp.net`;
}

async function iniciarWhatsApp() {
    if (isStarting) return;
    isStarting = true;

    try {
        // Matar qualquer conexao fantasma antes de iniciar uma nova
        encerrarSocketAtual();

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
            keepAliveIntervalMs: 25000,
            msgRetryCounterCache,
            getMessage: async (key) => {
                if (key && key.id && recentMessagesStore.has(key.id)) {
                    return recentMessagesStore.get(key.id);
                }
                return {
                    conversation: "FoxCell Assistência Técnica"
                };
            }
        });

        sock.ev.on("creds.update", async () => {
            await saveCreds();
            salvarSessaoRemota();
        });

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

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                    console.log("[FOXCELL] Desconectado permanentemente. Limpando credenciais...");
                    await limparSessao();
                    agendarReconexao(2000);
                } else if (statusCode === 440) {
                    console.log("[FOXCELL] Conexao substituida (code 440). Aguardando 8 segundos para estabilizar...");
                    agendarReconexao(8000);
                } else {
                    agendarReconexao(4000);
                }
            } else if (connection === "open") {
                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = null;
                }
                connectionStatus = "conectado";
                currentQrCodeBase64 = null;
                connectedNumber = sock.user?.id ? sock.user.id.split(":")[0] : "Desconhecido";
                console.log(`[FOXCELL] Conectado com sucesso no WhatsApp! Numero: ${connectedNumber}`);
                salvarSessaoRemota();
            }
        });

        // Delay Inteligente (10s) para IA nao atropelar atendente humano
        const pendingTimers = new Map();
        const DELAY_RESPOSTA_MS = 10000;

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;

            for (const msg of messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.includes("@g.us") || remoteJid === "status@broadcast") {
                    continue;
                }

                // 1. SE FOI O ATENDENTE HUMANO (ALEXANDRE) QUEM MANDOU MENSAGEM:
                if (msg.key.fromMe) {
                    if (pendingTimers.has(remoteJid)) {
                        clearTimeout(pendingTimers.get(remoteJid));
                        pendingTimers.delete(remoteJid);
                        console.log(`[FOXCELL] Resposta da Agatha CANCELADA pois o atendente assumiu a conversa!`);
                    }
                    continue;
                }

                const text =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    "";

                if (!text || !text.trim()) continue;

                const senderName = msg.pushName || "Cliente";
                const phone = remoteJid.split("@")[0];

                if (pendingTimers.has(remoteJid)) {
                    clearTimeout(pendingTimers.get(remoteJid));
                }

                console.log(`[FOXCELL] Aguardando ${DELAY_RESPOSTA_MS / 1000}s de delay para ${senderName}. Se o Alexandre responder, a IA é cancelada.`);
                
                const timerId = setTimeout(async () => {
                    pendingTimers.delete(remoteJid);
                    try {
                        console.log(`[FOXCELL] Enviando mensagem de ${senderName} para a Agatha na HostGator...`);
                        const resp = await axios.post(
                            WEBHOOK_URL,
                            {
                                phone,
                                jid: remoteJid,
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
                }, DELAY_RESPOSTA_MS);

                pendingTimers.set(remoteJid, timerId);
            }
        });
    } catch (err) {
        console.error("[FOXCELL] Erro ao iniciar socket:", err);
        agendarReconexao(5000);
    } finally {
        isStarting = false;
    }
}

// ==========================================
// ROTAS DA API
// ==========================================

// 1. Healthcheck
app.get("/", (req, res) => {
    res.json({
        app: "FoxCell WhatsApp Baileys Microservice",
        status: connectionStatus,
        numero: connectedNumber,
        timestamp: new Date().toISOString()
    });
});

// 2. Status da Conexao
app.get("/status", (req, res) => {
    res.json({
        conectado: connectionStatus === "conectado",
        status: connectionStatus,
        numero: connectedNumber,
        temQrCode: !!currentQrCodeBase64
    });
});

// 3. Obter QR Code
app.get("/qrcode", (req, res) => {
    if (connectionStatus === "conectado") {
        return res.json({
            sucesso: true,
            status: "conectado",
            numero: connectedNumber,
            mensagem: "WhatsApp ja esta conectado!"
        });
    }

    if (currentQrCodeBase64) {
        return res.json({
            sucesso: true,
            status: "aguardando_qrcode",
            qrcode: currentQrCodeBase64
        });
    }

    if (!sock || connectionStatus === "desconectado") {
        iniciarWhatsApp();
    }

    return res.json({
        sucesso: false,
        status: "desconectado",
        mensagem: "Gerando novo QR Code limpo... Aguarde 3 segundos e tente novamente."
    });
});

// 4. Enviar Mensagem de Texto (com suporte a JID direto, LID, resolução do 9º dígito e pré-aquecimento Signal)
app.post("/send-text", async (req, res) => {
    const { phone, jid: directJid, message } = req.body;

    if (!sock || connectionStatus !== "conectado") {
        return res.status(400).json({ sucesso: false, erro: "WhatsApp nao esta conectado" });
    }

    if ((!phone && !directJid) || !message) {
        return res.status(400).json({ sucesso: false, erro: "Telefone/JID e mensagem sao obrigatorios" });
    }

    try {
        const target = directJid || phone;
        const jid = await resolverJidValido(target);

        if (!jid) {
            return res.status(400).json({ sucesso: false, erro: "Destinatário inválido" });
        }

        // Pré-aquecimento da sessão de criptografia (evita 'Aguardando mensagem...' no cliente)
        try {
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate("composing", jid);
            await new Promise((r) => setTimeout(r, 400));
            await sock.sendPresenceUpdate("paused", jid);
        } catch (pErr) {}

        const sent = await sock.sendMessage(jid, { text: message });

        // Salva a mensagem no cache para responder instantaneamente a requisições de chave/retry
        if (sent && sent.key && sent.key.id && sent.message) {
            recentMessagesStore.set(sent.key.id, sent.message);
            if (recentMessagesStore.size > 300) {
                const firstKey = recentMessagesStore.keys().next().value;
                recentMessagesStore.delete(firstKey);
            }
        }

        console.log(`[FOXCELL] Notificação/Mensagem enviada com sucesso para ${jid}`);
        return res.json({ sucesso: true, mensagem: "Enviado com sucesso", jid });
    } catch (err) {
        console.error("[FOXCELL] Erro ao enviar mensagem:", err);
        return res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 5. Enviar Imagem / Foto (Base64 ou URL) com Legenda
app.post("/send-image", async (req, res) => {
    const { phone, jid: directJid, image, caption } = req.body;

    if (!sock || connectionStatus !== "conectado") {
        return res.status(400).json({ sucesso: false, erro: "WhatsApp nao esta conectado" });
    }

    if ((!phone && !directJid) || !image) {
        return res.status(400).json({ sucesso: false, erro: "Telefone/JID e imagem sao obrigatorios" });
    }

    try {
        const target = directJid || phone;
        const jid = await resolverJidValido(target);

        if (!jid) {
            return res.status(400).json({ sucesso: false, erro: "Destinatário inválido" });
        }

        let imageBuffer;
        if (image.startsWith("data:image")) {
            const base64Data = image.split(",")[1];
            imageBuffer = Buffer.from(base64Data, "base64");
        } else if (image.startsWith("http")) {
            const imgResp = await axios.get(image, { responseType: "arraybuffer", timeout: 15000 });
            imageBuffer = Buffer.from(imgResp.data);
        } else {
            imageBuffer = Buffer.from(image, "base64");
        }

        // Pré-aquecimento da sessão de criptografia
        try {
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate("composing", jid);
            await new Promise((r) => setTimeout(r, 400));
            await sock.sendPresenceUpdate("paused", jid);
        } catch (pErr) {}

        const sent = await sock.sendMessage(jid, { 
            image: imageBuffer, 
            caption: caption || "" 
        });

        if (sent && sent.key && sent.key.id && sent.message) {
            recentMessagesStore.set(sent.key.id, sent.message);
            if (recentMessagesStore.size > 300) {
                const firstKey = recentMessagesStore.keys().next().value;
                recentMessagesStore.delete(firstKey);
            }
        }

        console.log(`[FOXCELL] Imagem enviada para ${jid}`);
        return res.json({ sucesso: true, mensagem: "Imagem enviada com sucesso", jid });
    } catch (err) {
        console.error("[FOXCELL] Erro ao enviar imagem:", err);
        return res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 6. Desconectar
app.post("/disconnect", async (req, res) => {
    try {
        await limparSessao();
        agendarReconexao(1500);
        res.json({ sucesso: true, mensagem: "Desconectado e resetado com sucesso" });
    } catch (err) {
        res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 7. Resetar Sessao (Gera QR Code 100% novo)
app.get("/reset", async (req, res) => {
    try {
        await limparSessao();
        agendarReconexao(1500);
        res.json({
            sucesso: true,
            mensagem: "Sessao antiga limpa com sucesso! Aguarde 5 segundos e gere o novo QR Code."
        });
    } catch (err) {
        res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 8. Teste de conexao com Webhook HostGator
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
app.listen(PORT, async () => {
    console.log(`=================================================`);
    console.log(`FOXCELL WHATSAPP SERVER RODANDO NA PORTA ${PORT}`);
    console.log(`=================================================`);
    await restaurarSessaoRemota();
    iniciarWhatsApp();
});
