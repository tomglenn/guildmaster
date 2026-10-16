import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Connect, Plugin, ProxyOptions } from 'vite';
import { developmentConfig } from '../src/dev/config.ts';

function harness(env: NodeJS.ProcessEnv = {}) {
  const config = developmentConfig(env);
  const plugin = config.plugins![0] as Plugin;
  let middleware: Connect.NextHandleFunction;
  (plugin.configureServer as Function)({ middlewares: { use(handler: Connect.NextHandleFunction) { middleware = handler; } } });
  const proxy = new EventEmitter();
  const options = Object.values(config.server!.proxy!)[0] as ProxyOptions;
  options.configure!(proxy as any, options);
  function request(path: string, headers: Record<string, string>) {
    let status = 200, forwarded = false;
    const outgoing: Record<string, string> = {};
    const req = { url: path, headers } as any;
    const res = { writeHead(code: number) { status = code; }, end() {} } as any;
    middleware(req, res, () => {
      forwarded = true;
      proxy.emit('proxyReq', { setHeader(name: string, value: string) { outgoing[name] = value; } }, req);
    });
    return { status, forwarded, outgoing };
  }
  return { config, options, request };
}

test('development API proxy accepts local requests and preserves backend origin guards', () => {
  const { config, options, request } = harness();
  assert.equal(config.server!.host, '127.0.0.1');
  assert.equal(config.server!.strictPort, true);
  assert.equal(options.changeOrigin, true);
  assert.equal(options.target, 'http://127.0.0.1:4173');
  for (const host of ['127.0.0.1:5173', 'localhost:5173']) {
    const get = request('/api/bootstrap', { host });
    assert.deepEqual(get, { status: 200, forwarded: true, outgoing: {} });
    const post = request('/api/quests', { host, origin: `http://${host}` });
    assert.equal(post.forwarded, true);
    assert.equal(post.outgoing.Origin, 'http://127.0.0.1:4173');
    assert.equal(request('/api/events', { host }).forwarded, true);
  }
});

test('development API proxy rejects foreign hosts and origins before rewriting', () => {
  const { request } = harness();
  const foreignHeaders: Record<string, string>[] = [
    { host: 'evil.example:5173' },
    { host: '127.0.0.1:5174' },
    { host: '127.0.0.1:5173', origin: 'https://evil.example' },
    { host: '127.0.0.1:5173', origin: 'http://localhost:5174' },
    { host: '127.0.0.1:5173', origin: 'null' },
    { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173.evil.example' },
  ];
  for (const headers of foreignHeaders) {
    for (const path of ['/api/bootstrap', '/api/quests', '/api/events', '/api?test=1']) {
      assert.deepEqual(request(path, headers), { status: 403, forwarded: false, outgoing: {} });
    }
  }
});

test('development proxy supports configured ports and validates its local target', () => {
  const { config, options, request } = harness({ GUILDMASTER_DEV_PORT: '5312', GUILDMASTER_API_URL: 'http://localhost:4312' });
  assert.equal(config.server!.port, 5312);
  assert.equal(options.target, 'http://localhost:4312');
  assert.equal(request('/api/quests', { host: '127.0.0.1:5312', origin: 'http://127.0.0.1:5312' }).outgoing.Origin, 'http://localhost:4312');
  assert.equal(request('/api/quests', { host: '127.0.0.1:5173' }).status, 403);
  for (const port of ['0', '-1', '65536', '5173.5', 'bad']) assert.throws(() => developmentConfig({ GUILDMASTER_DEV_PORT: port }), /DEV_PORT/);
  for (const target of ['https://127.0.0.1:4173', 'http://evil.example', 'http://user:secret@localhost:4173', 'http://localhost:4173/api']) {
    assert.throws(() => developmentConfig({ GUILDMASTER_API_URL: target }), /API_URL/);
  }
});
