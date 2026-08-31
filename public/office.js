// Canvas rendering for the pixel-art office.
// One terminal CLI session = one visitor avatar: it steps out of the
// entrance elevator when the session starts, waits in the lobby while the
// answer is produced, and rides the elevator home once the turn is done.
// A receptionist avatar in the lobby retires sessions whose CLI process has
// exited (log files are kept on disk). app.js pushes state via
// OFFICE.setState(); this file owns the draw loop. Pure geometry and vendor
// specs live in the ./office/ modules so this file is just the rendering.

import { CLI_SPECS, UNSET_SPEC } from './office/specs.js';
import {
  computeLayout,
  entranceObstacles,
  entranceSpot,
  elevatorPosition,
  roomDeskPosition,
  roomDeskHitRect,
  roomMonitorHitRect,
  teamLabelHitRect,
  BENCH,
  ELEVATOR,
  PARTITION_HEIGHT,
  RECEPTION,
  WHITEBOARD,
} from './office/layout.js';
import { findPath } from './office/pathfinding.js';

(() => {
  const canvas = document.getElementById('office');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // Walk speeds are tuned in pixels per 60fps frame. The frame loop scales
  // them by elapsed time (see frame()) so avatars cover the same distance per
  // second regardless of the monitor's refresh rate.
  const WALK_SPEED = 1.6;
  const LEAVE_SPEED = 2.6;
  const REFERENCE_FRAME_MS = 1000 / 60;
  // Cap the per-frame step so a long pause (e.g. a backgrounded tab, where
  // requestAnimationFrame stops firing) does not teleport avatars on return.
  const MAX_FRAME_STEP = 3;
  const MOOD_LABELS = { inspect: '確認中', think: '考え中', work: '作業中' };

  let state = { employees: [] };
  // The scene geometry of the most recently drawn frame; hit-testing and
  // bubble clamping read this so clicks match what is on screen.
  let currentLayout = computeLayout([]);
  // key -> {employee, leaving} — keeps departed sessions around while the
  // avatar walks back into the elevator.
  const presence = new Map();
  // resident name -> its most recently active session. Resident-run sessions
  // are visualized at the resident island, never in the entrance lobby.
  let residentEmployees = new Map();
  const actors = new Map();
  let hrBubble = null;
  // Timestamp of the previous animation frame, used to make movement
  // frame-rate independent. null until the first frame runs.
  let lastFrameTime = null;

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
        // A break-status session has delivered its answer: the visitor rides
        // the elevator home (or, if only now discovered, never shows up).
        if (employee.status === 'break') continue;
        seen.add(employee.key);
        presence.set(employee.key, { employee, leaving: false });
      }
      for (const [key, entry] of presence) {
        if (!seen.has(key) && !entry.leaving) entry.leaving = true;
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

  // The window sky gradients are position-independent, so build each once and
  // pick between them by the server-reported time of day (state.sky).
  let windowSkyDay = null;
  let windowSkyNight = null;
  // Fixed star field for the night windows (offsets within the 96x58 pane).
  const WINDOW_STARS = [
    { x: 10, y: 10 }, { x: 30, y: 22 }, { x: 52, y: 8 }, { x: 70, y: 28 },
    { x: 86, y: 16 }, { x: 20, y: 38 }, { x: 44, y: 50 }, { x: 78, y: 46 },
    { x: 8, y: 30 }, { x: 62, y: 40 },
  ];

  // The office sign: the user-configurable name on a black plate in white,
  // rendered once into an offscreen sprite and stamped each frame. The sprite
  // is rebuilt only when the name changes.
  const DEFAULT_OFFICE_NAME = 'AI OFFICE';
  let officeSignSprite = null;
  let officeSignName = null;
  function drawOfficeSign(x, y) {
    const name = state.officeName ?? DEFAULT_OFFICE_NAME;
    if (officeSignSprite === null || officeSignName !== name) {
      officeSignName = name;
      officeSignSprite = document.createElement('canvas');
      officeSignSprite.width = 122;
      officeSignSprite.height = 34;
      const sign = officeSignSprite.getContext('2d');
      sign.beginPath();
      sign.roundRect(0, 0, 122, 34, 6);
      sign.fillStyle = '#000000';
      sign.fill();
      // The name is capped at 10 characters; shrink the font until even a
      // full-width 10-character name fits inside the plate.
      let fontSize = 17;
      sign.textAlign = 'center';
      do {
        fontSize -= 1;
        sign.font = `bold ${fontSize}px "Hiragino Sans", sans-serif`;
      } while (fontSize > 8 && sign.measureText(name).width > 108);
      sign.fillStyle = '#ffffff';
      sign.fillText(name, 61, 23);
    }
    ctx.drawImage(officeSignSprite, x, y);
  }

  function drawRoom(time, layout) {
    const height = layout.height;
    const width = layout.width;
    // wall: warm plaster with a crown line and a baseboard
    px(0, 0, width, 96, '#ece6da');
    px(0, 0, width, 6, '#ddd5c6');
    px(0, 86, width, 10, '#c9c0ae');
    // windows: slim dark frames, sky gradient, and either drifting daytime
    // clouds or a twinkling night sky depending on the server's time of day.
    const night = state.sky === 'night';
    if (night) {
      if (!windowSkyNight) {
        windowSkyNight = ctx.createLinearGradient(0, 16, 0, 74);
        windowSkyNight.addColorStop(0, '#0c1636');
        windowSkyNight.addColorStop(1, '#28345f');
      }
    } else if (!windowSkyDay) {
      windowSkyDay = ctx.createLinearGradient(0, 16, 0, 74);
      windowSkyDay.addColorStop(0, '#8ecff0');
      windowSkyDay.addColorStop(1, '#cdeaf7');
    }
    // Windows repeat every 250px for as long as the (team-count-dependent)
    // wall lasts; the classic 960-wide scene reproduces [60, 310, 560, 810].
    const windowXs = [];
    for (let wx = 60; wx + 104 <= width - 8; wx += 250) windowXs.push(wx);
    for (const wx of windowXs) {
      px(wx - 4, 12, 104, 66, '#3d4852');
      ctx.fillStyle = night ? windowSkyNight : windowSkyDay;
      ctx.fillRect(wx, 16, 96, 58);
      ctx.save();
      ctx.beginPath();
      ctx.rect(wx, 16, 96, 58);
      ctx.clip();
      if (night) {
        // A pale moon in the first window, plus a field of twinkling stars.
        if (wx === 60) {
          ctx.fillStyle = 'rgba(244, 241, 214, 0.95)';
          ctx.beginPath();
          ctx.arc(wx + 74, 30, 8, 0, Math.PI * 2);
          ctx.fill();
        }
        for (let index = 0; index < WINDOW_STARS.length; index += 1) {
          const star = WINDOW_STARS[index];
          const twinkle = 0.55 + 0.45 * Math.sin(time / 500 + index * 1.7);
          ctx.fillStyle = `rgba(255, 255, 245, ${twinkle})`;
          ctx.fillRect(wx + star.x, 16 + star.y, 2, 2);
        }
      } else {
        const drift = ((time / 150 + wx) % 140) - 20;
        px(wx + drift, 28, 26, 7, 'rgba(255, 255, 255, 0.9)');
        px(wx + drift + 6, 23, 14, 6, 'rgba(255, 255, 255, 0.9)');
        px(wx + ((drift + 70) % 140), 48, 20, 6, 'rgba(255, 255, 255, 0.7)');
      }
      ctx.restore();
      px(wx + 46, 16, 4, 58, '#3d4852');
      px(wx, 42, 96, 3, '#3d4852');
      px(wx - 6, 74, 108, 6, '#f7f3ea');
    }
    drawWhiteboard();
    // oak plank floor with staggered seams
    for (let ty = 96; ty < height; ty += 24) {
      const row = (ty - 96) / 24;
      px(0, ty, width, 24, row % 2 === 0 ? '#d6b489' : '#cfab7e');
      ctx.fillStyle = 'rgba(90, 62, 40, 0.14)';
      ctx.fillRect(0, ty, width, 2);
      for (let sx = (row % 3) * 110; sx < width; sx += 320) {
        ctx.fillRect(sx, ty, 2, 24);
      }
    }
    // soft shadow the wall casts on the floor
    px(0, 96, width, 5, 'rgba(0, 0, 0, 0.10)');
    drawTeamRooms(time, layout);
    drawEntrance(layout);
    // plants (the left edge holds the team rooms, so only the right stays)
    drawPlant(width - 30, 180);
    drawPlant(width - 30, height - 30);

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
  // human. Unread reports plus kanban cards waiting in the user column show
  // as a count badge (red when any of them needs the human); clicking the
  // board opens the board panel (see app.js).
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
    const boardCounts = state.board;
    const attention = (counts?.unread ?? 0) + (boardCounts?.user ?? 0);
    if (attention > 0) {
      const badgeX = board.x + board.width - 3;
      const badgeY = board.y + 3;
      ctx.fillStyle = counts?.reviewNeeded > 0 || boardCounts?.user > 0 ? '#d93a4a' : '#e0952f';
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px "Hiragino Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.min(attention, 99)), badgeX, badgeY + 4);
    }
  }

  // The team rooms along the left edge: open (wall-less) carpeted patches,
  // one per team, each holding its island of always-present full-size desks.
  // A seat with no resident assigned keeps the neutral gray avatar; an
  // assigned seat wears its CLI's colors, faces the room while idle, and
  // turns to the monitor while a run is in progress. Residents never walk to
  // the entrance lobby or the elevator — they live at their desk.
  function drawTeamRooms(time, layout) {
    const residents = state.residents ?? [];
    for (const room of layout.rooms) {
      // a sage carpet-tile patch marks the area off from the oak floor while
      // staying in the office's warm, low-saturation palette. Clipped to a
      // soft-cornered rect so the checker stops cleanly without partitions.
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

      for (let index = 0; index < room.seatCount; index += 1) {
        const desk = roomDeskPosition(room, index);
        const resident = residents.find((r) => r.teamId === room.id && r.seat === index);
        if (!resident) {
          // Unassigned: gray avatar facing the room, screen off.
          drawDeskFurniture(desk.x, desk.y, SCREEN_OFF);
          drawAvatar(UNSET_SPEC, desk.x, desk.y + 18, { time });
          continue;
        }
        drawResidentSeat(resident, desk, time);
      }

      // sign: the team's name (dark so it reads on the sage carpet)
      ctx.fillStyle = '#3c4a38';
      ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(room.name, room.x + 8, room.y + 22);
    }
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

  // The entrance lobby along the bottom edge, walled off from the work area
  // by a partition: porcelain tiles, the elevator visitors ride in and out,
  // a decorative door into the work area, the neon company sign, a reception
  // counter and a bench for waiting guests. The furniture rects live in
  // layout.js next to entranceObstacles() so walkers route around what is
  // drawn.
  const OFFICE_DOOR_X = 600;

  // The elevator doors slide open while a visitor stands near them; frame()
  // eases this 0..1 amount toward its target from the visitors' positions.
  let elevatorDoorsOpen = 0;

  function drawElevator(top) {
    const frame = { x: ELEVATOR.x, y: top + ELEVATOR.y, width: ELEVATOR.width, height: ELEVATOR.height };
    px(frame.x - 4, frame.y - 8, frame.width + 8, frame.height + 8, '#7d868f');
    px(frame.x, frame.y, frame.width, frame.height, '#9aa3ac');
    // floor indicator lamp over the doors
    px(frame.x + frame.width / 2 - 14, frame.y + 4, 28, 8, '#2e3440');
    ctx.fillStyle = elevatorDoorsOpen > 0.5 ? '#8fe3a5' : '#e0952f';
    ctx.beginPath();
    ctx.arc(frame.x + frame.width / 2, frame.y + 8, 3, 0, Math.PI * 2);
    ctx.fill();
    // dark cab behind two sliding door panels
    const opening = { x: frame.x + 10, y: frame.y + 18, width: 52, height: 110 };
    px(opening.x - 3, opening.y - 3, opening.width + 6, opening.height + 6, '#5c6670');
    px(opening.x, opening.y, opening.width, opening.height, '#161a20');
    if (elevatorDoorsOpen > 0) {
      ctx.fillStyle = `rgba(255, 231, 166, ${0.25 * elevatorDoorsOpen})`;
      ctx.fillRect(opening.x, opening.y, opening.width, opening.height);
    }
    const half = opening.width / 2;
    const slide = Math.round(half * elevatorDoorsOpen);
    ctx.save();
    ctx.beginPath();
    ctx.rect(opening.x, opening.y, opening.width, opening.height);
    ctx.clip();
    px(opening.x - slide, opening.y, half, opening.height, '#aeb6bd');
    px(opening.x + half + slide, opening.y, half, opening.height, '#aeb6bd');
    px(opening.x + half - 1 - slide, opening.y, 1, opening.height, '#5c6670');
    px(opening.x + half + slide, opening.y, 1, opening.height, '#5c6670');
    ctx.restore();
  }

  function drawEntrance(layout) {
    const top = layout.entranceTop;
    const width = layout.width;
    // porcelain lobby tiles, cooler than the work area's oak planks
    let row = 0;
    for (let ty = top + PARTITION_HEIGHT; ty < layout.height; ty += 26, row += 1) {
      for (let tx = 0, column = 0; tx < width; tx += 26, column += 1) {
        px(tx, ty, 26, 26, (row + column) % 2 === 0 ? '#e9e5dc' : '#e0dbcf');
      }
    }
    // partition wall between the work area and the lobby
    px(0, top, width, PARTITION_HEIGHT, '#ece6da');
    px(0, top, width, 4, '#ddd5c6');
    px(0, top + PARTITION_HEIGHT - 8, width, 8, '#c9c0ae');
    px(0, top + PARTITION_HEIGHT, width, 5, 'rgba(0, 0, 0, 0.10)');
    // decorative door into the work area (no avatar ever passes through)
    px(OFFICE_DOOR_X - 4, top + 4, 52, 42, '#8a8172');
    px(OFFICE_DOOR_X, top + 8, 44, 38, '#7b5e57');
    px(OFFICE_DOOR_X + 4, top + 12, 36, 14, '#8d6e63');
    px(OFFICE_DOOR_X + 4, top + 30, 36, 12, '#8d6e63');
    px(OFFICE_DOOR_X + 36, top + 26, 4, 4, '#d9a441');
    // the office sign, moved down from the top wall to greet visitors
    drawOfficeSign(150, top + 6);
    drawElevator(top);
    // reception counter, with a call bell and a small potted plant
    px(RECEPTION.x, top + RECEPTION.y, RECEPTION.width, RECEPTION.height, '#4e342e');
    px(RECEPTION.x, top + RECEPTION.y, RECEPTION.width, 5, '#7b5e57');
    px(RECEPTION.x + 16, top + RECEPTION.y - 6, 8, 6, '#d9a441');
    px(RECEPTION.x + RECEPTION.width - 28, top + RECEPTION.y - 10, 12, 10, '#c96f4a');
    px(RECEPTION.x + RECEPTION.width - 26, top + RECEPTION.y - 16, 8, 6, '#5cb86e');
    // teal bench where visiting sessions wait
    px(BENCH.x + 4, top + BENCH.y + 26, 6, 8, '#37474f');
    px(BENCH.x + BENCH.width - 10, top + BENCH.y + 26, 6, 8, '#37474f');
    px(BENCH.x, top + BENCH.y, BENCH.width, 12, '#3f7d74');
    px(BENCH.x, top + BENCH.y + 10, BENCH.width, 18, '#4f9184');
    // sign
    ctx.fillStyle = '#5a4632';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('ENTRANCE', OFFICE_DOOR_X + 64, top + 30);
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
    const left = Math.min(Math.max(x - width / 2, 6), currentLayout.width - 6 - width);
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

  // --- reception (cleanup) ----------------------------------------------

  function drawHr(layout, time) {
    const x = 290;
    const y = layout.entranceTop + 124;
    drawAvatar(UNSET_SPEC, x, y, { time });
    ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
    ctx.fillStyle = '#4a4136';
    ctx.textAlign = 'center';
    ctx.fillText('受付', x, y + 14);
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

  function teamLabelAt(point) {
    for (const room of currentLayout.rooms) {
      if (isInside(point, teamLabelHitRect(room))) return room;
    }
    return null;
  }

  function teamDeskAt(point) {
    for (const room of currentLayout.rooms) {
      for (let index = 0; index < room.seatCount; index += 1) {
        if (isInside(point, roomDeskHitRect(room, index))) return { room, index };
      }
    }
    return null;
  }

  // The whiteboard, team labels and desks open panels owned by app.js; the
  // canvas only reports the hits as window events to stay DOM-agnostic.
  // Order matters: labels sit above the desk band.
  canvas.addEventListener('click', (event) => {
    const point = canvasPoint(event);
    if (isInside(point, WHITEBOARD)) {
      window.dispatchEvent(new CustomEvent('office:whiteboard-open'));
      return;
    }
    const labelRoom = teamLabelAt(point);
    if (labelRoom !== null) {
      window.dispatchEvent(
        new CustomEvent('office:team-open', { detail: { teamId: labelRoom.id } })
      );
      return;
    }
    const hit = teamDeskAt(point);
    if (hit !== null) {
      const resident = (state.residents ?? []).find(
        (r) => r.teamId === hit.room.id && r.seat === hit.index
      );
      // An assigned monitor opens the activity view; the avatar (and any
      // vacant seat) opens the settings panel to add or edit the resident.
      const eventName =
        resident && isInside(point, roomMonitorHitRect(hit.room, hit.index))
          ? 'office:resident-activity-open'
          : 'office:resident-seat-open';
      window.dispatchEvent(
        new CustomEvent(eventName, {
          detail: { seat: hit.index, name: resident?.name ?? null, teamId: hit.room.id },
        })
      );
    }
  });

  canvas.addEventListener('mousemove', (event) => {
    const point = canvasPoint(event);
    const clickable =
      isInside(point, WHITEBOARD) ||
      teamLabelAt(point) !== null ||
      teamDeskAt(point) !== null;
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

  // Walk the actor toward `target` along a route that skirts the desks,
  // replanning only when the destination moves. Returns true once the final
  // waypoint is reached so callers can tell "arrived" from "still walking"
  // (the per-waypoint `walking` flag toggles false at every leg).
  function walkAround(actor, target, speed, obstacles, bounds) {
    if (
      !actor.pathGoal ||
      Math.abs(actor.pathGoal.x - target.x) > 1 ||
      Math.abs(actor.pathGoal.y - target.y) > 1
    ) {
      actor.pathGoal = { x: target.x, y: target.y };
      actor.path = findPath(actor, target, obstacles, bounds);
      actor.pathIndex = 0;
    }
    const lastLeg = actor.path.length - 1;
    moveActor(actor, actor.path[actor.pathIndex], speed);
    if (!actor.walking && actor.pathIndex < lastLeg) {
      actor.pathIndex += 1;
      actor.walking = true;
    }
    return actor.pathIndex >= lastLeg && !actor.walking;
  }

  function frame(time) {
    // Scale movement by how long the previous frame took relative to a 60fps
    // frame, so walk speed stays constant across refresh rates.
    const frameStep =
      lastFrameTime === null
        ? 1
        : Math.min((time - lastFrameTime) / REFERENCE_FRAME_MS, MAX_FRAME_STEP);
    lastFrameTime = time;

    const layout = computeLayout(state.teams ?? []);
    currentLayout = layout;
    // Resizing clears the canvas and resets context state; re-pin the pixel
    // look. Width follows the team count, height the deepest desk row.
    if (canvas.width !== layout.width || canvas.height !== layout.height) {
      canvas.width = layout.width;
      canvas.height = layout.height;
      ctx.imageSmoothingEnabled = false;
    }

    const elevator = elevatorPosition(layout);
    // Slide the elevator doors open while any visitor stands near them (the
    // previous frame's positions — one frame of lag is invisible).
    let nearestVisitor = Infinity;
    for (const [key, actor] of actors) {
      if (key.startsWith('resident:')) continue;
      nearestVisitor = Math.min(
        nearestVisitor,
        Math.hypot(actor.x - elevator.x, actor.y - elevator.y)
      );
    }
    const doorsTarget = nearestVisitor < 64 ? 1 : 0;
    const doorsStep = 0.06 * frameStep;
    elevatorDoorsOpen = Math.min(
      1,
      Math.max(0, elevatorDoorsOpen + Math.max(-doorsStep, Math.min(doorsStep, doorsTarget - elevatorDoorsOpen)))
    );

    drawRoom(time, layout);
    drawHr(layout, time);

    const obstacles = entranceObstacles(layout);
    const bounds = { width: layout.width, height: layout.height };
    let spotIndex = 0;

    // Stable draw order by arrival.
    const entries = [...presence.entries()].sort(
      (a, b) =>
        (a[1].employee.firstSeenAt ?? 0) - (b[1].employee.firstSeenAt ?? 0) ||
        (a[0] < b[0] ? -1 : 1)
    );

    for (const [key, entry] of entries) {
      const employee = entry.employee;
      const spec = CLI_SPECS[employee.cli];
      if (!spec) continue;
      const actor = actorFor(key, elevator, time);

      if (entry.leaving) {
        const arrived = walkAround(actor, elevator, LEAVE_SPEED * frameStep, obstacles, bounds);
        if (arrived) {
          presence.delete(key);
          actors.delete(key);
          continue;
        }
        drawAvatar(spec, actor.x, actor.y, { time, walking: true });
        if (employee.isSubagent) drawWakabaMark(actor.x + 12, actor.y - 50, 11);
        drawBubble(actor.x, actor.y - 58, '失礼します');
        continue;
      }

      const spot = entranceSpot(spotIndex, layout);
      spotIndex += 1;
      const arrived = walkAround(actor, spot, WALK_SPEED * frameStep, obstacles, bounds);
      drawAvatar(spec, actor.x, actor.y, { time, walking: actor.walking });
      if (employee.isSubagent) drawWakabaMark(actor.x + 12, actor.y - 50, 11);
      // visitor tag: the repository / work name under the avatar
      ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
      ctx.fillStyle = '#4a4136';
      ctx.textAlign = 'center';
      ctx.fillText(String(employee.project ?? employee.name).slice(0, 12), actor.x, actor.y + 14);

      if (time < actor.greetUntil) {
        drawBubble(actor.x, actor.y - 58, 'お邪魔します');
      } else if (arrived) {
        drawSubagents(employee, spec, actor, actor.x, actor.y - 18, time);
        // "blocked" (a tool call still in flight — e.g. awaiting the boss's
        // command permission, or a long silent stretch mid-turn) shows "・・・"
        // and reverts to the normal label once fresh activity resumes;
        // "waiting" raises a hand for the boss's input.
        if (employee.status === 'blocked') {
          drawBubble(actor.x, actor.y - 58, '・・・');
        } else if (employee.status === 'waiting') {
          drawBubble(actor.x, actor.y - 58, '🖐️');
        } else {
          drawBubble(actor.x, actor.y - 58, MOOD_LABELS[employee.activityKind] ?? '作業中');
        }
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
