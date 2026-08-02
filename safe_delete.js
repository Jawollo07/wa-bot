module.exports = async function safeDeleteMessage(client, msg, groupId, log = console.log) {

    // Chat öffnen, damit die Nachricht im Store landet
    try {
        if (client.interface && client.interface.openChatWindow) {
            await client.interface.openChatWindow(groupId);
            await new Promise(r => setTimeout(r, 400));
        }
    } catch (_) {}

    const idInfo = {
        serialized: (msg.id && msg.id._serialized) || null,
        id: (msg.id && msg.id.id) || null,
        remote: (msg.id && msg.id.remote) || groupId,
        fromMe: !!(msg.id && msg.id.fromMe),
        participant: (msg.id && msg.id.participant) || msg.author || null
    };

    // 1) Native API
    try {
        if (typeof msg.delete === 'function') {
            await msg.delete(true);
            log('🗑️ Nachricht gelöscht (native)');
            return true;
        }
    } catch (e) {
        log('⚠️ native delete: ' + (e.message || e));
    }

    // 2) Store – Nachricht suchen + diverse Delete-APIs
    if (client.pupPage) {
        try {
            const result = await client.pupPage.evaluate(async (info) => {
                const Store = window.Store;
                if (!Store) return { ok: false, err: 'no Store' };

                function findMsg() {
                    let m = null;
                    const Msg = Store.Msg;
                    if (Msg) {
                        if (info.serialized && Msg.get) m = Msg.get(info.serialized);
                        if (!m && info.id && Msg.get) m = Msg.get(info.id);
                        if (!m && Msg.getMessagesById && info.serialized) {
                            try {
                                const arr = Msg.getMessagesById([info.serialized]);
                                m = Array.isArray(arr) ? arr[0] : (arr && arr._models && arr._models[0]);
                            } catch (_) {}
                        }
                        if (!m && Msg.models) {
                            m = Msg.models.find(x =>
                                (x.id && x.id._serialized === info.serialized) ||
                                (x.id && x.id.id === info.id)
                            );
                        }
                    }
                    if (!m && Store.Chat) {
                        const chat = Store.Chat.get(info.remote) || (Store.Chat.find && Store.Chat.find(info.remote));
                        if (chat) {
                            const list = (chat.msgs && chat.msgs.getModelsArray && chat.msgs.getModelsArray())
                                || (chat.msgs && chat.msgs.models)
                                || [];
                            m = list.find(x =>
                                (x.id && x.id._serialized === info.serialized) ||
                                (x.id && x.id.id === info.id)
                            );
                        }
                    }
                    return m;
                }

                const m = findMsg();
                if (!m) return { ok: false, err: 'Msg not in Store' };

                try {
                    if (Store.Cmd && typeof Store.Cmd.sendDeleteMsgs === 'function') {
                        await Store.Cmd.sendDeleteMsgs(Store.Chat.get(info.remote) || m.id.remote, [m], true);
                        return { ok: true, via: 'Cmd.sendDeleteMsgs' };
                    }
                } catch (e) {}

                try {
                    if (Store.Cmd && typeof Store.Cmd.msgDelete === 'function') {
                        await Store.Cmd.msgDelete([m]);
                        return { ok: true, via: 'Cmd.msgDelete' };
                    }
                } catch (e) {}

                try {
                    if (Store.Msg && typeof Store.Msg.sendDelete === 'function') {
                        await Store.Msg.sendDelete(m);
                        return { ok: true, via: 'Msg.sendDelete' };
                    }
                } catch (e) {}

                try {
                    if (window.WWebJS && typeof window.WWebJS.sendDelete === 'function') {
                        await window.WWebJS.sendDelete(m);
                        return { ok: true, via: 'WWebJS.sendDelete' };
                    }
                } catch (e) {}

                try {
                    if (Store.Cmd && typeof Store.Cmd.sendRevokeMsgs === 'function') {
                        const chat = Store.Chat.get(info.remote);
                        await Store.Cmd.sendRevokeMsgs(chat, [m], true);
                        return { ok: true, via: 'Cmd.sendRevokeMsgs' };
                    }
                } catch (e) {}

                return { ok: false, err: 'No delete method worked' };
            }, idInfo);

            if (result && result.ok) {
                log('🗑️ Nachricht gelöscht (' + result.via + ')');
                return true;
            }
            log('⚠️ Store-delete: ' + (result && result.err));
        } catch (e) {
            log('⚠️ Store-evaluate: ' + (e.message || e));
        }
    }

    console.error('Löschen fehlgeschlagen – Bot braucht ggf. Gruppen-Admin-Rechte, oder WhatsApp blockiert die API.');
    return false;
};
