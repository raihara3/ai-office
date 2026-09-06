// Canvas rendering for the miniature office.
// One terminal CLI session = one visitor avatar: it steps out of the
// entrance elevator when the session starts, waits in the lobby while the
// answer is produced, and rides the elevator home once the turn is done.
// app.js pushes state via OFFICE.setState(); this file owns the draw loop.
// Pure geometry and vendor specs live in the ./office/ modules so this file
// is just the rendering.

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
} from './office/layout.js';
import { findPath } from './office/pathfinding.js';
import { createMiniatureRenderer } from './office/miniature.js';

(() => {
  const canvas = document.getElementById('office');
  const ctx = canvas.getContext('2d');
  const miniature = createMiniatureRenderer(ctx);

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
  // Timestamp of the previous animation frame, used to make movement
  // frame-rate independent. null until the first frame runs.
  let lastFrameTime = null;

  window.OFFICE = {
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

  let sceneryLayer = null;
  let sceneryKey = null;
  let renderScale = 1;
  let elevatorDoorsOpen = 0;

  function drawRoom(time, layout) {
    const officeName = state.officeName ?? 'AI OFFICE';
    const night = state.sky === 'night';
    const key = JSON.stringify([layout, officeName, night, renderScale]);
    // Cache architecture and materials; only people, screens, the clock and
    // elevator doors need to be redrawn on each animation frame.
    if (sceneryKey !== key) {
      sceneryLayer ??= document.createElement('canvas');
      sceneryLayer.width = canvas.width;
      sceneryLayer.height = canvas.height;
      const sceneryContext = sceneryLayer.getContext('2d');
      sceneryContext.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      createMiniatureRenderer(sceneryContext).scenery(layout, { night, officeName });
      sceneryKey = key;
    }
    ctx.clearRect(0, 0, layout.width, layout.height);
    ctx.drawImage(sceneryLayer, 0, 0, layout.width, layout.height);
    drawTeamRooms(time, layout);
    miniature.elevator(layout.entranceTop, elevatorDoorsOpen);

    ctx.save();
    roundRect(443, 32, 74, 34, 2, 'rgba(42, 42, 42, 0.12)');
    roundRect(442, 30, 74, 34, 2, '#515151');
    roundRect(445, 33, 68, 28, 1, '#292929');
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    ctx.font = '500 20px "SFMono-Regular", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ededed';
    ctx.fillText(`${hours}:${minutes}`, 479, 48);
    ctx.restore();
  }

  // The team rooms along the left edge: open (wall-less) carpeted patches,
  // one per team, each holding its island of always-present full-size desks.
  // A seat with no resident assigned keeps only its furniture; an
  // assigned seat wears its CLI's colors, faces the room while idle, and
  // turns to the monitor while a run is in progress. Residents never walk to
  // the entrance lobby or the elevator — they live at their desk.
  function drawTeamRooms(time, layout) {
    const residents = state.residents ?? [];
    for (const room of layout.rooms) {
      for (let index = 0; index < room.seatCount; index += 1) {
        const desk = roomDeskPosition(room, index);
        const resident = residents.find((r) => r.teamId === room.id && r.seat === index);
        if (!resident) {
          // Unassigned: empty chair and powered-off monitor.
          drawDeskFurniture(desk.x, desk.y, SCREEN_OFF);
          continue;
        }
        drawResidentSeat(resident, desk, time);
      }
    }
  }

  // One assigned resident seat: a subdued name below the avatar, and the
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
    drawDeskFurniture(desk.x, desk.y, active ? '#1a2b3c' : SCREEN_OFF);
    if (active) {
      drawScreenCode(desk.x, desk.y, time, resident.name);
    } else if (!resident.enabled) {
      ctx.fillStyle = '#5c6670';
      ctx.font = 'bold 13px "Hiragino Sans", sans-serif';
      ctx.fillText('⏸', desk.x, desk.y - 63);
    }

    drawAvatar(spec, desk.x, desk.y + 18, { time, typing: active, facingAway: active });
    ctx.font = '11px "Hiragino Sans", sans-serif';
    const labelWidth = Math.min(112, ctx.measureText(resident.displayName).width + 12);
    roundRect(desk.x - labelWidth / 2, desk.y + 25, labelWidth, 17, 3, 'rgba(65, 65, 65, 0.07)');
    ctx.fillStyle = '#484848';
    ctx.fillText(resident.displayName, desk.x, desk.y + 37, labelWidth - 12);
    if (active && employee) {
      const actor = actorFor(`resident:${resident.name}`, { x: desk.x, y: desk.y + 18 }, time);
      drawSubagents(employee, spec, actor, desk.x, desk.y + 20, time);
      if (employee.status === 'blocked') {
        drawBubble(desk.x, desk.y - 40, '・・・');
      } else {
        drawBubble(desk.x, desk.y - 40, MOOD_LABELS[employee.activityKind] ?? '作業中');
      }
    }
  }

  const SCREEN_OFF = '#0b0d10';
  const deskSprites = new Map();
  let deskSpriteScale = null;
  function drawDeskFurniture(x, y, screenColor) {
    if (deskSpriteScale !== renderScale) {
      deskSprites.clear();
      deskSpriteScale = renderScale;
    }
    let sprite = deskSprites.get(screenColor);
    if (!sprite) {
      sprite = document.createElement('canvas');
      sprite.width = Math.ceil(152 * renderScale);
      sprite.height = Math.ceil(128 * renderScale);
      const furnitureContext = sprite.getContext('2d');
      furnitureContext.setTransform(sprite.width / 152, 0, 0, sprite.height / 128, 0, 0);
      createMiniatureRenderer(furnitureContext).desk(76, 92, screenColor);
      deskSprites.set(screenColor, sprite);
    }
    ctx.drawImage(sprite, x - 76, y - 92, 152, 128);
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

  // (x, y) is the feet baseline center, shared with the walking geometry.
  function drawAvatar(spec, x, y, options) {
    miniature.avatar(spec, x, y, options, drawEmblem);
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
    roundRect(left, y - height, width, height, 9, '#fffcf5', 'rgba(113, 106, 86, 0.28)');
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

  // --- pointer targets --------------------------------------------------

  // Canvas pixels from a mouse event; the canvas is CSS-scaled to fit.
  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (currentLayout.width / rect.width),
      y: (event.clientY - rect.top) * (currentLayout.height / rect.height),
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

  // The team labels and desks open panels owned by app.js; the
  // canvas only reports the hits as window events to stay DOM-agnostic.
  // Order matters: labels sit above the desk band.
  canvas.addEventListener('click', (event) => {
    const point = canvasPoint(event);
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
    // Bound the backing store for large offices while retaining crisp curves
    // on Retina displays. Hit targets and zoom always use logical dimensions.
    renderScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (layout.width * layout.height)));
    const pixelWidth = Math.round(layout.width * renderScale);
    const pixelHeight = Math.round(layout.height * renderScale);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight ||
        Number(canvas.dataset.sceneWidth) !== layout.width || Number(canvas.dataset.sceneHeight) !== layout.height) {
      canvas.dataset.sceneWidth = layout.width;
      canvas.dataset.sceneHeight = layout.height;
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
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
