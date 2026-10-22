import { hasAcceptableResult } from '../src/domain/quest-acceptance.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acknowledgedLifecycle, inboxQuests, historyOutcome, lifecycleBody, viewFromUrl, urlForView, shouldReturnHome, type LifecycleQuest } from '../src/web/quest-lifecycle.ts';
const item = (id: string, group: 'input' | 'attention' | 'working', since: number): LifecycleQuest => ({ id, runCount: 2, createdAt: since, inbox: { included: true, group, label: group, since, pendingQuestions: group === 'input' ? 3 : 0, active: group === 'working' ? 1 : 0 } });

test('family projection is authoritative; counts and newest-first order have no twelve-row cap', () => {
  const rows = Array.from({ length: 24 }, (_, i) => item(`working-${i}`, 'working', i));
  const input = item('question', 'input', 1000);
  const anomaly = { ...item('closed-anomaly', 'input', 10), closedAt: 5 };
  const excluded = { ...item('excluded', 'input', 0), inbox: { ...input.inbox!, included: false } };
  const result = inboxQuests([...rows, item('z', 'attention', 20), item('a', 'attention', 20), input, anomaly, excluded, { id: 'missing-projection', runCount: 1 }]);
  assert.equal(result.length, 28);
  assert.deepEqual(result.slice(0, 4).map(q => q.id), ['question', 'working-23', 'working-22', 'working-21']);
  assert.equal(result.filter(q => q.inbox!.group !== 'working').length, 4); // quests, not questions
  assert.equal(result.at(-1)!.id, 'working-0');
  assert.deepEqual(inboxQuests([...result].reverse()).map(q => q.id), result.map(q => q.id));
});

test('creation order stays fixed through status, question, result, close and reopen transitions', () => {
  const older = item('older', 'working', 100);
  const newer = item('newer', 'attention', 200);
  const ids = (quests: LifecycleQuest[]) => inboxQuests(quests).map(q => q.id);
  assert.deepEqual(ids([older, newer]), ['newer', 'older']);
  for (const group of ['input', 'attention', 'working'] as const) {
    assert.deepEqual(ids([{ ...older, inbox: { ...older.inbox!, group, since: 9999, label: 'New result or question' } }, newer]), ['newer', 'older']);
  }
  assert.deepEqual(ids([{ ...older, inbox: { ...older.inbox!, included: false } }, newer]), ['newer']);
  assert.deepEqual(ids([{ ...older, reopenedAt: 9999 }, newer]), ['newer', 'older']);
  assert.deepEqual(ids([older, newer, item('latest', 'working', 300)]), ['latest', 'newer', 'older']);
  // Legacy records without a creation date never fall back to mutable attention timestamps.
  assert.deepEqual(ids([{ ...older, createdAt: undefined, inbox: { ...older.inbox!, since: 99999 } }, newer]), ['newer', 'older']);
});

test('reopened current results can be accepted without asking the lead for another result', () => {
  assert.equal(hasAcceptableResult({status:'awaiting_review',runCount:2,reopenedAt:10,result:'saved'}),true);
  assert.equal(hasAcceptableResult({status:'accepted',runCount:2,reopenedAt:10,result:'saved',acceptance:{runCount:2,result:'saved'}}),true);
  assert.equal(hasAcceptableResult({status:'accepted',runCount:3,reopenedAt:10,result:'saved',acceptance:{runCount:2,result:'saved'}}),false);
  assert.equal(hasAcceptableResult({status:'cancelled',runCount:3,reopenedAt:10,result:'older result'}),false);
  const app = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /hasAcceptableResult\(current\) && <QuestAcceptButton/);
  assert.doesNotMatch(app, /hasAcceptableResult\(q\) && <QuestAcceptButton/);
});

test('history outcome does not infer human acceptance from retained execution state', () => {
  assert.equal(historyOutcome({ id: 'a', runCount: 3, closeReason: 'accepted' }), 'Accepted');
  assert.equal(historyOutcome({ id: 'a', runCount: 3, closeReason: 'legacy', status: 'accepted' }), 'Accepted');
  assert.equal(historyOutcome({ id: 'a', runCount: 3, closeReason: 'closed', status: 'accepted' }), 'Closed');
  for (const closeReason of ['closed', 'legacy', undefined] as const) assert.equal(historyOutcome({ id: 'a', runCount: 3, closeReason, acceptance: { acceptedAt: 1, runCount: 1 } }), 'Closed');
});

test('close, reopen and undo include optimistic run and closure guards', () => {
  assert.deepEqual(lifecycleBody({ id: 'a', runCount: 4 }, 'cmd'), { commandId: 'cmd', expectedRunCount: 4 });
  assert.deepEqual(lifecycleBody({ id: 'a', runCount: 4, closedAt: 123 }, 'undo'), { commandId: 'undo', expectedRunCount: 4, expectedClosedAt: 123 });
  assert.equal(lifecycleBody({ id: 'a', runCount: 5 }, 'close', true).confirmCancel, true);
});

