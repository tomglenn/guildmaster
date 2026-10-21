import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HistoricalConversation } from '../src/web/GuildmasterHistory.tsx';

// Exercise the real history/transcript components, including attachment rendering.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('./') && context.parentURL?.includes('/src/web/')) {
      for (const extension of ['.tsx', '.ts']) {
        if (existsSync(new URL(specifier + extension, context.parentURL))) return next(specifier + extension, context);
      }
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
const { SavedConversation } = await import('../src/web/GuildmasterHistory.tsx');
hooks.deregister();

const detail: HistoricalConversation = {
  quest: { id: 'archived-main', status: 'cancelled' },
  messages: [
    { id: 'user', role: 'user', text: 'Summarize the issue', createdAt: 1, attachments: [{ id: 'attachment', name: 'context.png', mimeType: 'image/png', size: 20 }] },
    { id: 'answer', role: 'assistant', text: '[Source](https://github.com/org/repo/issues/1) — partial coverage. [Report](reports/summary.html)', createdAt: 4 },
  ],
  toolCalls: [
    { id: 'read', runId: 'run', tool: 'read_issue', detail: 'org/repo#1', status: 'completed', startedAt: 2, endedAt: 3, output: 'Source: https://github.com/org/repo/issues/1\nCoverage: 1 of 3 comment pages; partial.' },
    { id: 'comments', runId: 'run', tool: 'read_issue_comments', detail: 'org/repo#1 page 2', status: 'interrupted', startedAt: 3, endedAt: 4, output: 'Cancelled before all pages were read.' },
  ],
  events: [{ id: 'cancel', type: 'cancelled', detail: 'You cancelled this turn. Remote completion is unknown.', createdAt: 5 }],
  requests: [
    { id: 'own', questId: 'archived-main', question: 'Which issue?', status: 'answered', createdAt: 0 },
    { id: 'delegate', questId: 'other', question: 'Private delegate question', status: 'pending', createdAt: 0 },
  ],
};
const render = (value: HistoricalConversation) => renderToStaticMarkup(React.createElement(SavedConversation, { detail: value }));

test('archived main retains saved tool evidence, source/coverage and cancellation without accepted semantics', () => {
  const html = render(detail);
  assert.match(html, /Saved turn status: cancelled/);
  assert.match(html, /Read issue/);
  assert.match(html, /org\/repo#1 page 2/);
  assert.match(html, /aria-label="Completed"/);
  assert.match(html, /aria-label="Interrupted"/);
  assert.match(html, /aria-expanded="false" aria-controls="tool-output-read"/);
  assert.match(html, /href="https:\/\/github.com\/org\/repo\/issues\/1"/);
  assert.match(html, /partial coverage/);
  assert.match(html, /Saved activity/);
  assert.match(html, /You cancelled this turn. Remote completion is unknown./);
  assert.doesNotMatch(html, /Accepted|Resume|Writing…|Thinking…|Private delegate question/);
  assert.match(html, /Which issue\?/);

  // Evidence output is passed intact to the normal expandable tool renderer.
  const element = SavedConversation({ detail });
  const transcript = React.Children.toArray(element.props.children).find((child: any) => child.props?.assistantLabel === 'Guildmaster') as React.ReactElement<any>;
  assert.equal(transcript.props.toolCalls, detail.toolCalls);
  assert.equal(transcript.props.events, detail.events);
  assert.equal(transcript.props.toolCalls[0].output, detail.toolCalls![0].output);
  assert.equal(transcript.props.showToolCalls, true);
  assert.equal(transcript.props.status, 'cancelled');
});

test('historical attachments and report links retain their owning conversation context', () => {
  const html = render(detail);
  assert.match(html, /src="\/api\/quests\/archived-main\/images\/attachment"/);
  assert.match(html, /aria-label="View context.png"/);
  assert.match(html, /href="\/api\/quests\/archived-main\/files\/reports\/summary.html"/);
});

test('legacy history without optional evidence remains readable and preserves failure status', () => {
  const html = render({ quest: { id: 'legacy', status: 'failed', error: 'Source unavailable' }, messages: [{ id: 'old', role: 'assistant', text: 'Saved response', createdAt: 1 }] });
  assert.match(html, /Saved response/);
  assert.match(html, /Saved turn status: failed/);
  assert.match(html, /Source unavailable/);
  assert.doesNotMatch(html, /Saved activity|Accepted|Thinking…/);
});
