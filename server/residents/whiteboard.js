// The whiteboard: reports from resident team members to the human. Each
// report is a Markdown file with a small frontmatter block, stored in the
// resident's own outbox/ directory so a plain text editor sees the same thing
// the in-app panel does. Read state lives in a sidecar JSON next to the
// residents directory — the report files themselves are never moved or
// mutated by reading them.
//
// Frontmatter parsing/formatting are exported as pure functions; the store
// takes the filesystem as an injectable dependency for tests.

import fs from 'node:fs';
import path from 'node:path';

const MAX_REPORTS = 100;
const REPORT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]+\.md$/;

// A minimal "key: value" frontmatter block — no YAML nesting, by design.
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { attributes: {}, body: text };
  const attributes = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { attributes, body: text.slice(match[0].length) };
}

// `task` optionally links the report to the kanban card whose run produced
// it, so the card detail view can pull the report in.
export function formatReport({ title, level, resident, createdAt, task }, body) {
  return [
    '---',
    `title: ${title}`,
    `level: ${level}`,
    `resident: ${resident}`,
    ...(task ? [`task: ${task}`] : []),
    `createdAt: ${createdAt}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export function createWhiteboard({ dataDirectory, fileSystem = fs, now = () => Date.now() }) {
  const residentsDirectory = path.join(dataDirectory, 'residents');
  const stateFilePath = path.join(dataDirectory, 'whiteboard-state.json');
  // counts() runs on every snapshot broadcast; a short cache keeps the badge
  // from re-reading every report file at the refresh rate, while still
  // picking up reports written directly to an outbox within a few seconds.
  const COUNTS_CACHE_TTL_MS = 5_000;
  let countsCache = null;

  function readIds() {
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(stateFilePath, 'utf8'));
      return new Set(Array.isArray(parsed.readIds) ? parsed.readIds : []);
    } catch {
      return new Set();
    }
  }

  function persistReadIds(ids) {
    fileSystem.mkdirSync(dataDirectory, { recursive: true });
    fileSystem.writeFileSync(
      stateFilePath,
      `${JSON.stringify({ readIds: [...ids] }, null, 2)}\n`
    );
  }

  function saveReport(residentName, { title, level, body, createdAt, task = null }) {
    const outboxDirectory = path.join(residentsDirectory, residentName, 'outbox');
    fileSystem.mkdirSync(outboxDirectory, { recursive: true });
    const fileName = `${new Date(createdAt).toISOString().replaceAll(':', '-').slice(0, 19)}.md`;
    fileSystem.writeFileSync(
      path.join(outboxDirectory, fileName),
      formatReport({ title, level, resident: residentName, createdAt, task }, body)
    );
    countsCache = null;
    return `${residentName}/${fileName}`;
  }

  function listReports() {
    let residentNames;
    try {
      residentNames = fileSystem
        .readdirSync(residentsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const read = readIds();
    const reports = [];
    for (const residentName of residentNames) {
      const outboxDirectory = path.join(residentsDirectory, residentName, 'outbox');
      let fileNames;
      try {
        fileNames = fileSystem.readdirSync(outboxDirectory).filter((name) => name.endsWith('.md'));
      } catch {
        continue;
      }
      for (const fileName of fileNames) {
        const filePath = path.join(outboxDirectory, fileName);
        let text;
        try {
          text = fileSystem.readFileSync(filePath, 'utf8');
        } catch {
          continue;
        }
        const { attributes, body } = parseFrontmatter(text);
        const id = `${residentName}/${fileName}`;
        reports.push({
          id,
          resident: residentName,
          title: attributes.title ?? fileName,
          level: attributes.level === 'review-needed' ? 'review-needed' : 'info',
          task: attributes.task ?? null,
          createdAt: Number(attributes.createdAt) || 0,
          read: read.has(id),
          body: body.trim(),
        });
      }
    }
    reports.sort((a, b) => b.createdAt - a.createdAt);
    return reports.slice(0, MAX_REPORTS);
  }

  function markRead(id) {
    if (!REPORT_ID_PATTERN.test(id)) return false;
    const ids = readIds();
    if (ids.has(id)) return true;
    ids.add(id);
    persistReadIds(ids);
    countsCache = null;
    return true;
  }

  // Taking a report off the board moves the file into the outbox's .archived/
  // subdirectory (listing only scans outbox/*.md) rather than deleting it, so
  // a mis-click never loses a report. The read sidecar entry goes with it.
  function archiveReport(id) {
    if (!REPORT_ID_PATTERN.test(id)) return false;
    const [residentName, fileName] = id.split('/');
    const outboxDirectory = path.join(residentsDirectory, residentName, 'outbox');
    const archiveDirectory = path.join(outboxDirectory, '.archived');
    try {
      fileSystem.mkdirSync(archiveDirectory, { recursive: true });
      // A same-named file already archived earlier (report restored and
      // archived again) must not be overwritten — suffix the new one.
      let target = path.join(archiveDirectory, fileName);
      if (fileSystem.existsSync(target)) {
        target = path.join(archiveDirectory, `${fileName.slice(0, -'.md'.length)}-${now()}.md`);
      }
      fileSystem.renameSync(path.join(outboxDirectory, fileName), target);
    } catch {
      return false;
    }
    countsCache = null;
    try {
      const ids = readIds();
      if (ids.delete(id)) persistReadIds(ids);
    } catch {
      // The report is already off the board; a stale read id is harmless.
    }
    return true;
  }

  // Unread totals for the canvas badge; pushed with every snapshot.
  function counts() {
    if (countsCache !== null && now() - countsCache.at < COUNTS_CACHE_TTL_MS) {
      return countsCache.value;
    }
    const reports = listReports();
    const unreadReports = reports.filter((report) => !report.read);
    const value = {
      total: reports.length,
      unread: unreadReports.length,
      reviewNeeded: unreadReports.filter((report) => report.level === 'review-needed').length,
    };
    countsCache = { at: now(), value };
    return value;
  }

  return { saveReport, listReports, markRead, archiveReport, counts };
}
