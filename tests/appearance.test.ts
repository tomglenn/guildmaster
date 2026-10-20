import assert from 'node:assert/strict';
import test from 'node:test';

const storageKey = 'guildmaster:appearance';

test('appearance persistence, normalization, and application', async t => {
  const saved = new Map<string, string>([[storageKey, JSON.stringify({ theme: 'guildhall', textSize: 'large', motion: 'reduced' })]]);
  let storageUnavailable = false;
  const storage = {
    getItem(key: string) { if (storageUnavailable) throw new Error('Storage unavailable'); return saved.get(key) ?? null; },
    setItem(key: string, value: string) { if (storageUnavailable) throw new Error('Storage unavailable'); saved.set(key, value); },
  };
  class Media extends EventTarget {
    matches: boolean;
    constructor(matches: boolean) { super(); this.matches = matches; }
    change(matches: boolean) { this.matches = matches; this.dispatchEvent(new Event('change')); }
  }
  const dark = new Media(true);
  const reduced = new Media(false);
  const windowMock = new EventTarget();
  const root = { dataset: {} as Record<string, string> };
  const icon = { href: '' };
  const globals = {
    localStorage: storage,
    window: windowMock,
    document: { documentElement: root, querySelector: () => icon },
    matchMedia: (query: string) => query === '(prefers-color-scheme: dark)' ? dark : reduced,
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const storageChanged = (key: string | null = storageKey) => {
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: key });
    windowMock.dispatchEvent(event);
  };
  try {
    const { getAppearance, setAppearance, initializeAppearance } = await import('../src/web/appearance.ts');
    initializeAppearance();

    await t.test('loads Guildhall and uses dark ink on its light main surface', () => {
      assert.deepEqual(getAppearance(), { theme: 'guildhall', textSize: 'large', motion: 'reduced' });
      assert.deepEqual(root.dataset, { theme: 'guildhall', textSize: 'large', reducedMotion: 'true' });
      assert.equal(icon.href, '/gm-avatar-dark.png');
      dark.change(false);
      dark.change(true);
      assert.equal(root.dataset.theme, 'guildhall');
      const copy = getAppearance();
      copy.theme = 'dark';
      assert.equal(getAppearance().theme, 'guildhall');
    });

    await t.test('preserves existing themes, text size, and system motion', () => {
      setAppearance({ theme: 'system', textSize: 'larger', motion: 'system' });
      assert.equal(root.dataset.theme, 'dark');
      assert.equal(icon.href, '/gm-avatar-light.png');
      assert.equal(root.dataset.textSize, 'larger');
      assert.equal(root.dataset.reducedMotion, 'false');
      dark.change(false);
      assert.equal(root.dataset.theme, 'light');
      reduced.change(true);
      assert.equal(root.dataset.reducedMotion, 'true');
      for (const theme of ['light', 'dark'] as const) {
        setAppearance({ theme, textSize: 'default', motion: 'system' });
        dark.change(theme !== 'dark');
        assert.equal(root.dataset.theme, theme);
        assert.equal(icon.href, theme === 'dark' ? '/gm-avatar-light.png' : '/gm-avatar-dark.png');
      }
      reduced.change(false);
    });

    await t.test('persists Guildhall and notifies subscribers immediately', () => {
      let notifications = 0;
      const changed = () => notifications++;
      windowMock.addEventListener('guildmaster:appearance-changed', changed);
      const next = { theme: 'guildhall', textSize: 'large', motion: 'reduced' } as const;
      setAppearance(next);
      assert.deepEqual(JSON.parse(saved.get(storageKey)!), next);
      assert.equal(root.dataset.theme, 'guildhall');
      assert.equal(icon.href, '/gm-avatar-dark.png');
      assert.equal(notifications, 1);
      windowMock.removeEventListener('guildmaster:appearance-changed', changed);
    });

    await t.test('normalizes stored values and syncs other tabs and storage clearing', () => {
      for (const value of ['null', '{bad json', JSON.stringify({ theme: 'unknown', textSize: 'huge', motion: 'full' })]) {
        saved.set(storageKey, value);
        storageChanged();
        assert.deepEqual(getAppearance(), { theme: 'system', textSize: 'default', motion: 'system' });
      }
      saved.set(storageKey, JSON.stringify({ theme: 'guildhall', textSize: 'larger', motion: 'system' }));
      storageChanged('unrelated');
      assert.equal(getAppearance().theme, 'system');
      storageChanged();
      assert.deepEqual(getAppearance(), { theme: 'guildhall', textSize: 'larger', motion: 'system' });
      assert.equal(root.dataset.theme, 'guildhall');
      saved.clear();
      storageChanged(null);
      assert.deepEqual(getAppearance(), { theme: 'system', textSize: 'default', motion: 'system' });
    });

    await t.test('applies session preferences even when browser storage is unavailable', () => {
      storageUnavailable = true;
      setAppearance({ theme: 'guildhall', textSize: 'large', motion: 'reduced' });
      assert.equal(root.dataset.theme, 'guildhall');
      assert.equal(root.dataset.reducedMotion, 'true');
      storageChanged();
      assert.deepEqual(getAppearance(), { theme: 'system', textSize: 'default', motion: 'system' });
    });
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
