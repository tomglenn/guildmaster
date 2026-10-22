import React from 'react';
import Icon from './Icon';

// Confirmation belongs to the acknowledged command, never a hydrated/SSE status transition.
export default function QuestAcceptButton({ disabled, title, onAccept }: { disabled: boolean; title?: string; onAccept: () => Promise<void> }) {
  return <button className="button small quest-accept primary" disabled={disabled} title={title || 'Accepts this result and moves the quest to History. Does not merge, publish, verify correctness, or delete files.'} onClick={() => void onAccept()}>
    <Icon name="check" size={16}/><span>Accept &amp; close</span>
  </button>;
}
