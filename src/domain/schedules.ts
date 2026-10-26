import type { WorkspacePolicy } from './types.ts';

export interface Recurrence { days: number[]; time: string; timezone: string }
export interface ScheduleConfig {
  name: string; objective: string; recurrence: Recurrence; missed: 'latest' | 'skip';
  projectId: string | null; repositoryIds?: string[]; workspacePolicy: WorkspacePolicy;
  model: string; tools: string[];
  modelDefaults?: import('./model-defaults.ts').ModelDefaults;
}
export interface QuestSchedule extends ScheduleConfig {
  id: string; revision: number; enabled: boolean; nextAt: number; createdAt: number; updatedAt: number;
}
export interface ScheduleOrigin { id: string; name: string; occurrenceId: string; scheduledAt: number; revision: number }
export interface ScheduleOccurrence {
  id: string; scheduleId: string; config: QuestSchedule; scheduledAt: number; createdAt: number;
  trigger: 'scheduled' | 'manual'; state: 'preparing' | 'launched' | 'skipped' | 'failed';
  questId?: string; reason?: string;
}
