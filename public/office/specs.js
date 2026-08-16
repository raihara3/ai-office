// Per-vendor avatar appearance (body/accent/head/eye colors and the emblem
// drawn on the chest and chat face). Shared by the canvas renderer and the
// sidebar face icons, so both stay in sync from one source of truth.

export const CLI_SPECS = {
  claude: {
    colors: { body: '#d97757', accent: '#f5e6d3', head: '#b85c3e', eye: '#ffe9c9' },
    emblem: 'asterisk',
  },
  codex: {
    colors: { body: '#e8e8e8', accent: '#111111', head: '#222222', eye: '#8be9fd' },
    emblem: 'knot',
  },
  gemini: {
    colors: { body: '#4285f4', accent: '#d8c7ff', head: '#3367d6', eye: '#ffffff' },
    emblem: 'sparkle',
  },
};

// The HR avatar by the entrance that runs the retirement cleanup.
export const HR_SPEC = {
  colors: { body: '#8a93a6', accent: '#f5d76e', head: '#5b6270', eye: '#ffffff' },
  emblem: 'badge',
};
