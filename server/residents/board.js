// The kanban board: one task card per Markdown file with a small frontmatter
// block, stored under <dataDirectory>/board/. Columns are assignees ('user'
// or a resident name). Drag ordering lives in a sidecar JSON next to the
// board directory so reordering never rewrites the card files; cards missing
// from the sidecar sort after the listed ones by creation time, which is what
// makes a freshly filed card land at the bottom of its column. Archiving a
// card moves the file into board/.archived/ — never deletes it — mirroring
// the whiteboard's conventions.

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './whiteboard.js';

const MAX_CARDS = 100;
const CARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export const USER_COLUMN = 'user';

export function formatCard({ title, assignee, origin, createdAt, updatedAt }, body) {
  return [
    '---',
    `title: ${title}`,
    `assignee: ${assignee}`,
    `origin: ${origin}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export function createBoard({ dataDirectory, fileSystem = fs, now = () => Date.now() }) {
  const boardDirectory = path.join(dataDirectory, 'board');
  const stateFilePath = path.join(dataDirectory, 'board-state.json');
  // counts() runs on every snapshot broadcast; the same short cache the
  // whiteboard uses keeps the badge from re-reading every card file.
  const COUNTS_CACHE_TTL_MS = 5_000;
  let countsCache = null;

  function readOrder() {
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(stateFilePath, 'utf8'));
      const order = {};
      for (const [column, ids] of Object.entries(parsed.order ?? {})) {
        if (Array.isArray(ids)) order[column] = ids.filter((id) => typeof id === 'string');
      }
      return order;
    } catch {
      return {};
    }
  }

  function persistOrder(order) {
    fileSystem.mkdirSync(dataDirectory, { recursive: true });
    fileSystem.writeFileSync(stateFilePath, `${JSON.stringify({ order }, null, 2)}\n`);
  }

  function formatNoteDate(at) {
    const date = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function cardFromAttributes(id, attributes, body) {
    return {
      id,
      title: attributes.title || id,
      assignee: attributes.assignee || USER_COLUMN,
      origin: attributes.origin || USER_COLUMN,
      createdAt: Number(attributes.createdAt) || 0,
      updatedAt: Number(attributes.updatedAt) || Number(attributes.createdAt) || 0,
      body: body.trim(),
    };
  }

  function readCardFile(id) {
    try {
      return parseFrontmatter(fileSystem.readFileSync(path.join(boardDirectory, id), 'utf8'));
    } catch {
      return null;
    }
  }

  // Cards listed in the sidecar come first (in that order); the rest follow
  // by creation time, so untouched columns read oldest-at-top and a new card
  // appends at the bottom.
  function sortColumn(cards, orderedIds) {
    const position = new Map(orderedIds.map((id, index) => [id, index]));
    return [...cards].sort((a, b) => {
      const positionA = position.has(a.id) ? position.get(a.id) : Infinity;
      const positionB = position.has(b.id) ? position.get(b.id) : Infinity;
      if (positionA !== positionB) return positionA - positionB;
      return a.createdAt - b.createdAt;
    });
  }

  function listCards() {
    let fileNames;
    try {
      fileNames = fileSystem.readdirSync(boardDirectory).filter((name) => name.endsWith('.md'));
    } catch {
      return [];
    }
    const byColumn = new Map();
    for (const fileName of fileNames) {
      const parsed = readCardFile(fileName);
      if (parsed === null) continue;
      const card = cardFromAttributes(fileName, parsed.attributes, parsed.body);
      if (!byColumn.has(card.assignee)) byColumn.set(card.assignee, []);
      byColumn.get(card.assignee).push(card);
    }
    const order = readOrder();
    const cards = [];
    for (const [column, columnCards] of byColumn) {
      cards.push(...sortColumn(columnCards, order[column] ?? []));
    }
    return cards.slice(0, MAX_CARDS);
  }

  function createCard({ title, body, assignee, origin, createdAt }) {
    fileSystem.mkdirSync(boardDirectory, { recursive: true });
    const base = new Date(createdAt).toISOString().replaceAll(':', '-').slice(0, 19);
    let fileName = `${base}.md`;
    for (let suffix = 2; fileSystem.existsSync(path.join(boardDirectory, fileName)); suffix += 1) {
      fileName = `${base}-${suffix}.md`;
    }
    // The title lives on one frontmatter line; collapse any newlines.
    const cleanTitle = String(title).replace(/\s+/g, ' ').trim();
    fileSystem.writeFileSync(
      path.join(boardDirectory, fileName),
      formatCard(
        { title: cleanTitle, assignee, origin, createdAt, updatedAt: createdAt },
        String(body ?? '').trim()
      )
    );
    countsCache = null;
    return fileName;
  }

  // Reassign and/or reorder one card. `index` is the target position within
  // the column as displayed; the sidecar is rebuilt from the displayed order
  // of every column so the index stays meaningful even for cards that were
  // never dragged before.
  function moveCard(id, { assignee, index } = {}) {
    if (!CARD_ID_PATTERN.test(id)) return false;
    const parsed = readCardFile(id);
    if (parsed === null) return false;
    const card = cardFromAttributes(id, parsed.attributes, parsed.body);
    const targetColumn = assignee ?? card.assignee;
    if (targetColumn !== card.assignee) {
      fileSystem.writeFileSync(
        path.join(boardDirectory, id),
        formatCard({ ...card, assignee: targetColumn, updatedAt: now() }, card.body)
      );
    }
    const order = {};
    for (const listed of listCards()) {
      (order[listed.assignee] ??= []).push(listed.id);
    }
    for (const column of Object.keys(order)) {
      order[column] = order[column].filter((cardId) => cardId !== id);
    }
    const target = (order[targetColumn] ??= []);
    const insertAt = Number.isInteger(index)
      ? Math.max(0, Math.min(index, target.length))
      : target.length;
    target.splice(insertAt, 0, id);
    persistOrder(order);
    countsCache = null;
    return true;
  }

  // Taking a card off the board archives the file, like the whiteboard does,
  // so a mis-click never loses a task.
  function archiveCard(id) {
    if (!CARD_ID_PATTERN.test(id)) return false;
    const archiveDirectory = path.join(boardDirectory, '.archived');
    try {
      fileSystem.mkdirSync(archiveDirectory, { recursive: true });
      let target = path.join(archiveDirectory, id);
      if (fileSystem.existsSync(target)) {
        target = path.join(archiveDirectory, `${id.slice(0, -'.md'.length)}-${now()}.md`);
      }
      fileSystem.renameSync(path.join(boardDirectory, id), target);
    } catch {
      return false;
    }
    countsCache = null;
    try {
      const order = readOrder();
      let changed = false;
      for (const column of Object.keys(order)) {
        const pruned = order[column].filter((cardId) => cardId !== id);
        if (pruned.length !== order[column].length) {
          order[column] = pruned;
          changed = true;
        }
      }
      if (changed) persistOrder(order);
    } catch {
      // The card is already off the board; a stale order entry is harmless.
    }
    return true;
  }

  // A follow-up note from the human, appended to the card body so the next
  // run sees the full history in its prompt.
  function appendNote(id, note) {
    if (!CARD_ID_PATTERN.test(id)) return false;
    const parsed = readCardFile(id);
    if (parsed === null) return false;
    const card = cardFromAttributes(id, parsed.attributes, parsed.body);
    const noteText = String(note ?? '').trim();
    if (noteText === '') return false;
    const body = `${card.body}\n\n## 追記 (${formatNoteDate(now())})\n\n${noteText}`.trim();
    fileSystem.writeFileSync(
      path.join(boardDirectory, id),
      formatCard({ ...card, updatedAt: now() }, body)
    );
    return true;
  }

  // The next task for a resident: the top card of its column.
  function topCardFor(assignee) {
    return listCards().find((card) => card.assignee === assignee) ?? null;
  }

  // Card totals for the canvas badge; the user column is the human's inbox.
  function counts() {
    if (countsCache !== null && now() - countsCache.at < COUNTS_CACHE_TTL_MS) {
      return countsCache.value;
    }
    const cards = listCards();
    const value = {
      total: cards.length,
      user: cards.filter((card) => card.assignee === USER_COLUMN).length,
    };
    countsCache = { at: now(), value };
    return value;
  }

  return { createCard, listCards, moveCard, archiveCard, appendNote, topCardFor, counts };
}
