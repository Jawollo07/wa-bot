import { ADMIN_COMMANDS, dispatchAdminCommand } from './admin.js';
import { GROUP_COMMANDS, dispatchGroupCommand } from './group.js';
import { MODERATION_COMMANDS, dispatchModerationCommand } from './moderation.js';

export const COMMAND_GROUPS = Object.freeze({
  admin: new Set(ADMIN_COMMANDS),
  group: new Set(GROUP_COMMANDS),
  moderation: new Set(MODERATION_COMMANDS),
});

export function getCommandName(text,prefix){
  const first=String(text||'').trim().split(/\s+/)[0].toLowerCase();
  return first.startsWith(prefix.toLowerCase()) ? first.slice(prefix.length) : '';
}
export function getCommandGroup(name){
  for(const [group,commands] of Object.entries(COMMAND_GROUPS)) if(commands.has(name)) return group;
  return null;
}
export function isRegisteredCommand(name){ return getCommandGroup(name)!==null; }

export async function dispatchCommand(context){
  const command=getCommandName(context.text,context.prefix);
  const group=getCommandGroup(command);
  if(!group) return false;
  const c={...context,command,args:String(context.text||'').trim().split(/\s+/).slice(1),mentions:context.mentions||[]};
  if(group==='admin') return dispatchAdminCommand(c);
  if(group==='group') return dispatchGroupCommand(c);
  if(group==='moderation') return dispatchModerationCommand(c);
  if(group==='ai') return (await import('./ai.js')).dispatchAiCommand(c);
  return false;
}
export { ADMIN_COMMANDS, GROUP_COMMANDS, MODERATION_COMMANDS };
export default dispatchCommand;
