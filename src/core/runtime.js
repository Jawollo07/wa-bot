let socket = null;
let database = null;
let startedAt = 0;

const stats = {
  messages: 0,
  violations: 0,
  commands: 0,
  profanityChecks: 0,
  profanityHits: 0,
  requests: 0,
  replies: 0,
  errors: 0,
  timeouts: 0,
  rateLimited: 0
};

export function setSocket(value) {
  socket = value;
}

export function getRuntimeSocket() {
  return socket;
}

export function setDatabase(value) {
  database = value;
}

export function getRuntimeDatabase() {
  if (!database) throw new Error('Database wurde noch nicht initialisiert');
  return database;
}

export function markStarted() {
  startedAt = Date.now();
}

export function getStartedAt() {
  return startedAt;
}

export function getStats() {
  return stats;
}

export function incrementStat(key, amount = 1) {
  if (key in stats) stats[key] += amount;
}

export function resetStats() {
  for (const key of Object.keys(stats)) stats[key] = 0;
}
