import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import { onIncomingMessage, onGroupParticipantsUpdate } from './message-handler.js';
import log, { logAction } from '../logging/index.js';
import { getPhoneNumber, getAuthDir } from '../config/runtime.js';
import { setSocket, markStarted } from '../core/runtime.js';
import { getParticipatingGroups, isCommunityGroup } from '../services/group-service.js';
import { getGroupSettings } from '../database/index.js';
const SYSTEM_GROUP = 'SYSTEM';

async function syncParticipatingGroups() {
    const groups = await getParticipatingGroups();
    let communityCount = 0;
    for (const meta of groups) {
        if (!meta?.id) continue;
        const settings = await getGroupSettings(meta.id);
        if (isCommunityGroup(meta)) communityCount++;
        log('👥 Gruppe erkannt: ' + (meta.subject || meta.id) + ' | aktiv=' + settings.isActive + (isCommunityGroup(meta) ? ' | Community' : ''));
    }
    log('👥 Gruppen-Sync abgeschlossen: ' + groups.length + ' Gruppen, davon ' + communityCount + ' Community-Gruppen.');
}
let sock;
let pairingRequested = false;
let botStartTime = 0;

export function getSocket() { return sock; }
export function getBotStartTime() { return botStartTime; }

export default async function startSocket() {
    const { state, saveCreds } = await useMultiFileAuthState(getAuthDir());
    let version;
    try {
        const v = await fetchLatestBaileysVersion();
        version = v.version;
        log('📦 WA-Version: ' + version.join('.'));
    } catch (_) {}

    sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
        logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' }),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });

    setSocket(sock);
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n📷 QR-Code (mit WhatsApp scannen):\n');
            qrcode.generate(qr, { small: true });
            if (!pairingRequested && getPhoneNumber()) {
                pairingRequested = true;
                try {
                    const code = await sock.requestPairingCode(getPhoneNumber());
                    console.log('\n🔑 DEIN KOPPLUNGSCODE: ' + code + '\n');
                } catch (e) { log('⚠️ Pairing-Code: ' + (e.message || e)); }
            }
        }
        if (connection === 'open') {
            botStartTime = Date.now();
            markStarted();
            log('🤖 Moderations-Bot v3.6.0 ist einsatzbereit!');
            await syncParticipatingGroups();
            await logAction(SYSTEM_GROUP, 'bot', 'CONNECTED', 'WhatsApp-Verbindung hergestellt', 'system');
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            log('🔌 Verbindung geschlossen. status=' + statusCode + ' reconnect=' + shouldReconnect);
            await logAction(SYSTEM_GROUP, 'bot', 'DISCONNECTED', 'status=' + statusCode + ' reconnect=' + shouldReconnect, 'system', { statusCode, shouldReconnect });
            if (shouldReconnect) setTimeout(() => startSocket().catch(e => console.error(e)), 3000);
            else {
                log('❌ Ausgeloggt – Auth-Ordner löschen und neu koppeln: ' + getAuthDir());
                await logAction(SYSTEM_GROUP, 'bot', 'LOGGED_OUT', 'Auth neu koppeln erforderlich', 'system');
            }
        }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) await onIncomingMessage(msg);
    });
    sock.ev.on('group-participants.update', onGroupParticipantsUpdate);
}
