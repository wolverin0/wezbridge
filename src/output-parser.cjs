/**
 * Output Parser — transforms raw WezTerm terminal scrollback into Telegram-friendly HTML.
 * Strips ANSI codes, Claude chrome (status bars, rules), extracts responses and code blocks.
 */

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>Nc]|\x1b\[[\d;]*m/g;

function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

const CHROME_PATTERNS = [
  /^[\s─━═┌┐└┘├┤┬┴┼╭╮╯╰│┃]+$/,
  /^.*Total cost:.*$/m,
  /^.*tokens (remaining|used).*$/im,
  /^.*\d+\.\d+[km]? tokens.*$/im,
  /^.*Context:.*\d+%.*$/m,
  /^.*Model:.*claude.*$/im,
  /^\s*[╭╮╯╰│├┤].*$/,
  /^\s*>?\s*Tips:.*$/im,
];

function stripClaudeChrome(text) {
  return text
    .split('\n')
    .filter(line => !CHROME_PATTERNS.some(p => p.test(line)))
    .join('\n');
}

/**
 * Extract Claude's last response from raw terminal text.
 * Finds text between the last user prompt (❯) and the next ❯ prompt.
 */
function extractLastResponse(rawText) {
  const clean = stripAnsi(rawText);
  const lines = clean.split('\n');

  const promptPositions = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[❯>]\s/.test(lines[i]) || /^\s*[❯>]\s*$/.test(lines[i])) {
      promptPositions.push(i);
    }
  }

  if (promptPositions.length < 1) {
    return stripClaudeChrome(clean).trim();
  }

  let startLine, endLine;

  if (promptPositions.length === 1) {
    startLine = promptPositions[0] + 1;
    endLine = lines.length;
  } else {
    startLine = promptPositions[promptPositions.length - 2] + 1;
    endLine = promptPositions[promptPositions.length - 1];
  }

  const responseLines = lines.slice(startLine, endLine);
  return stripClaudeChrome(responseLines.join('\n')).trim();
}

function extractCodeBlocks(text) {
  const blocks = [];
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRe.exec(text)) !== null) {
    blocks.push({ lang: match[1] || '', code: match[2].trim() });
  }
  return blocks;
}

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function escapeHtml(text) {
  return text.replace(/[&<>]/g, ch => HTML_ESCAPE_MAP[ch]);
}

/**
 * Format text as Telegram HTML.
 */
function formatForTelegram(text, maxLen = 4000) {
  if (!text) return '';

  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    const langAttr = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trim())}</code></pre>`);
    return placeholder;
  });

  processed = processed.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  processed = escapeHtml(processed);

  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
  }

  processed = processed.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>');
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/\*(.+?)\*/g, '<i>$1</i>');

  if (processed.length > maxLen) {
    processed = processed.substring(0, maxLen - 20) + '\n\n<i>[truncated]</i>';
  }

  return processed.trim();
}

function summarizeIfLong(text, maxLen = 3000) {
  if (!text || text.length <= maxLen) return text;

  const paragraphs = text.split(/\n\n+/);
  const codeBlocks = extractCodeBlocks(text);
  const parts = [];

  if (paragraphs.length > 0) parts.push(paragraphs[0]);

  for (const block of codeBlocks.slice(0, 3)) {
    parts.push(`\`\`\`${block.lang}\n${block.code}\n\`\`\``);
  }

  if (paragraphs.length > 1) {
    parts.push('...\n\n' + paragraphs[paragraphs.length - 1]);
  }

  let result = parts.join('\n\n');
  if (result.length > maxLen) {
    result = result.substring(0, maxLen - 20) + '\n\n[truncated]';
  }

  return result;
}

module.exports = {
  stripAnsi,
  stripClaudeChrome,
  extractLastResponse,
  extractCodeBlocks,
  formatForTelegram,
  summarizeIfLong,
  escapeHtml,
};
