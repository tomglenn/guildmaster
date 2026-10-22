import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('.tsx') && ['./Icon', './SearchControl'].includes(specifier)) return next(`${specifier}.tsx`, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { default: BoardControls, HistoryFilterFields } = await import('../src/web/BoardControls.tsx');
hooks.deregister();
const base = { search: '', onSearch() {}, projectFilter: 'all', onProjectFilter() {}, projects: [] };

test('header shows removable History filters only when History filter props are present', () => {
  const inbox = renderToStaticMarkup(React.createElement(BoardControls, base));
  assert.doesNotMatch(inbox, /Outcome:|Closed:|Clear outcome filter|Clear closed date filter/);
  const history = renderToStaticMarkup(React.createElement(BoardControls, { ...base, historyFilters: { outcome: 'Accepted', closedDate: '30', onOutcome() {}, onClosedDate() {} } }));
  assert.match(history, /Outcome: Accepted/);
  assert.match(history, /Closed: Last 30 days/);
  assert.match(history, /aria-label="Clear outcome filter"/);
  assert.match(history, /aria-label="Clear closed date filter"/);
  const defaults = renderToStaticMarkup(React.createElement(BoardControls, { ...base, historyFilters: { outcome: 'all', closedDate: 'all', onOutcome() {}, onClosedDate() {} } }));
  assert.doesNotMatch(defaults, /Clear outcome filter|Clear closed date filter/);
});

test('project uses the same labeled dropdown styling and focus behavior as History filters', () => {
  const source = readFileSync(new URL('../src/web/BoardControls.tsx', import.meta.url), 'utf8');
  assert.match(source, /<label>Project<select value=\{projectFilter\} onChange=\{event => onProjectFilter\(event.target.value\)\}/);
  assert.match(source, /querySelector<HTMLSelectElement>\('\.board-filter-popover select'\)\?\.focus\(\)/);
  assert.doesNotMatch(source, /board-filter-options|board-history-filters/);
  assert.match(source, /className="board-filter-fields"/);
  assert.match(source, /No saved project/);
  assert.match(source, /Unavailable project<\/option>/);
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.board-filter-fields select\{/);
  assert.doesNotMatch(css, /\.board-filter-options/);
});

test('History popover fields expose selected values and route changes to their own filters', () => {
  let outcome = '', closedDate = '';
  const filters = { outcome: 'Closed', closedDate: '7', onOutcome(value: string) { outcome = value; }, onClosedDate(value: string) { closedDate = value; } };
  const html = renderToStaticMarkup(React.createElement(HistoryFilterFields, { filters }));
  assert.match(html, /Outcome<select/);
  assert.match(html, /Closed date<select/);
  assert.match(html, /selected="">Closed/);
  assert.match(html, /value="7" selected=""/);
  const fields = HistoryFilterFields({ filters });
  fields.props.children[0].props.children[1].props.onChange({ target: { value: 'Accepted' } });
  fields.props.children[1].props.children[1].props.onChange({ target: { value: '90' } });
  assert.equal(outcome, 'Accepted');
  assert.equal(closedDate, '90');
});
