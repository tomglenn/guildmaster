import { useEffect, useState } from 'react';
import { mergeToolCalls, type ToolCall } from './transcript-data';

export default function useLiveToolCalls(questId: string | undefined, snapshot: ToolCall[]): ToolCall[] {
  const [updates, setUpdates] = useState<{ questId?: string; calls: ToolCall[] }>({ questId, calls: [] });
  useEffect(() => {
    const receive = (event: Event) => {
      const data = (event as CustomEvent<{ questId: string; call: ToolCall }>).detail;
      if (data.questId !== questId || !data.call?.id) return;
      setUpdates(previous => ({ questId, calls: mergeToolCalls(previous.questId === questId ? previous.calls : [], [data.call]) }));
    };
    window.addEventListener('guildmaster:tool', receive);
    return () => window.removeEventListener('guildmaster:tool', receive);
  }, [questId]);
  return mergeToolCalls(snapshot, updates.questId === questId ? updates.calls : []);
}
