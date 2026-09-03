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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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
const recentMessagesStore = new Map();

// Rastreio de mensagens enviadas pela API/Robô para saber diferenciar de quando o Alexandre digita no celular da loja
const botSentMessageIds = new Set();

// Mapa de conversas pausadas porque o Alexandre (humano) conversou com o cliente (remoteJid -> timestamp até quando silenciar)
const humanPausedUntil = new Map();
const PAUSA_HUMANA_MS = 2 * 60 * 60 * 1000; // 2 horas de silêncio para o robô quando o Alexandre fala com o cliente

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

    if (raw.endsWith("@lid")) return raw;
    if (raw.endsWith("@s.whatsapp.net")) {
        raw = raw.replace("@s.whatsapp.net", "");
    }

    let clean = raw.replace(/\D/g, "");
    if (!clean) return null;

    if (clean.length > 13) return `${clean}@lid`;

    if (clean.length === 10 || clean.length === 11) {
        clean = "55" + clean;
    }

    if (sock && connectionStatus === "conectado") {
        try {
            const r1 = await sock.onWhatsApp(clean);
            if (r1 && r1.length > 0 && r1[0].exists && r1[0].jid) {
                return r1[0].jid;
            }

            if (clean.startsWith("55") && clean.length === 13 && clean[4] === "9") {
                const sem9 = clean.slice(0, 4) + clean.slice(5);
                const r2 = await sock.onWhatsApp(sem9);
                if (r2 && r2.length > 0 && r2[0].exists && r2[0].jid) {
                    console.log(`[FOXCELL] JID ajustado (sem nono dígito): ${clean} -> ${r2[0].jid}`);
                    return r2[0].jid;
                }
            }

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

        // =========================================================================
        // ATENDIMENTO INTELIGENTE: PAUSA HUMANA DE 2 HORAS E AGROPAMENTO DE MENSAGENS
        // =========================================================================
        const pendingTimers = new Map();
        const pendingMessages = new Map();
        const DELAY_RESPOSTA_MS = 25000; // 25 segundos para esperar o cliente terminar de digitar e dar tempo do Alexandre responder no celular se quiser

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;

            for (const msg of messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.includes("@g.us") || remoteJid === "status@broadcast") {
                    continue;
                }

                // 1. SE FOI O NOSSO WHATSAPP QUE MANDOU A MENSAGEM (fromMe === true):
                if (msg.key.fromMe) {
                    // Se foi o próprio robô que disparou via API (/send-text, garantia, etc):
                    if (botSentMessageIds.has(msg.key.id)) {
                        botSentMessageIds.delete(msg.key.id);
                        continue;
                    }

                    // FOI O ALEXANDRE DIGITANDO MANUALMENTE NO CELULAR DA LOJA!
                    console.log(`[FOXCELL] 🛑 Atendente Alexandre mandou mensagem para ${remoteJid}! Agatha SILENCIADA para este cliente por 2 horas.`);

                    // Cancela qualquer resposta que a Agatha estava prestes a enviar
                    if (pendingTimers.has(remoteJid)) {
                        clearTimeout(pendingTimers.get(remoteJid));
                        pendingTimers.delete(remoteJid);
                    }
                    pendingMessages.delete(remoteJid);

                    // Silencia o robô para este contato por 2 horas
                    humanPausedUntil.set(remoteJid, Date.now() + PAUSA_HUMANA_MS);

                    // Avisa a HostGator para gravar na tabela sistema_whatsapp_pausas
                    try {
                        const phone = remoteJid.split("@")[0];
                        axios.post(WEBHOOK_URL, {
                            phone,
                            jid: remoteJid,
                            senderName: "Alexandre",
                            message: "[Atendente Humano Falou]",
                            fromMe: true,
                            isGroup: false
                        }, { timeout: 8000 }).catch(() => {});
                    } catch (e) {}

                    continue;
                }

                // 2. SE FOI UMA MENSAGEM RECEBIDA DO CLIENTE (fromMe === false):
                const text =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    "";

                if (!text || !text.trim()) continue;

                const textClean = text.trim().toLowerCase();

                // Se o cliente explicitamente chamar a Agatha por comando, encerra a pausa humana
                if (["agatha", "robô", "robo", "bot", "#menu", "menu"].includes(textClean)) {
                    humanPausedUntil.delete(remoteJid);
                    console.log(`[FOXCELL] 🤖 Cliente chamou a Agatha explicitamente: reativando robô para ${remoteJid}!`);
                }

                // Verifica se este contato está silenciado porque o Alexandre está conversando com ele
                const pausadoAte = humanPausedUntil.get(remoteJid) || 0;
                if (Date.now() < pausadoAte) {
                    const minRestantes = Math.round((pausadoAte - Date.now()) / 60000);
                    console.log(`[FOXCELL] 🤫 Mensagem de ${remoteJid} ignorada pelo robô pois o Alexandre está conversando com o cliente (${minRestantes} min restantes de pausa).`);
                    continue;
                }

                const senderName = msg.pushName || "Cliente";
                const phone = remoteJid.split("@")[0];

                // Acumula mensagens picadas do cliente para responder tudo de uma vez
                if (!pendingMessages.has(remoteJid)) {
                    pendingMessages.set(remoteJid, []);
                }
                pendingMessages.get(remoteJid).push(text.trim());

                // Reinicia o timer a cada nova mensagem para esperar o cliente terminar de falar
                if (pendingTimers.has(remoteJid)) {
                    clearTimeout(pendingTimers.get(remoteJid));
                }

                console.log(`[FOXCELL] ⏳ Mensagem de ${senderName} recebida. Aguardando ${DELAY_RESPOSTA_MS / 1000}s para dar tempo do Alexandre responder ou o cliente terminar de digitar...`);

                const timerId = setTimeout(async () => {
                    pendingTimers.delete(remoteJid);
                    const todasMensagens = pendingMessages.get(remoteJid) || [text];
                    pendingMessages.delete(remoteJid);

                    // Re-valida se o Alexandre não começou a falar nesse intervalo
                    if (Date.now() < (humanPausedUntil.get(remoteJid) || 0)) {
                        console.log(`[FOXCELL] Envio cancelado: Alexandre mandou mensagem.`);
                        return;
                    }

                    const textoFinal = todasMensagens.join("\n");

                    try {
                        console.log(`[FOXCELL] Enviando mensagem agrupada de ${senderName} para a Agatha na HostGator...`);
                        await axios.post(
                            WEBHOOK_URL,
                            {
                                phone,
                                jid: remoteJid,
                                senderName,
                                message: textoFinal,
                                fromMe: false,
                                isGroup: false
                            },
                            { 
                                headers: { "Content-Type": "application/json" },
                                timeout: 25000 
                            }
                        );
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
        pausasAtivas: humanPausedUntil.size,
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

// 4. Enviar Mensagem de Texto
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

        // Pré-aquecimento da sessão de criptografia
        try {
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate("composing", jid);
            await new Promise((r) => setTimeout(r, 400));
            await sock.sendPresenceUpdate("paused", jid);
        } catch (pErr) {}

        const sent = await sock.sendMessage(jid, { text: message });

        if (sent && sent.key && sent.key.id) {
            // Registra para o robô saber que FOI ELE QUEM MANDOU e não o Alexandre
            botSentMessageIds.add(sent.key.id);
            if (botSentMessageIds.size > 500) {
                const first = botSentMessageIds.values().next().value;
                botSentMessageIds.delete(first);
            }

            if (sent.message) {
                recentMessagesStore.set(sent.key.id, sent.message);
                if (recentMessagesStore.size > 300) {
                    const firstKey = recentMessagesStore.keys().next().value;
                    recentMessagesStore.delete(firstKey);
                }
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

        if (sent && sent.key && sent.key.id) {
            botSentMessageIds.add(sent.key.id);
            if (botSentMessageIds.size > 500) {
                const first = botSentMessageIds.values().next().value;
                botSentMessageIds.delete(first);
            }

            if (sent.message) {
                recentMessagesStore.set(sent.key.id, sent.message);
                if (recentMessagesStore.size > 300) {
                    const firstKey = recentMessagesStore.keys().next().value;
                    recentMessagesStore.delete(firstKey);
                }
            }
        }

        console.log(`[FOXCELL] Imagem enviada para ${jid}`);
        return res.json({ sucesso: true, mensagem: "Imagem enviada com sucesso", jid });
    } catch (err) {
        console.error("[FOXCELL] Erro ao enviar imagem:", err);
        return res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 6. Pausar / Despausar Manualmente um Cliente
app.post("/pause-chat", (req, res) => {
    const { phone, jid, hours = 2 } = req.body;
    const target = jid || phone;
    if (target) {
        humanPausedUntil.set(target, Date.now() + hours * 3600 * 1000);
        return res.json({ sucesso: true, mensagem: `Chat pausado por ${hours} horas` });
    }
    res.status(400).json({ sucesso: false, erro: "Telefone ou JID obrigatório" });
});

app.post("/unpause-chat", (req, res) => {
    const { phone, jid } = req.body;
    const target = jid || phone;
    if (target) {
        humanPausedUntil.delete(target);
        return res.json({ sucesso: true, mensagem: "Chat despausado" });
    }
    res.status(400).json({ sucesso: false, erro: "Telefone ou JID obrigatório" });
});

// 7. Desconectar
app.post("/disconnect", async (req, res) => {
    try {
        await limparSessao();
        agendarReconexao(1500);
        res.json({ sucesso: true, mensagem: "Desconectado e resetado com sucesso" });
    } catch (err) {
        res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// 8. Resetar Sessao
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

// Iniciar servidor e conexao
app.listen(PORT, async () => {
    console.log(`=================================================`);
    console.log(`FOXCELL WHATSAPP SERVER RODANDO NA PORTA ${PORT}`);
    console.log(`=================================================`);
    await restaurarSessaoRemota();
    iniciarWhatsApp();
});
