import React, { createElement as h, useEffect, useMemo, useRef, useState } from 'react';

export interface CodeToken { text: string; kind?: 'comment' | 'string' | 'number' | 'keyword' | 'inserted' | 'deleted' | 'meta' }

const aliases: Record<string, string> = {
  js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript',
  py: 'python', python: 'python', sh: 'shell', bash: 'shell', shell: 'shell',
  json: 'json', diff: 'diff', patch: 'diff',
};
const keywords: Record<string, Set<string>> = {
  javascript: new Set('async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield'.split(' ')),
  typescript: new Set('abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface keyof let namespace never new null number of private protected public readonly return satisfies static string super switch this throw true try type typeof undefined unknown var void while yield'.split(' ')),
  python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' ')),
  shell: new Set('if then else elif fi for while do done case esac in function select until'.split(' ')),
  json: new Set(['true', 'false', 'null']),
};

// Lexical accents, not a language parser. Unknown languages stay entirely literal.
// Every match (including unfinished strings/comments) retains its original bytes.
export function highlightCode(text: string, language: string): CodeToken[] {
  const name = language.toLowerCase();
  const mode = Object.hasOwn(aliases, name) ? aliases[name] : undefined;
  if (!mode || text.length > 100_000) return [{ text }];
  if (mode === 'diff') return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(line => ({
    text: line,
    kind: /^(?:@@|diff |index |--- |\+\+\+ )/.test(line) ? 'meta' : line.startsWith('+') ? 'inserted' : line.startsWith('-') ? 'deleted' : undefined,
  }));
  // No JSX/HTML, regular-expression, interpolation, or shell-expansion semantics
  // are inferred. Unrecognised punctuation/identifiers remain plain text.
  const comments = mode === 'python' || mode === 'shell' ? '#[^\\n]*' : mode === 'json' ? '(?!)' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)';
  const strings = mode === 'python'
    ? `"""[\\s\\S]*?(?:"""|$)|'''[\\s\\S]*?(?:'''|$)|"(?:\\\\[\\s\\S]|[^"\\\\\\n])*(?:"|$)|'(?:\\\\[\\s\\S]|[^'\\\\\\n])*(?:'|$)`
    : mode === 'json' ? '"(?:\\\\[\\s\\S]|[^"\\\\\\n])*(?:"|$)'
    : '"(?:\\\\[\\s\\S]|[^"\\\\\\n])*(?:"|$)|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n])*(?:\'|$)|`(?:\\\\[\\s\\S]|[^`\\\\])*(?:`|$)';
  const pattern = new RegExp(`(${comments})|(${strings})|(\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|([A-Za-z_$][\\w$]*)`, 'g');
  const result: CodeToken[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > end) result.push({ text: text.slice(end, index) });
    result.push({ text: match[0], kind: match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'number' : keywords[mode]?.has(match[0]) ? 'keyword' : undefined });
    end = index + match[0].length;
  }
  if (end < text.length) result.push({ text: text.slice(end) });
  return result;
}

export async function copyCode(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard): Promise<boolean> {
  try {
    if (!clipboard) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function CodeBlock({ text, language }: { text: string; language?: string }) {
  const label = language?.trim().split(/\s+/)[0] || 'text';
  const tokens = useMemo(() => highlightCode(text, label), [text, label]);
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setStatus('idle');
    return () => { revision.current++; };
  }, [text]);
  useEffect(() => {
    if (status !== 'copied' && status !== 'failed') return;
    const timer = setTimeout(() => setStatus('idle'), 5000);
    return () => clearTimeout(timer);
  }, [status]);
  const copy = async () => {
    const current = revision.current;
    setStatus('copying');
    const success = await copyCode(text);
    if (current === revision.current) setStatus(success ? 'copied' : 'failed');
  };
  return h('div', { className: 'code-block' },
    h('div', { className: 'code-header' },
      h('span', { className: 'code-language' }, label),
      h('span', { className: 'code-copy-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
        status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed — select and copy the code manually.' : ''),
      h('button', { type: 'button', className: 'code-copy', onClick: copy, disabled: status === 'copying', 'aria-label': `Copy ${label} code` }, status === 'copying' ? 'Copying…' : 'Copy')),
    h('pre', { tabIndex: 0, role: 'region', 'aria-label': `${label} code` }, h('code', null,
      tokens.map((token, key) => token.kind ? h('span', { key, className: `code-token-${token.kind}` }, token.text) : token.text))));
}
