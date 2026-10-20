import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from '../src/web/Markdown.ts';
import { copyCode, highlightCode } from '../src/web/CodeBlock.ts';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test('Markdown covers every heading level, prose, rules and literal unsupported HTML', () => {
  const html = render('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nPlain **strong** *emphasis* ~~removed~~ [link](https://example.com)\n\n---\n\n<details><summary>Not interactive HTML</summary>literal</details>');
  for (const [i, word] of ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].entries()) {
    assert.match(html, new RegExp(`<h${i + 1}>${word}</h${i + 1}>`));
  }
  assert.match(html, /<strong>strong<\/strong> <em>emphasis<\/em> <del>removed<\/del>/);
  assert.match(html, /<hr\/>/);
  assert.doesNotMatch(html, /<details|<summary/);
  assert.match(html, /&lt;details&gt;/);
});

test('code controls label plain fences and preserve unknown languages literally', () => {
  const plain = render('```\n<&amp;>\n```');
  assert.match(plain, /class="code-language">text<\/span>/);
  assert.match(plain, /aria-label="Copy text code">Copy<\/button>/);
  assert.match(plain, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(plain, /<code>&lt;&amp;amp;&gt;<\/code>/);
  const unknown = render('```mystery extra metadata\nconst value = "<script>";\n```');
  assert.match(unknown, /class="code-language">mystery<\/span>/);
  assert.doesNotMatch(unknown, /code-token-|<script/);
});

test('lexical highlighting is lossless for supported languages and every streaming prefix', () => {
  const examples: Record<string, string> = {
    js: 'const x = "<&amp;>"; // caret ^ comment\n/* partial',
    ts: 'interface Quest { readonly id: string }\nconst n = 12.5;',
    python: 'def run():\n  # note\n  return """partial\ntext',
    bash: '#!/bin/sh\nif true; then echo "$HOME"; fi\n',
    json: '{"safe": true, "n": 42, "partial": "abc',
    diff: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n context\n',
  };
  for (const [language, text] of Object.entries(examples)) {
    for (let length = 0; length <= text.length; length++) {
      const partial = text.slice(0, length);
      assert.equal(highlightCode(partial, language).map(token => token.text).join(''), partial);
    }
    assert.ok(highlightCode(text, language).some(token => token.kind));
  }
  assert.ok(highlightCode(examples.js, 'js').some(token => token.kind === 'comment' && token.text.includes('^ comment')));
  for (const language of ['html', 'unknown', 'text', 'constructor', 'toString']) {
    assert.deepEqual(highlightCode('<b>&amp;</b>', language), [{ text: '<b>&amp;</b>' }]);
  }
  const large = 'const x = 1;\n'.repeat(10_000);
  assert.deepEqual(highlightCode(large, 'js'), [{ text: large }]);
});

test('copy code reports success, unavailable clipboard and rejected permission without altering text', async () => {
  const text = '\tconst value = "<&amp;>";\n\n';
  let copied: string | undefined;
  assert.equal(await copyCode(text, { writeText: async value => { copied = value; } }), true);
  assert.equal(copied, text);
  assert.equal(await copyCode(text, { writeText: async () => { throw new Error('Denied'); } }), false);
  assert.equal(await copyCode(text, undefined), false);
});

test('Markdown renders nested inline code inside emphasis without leaking delimiters', () => {
  assert.equal(render('**Two stores under `~/.guildmaster-gui` (or `GUILDMASTER_HOME`):**'),
    '<div class="markdown"><p><strong>Two stores under <code>~/.guildmaster-gui</code> (or <code>GUILDMASTER_HOME</code>):</strong></p></div>');
  assert.equal(render('*Read **this `path`** first*'),
    '<div class="markdown"><p><em>Read <strong>this <code>path</code></strong> first</em></p></div>');
});

test('Markdown preserves nested lists, multiline items, starting numbers, and task states', () => {
  const html = render('3. First line\n   continued\n   - nested **item**\n   - second\n4. Last\n\n- [x] Done\n- [ ] Pending');
  assert.match(html, /<ol start="3"><li>First line\ncontinued<ul><li>nested <strong>item<\/strong><\/li><li>second<\/li><\/ul><\/li><li>Last<\/li><\/ol>/);
  assert.match(html, /class="task-list"/);
  assert.match(html, /aria-label="Completed task" checked=""/);
  assert.match(html, /aria-label="Incomplete task"/);
});

test('Markdown decodes prose entities while preserving literal entities and markup in code', () => {
  assert.equal(render('A &amp; B &copy; &#x41; \\[literal\\] `&amp; <tag>`'),
    '<div class="markdown"><p>A &amp; B © A [literal] <code>&amp;amp; &lt;tag&gt;</code></p></div>');
  assert.match(render('```html\n<div>&amp;</div>\n```'), /<code>&lt;div&gt;&amp;amp;&lt;\/div&gt;<\/code><\/pre>/);
});

test('Markdown safely renders raw HTML and rejects executable link schemes', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [data](data:text/html,bad) [good](https://example.com?q=1&amp;x=2)');
  assert.doesNotMatch(html, /<script|<img|onerror="|href="(?:javascript|data):/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/example.com\?q=1&amp;x=2"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('Markdown presents images as opt-in links without automatic remote requests', () => {
  const html = render('![Diagram](https://example.com/tracking.png) ![Unsafe](data:image/png,secret)');
  assert.doesNotMatch(html, /<img|src=|href="data:/);
  assert.match(html, /class="image-link">Diagram<\/a>/);
  assert.match(html, /Unsafe/);
});

test('Markdown renders tables, blockquotes, and partial streaming fences', () => {
  const html = render('> A **note**\n\n| Name | State |\n| :--- | ---: |\n| `Quest` | ~~pending~~ done |\n\n```ts\nconst value = "<unfinished>";');
  assert.match(html, /<blockquote><p>A <strong>note<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<th scope="col" style="text-align:left">Name<\/th>/);
  assert.match(html, /<td style="text-align:right"><del>pending<\/del> done<\/td>/);
  assert.match(html, /class="code-language">ts<\/span>/);
  assert.match(html, /<span class="code-token-keyword">const<\/span> value = <span class="code-token-string">&quot;&lt;unfinished&gt;&quot;<\/span>;/);
  assert.match(html, /tabindex="0" role="region" aria-label="ts code"/);
});

test('conversation links open files in the correct quest without changing web or app links', () => {
  const html = renderToStaticMarkup(createElement(Markdown, {questId:'quest-one',text:
    '[Brief](morning-brief.html#attention) [Nested](reports/full%20brief.html) [Absolute](/tmp/quest/report.html) [File](file:///tmp/quest/report.html) [Web](https://example.com/report.html) [Schedule](/?scheduleDraft=draft) [API](/api/quests/other/files/report.html) [Anchor](#heading)'}));
  assert.match(html,/href="\/api\/quests\/quest-one\/files\/morning-brief.html#attention"/);
  assert.match(html,/href="\/api\/quests\/quest-one\/files\/reports\/full%20brief.html"/);
  assert.equal((html.match(/href="\/api\/quests\/quest-one\/files\/%2Ftmp\/quest\/report.html"/g)??[]).length,2);
  assert.match(html,/href="https:\/\/example.com\/report.html"/);
  assert.match(html,/href="\/\?scheduleDraft=draft"/);
  assert.match(html,/href="\/api\/quests\/other\/files\/report.html"/);
  assert.match(html,/href="#heading"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Markdown,{questId:'q',text:'[Bad](javascript:alert%281%29) [Remote file](file://remote/secret)'})),/href=/);
});
