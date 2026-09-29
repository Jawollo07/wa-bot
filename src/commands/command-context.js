export function createCommandContext({ msg, text, groupId, senderId, settings, meta, prefix }) {
  return Object.freeze({
    msg,
    text: String(text || ''),
    groupId,
    senderId,
    settings,
    meta,
    prefix
  });
}
