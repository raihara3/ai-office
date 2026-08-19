// Session registry: the persistent mapping that keeps resident-run sessions
// off the free-address grid. The runner binds a path fragment — Claude's
// explicit session id, or the discovered transcript path for CLIs without an
// id flag — to a resident name; the core then asks `residentForFile` for every
// session log the watchers pick up. Persisted so a server restart cannot leak
// a resident session onto the free-address grid.

import fs from 'node:fs';
import path from 'node:path';

// Old bindings only matter while their transcripts are still tailed (sessions
// expire from the office after 3 days), so a modest cap keeps the file small.
const MAX_BINDINGS = 200;

export function createSessionRegistry({ filePath, fileSystem = fs, now = () => Date.now() }) {
  let bindings = [];
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed.bindings)) bindings = parsed.bindings;
  } catch {
    // First run or corrupt file: start empty.
  }

  function persist() {
    fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
    fileSystem.writeFileSync(filePath, `${JSON.stringify({ bindings }, null, 2)}\n`);
  }

  function bind(residentName, pathFragment) {
    if (!pathFragment) return;
    if (bindings.some((b) => b.fragment === pathFragment)) return;
    bindings.push({ resident: residentName, fragment: pathFragment, at: now() });
    if (bindings.length > MAX_BINDINGS) bindings = bindings.slice(-MAX_BINDINGS);
    persist();
  }

  // The resident owning this session log, or null for free-address sessions.
  // Newest bindings win, matching how a rebound fragment should behave.
  // A fragment that is itself a path (Codex/Gemini transcript discovery) must
  // match exactly — substring matching could mis-attribute an unrelated
  // session whose path merely contains it. Session-id fragments (Claude) are
  // UUIDs, where a substring match within the path is unambiguous.
  function residentForFile(sessionFilePath) {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const { resident, fragment } = bindings[index];
      const matches = fragment.includes(path.sep)
        ? sessionFilePath === fragment
        : sessionFilePath.includes(fragment);
      if (matches) return resident;
    }
    return null;
  }

  return { bind, residentForFile };
}
