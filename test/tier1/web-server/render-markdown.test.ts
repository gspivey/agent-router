import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  escapeHtml,
  isSafeLinkHref,
  safeLinkHref,
  renderMarkdown,
} from '../../../src/ui/logic.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<a href="x" onload=\'y\'>&</a>')).toBe(
      '&lt;a href=&quot;x&quot; onload=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('never leaves a raw < or > in output', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = escapeHtml(s);
        expect(out.includes('<')).toBe(false);
        expect(out.includes('>')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe('isSafeLinkHref / safeLinkHref', () => {
  it('permits http, https, mailto', () => {
    expect(isSafeLinkHref('http://example.com')).toBe(true);
    expect(isSafeLinkHref('https://example.com/a?b=c')).toBe(true);
    expect(isSafeLinkHref('mailto:me@example.com')).toBe(true);
  });

  it('permits relative, scheme-relative and fragment URLs', () => {
    expect(isSafeLinkHref('/path/to/thing')).toBe(true);
    expect(isSafeLinkHref('//cdn.example.com/x')).toBe(true);
    expect(isSafeLinkHref('#section')).toBe(true);
    expect(isSafeLinkHref('relative.html')).toBe(true);
  });

  it('rejects javascript, data, vbscript schemes', () => {
    expect(isSafeLinkHref('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isSafeLinkHref('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects schemes hidden behind control characters / whitespace', () => {
    expect(isSafeLinkHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('  javascript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('\u0001javascript:alert(1)')).toBe(false);
  });

  it('safeLinkHref returns the URL when safe, # when not', () => {
    expect(safeLinkHref('https://ok.example')).toBe('https://ok.example');
    expect(safeLinkHref('javascript:alert(1)')).toBe('#');
  });
});

describe('renderMarkdown', () => {
  it('escapes HTML before formatting (no injection)', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out.includes('<script>')).toBe(false);
    expect(out.includes('&lt;script&gt;')).toBe(true);
  });

  it('renders bold, italic, and inline code', () => {
    expect(renderMarkdown('**bold**')).toBe('<strong>bold</strong>');
    expect(renderMarkdown('*it*')).toBe('<em>it</em>');
    expect(renderMarkdown('_it_')).toBe('<em>it</em>');
    expect(renderMarkdown('`code`')).toBe('<code>code</code>');
  });

  it('renders fenced code blocks and does not format inside them', () => {
    const out = renderMarkdown('```js\nconst x = **y**;\n```');
    expect(out).toContain('<pre><code>');
    expect(out).toContain('</code></pre>');
    // The ** inside a code fence must NOT become <strong>.
    expect(out).not.toContain('<strong>');
    expect(out).toContain('const x = **y**;');
  });

  it('converts newlines to <br> outside code blocks', () => {
    expect(renderMarkdown('a\nb')).toBe('a<br>b');
  });

  it('renders safe links with target/rel and blocks javascript: links', () => {
    const safe = renderMarkdown('[click](https://example.com)');
    expect(safe).toContain('<a href="https://example.com"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
    expect(safe).toContain('>click</a>');

    const unsafe = renderMarkdown('[x](javascript:alert(1))');
    expect(unsafe).toContain('href="#"');
    expect(unsafe).not.toContain('javascript:');
  });

  it('does not treat ** inside inline code as bold', () => {
    const out = renderMarkdown('`**not bold**`');
    expect(out).toBe('<code>**not bold**</code>');
    expect(out).not.toContain('<strong>');
  });

  it('never emits a raw <script> tag for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = renderMarkdown(s);
        expect(out.toLowerCase().includes('<script')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('never emits a javascript: href for arbitrary link URLs', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((s) => !s.includes(')') && !s.includes(' ')), (url) => {
        const out = renderMarkdown('[label](' + url + ')');
        // Extract the emitted href value.
        const m = /href="([^"]*)"/.exec(out);
        if (m) {
          const href = m[1] ?? '';
          expect(href.toLowerCase().replace(/[\u0000-\u0020]+/g, '').startsWith('javascript:')).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
