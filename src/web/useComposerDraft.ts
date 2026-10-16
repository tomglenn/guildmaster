import { useCallback, useEffect, useSyncExternalStore, type SetStateAction } from 'react';
import { ComposerDrafts, type DraftContent, type DraftImage, type DraftPersistence } from './composer-drafts';

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('guildmaster-drafts', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'key' });
      request.result.createObjectStore('images', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Draft storage is busy.'));
  });
}
const browserPersistence: DraftPersistence = {
  async load(key) {
    const db = await openDatabase();
    return new Promise<DraftContent | undefined>((resolve, reject) => {
      const transaction = db.transaction(['drafts', 'images'], 'readonly');
      const request = transaction.objectStore('drafts').get(key);
      let result: DraftContent | undefined;
      const images: (DraftImage | undefined)[] = [];
      request.onsuccess = () => {
        const record = request.result as { text: string; imageIds: string[] } | undefined;
        if (!record) return;
        result = { text: record.text, images: [] };
        for (const [index, id] of record.imageIds.entries()) {
          const image = transaction.objectStore('images').get(id);
          image.onsuccess = () => { images[index] = image.result; };
        }
      };
      transaction.oncomplete = () => {
        if (result) result.images = images.filter((image): image is DraftImage => !!image);
        resolve(result);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  },
  async save(key, draft) {
    const db = await openDatabase();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['drafts', 'images'], 'readwrite');
      const drafts = transaction.objectStore('drafts'), images = transaction.objectStore('images');
      const request = drafts.get(key);
      request.onsuccess = () => {
        const previous = new Set<string>(request.result?.imageIds ?? []);
        const current = new Set(draft.images.map(image => image.id));
        for (const id of previous) if (!current.has(id)) images.delete(id);
        // Image bytes are written only when attachments change, not on each keystroke.
        for (const image of draft.images) if (!previous.has(image.id)) images.put(image);
        if (draft.text || draft.images.length) drafts.put({ key, text: draft.text, imageIds: [...current] });
        else drafts.delete(key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  },
};
export const composerDrafts = new ComposerDrafts(browserPersistence);

export default function useComposerDraft(key: string) {
  const subscribe = useCallback((listener: () => void) => composerDrafts.subscribe(key, listener), [key]);
  const snapshot = useCallback(() => composerDrafts.get(key), [key]);
  const draft = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => { void composerDrafts.load(key); }, [key]);
  const setText = useCallback((next: SetStateAction<string>) => composerDrafts.update(key, previous => ({ ...previous, text: typeof next === 'function' ? next(previous.text) : next })), [key]);
  const setImages = useCallback((next: SetStateAction<DraftImage[]>) => composerDrafts.update(key, previous => ({ ...previous, images: typeof next === 'function' ? next(previous.images) : next })), [key]);
  return { ...draft, setText, setImages };
}
