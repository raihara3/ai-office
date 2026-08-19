// Canvas rendering for the pixel-art office.
// One CLI session = one avatar. All vendors share a single desk grid that
// fills from the top-left as sessions appear. An HR avatar by the entrance
// retires sessions whose CLI process has exited (logs go to the Trash).
// app.js pushes state via OFFICE.setState(); this file owns the draw loop.
// Pure geometry, vendor specs and the break-room small talk live in the
// ./office/ modules so this file is just the canvas rendering.

import { CLI_SPECS, UNSET_SPEC } from './office/specs.js';
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
  residentDeskHitRect,
  SEAT_COUNT,
  WHITEBOARD,
} from './office/layout.js';
import { createSmallTalk } from './office/small-talk.js';

(() => {
  const canvas = document.getElementById('office');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const WALK_SPEED = 1.6;
  const LEAVE_SPEED = 2.6;
  const MOOD_LABELS = { inspect: '確認中', think: '考え中', work: '作業中' };

  let state = { employees: [] };
  // key -> {employee, leaving} — keeps departed sessions around while the
  // avatar walks to the door.
  const presence = new Map();
  // resident name -> its most recently active session. Resident-run sessions
  // are visualized at the resident island, never on the free-address grid.
  let residentEmployees = new Map();
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
    const spec = kind === 'hr' ? UNSET_SPEC : CLI_SPECS[kind];
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
      residentEmployees = new Map();
      for (const employee of next.employees) {
        if (employee.resident) {
          const known = residentEmployees.get(employee.resident);
          if (!known || (employee.lastEventAt ?? 0) > (known.lastEventAt ?? 0)) {
            residentEmployees.set(employee.resident, employee);
          }
          continue;
        }
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

  // The window sky gradient is position-independent, so build it once.
  let windowSky = null;

  // Shadow-blurred text is expensive to rasterize, so the neon sign is
  // rendered once into an offscreen sprite and stamped each frame.
  let neonSignSprite = null;
  function drawNeonSign(x, y) {
    if (!neonSignSprite) {
      neonSignSprite = document.createElement('canvas');
      neonSignSprite.width = 122;
      neonSignSprite.height = 34;
      const sign = neonSignSprite.getContext('2d');
      sign.beginPath();
      sign.roundRect(0, 0, 122, 34, 6);
      sign.fillStyle = '#2e3440';
      sign.fill();
      sign.font = 'bold 16px "Hiragino Sans", sans-serif';
      sign.textAlign = 'center';
      sign.shadowColor = '#5ad1a0';
      sign.shadowBlur = 8;
      sign.fillStyle = '#7ee2b8';
      sign.fillText('AI OFFICE', 61, 23);
    }
    ctx.drawImage(neonSignSprite, x, y);
  }

  function drawRoom(time, layout) {
    const height = layout.height;
    // wall: warm plaster with a crown line and a baseboard
    px(0, 0, CANVAS_WIDTH, 96, '#ece6da');
    px(0, 0, CANVAS_WIDTH, 6, '#ddd5c6');
    px(0, 86, CANVAS_WIDTH, 10, '#c9c0ae');
    // daylight windows: slim dark frames, sky gradient, drifting clouds
    if (!windowSky) {
      windowSky = ctx.createLinearGradient(0, 16, 0, 74);
      windowSky.addColorStop(0, '#8ecff0');
      windowSky.addColorStop(1, '#cdeaf7');
    }
    for (const wx of [60, 310, 560, 810]) {
      px(wx - 4, 12, 104, 66, '#3d4852');
      ctx.fillStyle = windowSky;
      ctx.fillRect(wx, 16, 96, 58);
      ctx.save();
      ctx.beginPath();
      ctx.rect(wx, 16, 96, 58);
      ctx.clip();
      const drift = ((time / 150 + wx) % 140) - 20;
      px(wx + drift, 28, 26, 7, 'rgba(255, 255, 255, 0.9)');
      px(wx + drift + 6, 23, 14, 6, 'rgba(255, 255, 255, 0.9)');
      px(wx + ((drift + 70) % 140), 48, 20, 6, 'rgba(255, 255, 255, 0.7)');
      ctx.restore();
      px(wx + 46, 16, 4, 58, '#3d4852');
      px(wx, 42, 96, 3, '#3d4852');
      px(wx - 6, 74, 108, 6, '#f7f3ea');
    }
    drawWhiteboard();
    // neon company sign on a dark mounting board
    drawNeonSign(672, 30);
    // oak plank floor with staggered seams
    for (let ty = 96; ty < height; ty += 24) {
      const row = (ty - 96) / 24;
      px(0, ty, CANVAS_WIDTH, 24, row % 2 === 0 ? '#d6b489' : '#cfab7e');
      ctx.fillStyle = 'rgba(90, 62, 40, 0.14)';
      ctx.fillRect(0, ty, CANVAS_WIDTH, 2);
      for (let sx = (row % 3) * 110; sx < CANVAS_WIDTH; sx += 320) {
        ctx.fillRect(sx, ty, 2, 24);
      }
    }
    // soft shadow the wall casts on the floor
    px(0, 96, CANVAS_WIDTH, 5, 'rgba(0, 0, 0, 0.10)');
    drawResidentRoom(time);
    drawBreakArea(layout);
    // plants (the left edge is now the resident room, so only the right stays)
    drawPlant(930, 180);
    drawPlant(930, height - 30);
    // entrance door, spanning the same y band as the break area
    const door = doorPosition(layout);
    const doorTop = layout.breakTop + 10;
    px(0, doorTop, 18, 112, '#8a8172');
    px(4, doorTop + 6, 10, 100, '#4e463c');
    roundRect(door.x - 20, door.y + 4, 52, 12, 4, '#607d8b');
    roundRect(door.x - 16, layout.breakTop - 22, 56, 18, 4, '#2f5d50');
    ctx.fillStyle = '#8fe3a5';
    ctx.font = 'bold 11px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EXIT', door.x + 12, layout.breakTop - 9);

    // wall clock (real time)
    ctx.save();
    ctx.beginPath();
    ctx.arc(480, 48, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#fbf8f2';
    ctx.fill();
    ctx.strokeStyle = '#4e463c';
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

  // The whiteboard on the top wall where residents post reports for the
  // human. Unread reports show as a count badge (red when one of them needs
  // review); clicking the board opens the report panel (see app.js).
  function drawWhiteboard() {
    const board = WHITEBOARD;
    ctx.lineWidth = 2;
    roundRect(board.x, board.y, board.width, board.height, 4, '#fbfaf6', '#b9b2a2');
    px(board.x + 8, board.y + 12, 40, 3, '#7aa2f7');
    px(board.x + 8, board.y + 20, 56, 3, '#c9c2b2');
    px(board.x + 8, board.y + 28, 48, 3, '#c9c2b2');
    px(board.x + 8, board.y + 36, 30, 3, '#e0707a');
    // pen tray under the board
    px(board.x + 26, board.y + board.height + 0, 44, 4, '#b9b2a2');
    const counts = state.whiteboard;
    if (counts && counts.unread > 0) {
      const badgeX = board.x + board.width - 3;
      const badgeY = board.y + 3;
      ctx.fillStyle = counts.reviewNeeded > 0 ? '#d93a4a' : '#e0952f';
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px "Hiragino Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.min(counts.unread, 99)), badgeX, badgeY + 4);
    }
  }

  // The resident team's corner on the left edge: an open (wall-less) carpeted
  // patch holding an island of four always-present full-size desks (two
  // columns of two). A seat with no resident assigned keeps the neutral gray
  // avatar; an assigned seat wears its CLI's colors, faces the room while
  // idle, and turns to the monitor while a run is in progress. Residents
  // never walk to the break room or the exit — they live at their desk.
  function drawResidentRoom(time) {
    const room = RESIDENT_ROOM;
    // a sage carpet-tile patch marks the area off from the oak floor while
    // staying in the office's warm, low-saturation palette. Clipped to a
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
        px(tx, ty, 48, 48, even ? '#a9bfa4' : '#a0b69a');
      }
    }
    ctx.restore();

    const residents = state.residents ?? [];
    for (let index = 0; index < RESIDENT_DESK_COUNT; index += 1) {
      const desk = residentDeskPosition(index);
      const resident = residents.find((r) => r.seat === index);
      if (!resident) {
        // Unassigned: gray avatar facing the room, screen off.
        drawDeskFurniture(desk.x, desk.y, SCREEN_OFF);
        drawAvatar(UNSET_SPEC, desk.x, desk.y + 18, { time });
        continue;
      }
      drawResidentSeat(resident, desk, time);
    }

    // sign (dark so it reads on the sage carpet)
    ctx.fillStyle = '#3c4a38';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('常駐チーム', room.x + 8, room.y + 22);
  }

  // One assigned resident seat: nameplate in the vendor color, and the
  // three-state avatar — running (typing at the lit monitor, with the usual
  // status bubble and subagent minis), paused (⏸ on the dark screen) or
  // simply waiting for the next trigger (facing the room).
  function drawResidentSeat(resident, desk, time) {
    const spec = CLI_SPECS[resident.cli] ?? UNSET_SPEC;
    const employee = residentEmployees.get(resident.name);
    const sessionActive =
      employee && (employee.status === 'working' || employee.status === 'blocked');
    const active = Boolean(resident.busy || sessionActive);

    ctx.textAlign = 'center';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    const labelWidth = ctx.measureText(resident.displayName).width + 16;
    roundRect(desk.x - labelWidth / 2, desk.y - 106, labelWidth, 18, 9, 'rgba(38, 36, 50, 0.85)');
    ctx.fillStyle = spec.colors.body;
    ctx.fillText(resident.displayName, desk.x, desk.y - 93);

    drawDeskFurniture(desk.x, desk.y, active ? '#1a2b3c' : SCREEN_OFF);
    if (active) {
      drawScreenCode(desk.x, desk.y, time, resident.name);
    } else if (!resident.enabled) {
      ctx.fillStyle = '#5c6670';
      ctx.font = 'bold 13px "Hiragino Sans", sans-serif';
      ctx.fillText('⏸', desk.x, desk.y - 63);
    }

    drawAvatar(spec, desk.x, desk.y + 18, { time, typing: active, facingAway: active });
    if (active && employee) {
      const actor = actorFor(`resident:${resident.name}`, { x: desk.x, y: desk.y + 18 }, time);
      drawSubagents(employee, spec, actor, desk.x, desk.y, time);
      if (employee.status === 'blocked') {
        drawBubble(desk.x, desk.y - 40, '・・・');
      } else {
        drawBubble(desk.x, desk.y - 40, MOOD_LABELS[employee.activityKind] ?? '作業中');
      }
    }
  }

  // The desk furniture shared by occupied and vacant desks: chair, steel
  // legs, white top, monitor shell, stand and keyboard. Only the screen fill
  // varies, so occupied desks can light it up (and animate over it). Vacant
  // seats — free-address or the resident island — pass the powered-off color.
  const SCREEN_OFF = '#0b0d10';
  function drawDeskFurniture(x, y, screenColor) {
    roundRect(x - 13, y + 8, 26, 12, 4, '#37474f');
    px(x - 52, y - 6, 6, 16, '#9aa3ac');
    px(x + 46, y - 6, 6, 16, '#9aa3ac');
    px(x - 56, y - 46, 112, 40, '#f4efe6');
    px(x - 56, y - 46, 112, 5, '#fbf8f2');
    px(x - 56, y - 10, 112, 4, '#d9d2c4');
    px(x - 26, y - 84, 52, 34, '#22262b');
    px(x - 23, y - 81, 46, 28, screenColor);
    px(x - 3, y - 50, 6, 6, '#5c6670');
    px(x - 20, y - 38, 40, 7, '#cfd4d9');
  }

  // Scrolling code lines on a lit monitor, seeded per occupant so desks don't
  // animate in lockstep.
  function drawScreenCode(x, y, time, seedKey) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 23, y - 81, 46, 28);
    ctx.clip();
    const scroll = (time / 120) % 8;
    for (let i = -1; i < 5; i += 1) {
      const lineY = y - 79 + i * 7 + scroll;
      const width = 12 + ((i * 37 + seedKey.length * 13) % 24);
      px(x - 19, lineY, width, 2, i % 3 === 0 ? '#7aa2f7' : '#9ece6a');
    }
    ctx.restore();
  }

  // A café-style break corner: checkered tiles, a walnut coffee counter under
  // pendant lamps, round café tables, a mustard sofa and a plant. Aligned with
  // the entrance at the bottom band.
  function drawBreakArea(layout) {
    const top = layout.breakTop;
    // checkered café tiles
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(140, top, 690, 132, 12);
    ctx.clip();
    for (let ty = 0; ty < 132; ty += 22) {
      for (let tx = 0; tx < 690; tx += 22) {
        const even = ((tx + ty) / 22) % 2 === 0;
        px(140 + tx, top + ty, 22, 22, even ? '#efe6d3' : '#ddd0b6');
      }
    }
    ctx.restore();
    ctx.lineWidth = 3;
    roundRect(140, top, 690, 132, 12, null, '#b3a68d');

    // walnut coffee counter along the inside top-right
    px(640, top + 10, 172, 30, '#4e342e');
    px(640, top + 10, 172, 5, '#7b5e57');
    // espresso machine on the counter
    px(654, top - 16, 34, 30, '#2e3440');
    px(661, top - 9, 20, 10, '#80cbc4');
    px(666, top + 6, 10, 6, '#1c2128');
    // cups
    px(756, top + 2, 8, 8, '#fbf8f2');
    px(770, top + 2, 8, 8, '#fbf8f2');
    // pendant lamps hanging over the counter, with warm pools of light
    for (const lampX of [706, 756, 800]) {
      px(lampX - 1, top - 34, 2, 24, '#4e463c');
      ctx.fillStyle = '#2e3440';
      ctx.beginPath();
      ctx.moveTo(lampX - 10, top - 2);
      ctx.lineTo(lampX + 10, top - 2);
      ctx.lineTo(lampX + 5, top - 12);
      ctx.lineTo(lampX - 5, top - 12);
      ctx.closePath();
      ctx.fill();
      px(lampX - 4, top - 2, 8, 3, '#ffd97a');
      ctx.fillStyle = 'rgba(255, 214, 120, 0.18)';
      ctx.beginPath();
      ctx.ellipse(lampX, top + 18, 20, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // round café tables: white tops on dark pedestals
    for (const tableX of [301, 481]) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.beginPath();
      ctx.ellipse(tableX, top + 100, 18, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      px(tableX - 3, top + 84, 6, 14, '#37474f');
      ctx.fillStyle = '#5d4037';
      ctx.beginPath();
      ctx.arc(tableX, top + 84, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8d5b5';
      ctx.beginPath();
      ctx.arc(tableX, top + 84, 14, 0, Math.PI * 2);
      ctx.fill();
      // a shared coffee pot in the middle
      px(tableX - 4, top + 76, 8, 8, '#2e3440');
      px(tableX + 4, top + 78, 3, 4, '#2e3440');
    }

    // mustard sofa with teal cushions (avatars settle in front)
    px(654, top + 46, 8, 36, '#c98f2d');
    px(742, top + 46, 8, 36, '#c98f2d');
    px(660, top + 46, 84, 14, '#c98f2d');
    px(662, top + 58, 80, 24, '#e0a63c');
    px(668, top + 50, 18, 10, '#3f7d74');
    px(716, top + 50, 18, 10, '#3f7d74');

    // plant in the corner of the area
    drawPlant(812, top + 124);

    // sign
    ctx.fillStyle = '#5a4632';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('☕ BREAK ROOM', 152, top - 8);
  }

  function drawPlant(x, y) {
    // terracotta pot with layered monstera-like foliage
    px(x - 11, y - 16, 22, 16, '#c96f4a');
    px(x - 11, y - 16, 22, 4, '#b35f3d');
    ctx.fillStyle = '#3e8e52';
    ctx.beginPath();
    ctx.arc(x - 8, y - 22, 9, 0, Math.PI * 2);
    ctx.arc(x + 8, y - 22, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5cb86e';
    ctx.beginPath();
    ctx.arc(x, y - 30, 11, 0, Math.PI * 2);
    ctx.arc(x - 10, y - 32, 6, 0, Math.PI * 2);
    ctx.arc(x + 10, y - 32, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawDesk(deskLabel, x, y, time, employeeKey, spec, working) {
    // nameplate: repository / work name on a Gather-style dark chip, tinted
    // with the vendor color so it reads on the light oak floor. It hugs the
    // monitor so the desk rows can pack tightly.
    ctx.textAlign = 'center';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    const labelWidth = ctx.measureText(deskLabel).width + 16;
    roundRect(x - labelWidth / 2, y - 106, labelWidth, 18, 9, 'rgba(38, 36, 50, 0.85)');
    ctx.fillStyle = spec.colors.body;
    ctx.fillText(deskLabel, x, y - 93);

    drawDeskFurniture(x, y, working ? '#1a2b3c' : SCREEN_OFF);
    if (working) drawScreenCode(x, y, time, employeeKey);
    // a small personal prop, picked deterministically per session
    const prop = employeeKey.length % 3;
    if (prop === 0) {
      // succulent in a terracotta pot
      px(x + 36, y - 50, 10, 8, '#c96f4a');
      px(x + 38, y - 56, 6, 6, '#5cb86e');
      px(x + 35, y - 53, 4, 4, '#3e8e52');
      px(x + 43, y - 53, 4, 4, '#3e8e52');
    } else if (prop === 1) {
      // coffee mug
      px(x + 37, y - 50, 9, 8, '#e0707a');
      px(x + 46, y - 48, 3, 4, '#e0707a');
    } else {
      // a short stack of books
      px(x + 34, y - 46, 16, 4, '#3f7d74');
      px(x + 36, y - 50, 14, 4, '#d9a441');
    }
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
    // white bubble with a thin outline so it stays visible on light floors
    ctx.lineWidth = 1.5;
    roundRect(left, y - height, width, height, 7, '#ffffff', 'rgba(60, 54, 72, 0.45)');
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 6);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
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
      ctx.fillStyle = '#4a4136';
      ctx.textAlign = 'center';
      ctx.fillText(String(subagent.label).slice(0, 10), x, y + 12);
    });
    if (employee.subagents.length > 2) {
      ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
      ctx.fillStyle = '#2e7d32';
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
    drawAvatar(UNSET_SPEC, x, y, { time });
    ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
    ctx.fillStyle = '#4a4136';
    ctx.textAlign = 'center';
    ctx.fillText('人事', x, y + 14);
    if (hrBubble && hrBubble.until > Date.now()) {
      drawBubble(x, y - 56, hrBubble.text);
    } else if (!hrBubble || hrBubble.until <= Date.now()) {
      hrBubble = null;
    }
  }

  // --- pointer targets --------------------------------------------------

  // Canvas pixels from a mouse event; the canvas is CSS-scaled to fit.
  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function isInside(point, area) {
    return (
      point.x >= area.x &&
      point.x <= area.x + area.width &&
      point.y >= area.y &&
      point.y <= area.y + area.height
    );
  }

  function residentSeatAt(point) {
    for (let index = 0; index < RESIDENT_DESK_COUNT; index += 1) {
      if (isInside(point, residentDeskHitRect(index))) return index;
    }
    return null;
  }

  // The whiteboard and the resident desks open panels owned by app.js; the
  // canvas only reports the hits as window events to stay DOM-agnostic.
  canvas.addEventListener('click', (event) => {
    const point = canvasPoint(event);
    if (isInside(point, WHITEBOARD)) {
      window.dispatchEvent(new CustomEvent('office:whiteboard-open'));
      return;
    }
    const seat = residentSeatAt(point);
    if (seat !== null) {
      const resident = (state.residents ?? []).find((r) => r.seat === seat);
      window.dispatchEvent(
        new CustomEvent('office:resident-seat-open', {
          detail: { seat, name: resident?.name ?? null },
        })
      );
    }
  });

  canvas.addEventListener('mousemove', (event) => {
    const point = canvasPoint(event);
    const clickable = isInside(point, WHITEBOARD) || residentSeatAt(point) !== null;
    canvas.style.cursor = clickable ? 'pointer' : 'default';
  });

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
    // The eight free-address seats are furnished up front; vacant ones show
    // an empty desk until a session clocks in and claims the seat.
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      if (!usedSeats.has(seat)) {
        const desk = deskPosition(seat);
        drawDeskFurniture(desk.x, desk.y, SCREEN_OFF);
      }
    }
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
      drawDesk(employee.project ?? employee.name, desk.x, desk.y, time, key, spec, atDeskStatus);

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
