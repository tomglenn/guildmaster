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
    if (context.parentURL?.endsWith('/SidebarQuest.tsx') && specifier === './Icon') {
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
  assert.match(app, /currentQuests = quests.filter\(q => !q.archivedAt\)/);
  assert.match(app, /currentQuests.length\} total/);
  assert.doesNotMatch(app, /sidebarWorking|sidebarStatus/);
});
