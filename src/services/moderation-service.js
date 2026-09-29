/** Compatibility facade. New code should import from ./moderation/. */
export * from './moderation/index.js';
export { isSpamming } from './moderation/spam.js';
export { applyViolation } from './moderation/violations.js';
