import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Same JSX loader as sidebar.test.ts; SSR runs no effects, services, or paid requests.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/src/web/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
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
const { ImageGenerationSettingsForm } = await import('../src/web/ImageGenerationSettings.tsx');
const { default: ConversationImages, imageConceptLabel } = await import('../src/web/ConversationImages.tsx');
const { default: ImagePreview } = await import('../src/web/ImagePreview.tsx');
hooks.deregister();

const base = { id: 'image/one', name: 'concept.png', mimeType: 'image/png' as const, size: 512 };
const settings = { enabled: false, mock: true, model: 'gpt-image-1.5', configured: false, defaultQuality: 'auto' as const, defaultSize: 'auto' as const, maxOutputs: null, maxAttempts: 10 };
const form = (overrides = {}) => renderToStaticMarkup(React.createElement(ImageGenerationSettingsForm, { settings: { ...settings, ...overrides }, busy: false, onSave: async () => {} }));

test('image settings default to mock placeholders and separate API credentials', () => {
  const html = form();
  assert.match(html, /value="mock" selected=""/);
  assert.match(html, /Mock · test placeholders \(no paid API calls\)/);
  assert.match(html, /type="password"[^>]*value=""/);
  assert.match(html, /value="gpt-image-1.5" selected=""/);
  assert.equal((html.match(/value="gpt-image-/g) || []).length, 3);
  assert.doesNotMatch(html, /Output budget|Attempt budget|per exact user authorization|Default 1 image/);
  assert.doesNotMatch(html, /maximum 2 per call|at most 4 outputs|Fixed low quality/);
  assert.doesNotMatch(html, /No automatic retries|upstream cancellation|Codex subscription|Credentials stay/);
});

test('quality and size remain editable without budget fields or the explanatory footer', () => {
  const html = form();
  assert.equal((html.match(/value="auto" selected=""/g) || []).length, 2);
  for (const quality of ['low', 'medium', 'high']) assert.ok(html.includes(`value="${quality}"`));
  for (const size of ['1024x1024', '1536x1024', '1024x1536']) assert.ok(html.includes(`value="${size}"`));
  assert.match(html, /Your request can override these defaults/);
  assert.doesNotMatch(html, /budget|Unlimited|type="number"|dollar|upstream cancellation/i);
  assert.doesNotMatch(html, /<button class="button" disabled/);
  const custom = form({ defaultQuality: 'high', defaultSize: '1536x1024' });
  assert.match(custom, /value="high" selected=""/);
  assert.match(custom, /value="1536x1024" selected=""/);
});

test('saved credentials are indicated without displaying a key, and live requires a credential', () => {
  const configured = form({ configured: true });
  assert.match(configured, /Key saved · enter a replacement only/);
  assert.match(configured, /type="password"[^>]*value=""/);
  assert.doesNotMatch(configured, /sk-/);
  assert.match(form({ enabled: true, mock: false }), /<button class="button" disabled="">Save image settings/);
});

test('concept lineage labels preserve supplied ordering and do not label regular screenshots', () => {
  assert.equal(imageConceptLabel(base), undefined);
  assert.equal(imageConceptLabel({ ...base, mock: true, conceptIndex: 1 }), 'Mock placeholder 1');
  assert.equal(imageConceptLabel({ ...base, conceptIndex: 2, version: 3, parentImageId: 'old' }), 'Generated concept 2 · v3');
  const html = renderToStaticMarkup(React.createElement(ConversationImages, {
    questId: 'quest/one', images: [{ ...base, conceptIndex: 2, version: 3 }, { ...base, id: 'screenshot', name: 'Screenshot.png' }],
  }));
  assert.match(html, /\/api\/quests\/quest%2Fone\/images\/image%2Fone/);
  assert.match(html, /View Generated concept 2 · v3: concept.png/);
  assert.match(html, /View Screenshot.png/);
  assert.equal((html.match(/message-image-label/g) || []).length, 1);
  assert.ok(html.indexOf('Generated concept 2') < html.indexOf('Screenshot.png'));
  assert.doesNotMatch(html, /base64/);
});

test('shared full-size viewer provides download for durable and composer images', () => {
  for (const src of ['/api/quests/q/images/i', 'data:image/png;base64,AAAA']) {
    const html = renderToStaticMarkup(React.createElement(ImagePreview, { src, name: 'example.png', onClose() {} }));
    assert.match(html, /download="example.png"/);
    assert.match(html, /aria-label="Download example.png"/);
    assert.ok(html.includes(`href="${src}"`));
    assert.match(html, /aria-label="Close image"/);
  }
});
