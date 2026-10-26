import { AppError } from '../domain/types.ts';
import { MODEL_DEFAULTS_KEY, MODEL_PREFERENCES, type ModelDefaults, type ModelSelection, type ModelInfo, type ModelPreference } from '../domain/model-defaults.ts';
import type { Store } from './store.ts';

export class ModelDefaultsStore {
  catalog?: ModelInfo[];
  private store: Store;
  constructor(store: Store) { this.store=store; }
  get() { return this.store.setting<ModelDefaults>(MODEL_DEFAULTS_KEY); }
  initialize(model: string) {
    if (!this.get()) {
      const selection = {model, reasoning:null};
      this.store.saveSetting(MODEL_DEFAULTS_KEY, {revision:1,guildmaster:selection,quest:selection,delegate:selection,specialists:{}});
    }
    const existing=this.get()!;
    if(model && [existing.guildmaster,existing.quest,existing.delegate].some(s=>!s.model)) {
      for(const role of ['guildmaster','quest','delegate'] as const)if(!existing[role].model)existing[role]={model,reasoning:null};
      existing.revision++;this.store.saveSetting(MODEL_DEFAULTS_KEY,existing);
    }
    return this.get()!;
  }
  validate(value: unknown): ModelSelection {
    const v=value as Partial<ModelSelection> | undefined;
    if (!v || typeof v.model!=='string' || v.model.length>250 || (v.reasoning!==null && typeof v.reasoning!=='string')) throw new AppError('Choose a model and a supported thinking setting.');
    if (this.catalog) {
      const model=this.catalog.find(m=>m.id===v.model && m.available!==false);
      if (!model) throw new AppError(`Model ${v.model || '(not selected)'} is unavailable. Connect its provider in Settings.`,409);
      if (v.reasoning!==null && !model.reasoningLevels?.includes(v.reasoning)) throw new AppError('This model does not support the selected thinking setting.',409);
    }
    return {model:v.model,reasoning:v.reasoning};
  }
  selection(role: 'guildmaster'|'quest'|'delegate', legacyModel='', preference?: unknown, snapshot?: ModelDefaults): ModelSelection {
    if (preference!==undefined && !MODEL_PREFERENCES.includes(preference as ModelPreference)) throw new AppError('Unknown model preference. Omit it for general work.');
    const defaults=snapshot ?? this.get();
    return this.validate(defaults ? (role==='delegate' && preference ? defaults.specialists[preference as ModelPreference] : undefined) ?? defaults[role] : {model:legacyModel,reasoning:null});
  }
  save(input: Record<string,any>) {
    const previous=this.get()!;
    if (input.revision!==previous.revision) throw new AppError('Model settings changed elsewhere. Reload before saving.',409);
    if (!input.specialists || typeof input.specialists!=='object' || Array.isArray(input.specialists) || Object.keys(input.specialists).some(k=>!MODEL_PREFERENCES.includes(k as ModelPreference))) throw new AppError('Invalid specialist model preferences.');
    const specialists: ModelDefaults['specialists']={};
    for (const key of MODEL_PREFERENCES) if (input.specialists[key]) specialists[key]=this.validate(input.specialists[key]);
    const next: ModelDefaults={revision:previous.revision+1,guildmaster:this.validate(input.guildmaster),quest:this.validate(input.quest),delegate:this.validate(input.delegate),specialists,guildmasterSelected:true};
    this.store.saveSetting(MODEL_DEFAULTS_KEY,next);return next;
  }
  selectGuildmaster(input: Record<string,any>) {
    const previous=this.get()!;
    // Browser-local migration is accepted only before the first explicit server selection.
    if (input.migrate && previous.guildmasterSelected) return previous;
    if (input.revision!==previous.revision) throw new AppError('The model choice changed elsewhere. Refresh and try again.',409);
    const selection=this.validate({model:input.model,reasoning:input.reasoning===undefined ? previous.guildmaster.reasoning : input.reasoning});
    const firstChoice=[previous.guildmaster,previous.quest,previous.delegate].every(value=>!value.model);
    const next={...previous,...(firstChoice?{quest:{...selection},delegate:{...selection}}:{}),revision:previous.revision+1,guildmaster:selection,guildmasterSelected:true};
    this.store.saveSetting(MODEL_DEFAULTS_KEY,next);return next;
  }
}
