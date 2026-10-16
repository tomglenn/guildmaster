import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from '../src/web/Markdown.ts';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

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
  assert.match(render('```html\n<div>&amp;</div>\n```'), /<pre><code>&lt;div&gt;&amp;amp;&lt;\/div&gt;<\/code><\/pre>/);
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
  assert.match(html, /<th style="text-align:left">Name<\/th>/);
  assert.match(html, /<td style="text-align:right"><del>pending<\/del> done<\/td>/);
  assert.match(html, /class="code-language">ts<\/div><pre><code>const value = &quot;&lt;unfinished&gt;&quot;;<\/code><\/pre>/);
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