test('quest/history/schedule navigation round trips; unrelated parameters survive', () => {
  const base = 'http://localhost/?unrelated=keep&scheduleDraft=old';
  for (const view of ['guildmaster', 'board', 'settings', 'projects', 'schedules', 'schedule:abc', 'schedule:draft:abc', 'quest/with spaces']) {
    const path = urlForView(view, base);
    assert.equal(viewFromUrl(new URL(path, base).search), view);
    assert.equal(new URL(path, base).searchParams.get('unrelated'), 'keep');
    if (view !== 'schedule:draft:abc') assert.equal(new URL(path, base).searchParams.get('scheduleDraft'), null);
  }
  const history = urlForView('board', base, true);
  assert.equal(new URL(history, base).searchParams.get('view'), 'history');
  assert.equal(viewFromUrl(new URL(history, base).search), 'board');
  assert.equal(viewFromUrl('?quest=retained-closed'), 'retained-closed');
});

test('only unchanged initiating detail can return home: board, navigation and away/back never hijacked', () => {
  assert.equal(shouldReturnHome('q', 'q', 'q', 1, 1), true);
  assert.equal(shouldReturnHome('board', 'board', 'q', 1, 1), false);
  assert.equal(shouldReturnHome('q', 'other', 'q', 1, 2), false);
  assert.equal(shouldReturnHome('q', 'q', 'q', 1, 3), false);
});

test('mutation success is acknowledged even when refresh fails; rejected actions do not navigate or toast', async () => {
  const events: string[] = [];
  await acknowledgedLifecycle(async () => ({ closedAt: 10 }), response => { assert.equal(response.closedAt, 10); events.push('ack', 'toast', 'navigate'); }, async () => { events.push('refresh'); throw Error('offline'); }, () => { events.push('reconnect'); });
  assert.deepEqual(events, ['ack', 'toast', 'navigate', 'refresh', 'reconnect']);
  events.length = 0;
  await assert.rejects(acknowledgedLifecycle(async () => { throw Error('newer run'); }, () => { events.push('ack'); }, async () => { events.push('refresh'); }, () => { events.push('reconnect'); }), /newer run/);
  assert.deepEqual(events, []);
});

test('open board cards have no action buttons; History filters use the existing header popover', () => {
  const app = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
  const cards = app.slice(app.indexOf('className="quest-grid"'), app.indexOf('className="board-empty"'));
  assert.doesNotMatch(cards, /QuestAcceptButton|requestClose\(q\)/);
  assert.match(cards, /q.closedAt !== undefined && <div className="quest-card-controls"/);
  assert.match(cards, /lifecycle\('reopen', q\)/);
  assert.doesNotMatch(app, /historyScheduleFilter|All schedules/);
  assert.doesNotMatch(app, /className="history-filters"/);
  assert.match(app, /historyFilters=\{filter === 'history' \?/);
  const controls = readFileSync(new URL('../src/web/BoardControls.tsx', import.meta.url), 'utf8');
  assert.match(controls, /historyFilters && <HistoryFilterFields/);
  assert.match(controls, /Clear outcome filter/);
  assert.match(controls, /Clear closed date filter/);
});

test('storage settings describe automatic deletion of all closed quests, not an archive-only policy', () => {
  const settings = readFileSync(new URL('../src/web/StorageSettings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /Automatically delete closed quests/);
  assert.match(settings, /view.closedQuests/);
  assert.match(settings, /Days since closing/);
  assert.match(settings, /whether accepted or not/);
  assert.match(settings, /Quests already older than this will start being deleted/);
  assert.doesNotMatch(settings, /archivedQuests|Legacy archive|archive timestamp|not included|without enrolling/);
  const app = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /Closing does not enroll/);
});

test('UI wires atomic actions, contextual confirmation, durable popstate and acknowledgement-only toast', () => {
  const app = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /capabilities\?\.questLifecycle === true/);
  assert.match(app, /lifecycle\('accept-close', current\)/);
  assert.doesNotMatch(app, /action\('accept'\)|action\('archive'\)|action\('restore'\)/);
  assert.match(app, /questions will be dismissed, not answered or approved/);
  const closeHandler = app.slice(app.indexOf('const requestClose ='), app.indexOf('const deleteArchived ='));
  assert.match(closeHandler, /setCancelQuest\(quest\)/);
  assert.doesNotMatch(closeHandler, /if\s*\(/); // Idle interrupted work may still have deliveries to cancel.
  assert.match(app, /addEventListener\('popstate'/);
  assert.match(app, /Could not accept and close/);
  assert.match(app, /expectedClosedAt|lifecycleBody/);
  assert.match(app, /setNotice\(\{ quest: response.quest/);
  const toast = readFileSync(new URL('../src/web/ClosureToast.tsx', import.meta.url), 'utf8');
  assert.match(toast, /role="status" aria-live="polite"/);
  assert.match(toast, /Undo close; return quest to inbox/);
  assert.match(toast, /onFocus/);
  assert.match(toast, /onMouseEnter/);
});
