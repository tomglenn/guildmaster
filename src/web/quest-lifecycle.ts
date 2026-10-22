export type Inbox = { included: boolean; group: 'input' | 'attention' | 'working'; label: string; since: number; pendingQuestions: number; active: number };
export type LifecycleQuest = { id: string; runCount: number; createdAt?: string | number; closedAt?: number; closeReason?: 'accepted' | 'closed' | 'legacy'; reopenedAt?: number; acceptance?: { acceptedAt: number; runCount: number; result?: string }; inbox?: Inbox };
// Absence of the projection is not a license to guess family state from the lead status.
export function inboxQuests<T extends LifecycleQuest>(quests: T[]): T[] {
  return quests.filter(q => q.inbox?.included).sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime() || a.id.localeCompare(b.id));
}
export function historyOutcome(quest: LifecycleQuest & { status?: string }): 'Accepted' | 'Closed' {
  // Legacy accepted status is retained evidence, not a newly invented acceptance record.
  return quest.closeReason === 'accepted' || quest.closeReason === 'legacy' && quest.status === 'accepted' ? 'Accepted' : 'Closed';
}
export function lifecycleBody(quest: LifecycleQuest, commandId: string, confirmCancel = false) {
  return { commandId, expectedRunCount: quest.runCount, ...(quest.closedAt !== undefined ? { expectedClosedAt: quest.closedAt } : {}), ...(confirmCancel ? { confirmCancel: true } : {}) };
}
export function viewFromUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  const draft = params.get('scheduleDraft');
  if (draft) return `schedule:draft:${draft}`;
  const quest = params.get('quest');
  if (quest) return quest;
  const schedule = params.get('schedule');
  if (schedule) return `schedule:${schedule}`;
  const view = params.get('view');
  return view === 'history' ? 'board' : ['guildmaster', 'board', 'settings', 'projects', 'schedules'].includes(view || '') ? view : null;
}
export function urlForView(next: string, current: string, historyTab = false): string {
  const url = new URL(current);
  for (const key of ['quest', 'view', 'schedule', 'scheduleDraft']) url.searchParams.delete(key);
  if (next.startsWith('schedule:draft:')) url.searchParams.set('scheduleDraft', next.slice(15));
  else if (next.startsWith('schedule:')) url.searchParams.set('schedule', next.slice(9));
  else if (['guildmaster', 'board', 'settings', 'projects', 'schedules'].includes(next)) url.searchParams.set('view', next === 'board' && historyTab ? 'history' : next);
  else url.searchParams.set('quest', next);
  return `${url.pathname}${url.search}${url.hash}`;
}
// Mutation acknowledgement and refresh are separate failure domains. Never report a
// committed close as failed merely because the following snapshot cannot be read.
export async function acknowledgedLifecycle<T>(mutate: () => Promise<T>, acknowledge: (response: T) => void, refresh: () => Promise<void>, refreshFailed: (error: unknown) => void): Promise<void> {
  const response = await mutate();
  acknowledge(response);
  try { await refresh(); } catch (error) { refreshFailed(error); }
}
export function shouldReturnHome(initiatingView: string, currentView: string, questId: string, initiatingNavigation: number, currentNavigation: number) {
  return initiatingView === questId && currentView === questId && initiatingNavigation === currentNavigation;
}
