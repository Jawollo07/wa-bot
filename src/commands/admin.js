import { dbPool, getGroupSettings } from '../database/index.js';
import { getStats, getStartedAt } from '../core/runtime.js';
import { getPrefix, getKiSettingsFromDb, formatConfigList, isKnownConfigKey, CONFIG_DEFAULTS, setConfig, reloadBotConfig } from '../config/runtime.js';
import { getKiConfig, applyKiConfig } from '../ki/index.js';
import { isBotOwner } from '../services/permission-service.js';
import { sendText } from '../services/message-service.js';
import { logAction } from '../logging/index.js';

export const ADMIN_COMMANDS = Object.freeze(['bot','ping','info','stats','logs','config','cfg','setconfig','setcfg','reloadconfig','reloadcfg','help']);
const uptime=()=>{const s=Math.floor((Date.now()-getStartedAt())/1000);return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m '+(s%60)+'s';};

export async function dispatchAdminCommand(c){
 const {command,args,groupId,senderId,settings,prefix}=c, reply=t=>sendText(groupId,t), stats=getStats();
 if(command==='bot'){const action=args[1]?.toLowerCase();if(action==='on'||action==='off'){const state=action==='on'?1:0;await dbPool.query('INSERT INTO group_settings (group_id,is_active,auto_activation_disabled) VALUES (?,?,?) ON DUPLICATE KEY UPDATE is_active=VALUES(is_active), auto_activation_disabled=VALUES(auto_activation_disabled)',[groupId,state,state?0:1]);await logAction(groupId,'bot',state?'BOT_ON':'BOT_OFF',null,senderId);await reply(state?'🟢 *Bot aktiviert!*':'🔴 *Bot deaktiviert!*');}else await reply('ℹ️ Status: *'+((await getGroupSettings(groupId)).isActive?'🟢 AKTIV':'🔴 INAKTIV')+'*\nGruppe: '+groupId);return true;}
 if(command==='ping'){const t=Date.now();await reply('🏓 Pong! ('+(Date.now()-t)+'ms) | Uptime: '+uptime());return true;}
 if(command==='info'){const ki=getKiConfig();await reply('🤖 *wa-bot v3.7.0*\n• Uptime: '+uptime()+'\n• Nachrichten: '+stats.messages+'\n• Verstöße: '+stats.violations+'\n• Befehle: '+stats.commands+'\n• Gruppe: '+(settings.isActive?'🟢 aktiv':'🔴 inaktiv')+'\n• KI: '+(ki.enabled?'✅ ('+ki.model+')':'❌ deaktiviert'));return true;}
 if(command==='stats'){const [w]=await dbPool.query('SELECT COUNT(*) c,COALESCE(SUM(warn_count),0) total FROM warnings WHERE group_id=?',[groupId]);const [m]=await dbPool.query('SELECT COUNT(*) c FROM muted_users WHERE group_id=?',[groupId]);const [l]=await dbPool.query('SELECT COUNT(*) c FROM mod_logs WHERE group_id=? AND created_at>DATE_SUB(NOW(),INTERVAL 24 HOUR)',[groupId]);await reply('📊 *Gruppen-Statistik*\n• Verwarnte User: '+w[0].c+'\n• Summe Verwarnungen: '+w[0].total+'\n• Stummgeschaltet: '+m[0].c+'\n• Mod-Aktionen (24h): '+l[0].c+'\n• Max. Warns: '+settings.maxWarnings);return true;}
 if(command==='logs'){const limit=Math.min(parseInt(args[1],10)||15,30);const [rows]=await dbPool.query('SELECT action,user_id,actor_id,reason,created_at FROM mod_logs WHERE group_id=? ORDER BY id DESC LIMIT ?',[groupId,limit]);await reply(rows.length?'📜 *Letzte '+rows.length+' Logs*\n'+rows.map(r=>'• '+(r.created_at?new Date(r.created_at).toISOString().slice(5,16).replace('T',' '):'?')+' *'+r.action+'* '+(r.user_id||'').split('@')[0].slice(-8)+(r.reason?' – '+r.reason.slice(0,40):'')).join('\n'):'📋 Keine Logs für diese Gruppe.');return true;}
 if(['config','cfg'].includes(command)){if(!isBotOwner(senderId)){await reply('⛔ Nur Bot-Owner dürfen die globale Config sehen.');return true;}await reply('⚙️ *Bot-Config*\n\n'+formatConfigList(false));return true;}
 if(['setconfig','setcfg'].includes(command)){if(!isBotOwner(senderId)){await reply('⛔ Nur Bot-Owner.');return true;}const key=(args[1]||'').toLowerCase(),value=args.slice(2).join(' ').trim();if(!key||!value||(!isKnownConfigKey(key)&&!(key in CONFIG_DEFAULTS))){await reply('⚠️ Ungültiger Config-Key oder Wert.');return true;}await setConfig(key,value);applyKiConfig(getKiSettingsFromDb());await logAction('SYSTEM','config','SET_CONFIG',key+'='+value.slice(0,120),senderId);await reply('✅ '+key+' = '+value.slice(0,200));return true;}
 if(['reloadconfig','reloadcfg'].includes(command)){if(!isBotOwner(senderId)){await reply('⛔ Nur Bot-Owner.');return true;}await reloadBotConfig();applyKiConfig(getKiSettingsFromDb());await reply('🔄 Config neu geladen. Prefix: '+getPrefix()+' · Modell: '+getKiConfig().model);return true;}
 if(command==='help'){await reply('🛠 *Admin-Befehle*\n\n• '+prefix+'bot on/off\n• '+prefix+'settings / stats / info / ping / logs\n• '+prefix+'toggle ...\n• '+prefix+'mute / unmute / muted\n• '+prefix+'ban / unban / banned\n• '+prefix+'kick\n• '+prefix+'warns / resetwarns / clearwarns');return true;}
 return false;
}
