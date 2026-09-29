import { dbPool } from '../database/index.js';
import { getRuntimeSocket } from '../core/runtime.js';
import { sendText } from '../services/message-service.js';
import { logAction } from '../logging/index.js';

export const GROUP_COMMANDS=Object.freeze(['lock','unlock','toggle','maxwarns','setwelcome','setleave','settings']);

export async function dispatchGroupCommand(c){
 const {command,args,groupId,senderId,settings,prefix}=c, reply=t=>sendText(groupId,t), sock=getRuntimeSocket();
 if(command==='lock'||command==='unlock'){try{await sock.groupSettingUpdate(groupId,command==='lock'?'announcement':'not_announcement');await logAction(groupId,'group',command.toUpperCase(),'Manuell',senderId);await reply(command==='lock'?'🔒 *Gruppe gesperrt.*':'🔓 *Gruppe entsperrt.*');}catch(e){await reply('❌ '+command+' fehlgeschlagen: '+(e.message||e));}return true;}
 if(command==='toggle'&&args[1]){const map={links:'allow_links',stickers:'allow_stickers',images:'allow_images',videos:'allow_videos',audios:'allow_audios',antispam:'anti_spam',welcome:'welcome_active',ki:'allow_ki'};const field=map[args[1].toLowerCase()];if(!field){await reply('⚠️ Optionen: links, stickers, images, videos, audios, antispam, welcome, ki');return true;}const key=field.replace(/_([a-z])/g,(_,x)=>x.toUpperCase()),value=!settings[key];await dbPool.query('UPDATE group_settings SET '+field+'=? WHERE group_id=?',[value?1:0,groupId]);await logAction(groupId,'settings','TOGGLE',args[1]+' → '+(value?'ON':'OFF'),senderId);await reply('✅ *'+args[1]+'*: '+(value?'AN ✅':'AUS ❌'));return true;}
 if(command==='maxwarns'){const n=Number(args[1]);if(!Number.isInteger(n)||n<1||n>20){await reply('⚠️ Bitte Zahl 1–20 angeben.');return true;}await dbPool.query('UPDATE group_settings SET max_warnings=? WHERE group_id=?',[n,groupId]);await reply('✅ Max. Verwarnungen: *'+n+'*');return true;}
 if(command==='setwelcome'||command==='setleave'){const t=args.slice(1).join(' ').trim();if(!t){await reply('⚠️ Nutzung: '+prefix+command+' <Text>');return true;}const field=command==='setwelcome'?'welcome_msg':'leave_msg';await dbPool.query('UPDATE group_settings SET '+field+'=?, welcome_active=1 WHERE group_id=?',[t,groupId]);await logAction(groupId,'settings',command.toUpperCase(),t.slice(0,100),senderId);await reply('✅ Text gesetzt:\n'+t);return true;}
 if(command==='settings'){await reply('⚙️ *Gruppen-Einstellungen*\n\n• Status: '+(settings.isActive?'🟢':'🔴')+'\n• Willkommen: '+(settings.welcomeActive?'✅':'❌')+'\n• KI: '+(settings.allowKi?'✅':'❌')+'\n• Links: '+(settings.allowLinks?'✅':'❌')+' | Sticker: '+(settings.allowStickers?'✅':'❌')+'\n• Bilder: '+(settings.allowImages?'✅':'❌')+' | Videos: '+(settings.allowVideos?'✅':'❌')+'\n• Audio: '+(settings.allowAudios?'✅':'❌')+' | Anti-Spam: '+(settings.antiSpam?'✅':'❌')+'\n• Max. Verwarnungen: '+settings.maxWarnings);return true;}
 return false;
}
