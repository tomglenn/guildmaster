export type Appearance = {
  theme: 'system' | 'light' | 'dark' | 'cyberpunk' | 'guildhall';
  textSize: 'default' | 'large' | 'larger';
  motion: 'system' | 'reduced';
};
const key = 'guildmaster:appearance';
const defaults: Appearance = { theme: 'system', textSize: 'default', motion: 'system' };
function read(): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      theme: ['system', 'light', 'dark', 'cyberpunk', 'guildhall'].includes(value?.theme) ? value.theme : defaults.theme,
      textSize: ['default', 'large', 'larger'].includes(value?.textSize) ? value.textSize : defaults.textSize,
      motion: ['system', 'reduced'].includes(value?.motion) ? value.motion : defaults.motion,
    };
  } catch { return { ...defaults }; }
}
let current = read();
export const getAppearance = () => ({ ...current });
export function setAppearance(next: Appearance) {
  current = { ...next };
  try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Apply for this session when browser storage is unavailable. */ }
  window.dispatchEvent(new Event('guildmaster:appearance-changed'));
}
export function initializeAppearance() {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const apply = () => {
    const root = document.documentElement;
    root.dataset.theme = current.theme === 'system' ? dark.matches ? 'dark' : 'light' : current.theme;
    const icon = document.querySelector<HTMLLinkElement>('#app-icon');
    if (icon) icon.href = root.dataset.theme === 'light' ? '/gm-avatar-dark.png' : '/gm-avatar-light.png';
    root.dataset.textSize = current.textSize;
    root.dataset.reducedMotion = String(current.motion === 'reduced' || reduced.matches);
  };
  apply();
  dark.addEventListener('change', apply);
  reduced.addEventListener('change', apply);
  window.addEventListener('guildmaster:appearance-changed', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { current = read(); apply(); window.dispatchEvent(new Event('guildmaster:appearance-changed')); }
  });
}
