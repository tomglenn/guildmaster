import test from 'node:test';
import assert from 'node:assert/strict';
import { latestMessageDirection, latestMessageTarget, observeLatestMessage } from '../src/web/latest-message.ts';
import { transcriptItems, visibleLive, type TranscriptMessage, type TranscriptRequest } from '../src/web/transcript-data.ts';

function harness() {
  let nodes: HTMLElement[] = [];
  const listeners = new Set<() => void>();
  const scroll = {
    scrollHeight: 1200, scrollTop: 0, clientHeight: 400, clientTop: 2,
    firstElementChild: {} as Element,
    querySelectorAll: () => nodes,
    getBoundingClientRect: () => ({ top: 100, bottom: 504 }),
    addEventListener: (_: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
  } as unknown as HTMLElement;
  const message = (id: string, top: number, bottom: number) => ({ dataset: { messageId: id }, getBoundingClientRect: () => ({ top, bottom }) }) as unknown as HTMLElement;
  return { scroll, message, setNodes: (next: HTMLElement[]) => { nodes = next; }, emitScroll: () => listeners.forEach(fn => fn()), listeners };
}

test('ready-for-review -> continued turns -> question -> answer -> new result uses rendered chronology, not saved result', () => {
  const h = harness();
  const messages: TranscriptMessage[] = [{ id: 'old-result', role: 'assistant', text: 'Ready', createdAt: 1 }];
  const requests: TranscriptRequest[] = [];
  const render = () => h.setNodes(transcriptItems(messages, requests).map(item => h.message(item.id, 600, 700)));
  render();
  assert.equal(latestMessageTarget(h.scroll)?.dataset.messageId, 'old-result');
  messages.push({ id: 'continue', role: 'user', text: 'More please', createdAt: 2 });
  messages.push({ id: 'commentary', role: 'assistant', text: 'New summary', createdAt: 3 });
  requests.push({ id: 'ask', question: 'Proceed?', status: 'pending', createdAt: 3 });
  render();
  assert.equal(latestMessageTarget(h.scroll)?.dataset.messageId, 'question:ask');
  h.scroll.scrollTop = 800;
  assert.equal(latestMessageDirection(h.scroll, latestMessageTarget(h.scroll)!), null);
  requests[0].status = 'answered';
  messages.push({ id: 'answer', role: 'user', text: 'Yes', createdAt: 4 });
  render();
  assert.equal(latestMessageTarget(h.scroll)?.dataset.messageId, 'answer');
  messages.push({ id: 'new-result', role: 'assistant', text: 'Done again', createdAt: 5 });
  render();
  assert.equal(latestMessageTarget(h.scroll)?.dataset.messageId, 'new-result');
});

test('viewport uses client bounds, hides on partial overlap and at rounded bottom', () => {
  const { scroll, message } = harness();
  assert.equal(latestMessageDirection(scroll, message('m', 502, 600)), 'below');
  assert.equal(latestMessageDirection(scroll, message('m', 501.5, 600)), null);
  assert.equal(latestMessageDirection(scroll, message('m', 0, 102)), 'above');
  assert.equal(latestMessageDirection(scroll, message('m', 0, 102.5)), null);
  assert.equal(latestMessageDirection(scroll, message('long', 0, 900)), null);
  scroll.scrollTop = 799.5;
  assert.equal(latestMessageDirection(scroll, message('historical', -500, -100)), null);
  scroll.scrollTop = 0; Object.assign(scroll, { scrollHeight: 300 });
  assert.equal(latestMessageDirection(scroll, message('m', -500, -100)), null);
});

test('streaming identity and saved replacement agree with rendered last message; operational rows have no target', () => {
  const h = harness();
  const saved: TranscriptMessage[] = [{ id: 'result', role: 'assistant', text: 'Old result', createdAt: 1 }];
  const live = { runId: 'next', messageId: 'stream', text: 'Writing' };
  const stream = visibleLive(saved, live, 'running', 'next')!;
  const node = h.message(stream.messageId, 600, 700);
  h.setNodes([h.message('result', -200, -100), node]);
  assert.equal(latestMessageTarget(h.scroll), node);
  saved.push({ id: 'stream', role: 'assistant', text: 'Writing done', createdAt: 2 });
  assert.equal(visibleLive(saved, live, 'running', 'next'), null);
  const replacement = h.message('stream', 600, 800);
  h.setNodes([h.message('result', -200, -100), replacement]);
  assert.equal(latestMessageTarget(h.scroll), replacement);
  h.setNodes([]);
  assert.equal(latestMessageTarget(h.scroll), undefined);
});

test('observers retarget after questions, same-ID stream replacement, quest switch and content/layout changes; cleanup detaches', () => {
  const h = harness();
  let resize!: () => void, mutate!: () => void;
  const observed = new Set<Element>();
  let disconnected = 0;
  const oldResize = globalThis.ResizeObserver, oldMutation = globalThis.MutationObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { resize = callback; }
    observe(node: Element) { observed.add(node); }
    unobserve(node: Element) { observed.delete(node); }
    disconnect() { observed.clear(); disconnected++; }
  } as unknown as typeof ResizeObserver;
  globalThis.MutationObserver = class {
    constructor(callback: () => void) { mutate = callback; }
    observe() {}
    disconnect() { disconnected++; }
  } as unknown as typeof MutationObserver;
  let cleanup: (() => void) | undefined;
  try {
    let direction: 'above' | 'below' | null = null;
    cleanup = observeLatestMessage(h.scroll, next => { direction = next; });
    const stream = h.message('stream', 600, 700);
    h.setNodes([stream]); mutate();
    assert.equal(direction, 'below'); assert.ok(observed.has(stream));
    const saved = h.message('stream', 300, 400);
    h.setNodes([saved]); mutate();
    assert.equal(direction, null); assert.ok(!observed.has(stream)); assert.ok(observed.has(saved));
    const question = h.message('question:new', 600, 700);
    h.setNodes([saved, question]); mutate();
    assert.equal(direction, 'below'); assert.ok(observed.has(question));
    // Composer growth / viewport resize and later content growth never scroll the reader.
    Object.assign(h.scroll, { clientHeight: 650 }); resize();
    assert.equal(direction, null); assert.equal(h.scroll.scrollTop, 0);
    Object.assign(h.scroll, { clientHeight: 400 }); resize();
    assert.equal(direction, 'below');
    h.scroll.scrollTop = 800; h.emitScroll(); assert.equal(direction, null);
    const oldContent = h.scroll.firstElementChild!;
    Object.defineProperty(h.scroll, 'firstElementChild', { value: {}, configurable: true });
    h.setNodes([]); mutate();
    assert.equal(direction, null); assert.ok(!observed.has(oldContent)); assert.ok(!observed.has(question));
    h.setNodes([h.message('other-quest', 0, 80)]); h.scroll.scrollTop = 100; mutate();
    assert.equal(direction, 'above');
    cleanup(); cleanup = undefined;
    assert.equal(disconnected, 2); assert.equal(h.listeners.size, 0);
  } finally {
    cleanup?.();
    globalThis.ResizeObserver = oldResize; globalThis.MutationObserver = oldMutation;
  }
});
