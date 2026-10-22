import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Node strips types but not JSX. Load the actual components without a second renderer.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if ((context.parentURL?.endsWith('/SidebarQuest.tsx') || context.parentURL?.endsWith('/QuestAcceptButton.tsx')) && specifier === './Icon') {
      return next('./Icon.tsx', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.tsx')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { default: SidebarQuest, sidebarStatuses } = await import('../src/web/SidebarQuest.tsx');
const { default: QuestAcceptButton } = await import('../src/web/QuestAcceptButton.tsx');
const { default: ClosureToast } = await import('../src/web/ClosureToast.tsx');
hooks.deregister();

const quest = { id: 'q1', title: 'Incremental re-review Pathfinder #2138: recovery retries and distinguishing details', status: 'running' as const, project: { name: 'Pathfinder' } };
const render = (status: keyof typeof sidebarStatuses, selected = false) => renderToStaticMarkup(React.createElement(SidebarQuest, { quest: { ...quest, status }, selected, onOpen() {} }));

test('sidebar uses accurate short labels, accessible descriptions and existing icons for every state', () => {
  const expected = { queued: 'Queued', running: 'Running', awaiting_input: 'Needs you', awaiting_review: 'Review', waiting: 'Waiting', accepted: 'Accepted', completed: 'Completed', interrupted: 'Interrupted', failed: 'Failed', cancelled: 'Cancelled' };
  for (const [status, label] of Object.entries(expected)) {
    const html = render(status as keyof typeof sidebarStatuses);
    assert.ok(html.includes(`status-${status}`));
    assert.ok(html.includes(`</svg>${label}</span>`));
    assert.match(html, /<svg[^>]+aria-hidden="true"/);
    assert.ok(html.includes(sidebarStatuses[status as keyof typeof sidebarStatuses].description));
    assert.doesNotMatch(html, /status-dot/);
  }
  assert.notEqual(sidebarStatuses.running.icon, sidebarStatuses.waiting.icon);
  assert.notEqual(sidebarStatuses.running.icon, sidebarStatuses.queued.icon);
  assert.match(render('awaiting_review'), /not yet accepted/);
  assert.doesNotMatch(render('queued'), /Paused|Interrupted/);
});

test('selection is exposed independently of status, and opening preserves quest navigation', () => {
  assert.match(render('running', true), /class="recent-quest active" aria-current="page"/);
  assert.doesNotMatch(render('running'), /aria-current/);
  let opened = '';
  const element = SidebarQuest({ quest, selected: false, onOpen: id => { opened = id; } });
  element.props.onClick();
  assert.equal(opened, quest.id);
});

test('full title and project remain accessible without hover popups', () => {
  const html = render('running');
  assert.ok(html.includes(`aria-label="${quest.title} — Pathfinder — Running"`));
  assert.ok(html.includes(`class="recent-quest-title">${quest.title}</span>`));
  assert.doesNotMatch(html, /\btitle=|tooltip/);
  assert.match(html, /class="recent-quest-project">Pathfinder/);
  const missingProject = renderToStaticMarkup(React.createElement(SidebarQuest, { quest: { ...quest, project: undefined, status: 'queued', queueReason: 'Waiting for workspace' }, selected: false, onOpen() {} }));
  assert.match(missingProject, /No saved project/);
  assert.match(missingProject, /Queued for execution: Waiting for workspace/);
});

test('authoritative family inbox label overrides lead execution status', () => {
  const html = renderToStaticMarkup(React.createElement(SidebarQuest, { quest: { ...quest, status: 'accepted', inbox: { label: 'Agent needs input', group: 'input' } }, selected: false, onOpen() {} }));
  assert.match(html, /Agent needs input/);
  assert.doesNotMatch(html, />Accepted</);
  assert.match(html, /aria-label="[^"‌]*Agent needs input/);
  const reopened = renderToStaticMarkup(React.createElement(SidebarQuest, { quest: { ...quest, inbox: { label: 'Reopened', group: 'attention' } }, selected: false, onOpen() {} }));
  assert.match(reopened, />Reopened</);
});

test('review uses the same colour across sidebar, cards and detail, with a document not a warning icon', () => {
  const html = renderToStaticMarkup(React.createElement(SidebarQuest, { quest: { ...quest, status: 'awaiting_review', inbox: { label: 'Ready for review', group: 'attention' } }, selected: false, onOpen() {} }));
  assert.match(html, />Review<\/span>/);
  assert.match(html, /Ready for review/);
  const legacy = render('awaiting_review');
  const svg = (markup: string) => markup.match(/<svg[\s\S]*?<\/svg>/)?.[0];
  assert.equal(svg(html), svg(legacy));
  assert.notEqual(svg(html), svg(render('failed')));
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.recent-quest \.status-awaiting_review\{color:var\(--warning\)\}/);
  assert.match(css, /\.badge\.status-awaiting_review[^}]*color:var\(--warning\)/);
  assert.match(css, /\.quest-card\[data-status="awaiting_review"\]\{--quest-accent:var\(--warning\)/);
});

test('accept-close button uses explicit lifecycle semantics without hydration celebration', () => {
  const html = renderToStaticMarkup(React.createElement(QuestAcceptButton, { disabled: false, onAccept: async () => {} }));
  assert.match(html, /Accept &amp; close/);
  assert.match(html, /Does not merge, publish, verify correctness, or delete files/);
  assert.doesNotMatch(html, /accept-celebrate|is-accepted/);
});

test('closure confirmation stays at the top right near the quest actions', () => {
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.closure-toast\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /position:fixed/);
  assert.match(rule, /(?:^|;)top:24px(?:;|$)/);
  assert.match(rule, /(?:^|;)right:24px(?:;|$)/);
  assert.doesNotMatch(rule, /(?:^|;)bottom:/);
});

test('closure confirmation exposes accessible View/Undo and contextual conflict without starting work', () => {
  const html = renderToStaticMarkup(React.createElement(ClosureToast, { notice: { quest: { id: 'q', runCount: 2, closedAt: 10, title: 'Review branch' }, message: 'Quest closed.', error: 'Could not reopen: newer closure' }, busy: false, onView() {}, onUndo() {}, onDismiss() {} }));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, />View</);
  assert.match(html, /aria-label="Undo close; return quest to inbox"/);
  assert.match(html, /role="alert">Could not reopen: newer closure/);
});

test('sidebar keeps compact layout, background selection and keyboard focus without accent borders', () => {
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.recent-quest-title\{[^}]*-webkit-line-clamp:2/);
  assert.match(css, /\.recent-quest-meta\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.recent-quest\.active\{[^}]*background:/);
  assert.doesNotMatch(css, /\.recent-quest(?:\.active)?\{[^}]*border-left/);
  assert.doesNotMatch(css, /recent-quest-tooltip/);
  assert.match(css, /\.recent-quest:focus-visible\{outline-offset:-2px/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.recent-quest\{transition:none/);
  const app = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /currentQuests = inboxQuests\(quests\)/);
  assert.doesNotMatch(app, /slice\(0, 12\)/);
  assert.doesNotMatch(app, /inbox-group|inboxSection/);
  assert.match(app, /currentQuests\.map\(q => <SidebarQuest/);
  assert.match(app, /currentQuests.length\} total/);
  assert.match(app, /<span>Active quests<\/span>/);
  assert.doesNotMatch(app, /<span>Your quests<\/span>|sidebarReview|className="nav-count"/);
  assert.doesNotMatch(app, /sidebarWorking|sidebarStatus/);
});
