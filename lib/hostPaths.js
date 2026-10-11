/** Host filesystem conventions, configured at build time for the adopter. */
function envOr(value, fallback) {
  return value && value.trim() ? value.trim() : fallback;
}
function stripSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '');
}
export function hostHome() {
  return envOr(process.env.NEXT_PUBLIC_HOST_HOME, '/home/user').replace(/\/+$/, '');
}
export function hostBrainDir() {
  return stripSlashes(envOr(process.env.NEXT_PUBLIC_HOST_BRAIN_DIR, 'brain'));
}
export function hostExchangeDir() {
  return stripSlashes(envOr(process.env.NEXT_PUBLIC_HOST_EXCHANGE_DIR, 'exchange'));
}
export function hostPrefix() {
  return `${hostHome()}/`;
}
export function scratchpadPath() {
  return envOr(process.env.NEXT_PUBLIC_SCRATCHPAD_PATH, `${hostHome()}/scratchpad.md`);
}
export function hostPathTokenRegex() {
  const escaped = hostHome().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:file://)?(?:${escaped}|~)/[^\\s<>"'` + '\\\\' + `]+`, 'g');
}
