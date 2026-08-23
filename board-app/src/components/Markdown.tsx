import type { ReactNode } from 'react';

/**
 * A deliberately small markdown renderer for the briefs and the daily rollup.
 *
 * WHY NOT A LIBRARY: this app ships zero CDN and near-zero deps by house rule,
 * and the two things being rendered are machine-written files with a fixed
 * vocabulary (headings, bullets, quotes, bold, code). A parser for the whole
 * spec would be more code than the panels it serves.
 *
 * WHY NOT dangerouslySetInnerHTML: the input is a file on disk that other
 * processes append to. Rendering it as HTML would make any brief able to inject
 * markup into the operator's cockpit. This builds REACT ELEMENTS, so text is
 * text no matter what a bot writes into a brief — there is no escaping step to
 * get wrong because there is no HTML string anywhere in the path.
 */

/** Inline pass: `code`, **bold**. Everything else stays literal text. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code key={`${keyBase}-c${i}`} className="mono">{tok.slice(1, -1)}</code>);
    } else {
      out.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>);
    }
    last = m.index + tok.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (!bullets.length) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {items.map((b, i) => <li key={i}>{inline(b, `li-${blocks.length}-${i}`)}</li>)}
      </ul>,
    );
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { bullets.push(bullet[1]); return; }
    flush();
    if (!line.trim()) return;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <p key={`h-${idx}`} className={`md-h md-h${Math.min(level, 3)}`}>
          {inline(heading[2], `h-${idx}`)}
        </p>,
      );
      return;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(<p key={`q-${idx}`} className="md-quote">{inline(quote[1], `q-${idx}`)}</p>);
      return;
    }
    blocks.push(<p key={`p-${idx}`}>{inline(line, `p-${idx}`)}</p>);
  });
  flush();

  return <div className="md">{blocks}</div>;
}
