/**
 * Output Parser — transforms raw WezTerm terminal scrollback into Telegram-friendly HTML.
 * Strips ANSI codes, Claude chrome (status bars, rules), extracts responses and code blocks.
 */

// ANSI escape sequence pattern (covers CSI, OSC, and single-char escapes)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>Nc]|\x1b\[[\d;]*m/g;

/**
 * Strip all ANSI escape codes from text.
 */
function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

// Patterns for Claude Code "chrome" lines to remove
const CHROME_PATTERNS = [
  /^[\s─━═┌┐└┘├┤┬┴┼╭╮╯╰│┃]+$/,        // box-drawing lines
  /^.*Total cost:.*$/m,                    // cost summaries
  /^.*tokens (remaining|used).*$/im,       // token usage lines
  /^.*\d+\.\d+[km]? tokens.*$/im,         // token counts
  /^.*Context:.*\d+%.*$/m,                // context usage
  /^.*Model:.*claude.*$/im,               // model info lines
  /^\s*[╭╮╯╰│├┤].*$/,                     // box-drawing prefixed lines
  /^\s*>?\s*Tips:.*$/im,                   // tip lines
];

/**
 * Remove Claude Code status bar, box-drawing, cost/token lines.
 */
function stripClaudeChrome(text) {
  return text
    .split('\n')
    .filter(line => !CHROME_PATTERNS.some(p => p.test(line)))
    .join('\n');
}

/**
 * Extract Claude's last response from raw terminal text.
 * Looks for text between the last user prompt (❯ ...) and the next ❯ prompt indicator.
 */
function extractLastResponse(rawText) {
  const clean = stripAnsi(rawText);
  const lines = clean.split('\n');

  // Find all prompt positions (lines starting with ❯ or >)
  const promptPositions = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[❯>]\s/.test(lines[i]) || /^\s*[❯>]\s*$/.test(lines[i])) {
      promptPositions.push(i);
    }
  }

  if (promptPositions.length < 1) {
    // No prompts found — return last chunk of text
    return stripClaudeChrome(clean).trim();
  }

  // If there's only one prompt, response is everything after it
  // If multiple, response is between second-to-last prompt and last prompt
  let startLine, endLine;

  if (promptPositions.length === 1) {
    startLine = promptPositions[0] + 1;
    endLine = lines.length;
  } else {
    // The last prompt is where Claude is waiting; response is before it
    startLine = promptPositions[promptPositions.length - 2] + 1;
    endLine = promptPositions[promptPositions.length - 1];
  }

  const responseLines = lines.slice(startLine, endLine);
  return stripClaudeChrome(responseLines.join('\n')).trim();
}

/**
 * Extract fenced code blocks from text.
 * Returns array of { lang, code } objects.
 */
function extractCodeBlocks(text) {
  const blocks = [];
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRe.exec(text)) !== null) {
    blocks.push({ lang: match[1] || '', code: match[2].trim() });
  }
  return blocks;
}

// Characters that must be escaped in Telegram HTML
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function escapeHtml(text) {
  return text.replace(/[&<>]/g, ch => HTML_ESCAPE_MAP[ch]);
}

/**
 * Convert markdown-ish text to Telegram HTML.
 * Handles code blocks, inline code, headings, bold, italic.
 */
function markdownToHtml(text) {
  if (!text) return '';

  // Replace code blocks first (before escaping HTML)
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    const langAttr = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trim())}</code></pre>`);
    return placeholder;
  });

  // Replace inline code
  processed = processed.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // Escape remaining HTML (but not our placeholders)
  processed = escapeHtml(processed);

  // Restore code blocks (they're already escaped)
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
  }

  // Bold markdown headings (## Heading → <b>Heading</b>)
  processed = processed.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>');

  // Bold **text**
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic *text* — require whitespace/boundary around asterisks to avoid matching globs like *.js
  processed = processed.replace(/(?<=\s|^)\*([^*\n]+?)\*(?=\s|[.,;:!?]|$)/gm, '<i>$1</i>');

  return processed.trim();
}

/**
 * Format text as Telegram HTML with smart layout for long responses.
 *
 * Short (<1000 chars): plain message
 * Medium (1000–4000 chars): first paragraph visible + expandable blockquote for the rest
 * Long (>4000 chars): first paragraph + expandable blockquote (truncated) — caller sends full as document
 *
 * Telegram's <blockquote expandable> shows ~3 lines with a "Read more" tap to expand inline.
 */
function formatForTelegram(text, maxLen = 4000) {
  if (!text) return '';

  const html = markdownToHtml(text);

  // Short — just send it plain
  if (html.length <= 400) {
    return html;
  }

  // Split into lead (visible) and body (expandable)
  const firstBreak = html.indexOf('\n\n');
  let lead, body;

  if (firstBreak > 0 && firstBreak < 500) {
    lead = html.substring(0, firstBreak);
    body = html.substring(firstBreak + 2).trim();
  } else {
    // No good paragraph break — split at a newline near 250 chars
    const splitAt = html.indexOf('\n', 150);
    if (splitAt > 0 && splitAt < 400) {
      lead = html.substring(0, splitAt);
      body = html.substring(splitAt + 1).trim();
    } else {
      lead = html.substring(0, 250);
      body = html.substring(250).trim();
    }
  }

  if (!body) return html;

  // Truncate body if too long for Telegram's 4096 limit
  const overhead = lead.length + 80; // tags + spacing
  const bodyMax = maxLen - overhead;
  if (body.length > bodyMax) {
    body = body.substring(0, bodyMax - 50) + '\n\n<i>... full response sent as document below</i>';
  }

  // Telegram expandable blockquote: shows ~3 lines with "Read more" tap
  return `${lead}\n\n<blockquote expandable>${body}</blockquote>`;
}

/**
 * Check if a formatted response was truncated (needs document attachment).
 */
/**
 * Check if original response is long enough to warrant a document attachment.
 */
function wasResponseTruncated(originalText) {
  if (!originalText) return false;
  return originalText.length > 1500;
}

/**
 * Summarize long text: keep first paragraph, code blocks, and last paragraph.
 * Used as fallback — formatForTelegram now handles layout with expandable blockquotes.
 */
function summarizeIfLong(text, maxLen = 3000) {
  if (!text || text.length <= maxLen) return text;

  const paragraphs = text.split(/\n\n+/);
  const codeBlocks = extractCodeBlocks(text);

  const parts = [];

  // First paragraph
  if (paragraphs.length > 0) {
    parts.push(paragraphs[0]);
  }

  // Code blocks (up to 3)
  for (const block of codeBlocks.slice(0, 3)) {
    const lang = block.lang ? block.lang : '';
    parts.push(`\`\`\`${lang}\n${block.code}\n\`\`\``);
  }

  // Last paragraph (if different from first)
  if (paragraphs.length > 1) {
    parts.push('...\n\n' + paragraphs[paragraphs.length - 1]);
  }

  let result = parts.join('\n\n');
  if (result.length > maxLen) {
    result = result.substring(0, maxLen - 20) + '\n\n[truncated]';
  }

  return result;
}

