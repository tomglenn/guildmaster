import React from 'react';
import type { ContextUsage as Usage } from '../domain/types';

export default function ContextUsage({ usage, model }: { usage?: Usage; model?: string }) {
  const current = usage && (!model || usage.model === model) ? usage : undefined;
  if (!current || current.percent == null || current.tokens == null || current.tokens <= 0) return null;
  const description = `Estimated context: ${Math.round(current.tokens).toLocaleString()} of ${current.contextWindow.toLocaleString()} tokens (${Math.round(current.percent)}%), based on the latest measurement. Pi automatically summarizes older context as needed. This is not a spending meter.`;
  return <span className="context-usage" tabIndex={0} title={description} aria-label={description}>~{Math.round(current.percent)}% context</span>;
}
