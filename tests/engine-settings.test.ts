import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineSettings } from '../src/engine/settings.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

test('provider setup persists app-owned credentials and model preferences without a Pi CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-settings-test-'));
  try {
    const settings = new EngineSettings(directory);
    const first = await settings.get();
    assert.ok(first.providers.some((provider) => provider.id === 'anthropic' && provider.authMethods.includes('api_key')));
    const saved = await settings.saveProvider({ providerId: 'anthropic', apiKey: 'fixture-secret-not-a-real-key' });
    assert.ok(saved.providers.find((provider) => provider.id === 'anthropic')?.configured);
    assert.ok(!JSON.stringify(saved).includes('fixture-secret-not-a-real-key'));
    assert.equal((await stat(join(settings.agentDir, 'auth.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(settings.agentDir)).mode & 0o777, 0o700);
    const model = saved.models.find((model) => model.provider === 'anthropic');
    assert.ok(model);
    await settings.savePreferences({ defaultModel: model.id });
    const restarted = new EngineSettings(directory);
    assert.equal(await restarted.getDefaultModel(), model.id);
    assert.ok((await restarted.get()).providers.find((provider) => provider.id === 'anthropic')?.configured);
    await restarted.removeProvider('anthropic');
    assert.ok(!JSON.parse(await readFile(join(settings.agentDir, 'auth.json'), 'utf8')).anthropic);
    await assert.rejects(settings.savePreferences({ defaultModel: 'imaginary/model' }), /configured provider/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('interactive provider setup handles prompts, secrets, completion, and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-login-test-'));
  try {
    const settings = new EngineSettings(directory);
    const started = await settings.startLogin('anthropic', 'api_key');
    const waitFor = async (id: string, status: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = settings.getLogin(id);
        if (state.status === status) return state;
        if (state.status === 'error') assert.fail(state.error);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`Sign-in did not reach ${status}`);
    };
    const waiting = await waitFor(started.id, 'waiting');
    assert.ok(waiting.prompt);
    settings.answerLogin(started.id, 'fixture-interactive-key');
    const complete = await waitFor(started.id, 'complete');
    assert.ok(!JSON.stringify(complete).includes('fixture-interactive-key'));
    assert.equal(complete.prompt, undefined);
    assert.equal(JSON.parse(await readFile(join(settings.agentDir, 'auth.json'), 'utf8')).anthropic.key, 'fixture-interactive-key');

    const cancelled = await settings.startLogin('anthropic', 'api_key');
    await waitFor(cancelled.id, 'waiting');
    assert.equal(settings.cancelLogin(cancelled.id).status, 'cancelled');
    assert.throws(() => settings.answerLogin(cancelled.id, 'anything'), /not waiting/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('explicit Pi import copies configuration without altering source or overwriting existing app keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-import-test-'));
  const piDirectory = join(directory, 'source-pi');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(piDirectory);
    const sourceAuth = JSON.stringify({ anthropic: { type: 'api_key', key: 'fixture-import-key' } });
    await writeFile(join(piDirectory, 'auth.json'), sourceAuth);
    await writeFile(join(piDirectory, 'models.json'), JSON.stringify({ providers: {} }));
    await writeFile(join(piDirectory, 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5', packages: ['do-not-copy-extension'] }));
    process.env.PI_CODING_AGENT_DIR = piDirectory;
    const settings = new EngineSettings(join(directory, 'app'));
    const before = await settings.get();
    assert.equal(before.canImportPi, true);
    assert.ok(!JSON.stringify(await readFile(join(settings.agentDir, 'auth.json'), 'utf8')).includes('fixture-import-key'));
    await settings.importPi();
    assert.equal(await readFile(join(piDirectory, 'auth.json'), 'utf8'), sourceAuth);
    assert.equal(await settings.getDefaultModel(), 'anthropic/claude-sonnet-4-5');
    assert.ok(!JSON.stringify(JSON.parse(await readFile(join(settings.agentDir, 'settings.json'), 'utf8'))).includes('do-not-copy-extension'));
    await settings.saveProvider({ providerId: 'anthropic', apiKey: 'fixture-existing-key' });
    await settings.importPi();
    assert.equal(JSON.parse(await readFile(join(settings.agentDir, 'auth.json'), 'utf8')).anthropic.key, 'fixture-existing-key');
    assert.equal(await readFile(join(piDirectory, 'auth.json'), 'utf8'), sourceAuth);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('late provider success cannot revive cancelled login and completed history stays bounded', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-login-race-test-'));
  const settings = new EngineSettings(directory);
  const pending: Array<{ resolve: (value: any) => void; interaction: Parameters<ModelRuntime['login']>[2] }> = [];
  context.mock.method(ModelRuntime.prototype, 'login', (_providerId: string, _type: string, interaction: Parameters<ModelRuntime['login']>[2]) =>
    new Promise((resolve) => { pending.push({ resolve, interaction }); }));
  try {
    const first = await settings.startLogin('anthropic', 'api_key');
    settings.cancelLogin(first.id);
    pending[0].interaction.notify({ type: 'progress', message: 'Late provider progress' });
    pending[0].resolve({ type: 'api_key', key: 'fixture-race-key' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settings.getLogin(first.id).status, 'cancelled');
    assert.equal(settings.getLogin(first.id).instructions, undefined);

    const second = await settings.startLogin('anthropic', 'api_key');
    // Starting a new flow must not erase a previous result being polled by a client.
    assert.equal(settings.getLogin(first.id).status, 'cancelled');
    settings.cancelLogin(second.id);
    for (let index = 0; index < 22; index++) {
      const next = await settings.startLogin('anthropic', 'api_key');
      settings.cancelLogin(next.id);
    }
    assert.throws(() => settings.getLogin(first.id), /not found/);
  } finally {
    settings.close();
    for (const item of pending) item.resolve({ type: 'api_key', key: 'fixture-race-key' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rm(directory, { recursive: true, force: true });
  }
});
