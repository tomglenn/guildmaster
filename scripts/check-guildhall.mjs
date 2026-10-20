// Browser smoke checks against the production bundle and fixture APIs (no live service).
// npm run build; PLAYWRIGHT_MODULE=... BROWSER_EXECUTABLE=... node scripts/check-guildhall.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { richMarkdown, providerSettings, folderListing } from './guildhall-fixtures.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.guildmaster/guildhall-validation');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve('dist', `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(resolve('dist') + '/')) throw new Error('Outside build');
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png' })[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true });
const base = { kind: 'quest', workspaceMode: 'none', model: 'test/model', tools: [], runCount: 1, createdAt: 1792000000000, updatedAt: 1792000000000 };
const quests = [
  { ...base, id: 'review', title: 'End-user safety review of emberlight-app', objective: 'Independently assess product safety, architecture, and the details that matter. Preserve readable content beneath the parchment.', status: 'awaiting_review' },
  { ...base, id: 'build', title: 'Assess Guildmaster Apps: product, architecture, and security', objective: 'Provide an honest product and technical assessment grounded in the available project evidence.', status: 'running' },
  { ...base, id: 'docs', title: 'Improve documentation site', objective: 'Review current docs structure and propose improvements for clarity and searchability.', status: 'waiting' },
  { ...base, id: 'examples', title: 'Add example workflows', objective: 'Create practical examples for common agent workflows and include them in the docs.', status: 'accepted' },
];
const gm = { ...base, id: 'gm', kind: 'guildmaster', title: 'Guildmaster', status: 'completed' };
const projects = [
  { id: 'guild', name: 'Guildmaster', aliases: ['gm'], instructions: 'Keep technical output readable.', updatedAt: base.updatedAt, repositories: [{ id: 'repo', name: 'guildmaster', path: '/workspace/guildmaster', description: 'Agent orchestration and local developer tools.' }] },
  { id: 'ember', name: 'emberlight-app', aliases: [], instructions: '', updatedAt: base.updatedAt, repositories: [{ id: 'ember-repo', name: 'emberlight-app', path: '/workspace/emberlight-app', description: 'Main application for Emberlight.' }] },
  { id: 'docs', name: 'docs', aliases: [], instructions: '', archivedAt: base.updatedAt, updatedAt: base.updatedAt, repositories: [{ id: 'docs-repo', name: 'docs', path: '/workspace/docs', description: 'Documentation site and guides.' }] },
];
const plannerDay = new Date(); plannerDay.setUTCHours(8, 30, 0, 0);
const schedule = { id: 'morning', name: 'Morning briefing', objective: 'Review active quests and summarize the work that needs attention.', recurrence: { days: [1, 2, 3, 4, 5], time: '08:30', timezone: 'UTC' }, enabled: true, nextAt: plannerDay.getTime(), revision: 1, missed: 'latest', projectId: 'guild', repositoryIds: ['repo'], workspacePolicy: 'shared', tools: ['read'], model: 'test/model' };
const schedules = [schedule,
  { ...schedule, id: 'documentation', name: 'Documentation check', objective: 'Check for outdated docs and open review tasks.', nextAt: schedule.nextAt + 4 * 3600000 },
  { ...schedule, id: 'weekly', name: 'Weekly project review', objective: 'Summarize progress across all active projects.', nextAt: schedule.nextAt + 86400000 },
  { ...schedule, id: 'archive', name: 'Archive completed quests', objective: 'Move completed quests to the archive.', enabled: false, nextAt: schedule.nextAt + 6 * 86400000 },
];
const agent = { ...base, id: 'scribe', title: 'Verify repository changes', objective: 'Inspect and typecheck the implementation.', status: 'completed', activeRunId: 'fixture-run' };
const toolCalls = [{ id: 'tool1', runId: 'fixture-run', tool: 'bash', detail: 'npm run typecheck', status: 'completed', startedAt: base.createdAt + 1, endedAt: base.createdAt + 2, output: 'TypeScript check passed.\n0 errors.\nNo files were changed.' }];
let richContent = false;
let conversationState = 'completed';
let sent = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => { if (!localStorage.getItem('guildmaster:appearance')) localStorage.setItem('guildmaster:appearance', JSON.stringify({ theme: 'guildhall', textSize: 'default', motion: 'system' })); });
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    const fixtureGm = { ...gm, status: conversationState === 'question' ? 'waiting' : conversationState, activeRunId: 'live-fixture' };
    if (path === '/api/bootstrap') data = { quests, guildmaster: fixtureGm, projects, projectsSupported: true, models: [{ id: 'test/model', name: 'Test model' }], defaultModel: 'test/model', version: '0.1.0', dataDir: '/fixture', defaultWorkspace: '' };
    else if (path === '/api/events') { await route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }); return; }
    else if (path === '/api/guildmaster' && route.request().method() === 'POST') { sent.push(route.request().postDataJSON()); }
    else if (path.endsWith('/agents/scribe')) data = { quest: agent, requests: [], events: [], toolCalls, messages: [{ id: 'a1', role: 'assistant', text: 'The implementation passed verification. The tool record is below.', createdAt: base.createdAt }] };
    else if (path.startsWith('/api/quests/')) {
      const quest = quests.find(q => path.endsWith(q.id)) || fixtureGm;
      data = { quest, requests: conversationState === 'question' ? [{ id: 'question1', questId: quest.id, question: 'Which repository should receive this change?', status: 'pending', createdAt: base.createdAt + 10 }] : [], live: conversationState === 'running' ? { runId: 'live-fixture', messageId: 'live1', text: '### A live field note\nThe next section is arriving.\n\n```ts\nconst partial = "streaming' } : null, agents: [agent], events: [{ id: 'event1', type: 'verification', detail: 'Fixture: typecheck completed.', createdAt: base.createdAt }], toolCalls: [], messages: [
        { id: 'm1', role: 'user', text: 'Register the emberlight-app as a project.', createdAt: base.createdAt },
        { id: 'm2', role: 'assistant', text: richContent ? richMarkdown : '## A clear view of your work\nThe project is registered. Parchment should stay quiet behind the words, even in a long conversation.\n\n- Review the architecture and safety checks.\n- Preserve keyboard access and readable status labels.\n\n```typescript\nconst project = { name: "emberlight-app", ready: true };\nconsole.log(project);\n```\n\nThe changes are ready for your review. See [the project documentation](https://example.com).', createdAt: base.createdAt },
      ] };
    } else if (path === '/api/schedules') data = { schedules };
    else if (path === '/api/schedules/morning/history') data = { items: [
      { id: 'run1', state: 'launched', scheduledAt: base.createdAt, config: schedule, trigger: 'scheduled', quest: { ...quests[0], status: 'completed' } },
      { id: 'run2', state: 'failed', scheduledAt: base.createdAt, config: schedule, trigger: 'manual', reason: 'Fixture: provider unavailable' },
    ], total: 2 };
    else if (path === '/api/settings') data = providerSettings;
    else if (path === '/api/settings/connections') data = { connection: null, usesClaudeApp: true };
    else if (path === '/api/settings/storage') data = { retentionDays: null, archivedQuests: 2 };
    else if (path === '/api/folders') data = folderListing;
    await route.fulfill({ json: data });
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const screenshot = name => page.screenshot({ path: resolve(output, `${name}.png`), animations: 'disabled' });
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const restrainedFrames = async expected => {
    assert.equal(await page.locator('.sidebar').evaluate(e => getComputedStyle(e, '::before').borderImageWidth), `${expected}px`);
    assert.equal(await page.locator('.main-board').evaluate(e => getComputedStyle(e, '::before').content), 'none', 'Wood board has no brass perimeter');
  };
  await page.goto(url);
  await page.locator('.transcript .message').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.guildhall-crest').first().getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.markdown pre').first().evaluate(e => getComputedStyle(e).backgroundImage), 'none');
  await screenshot('chat-desktop');
  const sheetWidth = await page.locator('.sheet-tl').evaluate(e => e.getBoundingClientRect().width);
  await page.locator('.transcript').evaluate(e => {
    const message = e.querySelector('.message-assistant');
    for (let i = 0; i < 12; i++) { const copy = message.cloneNode(true); copy.classList.add('layout-stress-copy'); e.append(copy); }
  });
  await page.locator('.gm-scroll').evaluate(e => e.scrollTop = 500);
  assert.equal(await page.locator('.sheet-tl').evaluate(e => e.getBoundingClientRect().width), sheetWidth, 'Long transcript never resizes sheet corners');
  await screenshot('manuscript-long-scroll');
  await page.locator('.layout-stress-copy').evaluateAll(nodes => nodes.forEach(node => node.remove()));
  await page.setViewportSize({ width: 1273, height: 495 });
  await screenshot('chat-reference-size');
  assert.equal(await page.locator('.guildhall-sheet').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.sheet-tl').evaluate(e => Math.round(e.getBoundingClientRect().width)), 109);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A preserved draft');
  await screenshot('composer-focus');
  await page.getByRole('button', { name: 'Guildmaster model: Test model', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search models', exact: true }).fill('missing model');
  await page.getByText('No models match your search.', { exact: true }).waitFor();
  await screenshot('model-search-empty');
  await page.getByRole('textbox', { name: 'Search models', exact: true }).fill('Test');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('.model-picker-option').evaluate(e => e === document.activeElement), true);
  await screenshot('model-picker-keyboard');
  await page.keyboard.press('Escape');
  await page.getByLabel('Choose images', { exact: true }).setInputFiles('public/gm-avatar-dark.png');
  await page.getByRole('button', { name: 'View gm-avatar-dark.png', exact: true }).click();
  await page.getByRole('dialog', { name: 'gm-avatar-dark.png', exact: true }).waitFor();
  await screenshot('image-preview');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove gm-avatar-dark.png', exact: true }).click();
  await page.locator('.nav-item').filter({ hasText: 'Quest board' }).click();
  await page.locator('.quest-card').first().waitFor();
  assert.equal(await page.locator('.main').evaluate(e => e.classList.contains('main-board')), true);
  assert.equal(await page.locator('.guildhall-sheet').evaluate(e => getComputedStyle(e).display), 'grid');
  assert.match(await page.locator('.board > .quest-grid').evaluate(e => getComputedStyle(e, '::before').borderImageSource), /wooden-board\.webp/);
  assert.equal(await page.locator('.board > .quest-grid').evaluate(e => getComputedStyle(e, '::before').borderImageWidth), '34px', 'Board fittings keep a fixed scale');
  assert.ok(await page.locator('.board > .quest-grid').evaluate(e => e.clientHeight < document.querySelector('.board').clientHeight), 'Walnut inset sizes to actual notices');
  assert.equal(await page.locator('.quest-card').first().evaluate(e => getComputedStyle(e).color), 'rgb(44, 33, 23)');
  await restrainedFrames(9);
  await screenshot('board-desktop');
  const questSearch = page.getByRole('textbox', { name: 'Search quests', exact: true });
  await questSearch.fill('documentation');
  assert.equal(await page.locator('.quest-card').count(), 1);
  await page.getByRole('button', { name: 'Clear and close search', exact: true }).click();
  assert.equal(await questSearch.evaluate(e => e === document.activeElement), true, 'Persistent manuscript search returns focus after clearing');
  assert.equal(await page.locator('.quest-card').count(), 4);
  await page.getByRole('button', { name: 'New quest', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A preserved draft', 'New quest entry point never replaces an existing draft');
  await page.locator('.nav-item').filter({ hasText: 'Quest board' }).click();
  // Keep the header readable and its controls usable while the board scrolls.
  assert.equal(await page.getByRole('button', { name: 'Filter', exact: true }).evaluate(e => getComputedStyle(e).color), 'rgb(44, 33, 23)');
  assert.equal(await page.locator('.board .page-header-sticky').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.locator('.quest-grid').evaluate(e => e.style.paddingBottom = '1400px');
  await page.locator('.board').evaluate(e => e.scrollTop = 250);
  await page.waitForFunction(() => document.querySelector('.board').dataset.scrolled === 'true');
  await screenshot('board-scrolled');
  assert.equal(await page.getByRole('button', { name: 'Filter', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await screenshot('board-filter');
  await page.keyboard.press('Escape');
  await page.locator('.board').evaluate(e => e.scrollTop = 0);
  await page.locator('.quest-grid').evaluate(e => e.style.paddingBottom = '');
  // A contrasting backing exposes rectangular paper leaks that parchment-on-paper hides.
  const contrast = await page.addStyleTag({ content: ':root[data-theme="guildhall"] .main { background: #382b50; } :root[data-theme="guildhall"] .guildhall-sheet { visibility: hidden; }' });
  await page.locator('.quest-card').first().screenshot({ path: resolve(output, 'card-edge-contrast.png') });
  await contrast.evaluate(e => e.remove());
  for (const name of ['parchment-frame-1', 'parchment-frame-2', 'quest-card-main', 'brass-pin']) {
    const alpha = await page.evaluate(async name => {
      const image = new Image(); image.src = `/themes/guildhall/${name}.webp`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return [ctx.getImageData(0, 0, 1, 1).data[3], ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data[3]];
    }, name);
    assert.equal(alpha[0], 0, `${name} has transparent outside`);
    assert.ok(alpha[1] >= 245, `${name} has a near-opaque centre`);
  }
  assert.equal(await page.locator('.quest-card').first().evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('.quest-card').count(), 4);
  assert.equal(await page.locator('.quest-card .badge').first().textContent(), 'Ready for review');
  await page.locator('.quest-card-open').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('.quest-view').waitFor();
  await screenshot('quest-keyboard');
  await page.getByRole('button', { name: 'Quest info', exact: true }).click();
  await page.getByRole('dialog', { name: 'Quest info', exact: true }).waitFor();
  assert.equal(await page.locator('.sidebar').evaluate(e => e.inert), true);
  await screenshot('quest-info-activity');
  await page.locator('.quest-info').getByRole('button', { name: 'Details', exact: true }).click();
  await screenshot('quest-info-details');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sidebar').evaluate(e => e.inert), false);
  await page.getByRole('button', { name: /^Agents/ }).click();
  await page.locator('.agent-overview-row').waitFor();
  await screenshot('agent-register');
  await page.locator('.agent-overview-row').click();
  await page.locator('.conversation-tool-row').waitFor();
  await page.locator('.conversation-tool-row').click();
  await page.locator('.conversation-tool-output').waitFor();
  await screenshot('agent-tool-output');
  await page.locator('.nav-item').filter({ hasText: 'Guildmaster' }).click();
  assert.equal(await page.locator('.main').evaluate(e => e.classList.contains('main-board')), false);
  assert.equal(await page.locator('.guildhall-sheet').evaluate(e => getComputedStyle(e).display), 'grid');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A preserved draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  assert.equal(sent[0].message, 'A preserved draft');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('dialog', { name: 'Start a new conversation?', exact: true }).waitFor();
  await screenshot('conversation-confirmation');
  await page.keyboard.press('Escape');
  // Real page components, fictional fixture data: all four material identities
  // at the requested desktop viewports, not only the board.
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    for (const [label, material] of [['Guildmaster', 'manuscript'], ['Quest board', 'noticeboard'], ['Projects', 'ledger'], ['Schedules', 'planner']]) {
      await page.locator('.nav-item').filter({ hasText: label }).click();
      await page.waitForFunction(material => document.querySelector('.main').dataset.workspace === material, material);
      if (label === 'Schedules') {
        await page.locator('.schedule-card').first().waitFor();
        assert.deepEqual(await page.locator('.planner-group-heading').allTextContents(), ['Today', 'Tomorrow', 'Disabled']);
      }
      if (label === 'Projects') await page.locator('.project-directory-card').first().waitFor();
      assert.equal(await page.locator('.guildhall-sheet').evaluate(e => getComputedStyle(e).display), 'grid', 'Every workspace shares the manuscript');
      await noOverflow();
      assert.ok((await page.locator('.nav-item.active').innerText()).includes(label), 'Active navigation follows the workspace');
      if (material === 'ledger' || material === 'planner') {
        assert.equal(await page.locator('.quest-card').first().evaluate(e => getComputedStyle(e, '::after').content), 'none', 'Records are not pinned notices');
      }
      await screenshot(`${material}-${width}`);
    }
  }
  await page.locator('.schedule-card .schedule-menu > summary').first().click();
  await screenshot('planner-actions-menu');
  await page.keyboard.press('Escape');
  await page.locator('.schedule-card-open').first().click();
  await page.locator('.schedule-instruction-panel').waitFor();
  await screenshot('planner-detail');
  await page.getByRole('button', { name: /Run history/ }).click();
  await page.locator('.schedule-history-row').first().waitFor();
  assert.match(await page.locator('.schedule-history').textContent(), /Completed/);
  assert.match(await page.locator('.schedule-history').textContent(), /Launch failed/);
  await screenshot('planner-history');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).waitFor();
  await screenshot('planner-editor');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.nav-item').filter({ hasText: 'Projects' }).click();
  await page.getByRole('button', { name: 'Open project Guildmaster', exact: true }).click();
  await page.getByRole('button', { name: 'Configure guildmaster', exact: true }).waitFor();
  await screenshot('ledger-detail');
  await page.getByRole('button', { name: 'Configure guildmaster', exact: true }).click();
  await page.locator('.project-focus-editor').waitFor();
  await screenshot('ledger-editor');
  await page.getByRole('button', { name: 'Browse for local folder', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose a folder', exact: true }).waitFor();
  await page.getByLabel('Show hidden', { exact: true }).check();
  await page.getByRole('button', { name: 'Open guildmaster', exact: true }).waitFor();
  await screenshot('folder-browser');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Browse for local folder', exact: true }).evaluate(e => e === document.activeElement), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Providers', exact: true }).click();
  await screenshot('settings-providers');
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add provider', exact: true }).waitFor();
  await screenshot('provider-dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add connection', exact: true }).waitFor();
  await screenshot('connection-dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Storage', exact: true }).click();
  await page.locator('.storage-settings select').selectOption('30');
  await page.getByRole('button', { name: 'Save storage settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Enable permanent deletion?', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enable automatic deletion', exact: true }).evaluate(e => e.classList.contains('danger')), true);
  await screenshot('destructive-confirmation');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  for (const [label, theme] of [['Light', 'light'], ['Dark', 'dark'], ['Guildhall', 'guildhall']]) {
    await page.getByRole('radio', { name: label, exact: true }).check();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await screenshot(`settings-${theme}`);
  }
  // Saved/partial streams share the same crest and rich renderer; failure and questions keep their actions.
  await page.locator('.nav-item').filter({ hasText: 'Guildmaster' }).click();
  for (const state of ['running', 'failed', 'question']) {
    conversationState = state;
    await page.reload();
    if (state === 'running') {
      await page.locator('[data-message-id="live1"]').waitFor();
      assert.equal(await page.locator('[data-message-id="live1"] .guildhall-crest').count(), 1);
      await page.getByRole('button', { name: 'Stop Guildmaster', exact: true }).waitFor();
    } else if (state === 'failed') await page.getByRole('button', { name: 'Resume Guildmaster', exact: true }).waitFor();
    else await page.locator('.question-status').waitFor();
    await screenshot(`conversation-${state}`);
  }
  conversationState = 'completed';
  // Rich content uses the real renderer, safe React tokens and actual clipboard UI.
  richContent = true;
  const remoteImages = [];
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) remoteImages.push(request.url()); });
  await page.locator('.nav-item').filter({ hasText: 'Guildmaster' }).click();
  await page.reload();
  await page.getByRole('heading', { name: 'Field notes from the guild', exact: true }).waitFor();
  assert.equal(await page.locator('.markdown img').count(), 0, 'Agent Markdown images remain opt-in links');
  assert.deepEqual(remoteImages, []);
  assert.equal(await page.locator('.markdown .code-token-keyword').count() > 0, true);
  assert.equal(await page.locator('.markdown .code-token-inserted').count() > 0, true);
  assert.equal(await page.locator('.markdown .code-token-deleted').count() > 0, true);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const code = page.getByRole('region', { name: 'typescript code', exact: true });
  await page.getByRole('button', { name: 'Copy typescript code', exact: true }).click();
  await page.locator('.code-copy-status').filter({ hasText: /^Copied$/ }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await code.textContent());
  await page.locator('.code-block').first().screenshot({ path: resolve(output, 'code-typescript.png') });
  await page.getByRole('button', { name: 'Copy bash code', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.getByRole('region', { name: 'bash code', exact: true }).textContent(), 'Copy preserves entities, quotes and newlines exactly');
  await page.evaluate(() => {
    const original = navigator.clipboard.writeText;
    window.restoreFixtureClipboard = () => { navigator.clipboard.writeText = original; };
    navigator.clipboard.writeText = async () => { throw new Error('Fixture: clipboard denied'); };
  });
  await page.getByRole('button', { name: 'Copy diff code', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /Copy failed/ }).waitFor();
  await page.getByRole('button', { name: 'Copy diff code', exact: true }).locator('..').locator('..').screenshot({ path: resolve(output, 'code-diff-copy-failure.png') });
  await page.evaluate(() => window.restoreFixtureClipboard());
  await page.locator('.gm-scroll').evaluate(e => e.scrollTop = 0);
  await screenshot('rich-content-top');
  await page.locator('.markdown-table').screenshot({ path: resolve(output, 'markdown-ledger-table.png') });
  await page.locator('.markdown-table table').evaluate(e => e.style.minWidth = '1000px');
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow();
    assert.equal(await page.getByRole('region', { name: 'text code', exact: true }).evaluate(e => e.scrollWidth > e.clientWidth), true, 'Long code scrolls inside its insert');
    assert.equal(await page.locator('.markdown-table').evaluate(e => e.scrollWidth > e.clientWidth), true, 'Wide ledger tables scroll internally');
    await page.getByRole('region', { name: 'text code', exact: true }).focus();
    await screenshot(`rich-content-code-${width}`);
    await page.locator('.markdown-table').focus();
    await screenshot(`rich-content-table-${width}`);
  }
  richContent = false;
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'guildhall');
  await page.getByLabel('Text size', { exact: true }).selectOption('larger');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'true');
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.nav-item').filter({ hasText: 'Guildmaster' }).click();
    await page.locator('.transcript .message').first().waitFor();
    await noOverflow();
    assert.equal(await page.locator('.gm-header-actions').evaluate(e => e.getBoundingClientRect().right <= innerWidth), true, `Header actions fit at ${width}px`);
    await screenshot(`chat-${width}`);
    await page.locator('.nav-item').filter({ hasText: 'Quest board' }).click();
    await noOverflow();
    await restrainedFrames(width <= 650 ? 7 : 9);
    assert.equal(await page.getByRole('button', { name: 'Filter', exact: true }).evaluate(e => getComputedStyle(e).color), 'rgb(44, 33, 23)', `Board controls retain contrast at ${width}px`);
    await screenshot(`board-${width}`);
    for (const [label, material] of [['Projects', 'ledger'], ['Schedules', 'planner']]) {
      await page.locator('.nav-item').filter({ hasText: label }).click();
      await noOverflow();
      const controls = material === 'ledger' ? '.record-open' : '.record-schedule-actions button';
      await page.locator(controls).first().waitFor();
      assert.equal(await page.locator('.header-search input').evaluateAll(nodes => nodes.every(e => e.getBoundingClientRect().width >= 64)), true, `Search remains usable at ${width}px`);
      assert.equal(await page.locator(controls).evaluateAll(nodes => nodes.every(e => e.getBoundingClientRect().right <= innerWidth)), true, `Record actions fit at ${width}px`);
      await screenshot(`${material}-${width}`);
    }
    await page.locator('.nav-item').filter({ hasText: 'Quest board' }).click();
  }
  // Taller content and narrower cards must never resize the independent tack.
  const pin = await page.locator('.quest-card').first().evaluate(e => {
    const before = getComputedStyle(e, '::before'), pin = getComputedStyle(e, '::after');
    return { width: pin.width, height: pin.height, image: pin.backgroundImage, pointerEvents: pin.pointerEvents, paper: before.borderImageSource };
  });
  assert.equal(pin.width, '20px'); assert.equal(pin.height, '20px');
  assert.match(pin.image, /brass-pin\.webp/); assert.match(pin.paper, /quest-card-main\.webp/);
  assert.equal(pin.pointerEvents, 'none');
  await page.locator('.quest-card').first().evaluate(e => e.style.minHeight = '480px');
  assert.equal(await page.locator('.quest-card').first().evaluate(e => getComputedStyle(e, '::after').height), pin.height);
  await screenshot('board-tall-card');
  await page.locator('.quest-card').first().evaluate(e => e.style.minHeight = '');
  // 1440px desktop at 200% browser zoom has a 720 CSS-pixel layout viewport.
  await page.setViewportSize({ width: 720, height: 475 });
  await noOverflow(); await screenshot('board-zoom-equivalent');
  await page.emulateMedia({ forcedColors: 'active' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.main')).borderImageSource === 'none');
  await screenshot('board-forced-colors');
  assert.equal(await page.locator('.guildhall-sheet').evaluate(e => getComputedStyle(e).display), 'none');
  assert.equal(await page.locator('.quest-card').first().evaluate(e => getComputedStyle(e, '::before').display), 'none');
  assert.deepEqual(errors, []);
  const lightPage = await context.newPage();
  await lightPage.addInitScript(() => localStorage.setItem('guildmaster:appearance', JSON.stringify({ theme: 'light', textSize: 'default', motion: 'system' })));
  const themeRequests = [];
  lightPage.on('request', request => { if (request.url().includes('/themes/guildhall/')) themeRequests.push(request.url()); });
  await lightPage.goto(url);
  await lightPage.locator('.app-shell').waitFor();
  assert.equal(await lightPage.locator('html').getAttribute('data-theme'), 'light');
  await lightPage.locator('.nav-item').filter({ hasText: 'Guildmaster' }).click();
  await lightPage.locator('.transcript .message-assistant').first().waitFor();
  assert.deepEqual(themeRequests, [], 'Other themes do not request fantasy artwork');
  assert.equal(await lightPage.locator('.guildhall-crest').first().evaluate(e => getComputedStyle(e).display), 'none');
  assert.equal(await lightPage.locator('.guildhall-sheet').evaluate(e => getComputedStyle(e).display), 'none');
  await lightPage.locator('.nav-item').filter({ hasText: 'Schedules' }).click();
  await lightPage.locator('.schedule-card').first().waitFor();
  assert.equal(await lightPage.locator('.planner-group').count(), 1, 'Other themes retain their original schedule ordering');
  assert.equal(await lightPage.locator('.record-schedule-actions').first().isVisible(), false);
  assert.equal(await lightPage.getByRole('textbox', { name: 'Search schedules', exact: true }).isVisible(), false);
  await lightPage.getByRole('button', { name: 'Search', exact: true }).click();
  await lightPage.getByRole('textbox', { name: 'Search schedules', exact: true }).fill('missing schedule');
  await lightPage.getByRole('button', { name: 'Clear and close search', exact: true }).click();
  await lightPage.waitForFunction(() => document.activeElement?.classList.contains('search-toggle'));
  assert.equal(await lightPage.getByRole('button', { name: 'Search', exact: true }).evaluate(e => e === document.activeElement), true);
  console.log(`Browser smoke passed; screenshots: ${output}`);
  await context.close();
} finally { await browser.close(); await new Promise(done => server.close(done)); }
