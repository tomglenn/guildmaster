import WorkingIndicator from './WorkingIndicator';
import useLiveToolCalls from './useLiveToolCalls';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import Markdown from './Markdown';
import ConversationImages from './ConversationImages';
import { DelegationRow, NewEntry, ToolActivity, seenConversationEntries } from './ConversationActivity';
import { delegationEntries, conversationEntries, transcriptItems, visibleLive, conversationProgress, type ProgressEvent, type TranscriptRequest, type TranscriptMessage, type LiveMessage, type ToolCall, type Delegation } from './transcript-data';

const date = (value: string | number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export default function Transcript({ questId, messages, toolCalls: savedToolCalls = [], events = [], live, status, activeRunId, assistantLabel, requests = [], jumpTo, questionsForLead = false, queueReason, showToolCalls = false, agents = [], onOpenAgent, followups = [], onOpenQuest }: {
  followups?: Delegation[]; onOpenQuest?: (id: string) => void;
  questId?: string; showToolCalls?: boolean; agents?: Delegation[]; onOpenAgent?: (id: string) => void;
  jumpTo?: { id: string; sequence: number }; questionsForLead?: boolean; queueReason?: string;
  events?: ProgressEvent[]; requests?: TranscriptRequest[]; messages: TranscriptMessage[]; toolCalls?: ToolCall[]; live?: LiveMessage | null; status: string; activeRunId?: string; assistantLabel: string;
}) {
  const toolCalls = useLiveToolCalls(questId, savedToolCalls);
  const delegations = delegationEntries(agents, toolCalls);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!jumpTo) return;
    // Run after the parent restores its scroll position and the composer focuses.
    const frame = requestAnimationFrame(() => {
      const target = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
        .find(element => element.dataset.messageId === jumpTo.id);
      if (!target) return;
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      target.focus({ preventScroll: true });
      // Update follow-latest tracking before a resize observer can scroll back down.
      target.closest('.quest-scroll, .gm-scroll')?.dispatchEvent(new Event('scroll'));
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpTo]);
  // Keep the final streaming text visible until the saved message reaches this snapshot.
  const previousLive = useRef<LiveMessage | null>(null);
  if (live) previousLive.current = live;
  const stream = visibleLive(messages, live ?? previousLive.current, status, activeRunId);
  const rawProgress = conversationProgress(status, toolCalls, events, activeRunId, queueReason, delegations);
  const activeTool = toolCalls.some(call => call.runId === activeRunId && call.status === 'running' && call.tool !== 'request_user');
  const progress = requests.some(request => request.status === 'pending') ? null
    : stream && status === 'running' && !activeTool ? 'Writing…' : rawProgress;
  const messagesWithQuestions = transcriptItems(messages, requests);
  const entries = conversationEntries(messagesWithQuestions, showToolCalls ? toolCalls.filter(call => call.tool !== 'request_user') : [], [...delegations, ...followups.map(quest => ({...quest, questLink:true}))]);
  const hydrated = useRef(false);
  const arriving = hydrated.current;
  useLayoutEffect(() => {
    hydrated.current = true;
    for (const message of messagesWithQuestions) seenConversationEntries.add(`message:${message.id}`);
    for (const call of toolCalls) seenConversationEntries.add(`tool:${call.id}`);
    for (const agent of [...delegations, ...followups]) seenConversationEntries.add(`delegation:${agent.id}`);
    if (stream) seenConversationEntries.add(`message:${stream.messageId}`);
    // Bound session memory; initial history never animates even after eviction.
    while (seenConversationEntries.size > 20000) seenConversationEntries.delete(seenConversationEntries.values().next().value!);
  });
  const renderMessage = (message: TranscriptMessage) => <article data-message-id={message.id} tabIndex={-1} className={`message message-${message.role}`}><div className="message-body"><div className="message-meta"><strong>{message.source === 'schedule' ? 'Scheduled task' : message.source === 'guildmaster' ? 'Guildmaster' : message.source === 'quest_lead' ? 'Quest lead' : message.role === 'user' ? 'You' : message.role === 'system' ? 'Activity' : assistantLabel}</strong><span>{date(message.createdAt)}</span>{message.request?.status === 'pending' && <span className="question-status">{questionsForLead ? 'Waiting for quest lead' : 'Needs your input'}</span>}</div><Markdown text={message.text} questId={questId}/>{questId && !!message.attachments?.length && <ConversationImages questId={questId} images={message.attachments}/>}</div></article>;
  return <div className="transcript" ref={container}>{entries.map(entry => entry.kind === 'tools'
    ? <ToolActivity key={entry.id} calls={entry.calls} arriving={arriving}/>
    : <NewEntry key={entry.id} id={entry.id} arriving={arriving}>{entry.kind === 'message' ? renderMessage(entry.message) : <DelegationRow agent={entry.agent} onOpen={entry.agent.questLink ? onOpenQuest : onOpenAgent}/>}</NewEntry>
  )}{stream && <NewEntry key={`message:${stream.messageId}`} id={`message:${stream.messageId}`} arriving={arriving}><article data-message-id={stream.messageId} tabIndex={-1} className="message message-assistant"><div className="message-body"><div className="message-meta"><strong>{assistantLabel}</strong></div><Markdown text={stream.text} questId={questId}/></div></article></NewEntry>}<WorkingIndicator key={activeRunId ?? questId} label={progress}/></div>;
}
