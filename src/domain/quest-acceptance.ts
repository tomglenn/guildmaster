// Reopening changes inbox visibility, not the generation of the saved result.
// An accepted result can be accepted and closed again without starting a new run.
export function hasAcceptableResult(quest: {
  status: string; runCount: number; result?: string; reopenedAt?: number;
  acceptance?: { runCount: number; result?: string };
}) {
  if (quest.status === 'awaiting_review') return true;
  return quest.status === 'accepted' && quest.reopenedAt !== undefined && !!quest.result?.trim()
    && (!quest.acceptance || (quest.acceptance.runCount === quest.runCount
      && (quest.acceptance.result === undefined || quest.acceptance.result === quest.result)));
}
