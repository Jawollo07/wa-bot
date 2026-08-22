/**
 * Public command boundary.
 * The message layer only talks to this dispatcher; command domains stay isolated.
 */
import dispatchCommand, {
    getCommandName,
    getCommandGroup,
    isRegisteredCommand,
    COMMAND_GROUPS
} from './registry.js';

export { dispatchCommand, getCommandName, getCommandGroup, isRegisteredCommand, COMMAND_GROUPS };
export { ADMIN_COMMANDS, dispatchAdminCommand } from './admin.js';
export { GROUP_COMMANDS, dispatchGroupCommand } from './group.js';
export { MODERATION_COMMANDS, dispatchModerationCommand } from './moderation.js';
export { AI_COMMANDS, dispatchAiCommand } from './ai.js';

export default dispatchCommand;
