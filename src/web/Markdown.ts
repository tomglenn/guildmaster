import React, { createElement as h, Fragment, useMemo } from 'react';
import { lexer, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';

// Parse Markdown, then build React elements. Agent output never becomes HTML.
// Code tokens stay literal; entities are decoded only in prose and link fields.
function safeHref(value: string, questId?: string): string | undefined {
  const href = decodeHTML(value).trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  try {
    const url = new URL(href, 'https://guildmaster.invalid/');
    if (questId && !href.startsWith('#') && !href.startsWith('?') && !/^\/(?:\?|api\/)/.test(href) && !href.startsWith('//') && (!/^[a-z][a-z\d+.-]*:/i.test(href) || url.protocol === 'file:')) {
      if (url.protocol === 'file:' && url.hostname) return undefined;
      const rawPath = url.protocol === 'file:' ? url.pathname : href.split(/[?#]/)[0];
      const path = decodeURIComponent(rawPath);
      // Browsers collapse ./.. segments before requesting, so join each to the segment after it.
      const segments = path.split('/').map(encodeURIComponent).reduceRight<string[]>((after, part) => /^\.\.?$/.test(part) ? [`${part}%2F${after.shift() ?? ''}`, ...after] : [part, ...after], []);
      return `/api/quests/${encodeURIComponent(questId)}/files/${segments.join('/').replace(/^\//,'%2F')}${url.hash}`;
    }
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

function nodes(tokens: Token[] = [], questId?: string): React.ReactNode[] {
  return tokens.map((token, key) => node(token, key, questId));
}

function node(token: Token, key: number, questId?: string): React.ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'text':
      return h(Fragment, { key }, token.tokens ? nodes(token.tokens, questId) : decodeHTML(token.text));
    case 'escape':
      return h(Fragment, { key }, token.text);
    case 'html':
      return h(Fragment, { key }, token.text);
    case 'paragraph':
      return h('p', { key }, nodes(token.tokens, questId));
    case 'heading':
      return h(`h${Math.max(1, Math.min(6, token.depth))}`, { key }, nodes(token.tokens, questId));
    case 'strong':
    case 'em':
    case 'del':
      return h(token.type, { key }, nodes(token.tokens, questId));
    case 'codespan':
      return h('code', { key }, token.text);
    case 'code': {
      const language = token.lang?.split(/\s+/)[0];
      return h('div', { key, className: 'code-block' },
        language ? h('div', { className: 'code-language' }, language) : null,
        h('pre', null, h('code', null, token.text)));
    }
    case 'br':
    case 'hr':
      return h(token.type, { key });
    case 'blockquote':
      return h('blockquote', { key }, nodes(token.tokens, questId));
    case 'list':
      return h(token.ordered ? 'ol' : 'ul', {
        key,
        start: token.ordered && token.start !== 1 ? token.start : undefined,
        className: token.items.some((item: Tokens.ListItem) => item.task) ? 'task-list' : undefined,
      }, token.items.map((item: Tokens.ListItem, index: number) => h('li', {
        key: index, className: item.task ? 'task-list-item' : undefined,
      }, nodes(item.tokens, questId))));
    case 'checkbox':
      return h('input', { key, type: 'checkbox', checked: token.checked, disabled: true, 'aria-label': token.checked ? 'Completed task' : 'Incomplete task' });
    case 'link': {
      const href = safeHref(token.href, questId);
      return href
        ? h('a', { key, href, title: token.title ? decodeHTML(token.title) : undefined, target: '_blank', rel: 'noopener noreferrer' }, nodes(token.tokens, questId))
        : h(Fragment, { key }, nodes(token.tokens, questId));
    }
    case 'image': {
      // Loading agent-supplied remote images can leak the reader's IP address.
      // Preserve the alt text and let the reader choose whether to open it.
      const href = safeHref(token.href, questId);
      const label = decodeHTML(token.text) || 'Image';
      return href
        ? h('a', { key, href, target: '_blank', rel: 'noopener noreferrer', className: 'image-link' }, label)
        : h(Fragment, { key }, label);
    }
    case 'table': {
      const cell = (entry: Tokens.TableCell, index: number) => h(entry.header ? 'th' : 'td', {
        key: index, style: entry.align ? { textAlign: entry.align } : undefined,
      }, nodes(entry.tokens, questId));
      return h('div', { key, className: 'markdown-table' }, h('table', null,
        h('thead', null, h('tr', null, token.header.map(cell))),
        h('tbody', null, token.rows.map((row: Tokens.TableCell[], index: number) => h('tr', { key: index }, row.map(cell))))));
    }
    default:
      return h(Fragment, { key }, token.raw);
  }
}

export default function Markdown({ text, questId }: { text: string; questId?: string }) {
  const tokens = useMemo(() => lexer(text, { gfm: true }), [text]);
  return h('div', { className: 'markdown' }, nodes(tokens, questId));
}
