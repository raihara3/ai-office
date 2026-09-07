// Render the report-oriented Markdown subset without accepting raw HTML.
import { translate } from './i18n.js';

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function inline(text, depth = 0) {
  if (depth > 8) return escapeHtml(text);
  const tokens = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|~~([^~\n]+)~~|!?\[([^\[\]\n]+)\]\(([^\s()]*)\)|https?:\/\/[^\s<>]+/g;
  let html = '';
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    html += escapeHtml(text.slice(end, match.index));
    if (match[1]) html += `<code>${escapeHtml(match[1])}</code>`;
    else if (match[2] || match[3]) html += `<strong>${inline(match[2] || match[3], depth + 1)}</strong>`;
    else if (match[4]) html += `<em>${inline(match[4], depth + 1)}</em>`;
    else if (match[5]) html += `<del>${inline(match[5], depth + 1)}</del>`;
    else {
      const label = match[6] ?? match[0];
      const destination = match[7] ?? match[0];
      let safe = false;
      try {
        safe = ['https:', 'http:', 'mailto:'].includes(new URL(destination).protocol);
      } catch {
        // Unsupported and relative destinations remain readable text.
      }
      html += safe && !match[0].startsWith('!')
        ? `<a href="${escapeHtml(destination)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
        : escapeHtml(label);
    }
    end = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(end));
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

export function renderMarkdown(value, depth = 0) {
  const lines = String(value ?? '').replaceAll('\r\n', '\n').split('\n');
  if (depth > 8) return `<p>${escapeHtml(lines.join('\n'))}</p>`;
  const blocks = [];
  const listPattern = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;
  const startsBlock = (line) => /^(?:\s*$|\s*```|\s*~~~|#{1,6}\s|>\s?|\s*[-+*]\s|\s*\d+[.)]\s|\s*(?:---+|\*\*\*+)\s*$)/.test(line);
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(fence[1])) {
        code.push(lines[index++]);
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push('<hr>'); index += 1; continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith('>')) {
        quote.push(lines[index++].replace(/^> ?/, ''));
      }
      blocks.push(`<blockquote>${renderMarkdown(quote.join('\n'), depth + 1)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length &&
      tableCells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const cells = tableCells(lines[index++]);
        rows.push(`<tr>${headers.map((_, column) => `<td>${inline(cells[column] ?? '')}</td>`).join('')}</tr>`);
      }
      blocks.push(`<div class="markdown-table"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const list = line.match(listPattern);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item || item[1].length !== list[1].length || /^\d/.test(item[2]) !== ordered) break;
        index += 1;
        const continuation = [];
        while (index < lines.length && lines[index].trim() &&
          lines[index].search(/\S/) > list[1].length) {
          continuation.push(lines[index++].slice(list[1].length + 2));
        }
        const task = item[3].match(/^\[([ xX])\]\s+(.*)$/);
        const content = task
          ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="${task[1] !== ' ' ? translate('markdown.checkboxDone') : translate('markdown.checkboxOpen')}">${inline(task[2])}`
          : inline(item[3]);
        items.push(`<li${task ? ' class="markdown-task"' : ''}>${content}${continuation.length ? renderMarkdown(continuation.join('\n'), depth + 1) : ''}</li>`);
      }
      const start = ordered ? ` start="${Number.parseInt(list[2], 10) || 1}"` : '';
      blocks.push(`<${tag}${start}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index])) {
      if (lines[index].includes('|') && index + 1 < lines.length &&
        tableCells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) break;
      paragraph.push(lines[index++]);
    }
    blocks.push(`<p>${paragraph.map((part) => inline(part)).join('<br>')}</p>`);
  }
  return blocks.join('\n');
}
