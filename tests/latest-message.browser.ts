// Optional real-browser regression: requires a production build and Playwright.
// GUILDMASTER_TEST_BUILD=/absolute/build PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs \
//   node --experimental-strip-types tests/latest-message.browser.ts
// Only synthetic quests in a temporary data directory; no real workers or service.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/service/server.ts';
import type { Quest } from '../src/domain/types.ts';

if (!process.env.GUILDMASTER_TEST_BUILD || !process.env.PLAYWRIGHT_MODULE) throw new Error('Set GUILDMASTER_TEST_BUILD and PLAYWRIGHT_MODULE.');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const directory = await mkdtemp(join(tmpdir(), 'guildmaster-latest-message-'));
const app = createApp({ dataDir: directory, port: 0, models: [], staticDir: resolve(process.env.GUILDMASTER_TEST_BUILD), defaultWorkspace: directory });
let browser: any;
try {
  const { url } = await app.listen();
  const quest: Quest = { id: 'navigation-fixture', title: 'Navigation fixture', objective: 'Synthetic scroll test', kind: 'quest', status: 'awaiting_review', workspaceMode: 'none', workspacePath: directory, model: '', tools: [], instructions: '', createdAt: Date.now(), updatedAt: Date.now(), sessionPath: '', result: 'Historical ready-for-review result', runCount: 1 };
  app.store.save(quest);
  for (let n = 0; n < 18; n++) app.store.message(quest.id, n % 2 ? 'assistant' : 'user', `History ${n}\n\n${'Synthetic history content. '.repeat(40)}`, `history-${n}`);
  app.store.message(quest.id, 'assistant', quest.result!, 'historical-result');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(url);
  await page.getByText('Navigation fixture', { exact: true }).first().click();
  const shortcut = page.locator('.latest-result-shortcut button');
  const scroll = page.locator('.quest-scroll');
  const settledAtBottom = async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('.quest-scroll')!;
      return el && el.scrollHeight - el.scrollTop - el.clientHeight <= 1 && !document.querySelector('.latest-result-shortcut button');
    }).catch(async (error: Error) => {
      console.error(await scroll.evaluate((el: HTMLElement) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, last: Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).at(-1)?.dataset.messageId, shortcut: document.querySelector('.latest-result-shortcut')?.textContent })));
      throw error;
    });
  };
  const inspectHistory = async () => {
    await scroll.hover();
    await page.mouse.wheel(0, -100000);
    await page.waitForFunction(() => document.querySelector('.quest-scroll')?.scrollTop === 0);
    await shortcut.waitFor({ state: 'visible' });
  };
  await settledAtBottom();
  // Continue a completed turn while the old result remains stored.
  app.store.message(quest.id, 'user', 'Continue the synthetic conversation', 'continue');
  app.store.message(quest.id, 'assistant', 'New lead summary\n\n' + 'New summary. '.repeat(150), 'new-summary');
  app.store.request({ id: 'new-question', questId: quest.id, runId: 'next', question: 'Synthetic question: proceed?', status: 'pending', createdAt: Date.now() + 1 });
  app.store.save({ ...quest, status: 'awaiting_input', activeRunId: 'next', runCount: 2 });
  app.service.changed(quest.id);
  await page.getByText('Synthetic question: proceed?', { exact: true }).waitFor();
  await settledAtBottom();
  await inspectHistory();
  assert.match(await shortcut.innerText(), /below/);
  await shortcut.click();
  await page.waitForFunction(() => (document.activeElement as HTMLElement)?.dataset.messageId === 'question:new-question');
  await settledAtBottom();
  console.log('PASS continued quest: bottom hidden; jump focuses newest question, not historical result');

  // Reader position stays fixed as incoming messages arrive; answered questions
  // stay in history and do not outrank the later result.
  await inspectHistory();
  app.store.request({ id: 'new-question', questId: quest.id, runId: 'next', question: 'Synthetic question: proceed?', status: 'answered', answer: 'Yes', answerMessageId: 'answer', createdAt: Date.now() - 1 });
  app.store.message(quest.id, 'user', 'Yes', 'answer');
  app.store.save({ ...quest, status: 'running', activeRunId: 'next', runCount: 2 });
  app.service.changed(quest.id);
  await page.locator('[data-message-id="answer"]').waitFor();
  await settledAtBottom(); // An outgoing answer resumes following.
  await inspectHistory();
  app.store.message(quest.id, 'assistant', 'Newest result', 'new-result');
  app.store.save({ ...quest, result: 'Newest result', runCount: 2 });
  app.service.changed(quest.id);
  await page.getByText('Newest result', { exact: true }).waitFor();
  await shortcut.waitFor({ state: 'visible' });
  assert.equal(await scroll.evaluate((el: HTMLElement) => el.scrollTop), 0);
  await shortcut.click();
  await page.waitForFunction(() => (document.activeElement as HTMLElement)?.dataset.messageId === 'new-result');
  await settledAtBottom();
  console.log('PASS incoming result preserves older reader position; jump focuses newest result');

  // Composer and window layout changes at the bottom do not resurrect the chip.
  await page.locator('textarea').fill('Draft\n'.repeat(15));
  await settledAtBottom();
  await page.setViewportSize({ width: 820, height: 620 });
  await settledAtBottom();
  await inspectHistory();
  const position = await scroll.evaluate((el: HTMLElement) => el.scrollTop);
  await page.setViewportSize({ width: 900, height: 680 });
  await shortcut.waitFor({ state: 'visible' });
  assert.equal(await scroll.evaluate((el: HTMLElement) => el.scrollTop), position);
  await shortcut.click();
  await settledAtBottom();
  console.log('PASS composer/window resizing preserves bottom following and older reader position');

  // Streaming nodes and saved nodes can have the same ID, including the retained
  // final stream between a live-clear event and its persisted snapshot.
  app.store.save({ ...quest, status: 'running', activeRunId: 'stream-run', runCount: 3 });
  app.service.changed(quest.id);
  // Exercise the real live snapshot + SSE path without launching a model worker.
  (app.service as any).updateLive(quest.id, 'stream-run', 'stream-message', 'Streaming latest content');
  await page.getByText('Streaming latest content', { exact: true }).waitFor();
  await settledAtBottom();
  await inspectHistory();
  await shortcut.click();
  await page.waitForFunction(() => (document.activeElement as HTMLElement)?.dataset.messageId === 'stream-message');
  app.store.message(quest.id, 'assistant', 'Streaming latest content saved', 'stream-message');
  (app.service as any).clearLive(quest.id);
  app.service.changed(quest.id);
  await page.getByText('Streaming latest content saved', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-message-id="stream-message"]').count(), 1);
  await settledAtBottom();
  console.log('PASS streaming -> saved replacement has one target and no stale shortcut');

  // Jump means the start of the newest message, not the transcript bottom:
  // a tall message remains readable from its start across resize callbacks.
  app.store.message(quest.id, 'assistant', 'Tall latest message\n\n' + 'Tall content paragraph.\n\n'.repeat(70), 'tall-latest');
  app.store.save({ ...quest, runCount: 3 });
  app.service.changed(quest.id);
  await page.locator('[data-message-id="tall-latest"]').waitFor();
  await inspectHistory();
  await shortcut.click();
  await page.waitForFunction(() => (document.activeElement as HTMLElement)?.dataset.messageId === 'tall-latest');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-message-id="tall-latest"]')!;
    return Math.abs(el.getBoundingClientRect().top - el.closest('.quest-scroll')!.getBoundingClientRect().top - parseFloat(getComputedStyle(el).scrollMarginTop)) <= 1;
  });
  const tallTop = await page.locator('[data-message-id="tall-latest"]').evaluate((el: HTMLElement) => el.getBoundingClientRect().top - el.closest('.quest-scroll')!.getBoundingClientRect().top);
  assert.ok(tallTop >= 0 && tallTop < 64, `Tall message should stay at its start, offset ${tallTop}`);
  assert.equal(await shortcut.count(), 0);
  await scroll.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await settledAtBottom();
  console.log('PASS tall-message jump keeps its start visible rather than snapping back to bottom');

  // A different quest must not retain the old observer/target.
  app.store.save({ ...quest, id: 'other-fixture', title: 'Other fixture', result: undefined });
  app.store.message('other-fixture', 'assistant', 'Other quest latest', 'other-latest');
  app.service.changed('other-fixture');
  await page.getByText('Other fixture', { exact: true }).first().click();
  await page.getByText('Other quest latest', { exact: true }).waitFor();
  await settledAtBottom();
  await page.getByText('Navigation fixture', { exact: true }).first().click();
  await page.getByText('Streaming latest content saved', { exact: true }).waitFor();
  await settledAtBottom();
  assert.deepEqual(errors, []);
  console.log('PASS quest navigation retargets cleanly; no browser errors');
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
