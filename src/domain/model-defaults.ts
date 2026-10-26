export type ModelPreference = 'coding' | 'writing' | 'review';
export interface ModelSelection { model: string; reasoning: string | null }
export interface ModelDefaults {
  revision: number;
  guildmaster: ModelSelection;
  quest: ModelSelection;
  delegate: ModelSelection;
  specialists: Partial<Record<ModelPreference, ModelSelection>>;
  guildmasterSelected?: boolean;
}
export interface ModelInfo {
  id: string; name: string; provider?: string; available?: boolean;
  reasoningLevels?: readonly string[]; input?: readonly string[];
}
export const MODEL_DEFAULTS_KEY = 'modelDefaults';
export const MODEL_PREFERENCES = ['coding', 'writing', 'review'] as const;
