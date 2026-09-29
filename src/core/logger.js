export default function log(...args) {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log('[' + timestamp + ']', ...args);
}
