import { dbPool, getCommunitySettings, setCommunitySetting, setCommunityEnabled, setGroupCommunityOverride } from '../database/index.js';
import { getRuntimeSocket } from '../core/runtime.js';
import { sendText } from '../services/message-service.js';
import { logAction } from '../logging/index.js';
import { getCommunityId, getGroupMeta } from '../services/group-service.js';
import { isParticipantAdmin } from '../core/utils.js';

export const GROUP_COMMANDS=Object.freeze(['lock','unlock','toggle','maxwarns','setwelcome','setleave','settings','community']);

export async function dispatchGroupCommand(c){
 const {command,args,groupId,senderId,settings,prefix}=c, reply=t=>sendText(groupId,t), sock=getRuntimeSocket();
 if(command==='community'){
   const meta = c.meta || await getGroupMeta(groupId);
   const communityId = getCommunityId(meta);
   if (!communityId) { await reply('ℹ️ Diese Gruppe gehört zu keiner erkannten WhatsApp-Community.'); return true; }
   const action = (args[1] || 'settings').toLowerCase();
   const communityMeta = await getGroupMeta(communityId);
   if (!isParticipantAdmin(communityMeta, senderId)) { await reply('⛔ Nur Community-Admins dürfen die Community-Regelung ändern.'); return true; }
   if (action === 'override') {
     const enabled = ['on','an','true','1'].includes((args[2] || '').toLowerCase());
     if (!args[2]) { await reply('⚠️ Nutzung: '+prefix+'community override on/off'); return true; }
     await setGroupCommunityOverride(groupId, enabled);
     await reply(enabled ? '🔧 Diese Gruppe nutzt jetzt eigene Einstellungen.' : '🔗 Diese Gruppe übernimmt wieder die Community-Regelung.');
     return true;
   }
   if (action === 'on' || action === 'off') {
     await setCommunityEnabled(communityId, action === 'on');
     await reply(action === 'on' ? '🟢 Community-Regelung aktiviert.' : '🔴 Community-Regelung deaktiviert.');
     return true;
   }
   const map = { links:'links', stickers:'stickers', images:'images', videos:'videos', audios:'audios', antispam:'antispam', ki:'ki', maxwarns:'maxwarns' };
   if (action === 'settings') {
     const s = await getCommunitySettings(communityId);
     await reply('🌐 *Community-Regelung*\\n\\n• Aktiv: '+(s.enabled?'✅':'❌')+'\\n• Links: '+(s.allowLinks===null?'Gruppenwert':s.allowLinks?'AN':'AUS')+'\\n• Sticker: '+(s.allowStickers===null?'Gruppenwert':s.allowStickers?'AN':'AUS')+'\\n• Bilder: '+(s.allowImages===null?'Gruppenwert':s.allowImages?'AN':'AUS')+'\\n• Videos: '+(s.allowVideos===null?'Gruppenwert':s.allowVideos?'AN':'AUS')+'\\n• Audios: '+(s.allowAudios===null?'Gruppenwert':s.allowAudios?'AN':'AUS')+'\\n• Anti-Spam: '+(s.antiSpam===null?'Gruppenwert':s.antiSpam?'AN':'AUS')+'\\n• Max. Warns: '+(s.maxWarnings===null?'Gruppenwert':s.maxWarnings)+'\\n• KI: '+(s.allowKi===null?'Gruppenwert':s.allowKi?'AN':'AUS'));
     return true;
   }
   if (map[action]) {
     const valueArg = (args[2] || '').toLowerCase();
     if (action === 'maxwarns') { const n = Number(args[2]); if (!Number.isInteger(n)||n<1||n>20) { await reply('⚠️ Max. Warns: 1–20.'); return true; } await setCommunitySetting(communityId, action, n); }
     else { if (!['on','off','an','aus','true','false','1','0'].includes(valueArg)) { await reply('⚠️ Nutzung: '+prefix+'community '+action+' on/off'); return true; } await setCommunitySetting(communityId, action, ['on','an','true','1'].includes(valueArg)?1:0); }
     await logAction(groupId,'community','SET_'+action, String(args[2]),senderId);
     await reply('✅ Community-Einstellung *'+action+'* gespeichert.');
     return true;
   }
   await reply('🌐 Nutzung: '+prefix+'community settings | on/off | links/stickers/images/videos/audios/antispam/ki on/off | maxwarns <1-20> | override on/off');
   return true;
 }
 if(command==='lock'||command==='unlock'){try{await sock.groupSettingUpdate(groupId,command==='lock'?'announcement':'not_announcement');await logAction(groupId,'group',command.toUpperCase(),'Manuell',senderId);await reply(command==='lock'?'🔒 *Gruppe gesperrt.*':'🔓 *Gruppe entsperrt.*');}catch(e){await reply('❌ '+command+' fehlgeschlagen: '+(e.message||e));}return true;}
 if(command==='toggle'&&args[1]){const map={links:'allow_links',stickers:'allow_stickers',images:'allow_images',videos:'allow_videos',audios:'allow_audios',antispam:'anti_spam',welcome:'welcome_active',ki:'allow_ki'};const field=map[args[1].toLowerCase()];if(!field){await reply('⚠️ Optionen: links, stickers, images, videos, audios, antispam, welcome, ki');return true;}const key=field.replace(/_([a-z])/g,(_,x)=>x.toUpperCase()),value=!settings[key];await dbPool.query('UPDATE group_settings SET '+field+'=? WHERE group_id=?',[value?1:0,groupId]);await logAction(groupId,'settings','TOGGLE',args[1]+' → '+(value?'ON':'OFF'),senderId);await reply('✅ *'+args[1]+'*: '+(value?'AN ✅':'AUS ❌'));return true;}
 if(command==='maxwarns'){const n=Number(args[1]);if(!Number.isInteger(n)||n<1||n>20){await reply('⚠️ Bitte Zahl 1–20 angeben.');return true;}await dbPool.query('UPDATE group_settings SET max_warnings=? WHERE group_id=?',[n,groupId]);await reply('✅ Max. Verwarnungen: *'+n+'*');return true;}
 if(command==='setwelcome'||command==='setleave'){const t=args.slice(1).join(' ').trim();if(!t){await reply('⚠️ Nutzung: '+prefix+command+' <Text>');return true;}const field=command==='setwelcome'?'welcome_msg':'leave_msg';await dbPool.query('UPDATE group_settings SET '+field+'=?, welcome_active=1 WHERE group_id=?',[t,groupId]);await logAction(groupId,'settings',command.toUpperCase(),t.slice(0,100),senderId);await reply('✅ Text gesetzt:\n'+t);return true;}
 if(command==='settings'){await reply('⚙️ *Gruppen-Einstellungen*\n\n• Status: '+(settings.isActive?'🟢':'🔴')+'\n• Willkommen: '+(settings.welcomeActive?'✅':'❌')+'\n• KI: '+(settings.allowKi?'✅':'❌')+'\n• Links: '+(settings.allowLinks?'✅':'❌')+' | Sticker: '+(settings.allowStickers?'✅':'❌')+'\n• Bilder: '+(settings.allowImages?'✅':'❌')+' | Videos: '+(settings.allowVideos?'✅':'❌')+'\n• Audio: '+(settings.allowAudios?'✅':'❌')+' | Anti-Spam: '+(settings.antiSpam?'✅':'❌')+'\n• Max. Verwarnungen: '+settings.maxWarnings);return true;}
 return false;
}
