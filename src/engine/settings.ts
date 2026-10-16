import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';

type AuthType = Parameters<ModelRuntime['login']>[1];
type AuthPrompt = Parameters<Parameters<ModelRuntime['login']>[2]['prompt']>[0];
const LOGIN_RETENTION_MS = 10 * 60_000;
const MAX_FINISHED_LOGINS = 20;
const MAX_ACTIVE_LOGINS = 8;

export interface EngineSettingsView {
  providers: Array<{ id: string; name: string; configured: boolean; authMethods: string[] }>;
  models: Array<{ id: string; name: string; provider: string }>;
  defaultModel: string;
  providerError?: string;
  canImportPi: boolean;
}

export interface LoginState {
  id: string;
  providerId: string;
  status: 'working' | 'waiting' | 'complete' | 'error' | 'cancelled';
  prompt?: { type: 'text' | 'secret' | 'select' | 'manual_code'; message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] };
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  error?: string;
}

interface PendingLogin {
  state: LoginState;
  controller: AbortController;
  answer?: (value: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  finishedAt?: number;
}

async function jsonFile(path: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration object.');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Do not include parser errors: they can quote secret-bearing JSON text.
    throw new Error('A settings file could not be read. Check its JSON format and file permissions.');
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function runtimeOptions(agentDir: string) {
  return { authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json') };
}

/** App-owned settings. Pi is a library dependency; no Pi executable is needed. */
export class EngineSettings {
  readonly agentDir: string;
  private logins = new Map<string, PendingLogin>();
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.agentDir = join(dataDir, 'engine'); }

  private async prepare(): Promise<void> {
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    await chmod(this.agentDir, 0o700);
  }

  private async runtime(): Promise<ModelRuntime> {
    await this.prepare();
    return ModelRuntime.create(runtimeOptions(this.agentDir));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  async getDefaultModel(): Promise<string> {
    const settings = await jsonFile(join(this.agentDir, 'settings.json'));
    return typeof settings.defaultProvider === 'string' && typeof settings.defaultModel === 'string'
      ? `${settings.defaultProvider}/${settings.defaultModel}` : '';
  }

  async get(): Promise<EngineSettingsView> {
    const runtime = await this.runtime();
    const settings = await jsonFile(join(this.agentDir, 'settings.json'));
    const canImportPi = await access(join(getAgentDir(), 'auth.json')).then(() => true, () => false);
    return {
      providers: runtime.getProviders().map((provider) => ({
        id: provider.id, name: provider.name,
        configured: runtime.getProviderAuthStatus(provider.id).configured,
        authMethods: [
          ...(provider.auth.apiKey?.login ? ['api_key'] : []),
          ...(provider.auth.oauth ? ['oauth'] : []),
        ],
      })).sort((a, b) => a.name.localeCompare(b.name)),
      models: runtime.getAvailableSnapshot().map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      defaultModel: typeof settings.defaultProvider === 'string' && typeof settings.defaultModel === 'string'
        ? `${settings.defaultProvider}/${settings.defaultModel}` : '',
      ...(runtime.getError() ? { providerError: 'Provider configuration could not be loaded. Check the app’s engine settings and file permissions.' } : {}),
      canImportPi,
    };
  }

  async saveProvider(input: { providerId: string; apiKey: string }): Promise<EngineSettingsView> {
    if (typeof input.providerId !== 'string' || typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 16_384) {
      throw new Error('Choose a provider and enter an API key.');
    }
    return this.serialize(async () => {
      const runtime = await this.runtime();
      const provider = runtime.getProvider(input.providerId);
      if (!provider?.auth.apiKey?.login) throw new Error('This provider does not support API key setup. Use its sign-in option.');
      let consumed = false;
      try {
        await runtime.login(input.providerId, 'api_key', {
          signal: AbortSignal.timeout(30_000), notify: () => {},
          prompt: async (prompt) => {
            if (!consumed && (prompt.type === 'secret' || /api.?key|token/i.test(prompt.message))) {
              consumed = true;
              return input.apiKey.trim();
            }
            throw new Error('additional_setup');
          },
        });
      } catch {
        throw new Error('API key setup failed. This provider may require additional account settings; use the interactive sign-in flow.');
      }
      await chmod(join(this.agentDir, 'auth.json'), 0o600);
      return this.get();
    });
  }

  async savePreferences(input: { defaultModel: string }): Promise<EngineSettingsView> {
    if (typeof input.defaultModel !== 'string') throw new Error('Choose a default model.');
    return this.serialize(async () => {
      const runtime = await this.runtime();
      if (input.defaultModel && !runtime.getAvailableSnapshot().some((model) => `${model.provider}/${model.id}` === input.defaultModel)) {
        throw new Error('Choose a model from a configured provider.');
      }
      const separator = input.defaultModel.indexOf('/');
      await atomicJson(join(this.agentDir, 'settings.json'), input.defaultModel ? {
        defaultProvider: input.defaultModel.slice(0, separator), defaultModel: input.defaultModel.slice(separator + 1),
      } : {});
      return this.get();
    });
  }

  async removeProvider(providerId: string): Promise<EngineSettingsView> {
    return this.serialize(async () => {
      const runtime = await this.runtime();
      if (!runtime.getProvider(providerId)) throw new Error('Unknown provider.');
      for (const login of this.logins.values()) if (login.state.providerId === providerId) this.cancelLogin(login.state.id);
      await runtime.logout(providerId);
      return this.get();
    });
  }

  /** Explicit opt-in import. Keep existing app entries, never mutate Pi's files. */
  async importPi(): Promise<EngineSettingsView> {
    return this.serialize(async () => {
      await this.prepare();
      const source = getAgentDir();
      if (source === this.agentDir) throw new Error('The source and destination settings directories are the same.');
      const [auth, models, preferences] = await Promise.all([
        jsonFile(join(source, 'auth.json')), jsonFile(join(source, 'models.json')), jsonFile(join(source, 'settings.json')),
      ]);
      if (!Object.keys(auth).length && !Object.keys(models).length) throw new Error('No existing Pi credentials or model configuration were found.');
      // Interoperate with the SDK's auth.json.lock directory. Never replace a
      // credential while another process is refreshing it, or steal a held lock.
      const lockPath = join(this.agentDir, 'auth.json.lock');
      let locked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await mkdir(lockPath); locked = true; break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!locked) throw new Error('Credentials are in use. Retry the import after the active request finishes.');
      try {
        const current = await jsonFile(join(this.agentDir, 'auth.json'));
        await atomicJson(join(this.agentDir, 'auth.json'), { ...auth, ...current });
      } finally { await rm(lockPath, { recursive: true, force: true }); }
      const currentModels = await jsonFile(join(this.agentDir, 'models.json'));
      await atomicJson(join(this.agentDir, 'models.json'), { ...models, ...currentModels,
        providers: { ...(models.providers ?? {}), ...(currentModels.providers ?? {}) } });
      const currentPreferences = await jsonFile(join(this.agentDir, 'settings.json'));
      if (!currentPreferences.defaultModel && typeof preferences.defaultModel === 'string' && typeof preferences.defaultProvider === 'string') {
        await atomicJson(join(this.agentDir, 'settings.json'), {
          defaultModel: preferences.defaultModel, defaultProvider: preferences.defaultProvider,
        });
      }
      return this.get();
    });
  }

  async startLogin(providerId: string, authType: AuthType = 'oauth'): Promise<LoginState> {
    if (!['oauth', 'api_key'].includes(authType)) throw new Error('Unsupported sign-in method.');
    const runtime = await this.runtime();
    const provider = runtime.getProvider(providerId);
    if (!provider || !(authType === 'oauth' ? provider.auth.oauth : provider.auth.apiKey?.login)) throw new Error('This sign-in method is unavailable for the provider.');
    // Serialize the first installation ID write so concurrent provider logins use
    // the same stable device identity. Do this before registering a pending flow.
    const deviceId = await this.serialize(async () => {
      const installation = await jsonFile(join(this.agentDir, 'installation.json'));
      if (typeof installation.id === 'string') return installation.id;
      const id = randomUUID();
      await atomicJson(join(this.agentDir, 'installation.json'), { id });
      return id;
    });
    // No await between replacing an existing flow and registering its successor.
    for (const login of this.logins.values()) {
      if (login.state.providerId === providerId && ['working', 'waiting'].includes(login.state.status)) this.cancelLogin(login.state.id);
    }
    if ([...this.logins.values()].filter((login) => login.finishedAt === undefined).length >= MAX_ACTIVE_LOGINS) {
      throw new Error('Too many sign-in attempts are active. Finish or cancel one before starting another.');
    }
    const entry: PendingLogin = { state: { id: randomUUID(), providerId, status: 'working' }, controller: new AbortController() };
    this.logins.set(entry.state.id, entry);
    entry.timer = setTimeout(() => {
      this.finishLogin(entry, 'error', 'Sign-in expired. Start again.');
      entry.controller.abort();
    }, 10 * 60_000);
    entry.timer.unref();
    void runtime.login(providerId, authType, {
      signal: entry.controller.signal,
      notify: (event) => {
        if (entry.finishedAt !== undefined || entry.controller.signal.aborted) return;
        if (event.type === 'auth_url') { entry.state.url = event.url; entry.state.instructions = event.instructions; }
        if (event.type === 'device_code') {
          entry.state.userCode = event.userCode; entry.state.verificationUri = event.verificationUri;
          entry.state.url = event.verificationUri;
        }
        if (event.type === 'info' || event.type === 'progress') {
          entry.state.instructions = event.message;
          if (event.type === 'info' && event.links?.[0]) entry.state.url = event.links[0].url;
        }
      },
      prompt: (prompt) => this.waitForLoginInput(entry, prompt),
    }, { getDeviceId: () => deviceId }).then(async () => {
      if (entry.finishedAt !== undefined || entry.controller.signal.aborted) return;
      await chmod(join(this.agentDir, 'auth.json'), 0o600);
      // Cancellation can arrive while the permission operation is awaiting IO.
      if (!entry.controller.signal.aborted) this.finishLogin(entry, 'complete');
    }).catch(() => {
      this.finishLogin(entry, 'error', 'Sign-in failed. Check the provider account and try again.');
    }).finally(() => {
      delete entry.state.prompt;
      delete entry.answer;
    });
    return this.getLogin(entry.state.id);
  }

  private finishLogin(entry: PendingLogin, status: 'complete' | 'error' | 'cancelled', error?: string): void {
    // Terminal states are monotonic. A late provider result must never revive a
    // cancelled or expired attempt, nor replace its explanation.
    if (entry.finishedAt !== undefined) return;
    entry.finishedAt = Date.now();
    entry.state.status = status;
    if (error) entry.state.error = error;
    delete entry.state.prompt;
    delete entry.answer;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.logins.delete(entry.state.id), LOGIN_RETENTION_MS);
    entry.timer.unref();
    const finished = [...this.logins.values()].filter((login) => login.finishedAt !== undefined)
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const expired of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_LOGINS))) {
      clearTimeout(expired.timer);
      this.logins.delete(expired.state.id);
    }
  }

  private waitForLoginInput(entry: PendingLogin, prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal ? AbortSignal.any([entry.controller.signal, prompt.signal]) : entry.controller.signal;
    if (signal.aborted || entry.finishedAt !== undefined) return Promise.reject(new Error('Sign-in cancelled.'));
    const { signal: _signal, ...safePrompt } = prompt;
    entry.state.prompt = safePrompt;
    entry.state.status = 'waiting';
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener('abort', abort); delete entry.answer; delete entry.state.prompt; };
      const abort = () => { cleanup(); reject(new Error('Sign-in cancelled.')); };
      signal.addEventListener('abort', abort, { once: true });
      entry.answer = (answer) => { cleanup(); entry.state.status = 'working'; resolve(answer); };
    });
  }

  getLogin(id: string): LoginState {
    const entry = this.logins.get(id);
    if (!entry) throw new Error('Sign-in attempt not found. Start again if the service restarted.');
    return structuredClone(entry.state);
  }

  answerLogin(id: string, value: string): LoginState {
    const entry = this.logins.get(id);
    if (!entry?.answer || entry.state.status !== 'waiting') throw new Error('This sign-in attempt is not waiting for input.');
    if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw new Error('Enter the requested sign-in value.');
    if (entry.state.prompt?.type === 'select' && !entry.state.prompt.options?.some((option) => option.id === value)) throw new Error('Choose one of the listed options.');
    entry.answer(value.trim());
    return this.getLogin(id);
  }

  cancelLogin(id: string): LoginState {
    const entry = this.logins.get(id);
    if (!entry) throw new Error('Sign-in attempt not found.');
    if (['working', 'waiting'].includes(entry.state.status)) {
      this.finishLogin(entry, 'cancelled');
      entry.controller.abort();
    }
    return this.getLogin(id);
  }

  close(): void {
    for (const id of [...this.logins.keys()]) if (this.logins.has(id)) this.cancelLogin(id);
    for (const login of this.logins.values()) clearTimeout(login.timer);
  }
}
