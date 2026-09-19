// Installed-skill catalog: a read-only view of the Claude Code skills under
// ~/.claude/skills for the skills tab. Each skill is a directory holding a
// SKILL.md whose frontmatter names and describes it; the Markdown body after
// the frontmatter is the instruction text shown in the detail dialog. The
// directory is re-read on every call, so newly installed skills appear
// without a restart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SKILLS_DIRECTORY = path.join(os.homedir(), '.claude', 'skills');

// Minimal frontmatter reader: a leading `---` fence, `key: value` pairs until
// the closing fence. Claude Code skill frontmatter stays simple (name,
// description, keywords), so a YAML parser is not needed — but descriptions do
// use multi-line scalars, so indented continuation lines are folded onto the
// previous key with spaces (block-scalar indicators like `>` count as empty).
function parseSkillDocument(raw) {
  const frontmatter = {};
  if (!raw.startsWith('---\n')) return { frontmatter, body: raw.trim() };
  // Search from index 3 (the opening fence's newline) so an empty
  // frontmatter block (`---\n---\n`) still finds its closing fence.
  const closingFence = raw.indexOf('\n---', 3);
  if (closingFence === -1) return { frontmatter, body: raw.trim() };
  let currentKey = null;
  for (const line of raw.slice(4, closingFence).split('\n')) {
    if (/^\s/.test(line)) {
      if (currentKey !== null && line.trim() !== '') {
        frontmatter[currentKey] =
          frontmatter[currentKey] === '' ? line.trim() : `${frontmatter[currentKey]} ${line.trim()}`;
      }
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      currentKey = null;
      continue;
    }
    currentKey = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    frontmatter[currentKey] = /^[>|][+-]?$/.test(value) ? '' : value;
  }
  const bodyStart = raw.indexOf('\n', closingFence + 1);
  return { frontmatter, body: bodyStart === -1 ? '' : raw.slice(bodyStart + 1).trim() };
}

export function listSkills({ fileSystem = fs, skillsDirectory = DEFAULT_SKILLS_DIRECTORY } = {}) {
  let entries;
  try {
    entries = fileSystem.readdirSync(skillsDirectory, { withFileTypes: true });
  } catch {
    // No skills directory yet: an empty catalog, not an error.
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    const skillDirectory = path.join(skillsDirectory, entry.name);
    // Dirents do not stat symlink targets, and skills are commonly symlinked
    // in from a dotfiles repository — resolve those before filtering.
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = fileSystem.statSync(skillDirectory).isDirectory();
      } catch {
        // Broken link: not a skill.
      }
    }
    if (!isDirectory) continue;
    let raw;
    try {
      raw = fileSystem.readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8');
    } catch {
      // A directory without a readable SKILL.md is not a skill.
      continue;
    }
    const { frontmatter, body } = parseSkillDocument(raw);
    skills.push({
      id: entry.name,
      name: frontmatter.name || entry.name,
      description: frontmatter.description ?? '',
      body,
      directory: skillDirectory,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
