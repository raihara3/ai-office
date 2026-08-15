// Generic JSONL tailing over a directory tree.
// Discovers recently modified files matching a pattern, then streams
// appended lines to a callback. Uses fs.watch for immediacy plus a
// periodic rescan as a fallback (fs.watch can drop events on macOS).

import fs from 'node:fs';
import path from 'node:path';

const TAIL_INITIAL_BYTES = 256 * 1024;
const RESCAN_INTERVAL_MS = 4_000;
const FILE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const MAX_TAILED_FILES = 20;

class JsonlTailer {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.remainder = '';
    this.initialized = false;
  }

  poll() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return;
    }
    if (!this.initialized) {
      this.initialized = true;
      const start = Math.max(0, stat.size - TAIL_INITIAL_BYTES);
      this.readFrom(start, stat.size, start > 0, true);
      return;
    }
    if (stat.size < this.offset) {
      // File was truncated or rewritten; re-tail from the end, capped like
      // the initial read so a rewritten large file is never read in full.
      this.remainder = '';
      const start = Math.max(0, stat.size - TAIL_INITIAL_BYTES);
      this.readFrom(start, stat.size, start > 0, false);
    } else if (stat.size > this.offset) {
      this.readFrom(this.offset, stat.size, false, false);
    }
  }

  readFrom(start, end, skipFirstPartialLine, initial) {
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
      const length = end - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      this.offset = end;
      let text = this.remainder + buffer.toString('utf8');
      if (skipFirstPartialLine) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline === -1) return;
        text = text.slice(firstNewline + 1);
      }
      const lines = text.split('\n');
      this.remainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        try {
          this.onLine(parsed, { filePath: this.filePath, initial });
        } catch (error) {
          console.error(`[tail] handler error for ${this.filePath}:`, error.message);
        }
      }
    } catch {
      // File may have disappeared between stat and read; retry next poll.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

function findRecentFiles(rootDirectory, filePattern, maxDepth) {
  const results = [];
  const walk = (directory, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && filePattern.test(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          if (Date.now() - stat.mtimeMs < FILE_MAX_AGE_MS) {
            results.push({ path: fullPath, mtimeMs: stat.mtimeMs });
          }
        } catch {
          // Ignore files that vanish mid-scan.
        }
      }
    }
  };
  walk(rootDirectory, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, MAX_TAILED_FILES);
}

export function watchJsonl({ rootDirectory, filePattern, maxDepth = 4, onLine }) {
  const tailers = new Map();

  const rescan = () => {
    const recentPaths = new Set();
    for (const file of findRecentFiles(rootDirectory, filePattern, maxDepth)) {
      recentPaths.add(file.path);
      if (!tailers.has(file.path)) {
        tailers.set(file.path, new JsonlTailer(file.path, onLine));
      }
    }
    // Drop tailers for files that aged out so stat cost stays bounded.
    for (const filePath of tailers.keys()) {
      if (!recentPaths.has(filePath)) tailers.delete(filePath);
    }
    for (const tailer of tailers.values()) tailer.poll();
  };

  rescan();
  setInterval(rescan, RESCAN_INTERVAL_MS).unref();

  let pollTimer = null;
  try {
    fs.watch(rootDirectory, { recursive: true }, () => {
      // Debounce: watch events arrive in bursts while logs are written.
      if (pollTimer) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        for (const tailer of tailers.values()) tailer.poll();
      }, 100);
    });
  } catch {
    // Recursive fs.watch is best-effort; the rescan interval still covers us.
  }
}