/**
 * Detect the type of output from Claude's response.
 * @param {string} text - Raw or cleaned text
 * @returns {'diff'|'error'|'test-results'|'json'|'build'|'plain'}
 */
function detectOutputType(text) {
  if (!text) return 'plain';
  const trimmed = text.trim();

  // Diff detection
  if (/^diff --git/m.test(trimmed) || /^@@\s*-\d+,\d+\s*\+\d+,\d+\s*@@/m.test(trimmed)) {
    return 'diff';
  }
  if (/^\+{3}\s/m.test(trimmed) && /^-{3}\s/m.test(trimmed)) {
    return 'diff';
  }

  // Error/stack trace detection
  if (/^(Error|TypeError|ReferenceError|SyntaxError|RangeError):/m.test(trimmed)) {
    return 'error';
  }
  if (/at\s+\S+\s+\(.+:\d+:\d+\)/m.test(trimmed)) {
    return 'error';
  }
  if (/Traceback \(most recent call last\)/m.test(trimmed)) {
    return 'error';
  }

  // Test results detection
  if (/(\d+\s+(passing|passed|failed|failing|skipped))/im.test(trimmed)) {
    return 'test-results';
  }
  if (/^(PASS|FAIL|Tests?:)/m.test(trimmed)) {
    return 'test-results';
  }
  if (/✓|✗|✘|⨯/m.test(trimmed) && /\d+\s+(test|spec)/im.test(trimmed)) {
    return 'test-results';
  }

  // Build output detection
  if (/^(Building|Compiling|Bundling|vite|webpack|tsc|esbuild)/im.test(trimmed)) {
    return 'build';
  }
  if (/built in \d+/im.test(trimmed) || /bundle size/im.test(trimmed)) {
    return 'build';
  }

  // JSON detection
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch { /* not json */ }
  }

  return 'plain';
}

/**
 * Format diff output for Telegram — highlight +/- lines.
 */
function formatDiff(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const formatted = lines.map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      return `<b>${escapeHtml(line)}</b>`;
    }
    if (line.startsWith('+')) return escapeHtml(line);
    if (line.startsWith('-')) return escapeHtml(line);
    if (line.startsWith('@@')) return `<i>${escapeHtml(line)}</i>`;
    if (line.startsWith('diff --git')) return `<b>${escapeHtml(line)}</b>`;
    return escapeHtml(line);
  });
  return `<pre>${formatted.join('\n')}</pre>`;
}

/**
 * Format test results — extract pass/fail counts.
 */
function formatTestResults(text) {
  if (!text) return '';

  const passMatch = text.match(/(\d+)\s+(passing|passed)/i);
  const failMatch = text.match(/(\d+)\s+(failing|failed)/i);
  const skipMatch = text.match(/(\d+)\s+skipped/i);

  const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
  const fail = failMatch ? parseInt(failMatch[1], 10) : 0;
  const skip = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  const total = pass + fail + skip;

  const icon = fail > 0 ? '\u274c' : '\u2705';
  let summary = `${icon} <b>Tests: ${pass}/${total} passed</b>`;
  if (fail > 0) summary += ` | <b>${fail} failed</b>`;
  if (skip > 0) summary += ` | ${skip} skipped`;

  return summary;
}

/**
 * Format stack trace — collapse to relevant frames.
 */
function formatStackTrace(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const relevant = [];
  let inStack = false;
  let frameCount = 0;

  for (const line of lines) {
    if (/^\s+at\s/.test(line)) {
      inStack = true;
      frameCount++;
      // Keep first 3 frames and any from user code (not node_modules)
      if (frameCount <= 3 || !line.includes('node_modules')) {
        relevant.push(line);
      }
    } else {
      if (inStack && frameCount > 3) {
        relevant.push(`    ... ${frameCount - 3} more frames`);
      }
      inStack = false;
      frameCount = 0;
      relevant.push(line);
    }
  }

  return `<pre>${escapeHtml(relevant.join('\n'))}</pre>`;
}

module.exports = {
  stripAnsi,
  stripClaudeChrome,
  extractLastResponse,
  extractCodeBlocks,
  markdownToHtml,
  formatForTelegram,
  wasResponseTruncated,
  summarizeIfLong,
  escapeHtml,
  detectOutputType,
  formatDiff,
  formatTestResults,
  formatStackTrace,
};
