// Canvas rendering for the pixel-art office.
// One CLI session = one avatar. All vendors share a single desk grid that
// fills from the top-left as sessions appear. An HR avatar by the entrance
// retires sessions whose CLI process has exited (logs go to the Trash).
// app.js pushes state via OFFICE.setState(); this file owns the draw loop.
// Pure geometry, vendor specs and the break-room small talk live in the
// ./office/ modules so this file is just the canvas rendering.

import { CLI_SPECS, HR_SPEC } from './office/specs.js';
import {
  CANVAS_WIDTH,
  computeLayout,
  deskPosition,
  breakSpot,
  doorPosition,
  lowestFreeSeat,
  RESIDENT_ROOM,
  RESIDENT_DESK_COUNT,
  residentDeskPosition,
} from './office/layout.js';
import { createSmallTalk } from './office/small-talk.js';

(() => {
  const canvas = document.getElementById('office');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const WALK_SPEED = 1.6;
  const LEAVE_SPEED = 2.6;

  let state = { employees: [] };
  // key -> {employee, leaving} — keeps departed sessions around while the
  // avatar walks to the door.
  const presence = new Map();
  const actors = new Map();
  const seatByKey = new Map();
  const usedSeats = new Set();
  let hrBubble = null;

  // Break-room chatter (see ./office/small-talk.js). restingKeys is refreshed
  // at the end of each frame with whoever is currently on break.
  const smallTalk = createSmallTalk();
  let restingKeys = [];

  // Small face icons for the chat sidebar, rendered once and cached.
  const faceCache = new Map();
  function faceDataUrl(kind) {
    if (faceCache.has(kind)) return faceCache.get(kind);
    const faceCanvas = document.createElement('canvas');
    faceCanvas.width = 36;
    faceCanvas.height = 36;
    const face = faceCanvas.getContext('2d');
    face.imageSmoothingEnabled = false;
    if (kind === 'user') {
      // The boss: a human silhouette in a calm neutral tone.
      face.fillStyle = '#a9b1d6';
      face.beginPath();
      face.arc(18, 13, 7, 0, Math.PI * 2);
      face.fill();
      face.beginPath();
      face.arc(18, 34, 12, Math.PI, Math.PI * 2);
      face.fill();
      const url = faceCanvas.toDataURL();
      faceCache.set(kind, url);
      return url;
    }
    const spec = kind === 'hr' ? HR_SPEC : CLI_SPECS[kind];
    if (!spec) return null;
    // head
    face.beginPath();
    face.roundRect(3, 9, 30, 24, 7);
    face.fillStyle = spec.colors.head;
    face.fill();
    // face screen
    face.beginPath();
    face.roundRect(7, 14, 22, 15, 4);
    face.fillStyle = '#14141c';
    face.fill();
    // eyes
    face.fillStyle = spec.colors.eye;
    face.fillRect(11, 18, 5, 5);
    face.fillRect(20, 18, 5, 5);
    // claude's antenna
    if (spec.emblem === 'asterisk') {
      face.fillStyle = spec.colors.head;
      face.fillRect(16, 3, 4, 7);
      face.fillStyle = spec.colors.body;
      face.beginPath();
      face.arc(18, 4, 3.5, 0, Math.PI * 2);
      face.fill();
    }
    const url = faceCanvas.toDataURL();
    faceCache.set(kind, url);
    return url;
  }

  window.OFFICE = {
    faceDataUrl,
    // Shown above the HR avatar when the sidebar composer runs a cleanup.
    hrSay(text) {
      hrBubble = { text, until: Date.now() + 5000 };
    },
    setState(next) {
      state = next;
      const seen = new Set();
      for (const employee of next.employees) {
        seen.add(employee.key);
        presence.set(employee.key, { employee, leaving: false });
        if (!seatByKey.has(employee.key)) {
          const seat = lowestFreeSeat(usedSeats);
          usedSeats.add(seat);
          seatByKey.set(employee.key, seat);
        }
      }
      for (const [key, entry] of presence) {
        if (!seen.has(key) && !entry.leaving) {
          entry.leaving = true;
          const seat = seatByKey.get(key);
          if (seat !== undefined) {
            usedSeats.delete(seat);
            seatByKey.delete(key);
          }
        }
      }
    },
  };

  // --- actors ----------------------------------------------------------

  function actorFor(key, spawnAt, time) {
    let actor = actors.get(key);
    if (!actor) {
      actor = {
        x: spawnAt.x,
        y: spawnAt.y,
        walking: false,
        subagentPop: new Map(),
        // Morning greeting shown right after entering the office.
        greetUntil: time + 3500,
      };
      actors.set(key, actor);
    }
    return actor;
  }

  // --- primitives ------------------------------------------------------

  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function roundRect(x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  // --- room ------------------------------------------------------------

  function drawRoom(time, layout) {
    const height = layout.height;
    // wall
    px(0, 0, CANVAS_WIDTH, 96, '#4a4458');
    px(0, 88, CANVAS_WIDTH, 8, '#3a3547');
    for (const wx of [70, 330, 590, 820]) {
      px(wx, 20, 70, 52, '#2b2640');
      const glow = 0.5 + 0.5 * Math.sin(time / 4000);
      ctx.fillStyle = `rgba(137, 180, 250, ${0.35 + glow * 0.2})`;
      ctx.fillRect(wx + 4, 24, 62, 44);
      px(wx + 33, 24, 4, 44, '#2b2640');
      px(wx + 4, 44, 62, 3, '#2b2640');
    }
    // floor tiles
    for (let ty = 96; ty < height; ty += 48) {
      for (let tx = 0; tx < CANVAS_WIDTH; tx += 48) {
        const even = ((tx + ty) / 48) % 2 === 0;
        px(tx, ty, 48, 48, even ? '#8a7a6b' : '#93826f');
      }
    }
    drawResidentRoom();
    drawBreakArea(layout);
    // plants (the left edge is now the resident room, so only the right stays)
    drawPlant(930, 180);
    drawPlant(930, height - 30);
    // entrance door, spanning the same y band as the break area
    const door = doorPosition(layout);
    const doorTop = layout.breakTop + 10;
    px(0, doorTop, 18, 112, '#3a3547');
    px(4, doorTop + 6, 10, 100, '#26232e');
    roundRect(door.x - 20, door.y + 4, 52, 12, 4, '#5d4037');
    roundRect(door.x - 16, layout.breakTop - 22, 56, 18, 4, '#204d32');
    ctx.fillStyle = '#8fe3a5';
    ctx.font = 'bold 11px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EXIT', door.x + 12, layout.breakTop - 9);

    // wall clock (real time)
    ctx.save();
    ctx.beginPath();
    ctx.arc(480, 48, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#f5f0e8';
    ctx.fill();
    ctx.strokeStyle = '#2b2640';
    ctx.lineWidth = 3;
    ctx.stroke();
    const now = new Date();
    const minuteAngle = (now.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2;
    const hourAngle = ((now.getHours() % 12) / 12 + now.getMinutes() / 720) * Math.PI * 2 - Math.PI / 2;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(480, 48);
    ctx.lineTo(480 + Math.cos(hourAngle) * 10, 48 + Math.sin(hourAngle) * 10);
    ctx.moveTo(480, 48);
    ctx.lineTo(480 + Math.cos(minuteAngle) * 16, 48 + Math.sin(minuteAngle) * 16);
    ctx.stroke();
    ctx.restore();
  }

  // The resident team's corner on the left edge: an open (wall-less) greige
  // floor patch holding an island of four always-present full-size desks (two
  // columns of two). Purely decorative furniture for now — no avatars are
  // seated here, leaving the island for a resident team to move in later.
  function drawResidentRoom() {
    const room = RESIDENT_ROOM;
    // a muted greige floor with a faint checker marks the area off from the
    // office while blending with its warm, low-saturation tones. Clipped to a
    // soft-cornered rect so the checker stops cleanly without partition walls.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(room.x, room.y, room.width, room.height, 10);
    ctx.clip();
    const bottom = room.y + room.height;
    const right = room.x + room.width;
    for (let ty = room.y; ty < bottom; ty += 48) {
      for (let tx = room.x; tx < right; tx += 48) {
        const even = ((tx + ty) / 48) % 2 === 0;
        px(tx, ty, 48, 48, even ? '#bcae99' : '#b3a48d');
      }
    }
    ctx.restore();

    // Empty desks, each with an empty chair tucked beneath it.
    for (let index = 0; index < RESIDENT_DESK_COUNT; index += 1) {
      const desk = residentDeskPosition(index);
      drawResidentDesk(desk.x, desk.y);
    }

    // sign (dark so it reads on the greige floor)
    ctx.fillStyle = '#4a3b2a';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('常駐チーム', room.x + 8, room.y + 22);
  }

  // A full-size unoccupied desk matching the main desks' dimensions, drawn
  // upright: legs and empty chair at the bottom, then the desktop with a
  // powered-off monitor and keyboard sitting on top of it.
  function drawResidentDesk(centerX, centerY) {
    ctx.save();
    ctx.translate(centerX, centerY);
    roundRect(-13, 34, 26, 12, 4, '#3f3a4a');
    px(-52, 20, 8, 14, '#5d4037');
    px(44, 20, 8, 14, '#5d4037');
    px(-56, -20, 112, 40, '#6d4c41');
    px(-56, -20, 112, 6, '#8d6e63');
    px(-26, -58, 52, 36, '#263238');
    px(-22, -54, 44, 28, '#111418');
    px(-4, -22, 8, 4, '#455a64');
    px(-20, -12, 40, 8, '#455a64');
    ctx.restore();
  }

  // An office break corner: wooden floor, coffee counter, café tables,
  // a sofa and a plant. Aligned with the entrance at the bottom band.
  function drawBreakArea(layout) {
    const top = layout.breakTop;
    // wooden floor with plank lines
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(140, top, 690, 132, 12);
    ctx.clip();
    ctx.fillStyle = '#a08055';
    ctx.fillRect(140, top, 690, 132);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    for (let plankY = top + 12; plankY < top + 132; plankY += 12) {
      ctx.fillRect(140, plankY, 690, 2);
    }
    ctx.restore();
    ctx.lineWidth = 3;
    roundRect(140, top, 690, 132, 12, null, '#7a5c3e');

    // coffee counter along the inside top-right
    px(640, top + 10, 172, 28, '#5d4037');
    px(640, top + 10, 172, 6, '#8d6e63');
    // coffee machine on the counter
    px(700, top - 16, 34, 30, '#37474f');
    px(707, top - 9, 20, 10, '#80cbc4');
    px(712, top + 6, 10, 6, '#263238');
    // cups
    px(756, top + 2, 8, 8, '#f5f0e8');
    px(770, top + 2, 8, 8, '#f5f0e8');

    // round café tables
    for (const tableX of [301, 481]) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.beginPath();
      ctx.ellipse(tableX, top + 100, 18, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6d4c41';
      ctx.beginPath();
      ctx.arc(tableX, top + 84, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#a1887f';
      ctx.beginPath();
      ctx.arc(tableX, top + 84, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.arc(tableX - 4, top + 80, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // sofa (avatars settle in front, looking like they sat down)
    px(654, top + 46, 8, 36, '#55796b');
    px(742, top + 46, 8, 36, '#55796b');
    px(660, top + 46, 84, 14, '#55796b');
    px(662, top + 58, 80, 24, '#6f9779');

    // plant in the corner of the area
    drawPlant(812, top + 124);

    // sign
    ctx.fillStyle = '#d7ccc8';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('☕ BREAK ROOM', 152, top - 8);
  }

  function drawPlant(x, y) {
    px(x - 10, y - 14, 20, 14, '#8d6e63');
    ctx.fillStyle = '#66bb6a';
    ctx.beginPath();
    ctx.arc(x, y - 24, 12, 0, Math.PI * 2);
    ctx.arc(x - 8, y - 16, 8, 0, Math.PI * 2);
    ctx.arc(x + 8, y - 16, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawDesk(deskLabel, x, y, mcpCall, time, employeeKey, spec, working) {
    // nameplate: repository / work name, tinted with the vendor color
    ctx.textAlign = 'center';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.fillStyle = '#2b2640';
    ctx.fillText(deskLabel, x + 1, y - 123);
    ctx.fillStyle = spec.colors.body;
    ctx.fillText(deskLabel, x, y - 124);
    // MCP badge between the nameplate and the monitor
    if (mcpCall) {
      ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
      const text = `🔌 ${mcpCall.server}`;
      const badgeWidth = ctx.measureText(text).width + 14;
      roundRect(x - badgeWidth / 2, y - 113, badgeWidth, 17, 8, '#33283a', '#bb9af7');
      ctx.fillStyle = '#bb9af7';
      ctx.fillText(text, x, y - 101);
    }

    // table
    px(x - 56, y - 46, 112, 40, '#6d4c41');
    px(x - 56, y - 46, 112, 6, '#8d6e63');
    px(x - 52, y - 6, 8, 14, '#5d4037');
    px(x + 44, y - 6, 8, 14, '#5d4037');
    // monitor
    px(x - 26, y - 84, 52, 36, '#263238');
    px(x - 22, y - 80, 44, 28, working ? '#1a2b3c' : '#111418');
    if (working) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 22, y - 80, 44, 28);
      ctx.clip();
      const scroll = (time / 120) % 8;
      for (let i = -1; i < 5; i += 1) {
        const lineY = y - 78 + i * 7 + scroll;
        const width = 12 + ((i * 37 + employeeKey.length * 13) % 24);
        px(x - 19, lineY, width, 2, i % 3 === 0 ? '#7aa2f7' : '#9ece6a');
      }
      ctx.restore();
    }
    px(x - 4, y - 48, 8, 4, '#455a64');
    // keyboard
    px(x - 20, y - 38, 40, 8, '#455a64');
  }

  // --- avatar ----------------------------------------------------------

  function drawEmblem(kind, x, y, scale, accent) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = accent;
    ctx.strokeStyle = accent;
    if (kind === 'asterisk') {
      ctx.lineWidth = 2.4;
      for (let i = 0; i < 3; i += 1) {
        ctx.save();
        ctx.rotate((i * Math.PI) / 3);
        ctx.beginPath();
        ctx.moveTo(0, -4.5);
        ctx.lineTo(0, 4.5);
        ctx.stroke();
        ctx.restore();
      }
    } else if (kind === 'knot') {
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        const method = i === 0 ? 'moveTo' : 'lineTo';
        ctx[method](Math.cos(a) * 4.5, Math.sin(a) * 4.5);
      }
      ctx.closePath();
      ctx.stroke();
    } else if (kind === 'sparkle') {
      ctx.beginPath();
      ctx.moveTo(0, -5.5);
      ctx.quadraticCurveTo(1.5, -1.5, 5.5, 0);
      ctx.quadraticCurveTo(1.5, 1.5, 0, 5.5);
      ctx.quadraticCurveTo(-1.5, 1.5, -5.5, 0);
      ctx.quadraticCurveTo(-1.5, -1.5, 0, -5.5);
      ctx.fill();
    } else if (kind === 'badge') {
      ctx.fillRect(-3, -4, 6, 8);
    }
    ctx.restore();
  }

  // (x, y) is the feet baseline center.
  function drawAvatar(spec, x, y, options) {
    const { colors, emblem } = spec;
    const scale = options.scale ?? 1;
    const s = (value) => value * scale;
    const walkPhase = options.walking ? Math.sin(options.time / 90) : 0;
    const bob = options.typing ? Math.sin(options.time / 160) * s(1) : 0;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(x, y + s(2), s(13), s(4), 0, 0, Math.PI * 2);
    ctx.fill();

    // legs
    px(x - s(7), y - s(10) + walkPhase * s(2), s(5), s(10), colors.head);
    px(x + s(2), y - s(10) - walkPhase * s(2), s(5), s(10), colors.head);
    // body
    roundRect(x - s(11), y - s(26) + bob, s(22), s(18), s(4), colors.body);
    drawEmblem(emblem, x, y - s(17) + bob, scale, colors.accent);
    // arms
    if (options.typing) {
      const armBob = Math.sin(options.time / 110) * s(1.5);
      px(x - s(14), y - s(22) + armBob, s(4), s(9), colors.body);
      px(x + s(10), y - s(22) - armBob, s(4), s(9), colors.body);
    } else {
      px(x - s(14), y - s(24) + bob, s(4), s(11), colors.body);
      px(x + s(10), y - s(24) + bob, s(4), s(11), colors.body);
    }
    // head
    roundRect(x - s(10), y - s(42) + bob, s(20), s(16), s(5), colors.head);
    if (!options.facingAway) {
      // face screen + eyes
      roundRect(x - s(7), y - s(39) + bob, s(14), s(10), s(3), '#14141c');
      const blink = Math.sin(options.time / 900 + x) > 0.97 ? 0.2 : 1;
      px(x - s(5), y - s(36) + bob, s(3), s(3) * blink, colors.eye);
      px(x + s(2), y - s(36) + bob, s(3), s(3) * blink, colors.eye);
    }
    // antenna for claude
    if (emblem === 'asterisk') {
      px(x - s(1), y - s(47) + bob, s(2), s(5), colors.head);
      ctx.fillStyle = colors.body;
      ctx.beginPath();
      ctx.arc(x, y - s(48) + bob, s(2.5), 0, Math.PI * 2);
      ctx.fill();
    }

    // coffee cup while on break
    if (options.coffee) {
      px(x + s(12), y - s(20), s(7), s(7), '#f5f0e8');
      px(x + s(19), y - s(18), s(2), s(3), '#f5f0e8');
      const steamY = (options.time / 60) % 12;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x + s(14), y - s(24) - steamY / 2, 2, 4);
    }
  }

  // --- bubbles ---------------------------------------------------------

  function wrapText(text, maxWidth) {
    const lines = [];
    let current = '';
    for (const char of text) {
      if (ctx.measureText(current + char).width > maxWidth) {
        lines.push(current);
        current = char;
        if (lines.length === 2) {
          lines[1] = lines[1].slice(0, -1);
          return { lines, truncated: true };
        }
      } else {
        current += char;
      }
    }
    if (current) lines.push(current);
    return { lines, truncated: false };
  }

  function drawBubble(x, y, text) {
    ctx.font = '11px "Hiragino Sans", sans-serif';
    const { lines, truncated } = wrapText(text, 150);
    if (truncated) lines[1] += '…';
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const height = lines.length * 15 + 10;
    const left = Math.min(Math.max(x - width / 2, 6), CANVAS_WIDTH - 6 - width);
    roundRect(left, y - height, width, height, 7, '#f5f0e8');
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 6);
    ctx.closePath();
    ctx.fillStyle = '#f5f0e8';
    ctx.fill();
    ctx.fillStyle = '#2b2640';
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      ctx.fillText(line, left + 8, y - height + 16 + i * 15);
    });
  }

  // Japanese beginner's mark (若葉マーク): yellow left half, green right half.
  function drawWakabaMark(x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 10, size / 10);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.quadraticCurveTo(-7, -6, -5, 0);
    ctx.quadraticCurveTo(-4, 5, 0, 7);
    ctx.closePath();
    ctx.fillStyle = '#f7d417';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.quadraticCurveTo(7, -6, 5, 0);
    ctx.quadraticCurveTo(4, 5, 0, 7);
    ctx.closePath();
    ctx.fillStyle = '#31a24c';
    ctx.fill();
    ctx.restore();
  }

  function drawSubagents(employee, spec, actor, deskX, deskY, time) {
    const shown = employee.subagents.slice(0, 2);
    shown.forEach((subagent, index) => {
      let pop = actor.subagentPop.get(subagent.key);
      if (pop === undefined) {
        pop = time;
        actor.subagentPop.set(subagent.key, pop);
      }
      const age = time - pop;
      const scale = 0.55 * Math.min(1, age / 300);
      const x = deskX - 34 + index * 34;
      const y = deskY + 52;
      drawAvatar(spec, x, y, { scale, typing: true, time: time + index * 400 });
      drawWakabaMark(x + 10 * scale, y - 46 * scale, 12 * scale);
      ctx.font = '9px "Hiragino Sans", sans-serif';
      ctx.fillStyle = '#f5f0e8';
      ctx.textAlign = 'center';
      ctx.fillText(String(subagent.label).slice(0, 10), x, y + 12);
    });
    if (employee.subagents.length > 2) {
      ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
      ctx.fillStyle = '#9ece6a';
      ctx.fillText(`+${employee.subagents.length - 2}`, deskX + 44, deskY + 52);
    }
    for (const key of actor.subagentPop.keys()) {
      if (!employee.subagents.some((s) => s.key === key)) actor.subagentPop.delete(key);
    }
  }

  // --- HR (cleanup) ----------------------------------------------------

  function drawHr(layout, time) {
    const door = doorPosition(layout);
    const x = door.x + 62;
    const y = door.y + 6;
    drawAvatar(HR_SPEC, x, y, { time });
    ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
    ctx.fillStyle = '#f5f0e8';
    ctx.textAlign = 'center';
    ctx.fillText('人事', x, y + 14);
    if (hrBubble && hrBubble.until > Date.now()) {
      drawBubble(x, y - 56, hrBubble.text);
    } else if (!hrBubble || hrBubble.until <= Date.now()) {
      hrBubble = null;
    }
  }

  // --- main loop -------------------------------------------------------

  function moveActor(actor, target, speed) {
    const dx = target.x - actor.x;
    const dy = target.y - actor.y;
    const distance = Math.hypot(dx, dy);
    if (distance < speed) {
      actor.x = target.x;
      actor.y = target.y;
      actor.walking = false;
    } else {
      actor.x += (dx / distance) * speed;
      actor.y += (dy / distance) * speed;
      actor.walking = true;
    }
  }

  function frame(time) {
    const layout = computeLayout(usedSeats);
    if (canvas.height !== layout.height) {
      canvas.height = layout.height;
      ctx.imageSmoothingEnabled = false;
    }
    drawRoom(time, layout);
    drawHr(layout, time);
    smallTalk.update(time, restingKeys);

    const door = doorPosition(layout);
    let breakIndex = 0;
    const nowResting = [];

    // Stable draw order by seat.
    const entries = [...presence.entries()].sort(
      (a, b) => (seatByKey.get(a[0]) ?? 999) - (seatByKey.get(b[0]) ?? 999)
    );

    for (const [key, entry] of entries) {
      const employee = entry.employee;
      const spec = CLI_SPECS[employee.cli];
      if (!spec) continue;

      if (entry.leaving) {
        const actor = actorFor(key, door, time);
        moveActor(actor, door, LEAVE_SPEED);
        if (!actor.walking) {
          presence.delete(key);
          actors.delete(key);
          continue;
        }
        drawAvatar(spec, actor.x, actor.y, { time, walking: true });
        if (employee.isSubagent) drawWakabaMark(actor.x + 12, actor.y - 50, 11);
        drawBubble(actor.x, actor.y - 58, 'お疲れさまでした');
        continue;
      }

      const seat = seatByKey.get(key);
      if (seat === undefined) continue;
      const desk = deskPosition(seat);
      // "blocked" (a tool call awaiting a result, e.g. command permission)
      // stays seated at the desk just like active work.
      const working =
        employee.status === 'working' || employee.status === 'blocked';
      const waiting = employee.status === 'waiting';
      const atDeskStatus = working || waiting;
      const mcpCall = employee.mcpCalls[employee.mcpCalls.length - 1];
      drawDesk(employee.project ?? employee.name, desk.x, desk.y, mcpCall, time, key, spec, atDeskStatus);

      const actor = actorFor(key, door, time);
      // Sit in front of the desk, facing the monitor, while working.
      const chairSpot = { x: desk.x, y: desk.y + 18 };
      const restSpot = breakSpot(breakIndex, layout);
      if (!atDeskStatus) breakIndex += 1;
      moveActor(actor, atDeskStatus ? chairSpot : restSpot, WALK_SPEED);

      const seated = working && !actor.walking;
      // Waiting for the user: stand in front of the desk, facing the room.
      const standing = waiting && !actor.walking;
      drawAvatar(spec, actor.x, actor.y, {
        time,
        walking: actor.walking,
        typing: seated,
        facingAway: seated,
        coffee: !atDeskStatus && !actor.walking,
      });
      if (employee.isSubagent) drawWakabaMark(actor.x + 12, actor.y - 50, 11);

      if (time < actor.greetUntil) {
        if (seated) drawSubagents(employee, spec, actor, desk.x, desk.y, time);
        drawBubble(actor.x, actor.y - 58, 'おはようございます');
      } else if (seated) {
        drawSubagents(employee, spec, actor, desk.x, desk.y, time);
        // "blocked" (a tool call still in flight — e.g. awaiting the boss's
        // command permission, or a long silent stretch mid-turn) shows "・・・"
        // and reverts to the normal label once fresh activity resumes.
        if (employee.status === 'blocked') {
          drawBubble(actor.x, actor.y - 58, '・・・');
        } else {
          const MOOD_LABELS = { inspect: '確認中', think: '考え中', work: '作業中' };
          drawBubble(actor.x, actor.y - 58, MOOD_LABELS[employee.activityKind] ?? '作業中');
        }
      } else if (standing) {
        drawBubble(actor.x, actor.y - 58, '🖐️');
      } else if (!atDeskStatus && !actor.walking) {
        nowResting.push(key);
        drawBubble(actor.x, actor.y - 56, smallTalk.bubbleFor(key) ?? '☕');
      }
    }
    restingKeys = nowResting;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
