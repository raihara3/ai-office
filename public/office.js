// Canvas rendering for the pixel-art office.
// One CLI session = one avatar. Desks are grouped into per-vendor islands
// that grow with the number of sessions. An HR avatar by the entrance
// retires sessions whose CLI process has exited (logs go to the Trash).
// app.js pushes state via OFFICE.setState(); this file owns the draw loop.

(() => {
  const canvas = document.getElementById('office');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const CANVAS_WIDTH = 960;
  const WALK_SPEED = 1.6;
  const LEAVE_SPEED = 2.6;
  const FIRST_ROW_Y = 280;
  const ROW_SPACING = 210;
  const SEAT_COLUMN_OFFSET = 62;

  const ISLANDS = [
    {
      cli: 'claude',
      label: 'Claude Code',
      x: 170,
      colors: { body: '#d97757', accent: '#f5e6d3', head: '#b85c3e', eye: '#ffe9c9' },
      emblem: 'asterisk',
    },
    {
      cli: 'codex',
      label: 'Codex',
      x: 480,
      colors: { body: '#e8e8e8', accent: '#111111', head: '#222222', eye: '#8be9fd' },
      emblem: 'knot',
    },
    {
      cli: 'gemini',
      label: 'Gemini',
      x: 790,
      colors: { body: '#4285f4', accent: '#d8c7ff', head: '#3367d6', eye: '#ffffff' },
      emblem: 'sparkle',
    },
  ];
  const ISLAND_BY_CLI = Object.fromEntries(ISLANDS.map((island) => [island.cli, island]));

  const HR_SPEC = {
    colors: { body: '#8a93a6', accent: '#f5d76e', head: '#5b6270', eye: '#ffffff' },
    emblem: 'badge',
  };

  let state = { employees: [] };
  // key -> {employee, leaving} — keeps departed sessions around while the
  // avatar walks to the door.
  const presence = new Map();
  const actors = new Map();
  const seatByKey = new Map();
  const usedSeats = { claude: new Set(), codex: new Set(), gemini: new Set() };
  let hrBubble = null;
  let hrBox = null;
  let cleanupInFlight = false;

  window.OFFICE = {
    setState(next) {
      state = next;
      const seen = new Set();
      for (const employee of next.employees) {
        seen.add(employee.key);
        presence.set(employee.key, { employee, leaving: false });
        if (!seatByKey.has(employee.key)) {
          const seats = usedSeats[employee.cli];
          if (!seats) continue;
          let seat = 0;
          while (seats.has(seat)) seat += 1;
          seats.add(seat);
          seatByKey.set(employee.key, seat);
        }
      }
      for (const [key, entry] of presence) {
        if (!seen.has(key) && !entry.leaving) {
          entry.leaving = true;
          const seat = seatByKey.get(key);
          if (seat !== undefined) {
            usedSeats[entry.employee.cli]?.delete(seat);
            seatByKey.delete(key);
          }
        }
      }
    },
  };

  // --- layout ----------------------------------------------------------

  function computeLayout() {
    let maxRows = 1;
    const counts = { claude: 0, codex: 0, gemini: 0 };
    for (const entry of presence.values()) {
      if (!entry.leaving) counts[entry.employee.cli] += 1;
    }
    for (const seats of Object.values(usedSeats)) {
      for (const seat of seats) maxRows = Math.max(maxRows, Math.floor(seat / 2) + 1);
    }
    for (const count of Object.values(counts)) {
      maxRows = Math.max(maxRows, Math.ceil(count / 2));
    }
    const lastRowY = FIRST_ROW_Y + (maxRows - 1) * ROW_SPACING;
    const breakTop = lastRowY + 90;
    const height = Math.max(640, breakTop + 200);
    return { breakTop, height };
  }

  function deskPosition(cli, seat) {
    const island = ISLAND_BY_CLI[cli];
    const column = seat % 2;
    const row = Math.floor(seat / 2);
    return {
      x: island.x + (column === 0 ? -SEAT_COLUMN_OFFSET : SEAT_COLUMN_OFFSET),
      y: FIRST_ROW_Y + row * ROW_SPACING,
    };
  }

  function breakSpot(index, layout) {
    return {
      x: 300 + (index % 7) * 62,
      y: layout.breakTop + 70 + Math.floor(index / 7) * 42,
    };
  }

  function doorPosition(layout) {
    return { x: 46, y: layout.height - 76 };
  }

  function actorFor(key, spawnAt) {
    let actor = actors.get(key);
    if (!actor) {
      actor = { x: spawnAt.x, y: spawnAt.y, walking: false, subagentPop: new Map() };
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
    // island labels
    ctx.font = 'bold 14px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'center';
    for (const island of ISLANDS) {
      ctx.fillStyle = island.colors.body;
      ctx.fillText(island.label, island.x, 116);
    }
    // break-area rug
    const rugTop = layout.breakTop;
    roundRect(230, rugTop, 520, 140, 16, '#6b4f4f');
    roundRect(242, rugTop + 10, 496, 120, 12, '#7d5a5a');
    // couch
    px(250, rugTop + 16, 14, 46, '#b8574f');
    px(250, rugTop + 16, 40, 14, '#b8574f');
    // coffee machine on a stand
    px(760, rugTop + 4, 54, 20, '#5d4037');
    px(768, rugTop - 34, 38, 40, '#37474f');
    px(776, rugTop - 26, 22, 12, '#80cbc4');
    ctx.fillStyle = '#d7ccc8';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('☕ BREAK ROOM', 250, rugTop - 8);
    // plants
    drawPlant(30, 180);
    drawPlant(930, 180);
    drawPlant(930, height - 30);
    // entrance door (bottom-left)
    const door = doorPosition(layout);
    px(0, door.y - 60, 18, 96, '#3a3547');
    px(4, door.y - 54, 10, 84, '#26232e');
    roundRect(door.x - 20, door.y + 4, 52, 12, 4, '#5d4037');
    roundRect(door.x - 16, door.y - 96, 56, 18, 4, '#204d32');
    ctx.fillStyle = '#8fe3a5';
    ctx.font = 'bold 11px "Hiragino Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EXIT', door.x + 12, door.y - 83);

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

  function drawPlant(x, y) {
    px(x - 10, y - 14, 20, 14, '#8d6e63');
    ctx.fillStyle = '#66bb6a';
    ctx.beginPath();
    ctx.arc(x, y - 24, 12, 0, Math.PI * 2);
    ctx.arc(x - 8, y - 16, 8, 0, Math.PI * 2);
    ctx.arc(x + 8, y - 16, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawDesk(deskLabel, x, y, working, mcpCall, time, employeeKey) {
    // nameplate: repository / work name
    ctx.textAlign = 'center';
    ctx.font = 'bold 12px "Hiragino Sans", sans-serif';
    ctx.fillStyle = '#f5f0e8';
    ctx.fillText(deskLabel, x, y - 140);
    // status pill
    const label = working ? '作業中' : '休憩中';
    ctx.font = 'bold 10px "Hiragino Sans", sans-serif';
    const pillWidth = ctx.measureText(label).width + 22;
    roundRect(x - pillWidth / 2, y - 134, pillWidth, 16, 8, '#1f2030');
    ctx.fillStyle = working ? '#9ece6a' : '#e0af68';
    ctx.beginPath();
    ctx.arc(x - pillWidth / 2 + 9, y - 126, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e6e6ef';
    ctx.fillText(label, x + 5, y - 122);
    // MCP badge between the pill and the monitor
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
    hrBox = { left: x - 20, right: x + 20, top: y - 52, bottom: y + 16 };
    if (hrBubble && hrBubble.until > Date.now()) {
      drawBubble(x, y - 56, hrBubble.text);
    } else if (!hrBubble || hrBubble.until <= Date.now()) {
      hrBubble = null;
    }
  }

  async function runCleanup() {
    if (cleanupInFlight) return;
    cleanupInFlight = true;
    try {
      const preview = await (await fetch('/api/cleanup/preview')).json();
      if (preview.candidates.length === 0) {
        hrBubble = { text: 'サボっている人はいませんでした', until: Date.now() + 4000 };
        return;
      }
      // Only retire the sessions from this preview, so anything that became
      // retirable in between is left for the next click.
      const result = await (
        await fetch('/api/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: preview.candidates.map((c) => c.key) }),
        })
      ).json();
      hrBubble = {
        text: `${result.retired.length} 人が退勤しました`,
        until: Date.now() + 5000,
      };
    } catch {
      hrBubble = { text: '退勤処理に失敗しました', until: Date.now() + 4000 };
    } finally {
      cleanupInFlight = false;
    }
  }

  canvas.addEventListener('click', (event) => {
    if (!hrBox) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    if (x >= hrBox.left && x <= hrBox.right && y >= hrBox.top && y <= hrBox.bottom) {
      runCleanup();
    }
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

  // Desk labels: repository name, with #n suffixes when duplicated.
  function deskLabels() {
    const labels = new Map();
    const counts = new Map();
    for (const entry of presence.values()) {
      if (entry.leaving) continue;
      const employee = entry.employee;
      const base = employee.project ?? employee.name;
      const seen = counts.get(`${employee.cli}:${base}`) ?? 0;
      counts.set(`${employee.cli}:${base}`, seen + 1);
      labels.set(employee.key, seen === 0 ? base : `${base} #${seen + 1}`);
    }
    return labels;
  }

  function frame(time) {
    const layout = computeLayout();
    if (canvas.height !== layout.height) {
      canvas.height = layout.height;
      ctx.imageSmoothingEnabled = false;
    }
    drawRoom(time, layout);
    drawHr(layout, time);

    const labels = deskLabels();
    const door = doorPosition(layout);
    let breakIndex = 0;

    // Stable draw order: island order, then seat.
    const entries = [...presence.entries()].sort((a, b) => {
      const seatA = seatByKey.get(a[0]) ?? 99;
      const seatB = seatByKey.get(b[0]) ?? 99;
      return a[1].employee.cli.localeCompare(b[1].employee.cli) || seatA - seatB;
    });

    for (const [key, entry] of entries) {
      const employee = entry.employee;
      const spec = ISLAND_BY_CLI[employee.cli];
      if (!spec) continue;

      if (entry.leaving) {
        const actor = actorFor(key, door);
        moveActor(actor, door, LEAVE_SPEED);
        if (!actor.walking) {
          presence.delete(key);
          actors.delete(key);
          continue;
        }
        drawAvatar(spec, actor.x, actor.y, { time, walking: true });
        continue;
      }

      const seat = seatByKey.get(key);
      if (seat === undefined) continue;
      const desk = deskPosition(employee.cli, seat);
      const working = employee.status === 'working';
      const mcpCall = employee.mcpCalls[employee.mcpCalls.length - 1];
      drawDesk(labels.get(key) ?? '', desk.x, desk.y, working, mcpCall, time, key);

      const actor = actorFor(key, door);
      // Sit in front of the desk, facing the monitor, while working.
      const chairSpot = { x: desk.x, y: desk.y + 18 };
      const restSpot = breakSpot(breakIndex, layout);
      if (!working) breakIndex += 1;
      moveActor(actor, working ? chairSpot : restSpot, WALK_SPEED);

      const atDesk = working && !actor.walking;
      drawAvatar(spec, actor.x, actor.y, {
        time,
        walking: actor.walking,
        typing: atDesk,
        facingAway: atDesk,
        coffee: !working && !actor.walking,
      });

      if (atDesk) {
        drawSubagents(employee, spec, actor, desk.x, desk.y, time);
        const bubbleText = employee.activity ?? employee.task;
        if (bubbleText) drawBubble(actor.x, actor.y - 58, bubbleText);
      } else if (!working && !actor.walking) {
        drawBubble(actor.x, actor.y - 56, '☕');
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
