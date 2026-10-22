import React from 'react';
import Icon from './Icon';

// Keep scheduler states distinct: queued is not paused, review is not acceptance.
export const sidebarStatuses = {
  queued: { label: 'Queued', icon: 'clock', description: 'Queued for execution' },
  running: { label: 'Running', icon: 'activity', description: 'Running' },
  awaiting_input: { label: 'Needs you', icon: 'chat', description: 'Needs your input' },
  awaiting_review: { label: 'Review', icon: 'document', description: 'Ready for human review, not yet accepted' },
  waiting: { label: 'Waiting', icon: 'team', description: 'Waiting for agents' },
  accepted: { label: 'Accepted', icon: 'check', description: 'Accepted' },
  completed: { label: 'Completed', icon: 'check', description: 'Completed' },
  interrupted: { label: 'Interrupted', icon: 'alert', description: 'Interrupted' },
  failed: { label: 'Failed', icon: 'alert', description: 'Failed' },
  cancelled: { label: 'Cancelled', icon: 'close', description: 'Cancelled' },
} as const;

type SidebarQuestData = {
  id: string;
  title: string;
  status: keyof typeof sidebarStatuses;
  project?: { name: string };
  queueReason?: string;
  inbox?: { label: string; group: 'input' | 'attention' | 'working' };
};

export default function SidebarQuest({ quest, selected, onOpen }: {
  quest: SidebarQuestData;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  const base = sidebarStatuses[quest.status];
  const reviewReady = quest.inbox?.label === 'Ready for review';
  const status = quest.inbox ? { label: reviewReady ? 'Review' : quest.inbox.label, description: quest.inbox.label, icon: quest.inbox.group === 'input' ? 'chat' : reviewReady ? 'document' : quest.inbox.group === 'attention' ? 'alert' : base.icon } : base;
  const project = quest.project?.name || 'No saved project';
  const description = [status.description, quest.queueReason].filter(Boolean).join(': ');
  // No structured short title exists. Preserve distinguishing words and identifiers.
  return <button className={`recent-quest ${selected ? 'active' : ''}`}
    aria-current={selected ? 'page' : undefined}
    aria-label={`${quest.title} — ${project} — ${description}`}
    onClick={() => onOpen(quest.id)}>
    <span className="recent-quest-title">{quest.title}</span>
    <span className="recent-quest-meta">
      <span className="recent-quest-project">{project}</span>
      <span className={`sidebar-status status-${quest.status}`}>
        <Icon name={status.icon} size={13}/>{status.label}
      </span>
    </span>
  </button>;
}
