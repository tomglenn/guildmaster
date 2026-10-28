import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { acknowledgedLifecycle } from '../src/web/quest-lifecycle.ts';

const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('/Halloween.tsx')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { celebrateHalloweenQuest } = await import('../src/web/Halloween.tsx');
hooks.deregister();

test('Halloween celebration is opt-in and follows successful acknowledgement, even if refresh fails', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const dataset = { theme: 'halloween', reducedMotion: 'false' };
  const events = new EventTarget();
  let flights = 0;
  events.addEventListener('guildmaster:halloween-quest-closed', () => flights++);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  try {
    await acknowledgedLifecycle(async () => ({}), celebrateHalloweenQuest, async () => { throw Error('Offline'); }, () => {});
    assert.equal(flights, 1);
    await assert.rejects(acknowledgedLifecycle(async () => { throw Error('Rejected'); }, celebrateHalloweenQuest, async () => {}, () => {}));
    assert.equal(flights, 1, 'Rejected commands must not celebrate');
    dataset.reducedMotion = 'true';
    celebrateHalloweenQuest();
    assert.equal(flights, 1, 'Reduced motion must suppress flights');
    dataset.reducedMotion = 'false';
    dataset.theme = 'dark';
    celebrateHalloweenQuest();
    assert.equal(flights, 1, 'Other themes must not celebrate');
  } finally {
    for (const [key, descriptor] of [['document', previousDocument], ['window', previousWindow]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
