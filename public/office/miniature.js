import { BENCH, ELEVATOR, PARTITION_HEIGHT, RECEPTION, entranceLoungeRect, teamLabelHitRect } from './layout.js';

// Material and furniture drawing in logical scene coordinates. Geometry and
// interaction stay in layout.js; this renderer never reads application state.
export function createMiniatureRenderer(context) {
  function gradient(x, y, width, height, start, end) {
    const fill = context.createLinearGradient(x, y, x + width, y + height);
    fill.addColorStop(0, start);
    fill.addColorStop(1, end);
    return fill;
  }

  function rounded(x, y, width, height, radius, fill, stroke) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fillStyle = fill;
    context.fill();
    if (stroke) {
      context.strokeStyle = stroke;
      context.lineWidth = 0.8;
      context.stroke();
    }
  }

  function ellipse(x, y, radiusX, radiusY, fill, rotation = 0) {
    context.beginPath();
    context.ellipse(x, y, radiusX, radiusY, rotation, 0, Math.PI * 2);
    context.fillStyle = fill;
    context.fill();
  }

  function polygon(points, fill) {
    context.beginPath();
    points.forEach(([x, y], index) => context[index ? 'lineTo' : 'moveTo'](x, y));
    context.closePath();
    context.fillStyle = fill;
    context.fill();
  }

  function line(x, y, endX, endY, color, width = 1) {
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(endX, endY);
    context.strokeStyle = color;
    context.lineWidth = width;
    context.lineCap = 'round';
    context.stroke();
  }

  function shadow(x, y, radiusX, radiusY, opacity = 0.18) {
    const fill = context.createRadialGradient(x, y, 0, x, y, radiusX);
    fill.addColorStop(0, `rgba(40, 37, 30, ${opacity})`);
    fill.addColorStop(1, 'rgba(40, 37, 30, 0)');
    context.save();
    context.translate(x, y);
    context.scale(1, radiusY / radiusX);
    context.translate(-x, -y);
    ellipse(x, y, radiusX, radiusX, fill);
    context.restore();
  }

  function plant(x, y, scale = 1) {
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    shadow(3, 2, 24, 9);
    polygon([[-11, -18], [11, -18], [8, 5], [-8, 5]], '#d5d5d5');
    polygon([[5, -18], [11, -18], [8, 5], [4, 5]], '#b3b3b3');
    ellipse(0, -18, 11, 4, '#e4e4e4');
    ellipse(0, -18, 8, 2.5, '#57564c');
    for (let index = 0; index < 7; index += 1) {
      const angle = index * 2.4;
      const leafX = Math.cos(angle) * (index % 2 ? 16 : 10);
      const leafY = -34 - index * 4;
      line(0, -17, leafX, leafY, '#6b7766', 1.5);
      ellipse(leafX, leafY, 7, 14, index % 2 ? '#8c9d88' : '#536f5e', -angle / 2);
      line(leafX, leafY + 6, leafX + Math.sin(angle / 2) * 5, leafY - 7, '#a6b5a0', 0.6);
    }
    context.restore();
  }

  function sofa(x, y, width) {
    shadow(x + width / 2 + 3, y + 32, width * 0.55, 10, 0.14);
    rounded(x + 10, y + 22, 4, 14, 0, '#464646');
    rounded(x + width - 14, y + 22, 4, 14, 0, '#464646');
    rounded(x, y - 9, width, 34, 3, '#858585');
    rounded(x + 3, y + 13, width - 6, 17, 2, '#646464');
    line(x + 8, y - 6, x + width - 8, y - 6, '#b3b3b3', 1);
    const cushionWidth = (width - 28) / 3;
    for (let index = 0; index < 3; index += 1) {
      const cushionX = x + 12 + index * (cushionWidth + 2);
      rounded(cushionX, y + 2, cushionWidth, 17, 4, '#969696');
      line(cushionX + 4, y + 16, cushionX + cushionWidth - 4, y + 16, '#898989', 0.7);
    }
    rounded(x, y, 11, 26, 2, '#767676');
    rounded(x + width - 11, y, 11, 26, 2, '#767676');
    rounded(x + 15, y - 2, 24, 18, 5, '#dcdcdc');
    rounded(x + width - 49, y + 1, 25, 17, 4, '#a58c78');
  }

  function artwork(x, y, width = 42, height = 50) {
    rounded(x + 3, y + 3, width, height, 2, 'rgba(55, 45, 35, 0.12)');
    rounded(x, y, width, height, 2, '#4b4b4b');
    rounded(x + 3, y + 3, width - 6, height - 6, 1, '#ededed');
    context.save();
    context.beginPath();
    context.rect(x + 6, y + 6, width - 12, height - 12);
    context.clip();
    ellipse(x + width * 0.6, y + height * 0.35, width * 0.22, width * 0.22, '#a07d63');
    ellipse(x + width * 0.3, y + height * 0.9, width * 0.45, height * 0.45, '#878787');
    ellipse(x + width * 0.85, y + height, width * 0.5, height * 0.35, '#c6b8a2');
    context.restore();
  }

  function lounge(layout) {
    const area = entranceLoungeRect(layout);
    const lampX = area.x + 18;
    const floorY = layout.entranceTop + BENCH.y + 30;
    const light = context.createRadialGradient(lampX, floorY - 33, 4, lampX, floorY - 33, 48);
    light.addColorStop(0, 'rgba(255, 234, 179, 0.30)');
    light.addColorStop(1, 'rgba(255, 234, 179, 0)');
    ellipse(lampX, floorY - 33, 48, 48, light);
    shadow(lampX + 2, floorY, 17, 5, 0.12);
    line(lampX, floorY, lampX, floorY - 66, '#484848', 2);
    ellipse(lampX, floorY, 12, 3, '#484848');
    polygon([[lampX - 17, floorY - 53], [lampX - 11, floorY - 73],
      [lampX + 11, floorY - 73], [lampX + 17, floorY - 53]], '#414141');
    ellipse(lampX, floorY - 53, 17, 3, '#ededed');
    sofa(BENCH.x, layout.entranceTop + BENCH.y, BENCH.width);
    plant(BENCH.x + BENCH.width + 36, floorY + 2, 0.65);
  }

  function woodenSign(x, y, width, height) {
    rounded(x, y, width, height, 1, '#38271e');
    rounded(x, y, width, height - 2, 1, '#513a2b');
    for (let index = 0; index < 4; index += 1) {
      const grainY = y + 3 + index * (height - 6) / 4;
      line(x + 4 + index * 3, grainY, x + width - 5 - index * 5,
        grainY + (index % 2 ? 0.8 : -0.4), 'rgba(181, 142, 103, 0.18)', 0.7);
    }
    line(x + 1, y + 1, x + width - 1, y + 1, '#77563e', 0.8);
  }

  function teamSign(room) {
    const { x, y, width, height } = teamLabelHitRect(room);
    rounded(x + 15, y + height - 6, 3, 6, 1, '#585858');
    rounded(x + width - 18, y + height - 6, 3, 6, 1, '#585858');
    rounded(x + 2, y + 3, width, height - 5, 2, 'rgba(42, 42, 42, 0.20)');
    woodenSign(x, y, width, height - 5);
    ellipse(x + 6, y + 10, 1, 1, '#b4a288');
    ellipse(x + width - 6, y + 10, 1, 1, '#b4a288');
    context.font = '600 12px "Hiragino Sans", sans-serif';
    context.textAlign = 'center';
    context.fillStyle = '#ededed';
    const characters = Array.from(room.name);
    let label = room.name;
    if (context.measureText(label).width > width - 24) {
      let low = 0;
      let high = characters.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = characters.slice(0, middle).join('') + '…';
        if (context.measureText(candidate).width <= width - 24) low = middle;
        else high = middle - 1;
      }
      label = characters.slice(0, low).join('') + '…';
    }
    context.fillText(label, x + width / 2, y + 15);
  }

  function scenery(layout, { night, officeName }) {
    const { width, height, entranceTop } = layout;
    rounded(0, 0, width, height, 12, '#a39b8c');
    rounded(0, 0, width, height - 10, 2, '#d6cbbb');
    context.save();
    context.beginPath();
    context.rect(8, 96, width - 16, height - 112);
    context.clip();
    for (let y = 96; y < height; y += 32) {
      const row = (y - 96) / 32;
      polygon([[8, y], [width - 8, y], [width - 8, y + 32], [8, y + 32]],
        row % 2 ? 'rgba(255, 255, 245, 0.10)' : 'rgba(109, 95, 73, 0.025)');
      line(8, y, width - 8, y, 'rgba(97, 94, 77, 0.10)', 0.6);
      for (let x = (row % 3) * 90; x < width; x += 270) {
        line(x, y, x + 15, y + 32, 'rgba(97, 94, 77, 0.10)', 0.6);
        line(x + 25, y + 10, x + 216, y + 10, 'rgba(245, 244, 231, 0.14)', 0.6);
      }
    }
    context.restore();
    rounded(0, 0, width, 96, 1, '#ededed');
    line(0, 4, width, 4, '#eeeeee', 5);
    rounded(0, 86, width, 10, 0, '#a9a9a9');
    line(0, 87, width, 87, '#e3e3e3', 2);
    rounded(8, 96, width - 16, 16, 0, gradient(0, 96, 0, 16, 'rgba(79, 64, 46, 0.18)', 'rgba(79, 64, 46, 0)'));
    for (let x = 60; x + 104 <= width - 8; x += 250) {
      rounded(x - 6, 10, 108, 70, 0, '#a8a8a8');
      rounded(x - 3, 12, 102, 65, 0, '#3f3f3f');
      rounded(x, 16, 96, 58, 1, gradient(x, 16, 0, 58, night ? '#233348' : '#a4c8cb', night ? '#667782' : '#e7e7e7'));
      if (night) {
        for (let index = 0; index < 9; index += 1) {
          ellipse(x + 8 + (index * 37) % 80, 23 + (index * 13) % 36, 0.8, 0.8, '#f3e9c8');
        }
        if (x === 60) ellipse(x + 72, 30, 7, 7, '#f1e6bf');
      } else {
        ellipse(x + 24, 33, 22, 4, 'rgba(237,237,237,0.45)');
        ellipse(x + 71, 44, 19, 3, 'rgba(237,237,237,0.35)');
      }
      for (let index = 0; index < 7; index += 1) {
        const skylineHeight = 6 + (index * 11) % 16;
        rounded(x + index * 14, 74 - skylineHeight, 12, skylineHeight, 0, night ? '#3b515a' : '#aaaaaa');
      }
      line(x + 48, 16, x + 48, 74, '#3f3f3f', 3);
      line(x, 47, x + 96, 47, '#3f3f3f', 2);
      polygon([[x + 5, 17], [x + 24, 17], [x + 6, 73], [x + 1, 73]], 'rgba(237,237,237,0.13)');
      rounded(x - 8, 76, 112, 5, 1, '#8a8a8a');
      rounded(x - 8, 74, 112, 4, 1, '#e7e7e7');
      if (!night) {
        polygon([[x, 98], [x + 96, 98], [x + 182, 272], [x + 61, 272]], 'rgba(255, 247, 218, 0.15)');
      }
    }
    artwork(212, 21, 38, 48);
    artwork(711, 25, 34, 44);
    for (const room of layout.rooms) {
      rounded(room.x + 1, room.y + 2, room.width, room.height, 2, 'rgba(93, 87, 69, 0.10)');
      rounded(room.x, room.y, room.width, room.height, 2, '#c3c3c3');
      context.save();
      context.beginPath();
      context.roundRect(room.x + 4, room.y + 4, room.width - 8, room.height - 8, 1);
      context.strokeStyle = '#b5b5b5';
      context.lineWidth = 1;
      context.stroke();
      context.clip();
      for (let y = room.y + 10; y < room.y + room.height; y += 5) {
        line(room.x + 6, y, room.x + room.width - 6, y, 'rgba(237, 237, 237, 0.12)', 0.5);
      }
      context.restore();
      teamSign(room);
    }
    const top = entranceTop;
    rounded(8, top + PARTITION_HEIGHT, width - 16, height - top - PARTITION_HEIGHT - 10, 0,
      '#dedede');
    for (let y = top + PARTITION_HEIGHT; y < height - 10; y += 46) {
      line(8, y, width - 8, y, '#ededed', 1);
      for (let x = 8; x < width - 8; x += 92) line(x, y, x, Math.min(y + 46, height - 10), '#ededed', 1);
    }
    rounded(0, top, width, PARTITION_HEIGHT, 0, '#e6e6e6');
    line(0, top + 2, width, top + 2, '#ededed', 4);
    for (let x = RECEPTION.x - 12; x < RECEPTION.x + RECEPTION.width + 12; x += 10) {
      line(x, top + 5, x, top + PARTITION_HEIGHT - 5, 'rgba(130, 103, 72, 0.12)', 1);
    }
    rounded(0, top + PARTITION_HEIGHT - 4, width, 4, 0, '#a6a6a6');
    const doorX = width - 128;
    rounded(doorX, top + 3, 76, 43, 0, '#484848');
    rounded(doorX + 3, top + 6, 70, 39, 0, '#c8c8c8');
    polygon([[doorX + 5, top + 7], [doorX + 22, top + 7],
      [doorX + 11, top + 44], [doorX + 5, top + 44]], 'rgba(237, 237, 237, 0.35)');
    rounded(doorX + 3, top + 23, 70, 10, 0, '#e3e3e3');
    line(doorX + 38, top + 6, doorX + 38, top + 44, '#707070', 1.5);
    line(doorX + 32, top + 20, doorX + 32, top + 36, '#ededed', 2);
    line(doorX + 44, top + 20, doorX + 44, top + 36, '#ededed', 2);
    rounded(doorX - 16, top + 18, 10, 17, 1, '#424242');
    rounded(doorX - 14, top + 21, 6, 2, 0, '#bebebe');
    line(doorX - 13, top + 28, doorX - 9, top + 28, '#979797', 0.8);
    context.font = '500 5px sans-serif';
    context.textAlign = 'center';
    context.fillStyle = '#676767';
    context.fillText('STAFF ONLY', doorX + 38, top + 30);

    const signWidth = RECEPTION.width - 28;
    const signX = RECEPTION.x + 14;
    rounded(signX + 2, top + 9, signWidth, 29, 0, 'rgba(84, 78, 61, 0.10)');
    woodenSign(signX, top + 7, signWidth, 29);
    rounded(signX + 12, top + 14, 2, 15, 0, '#b7a283');
    context.textAlign = 'center';
    let fontSize = 17;
    do {
      context.font = `500 ${fontSize}px "Hiragino Sans", sans-serif`;
      if (context.measureText(officeName).width <= signWidth - 44) break;
      fontSize -= 1;
    } while (fontSize > 8);
    context.fillStyle = '#2b2b2b';
    context.fillText(officeName, signX + signWidth / 2 + 5, top + 28.7, signWidth - 44);
    context.fillStyle = '#e8e8e8';
    context.fillText(officeName, signX + signWidth / 2 + 5, top + 28, signWidth - 44);
    const counterY = top + RECEPTION.y;
    shadow(RECEPTION.x + RECEPTION.width / 2, counterY + RECEPTION.height, RECEPTION.width * 0.55, 12, 0.14);
    rounded(RECEPTION.x, counterY, RECEPTION.width, RECEPTION.height, 0, '#92775d');
    for (let x = RECEPTION.x + 6; x < RECEPTION.x + RECEPTION.width - 4; x += 6) {
      line(x, counterY + 8, x, counterY + RECEPTION.height - 4, '#b39a7d', 1.5);
    }
    rounded(RECEPTION.x - 2, counterY - 3, RECEPTION.width + 4, 10, 1, '#d9d9d9');
    rounded(RECEPTION.x + 50, counterY - 18, 28, 18, 3, '#454545');
    rounded(RECEPTION.x + 53, counterY - 16, 22, 13, 2, '#a2a2a2');
    ellipse(RECEPTION.x + 20, counterY, 7, 3, '#77736e');
    ellipse(RECEPTION.x + 20, counterY - 3, 5, 4, '#b2aaa0');
    plant(RECEPTION.x + RECEPTION.width - 18, counterY, 0.35);
    context.fillStyle = '#ededed';
    context.textAlign = 'left';
    context.font = '9px sans-serif';
    context.fillText('RECEPTION', RECEPTION.x + 94, counterY + 29);
    lounge(layout);
    line(8, height - 10, width - 8, height - 10, '#dedede', 2);
    polygon([[0, 96], [8, 104], [8, height - 10], [0, height - 2]], '#a9a493');
    polygon([[width - 8, 96], [width, 88], [width, height - 2], [width - 8, height - 10]], '#929292');
  }

  function desk(x, y, screenColor) {
    shadow(x + 4, y + 11, 60, 10, 0.16);
    rounded(x - 45, y - 16, 5, 29, 0, '#474747');
    rounded(x + 44, y - 16, 5, 29, 0, '#404040');
    polygon([[x - 56, y - 44], [x + 48, y - 44], [x + 56, y - 13], [x - 48, y - 13]], '#b39776');
    polygon([[x - 48, y - 13], [x + 56, y - 13], [x + 56, y - 7], [x - 48, y - 7]], '#947b5d');
    polygon([[x - 56, y - 46], [x + 48, y - 46], [x + 56, y - 15], [x - 48, y - 15]],
      '#cfb794');
    for (let index = 0; index < 4; index += 1) {
      line(x - 48, y - 39 + index * 6, x + 45, y - 39 + index * 6, 'rgba(119, 97, 69, 0.11)', 0.6);
    }
    rounded(x - 23, y - 38, 48, 15, 1, '#9b9b9b');
    rounded(x - 19, y - 35, 35, 7, 1, '#e6e6e6', '#bdbdbd');
    for (let index = 0; index < 9; index += 1) line(x - 16 + index * 3.5, y - 33, x - 16 + index * 3.5, y - 30, '#a9a9a9', 0.6);
    ellipse(x + 22, y - 31, 3, 4, '#e6e6e6');
    ellipse(x, y - 44, 14, 3, '#919191');
    rounded(x - 3, y - 56, 6, 12, 0, '#858585');
    rounded(x - 27, y - 84, 54, 35, 1, '#3e3e3e');
    rounded(x - 23, y - 81, 46, 28, 0, screenColor);
    line(x - 20, y - 79, x + 3, y - 79, 'rgba(237,237,237,0.15)', 1);
    ellipse(x + 21, y - 51, 1, 1, screenColor === '#0b0d10' ? '#878787' : '#d0d0d0');
    ellipse(x + 40, y - 28, 6, 2.5, '#b49b77');
    rounded(x + 35, y - 38, 10, 10, 3, '#e9e9e9');
    ellipse(x + 40, y - 38, 5, 2, '#71644b');
    rounded(x - 15, y + 7, 30, 13, 7, '#515151');
    rounded(x - 15, y + 6, 30, 8, 5, '#858585');
    rounded(x - 13, y - 1, 26, 13, 4, '#949494');
  }

  function elevator(top, open) {
    const { x, y: offset, width, height } = ELEVATOR;
    const y = top + offset;
    rounded(x - 4, y - 8, width + 8, height + 8, 0, '#676767');
    rounded(x - 1, y - 7, width + 2, height + 7, 0, '#bababa');
    rounded(x + 6, y + 14, 60, 118, 0, '#4b4b4b');
    rounded(x + 10, y + 18, 52, 110, 0, '#979797');
    line(x + 12, y + 19, x + 60, y + 19, '#ebebeb', 2);
    rounded(x + 24, y - 1, 24, 11, 1, '#3e3e3e');
    context.fillStyle = '#e1e1e1';
    context.font = '8px sans-serif';
    context.textAlign = 'center';
    context.fillText(open > 0.5 ? '01' : '↑ 01', x + width / 2, y + 7);
    const slide = 26 * open;
    context.save();
    context.beginPath();
    context.rect(x + 10, y + 18, 52, 110);
    context.clip();
    for (const doorX of [x + 10 - slide, x + 36 + slide]) {
      rounded(doorX, y + 18, 26, 110, 0, '#c4c4c4');
      line(doorX + 2, y + 19, doorX + 2, y + 127, '#e3e3e3', 0.8);
      line(doorX + 25, y + 18, doorX + 25, y + 128, '#a6a6a6', 0.8);
    }
    context.restore();
    line(x + 7, y + 131, x + 65, y + 131, '#e5e5e5', 2);
    for (let index = 0; index < 3; index += 1) {
      line(x + 9, y + 133 + index, x + 63, y + 133 + index, '#acacac', 0.5);
    }
    rounded(x + width - 5, y + 62, 4, 14, 1, '#787878');
    ellipse(x + width - 3, y + 67, 1, 1, open > 0.5 ? '#e2e2e2' : '#e8e8e8');
  }

  function avatar(spec, x, y, options, drawEmblem) {
    const { colors, emblem } = spec;
    const scale = options.scale ?? 1;
    if (scale <= 0) return;
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    const walking = options.walking ? Math.sin(options.time / 90) * 2 : 0;
    const bob = options.typing ? Math.sin(options.time / 160) : Math.abs(walking) * 0.5;
    shadow(2, 2, 20, 6, emblem === 'knot' ? 0.10 : 0.24);
    for (const [legX, step] of [[-8, walking], [2, -walking]]) {
      rounded(legX, -11 + step, 7, 11, 2, colors.head);
      rounded(legX - 1, -4 + step, 9, 5, 2.5, emblem === 'knot' ? '#aeb5b6' : '#3e4945');
    }
    rounded(-12, -28 + bob, 24, 21, 5, colors.head);
    rounded(-12, -28 + bob, 21, 18, 4, colors.body);
    line(-7, -26 + bob, 5, -26 + bob, 'rgba(255,255,255,0.18)', 0.8);
    if (!options.facingAway) drawEmblem(emblem, 0, -17 + bob, 0.85, colors.accent);
    else rounded(-6, -20 + bob, 12, 6, 3, 'rgba(255,255,255,0.18)');
    const armBob = options.typing ? Math.sin(options.time / 110) * 1.5 : walking;
    rounded(-16, -25 + bob + armBob, 6, 14, 3, colors.body);
    rounded(10, -25 + bob - armBob, 6, 14, 3, colors.head);
    rounded(-13, -46 + bob, 26, 22, 7, colors.head);
    rounded(-13, -46 + bob, 23, 19, 6, colors.body);
    line(-7, -44 + bob, 4, -44 + bob, 'rgba(255,255,255,0.18)', 0.8);
    if (!options.facingAway) {
      rounded(-10, -40 + bob, 20, 12, 5, '#263b32');
      const blink = Math.sin(options.time / 900 + x) > 0.97 ? 0.3 : 1;
      ellipse(-4, -34 + bob, 2, 2.2 * blink, colors.eye);
      ellipse(4, -34 + bob, 2, 2.2 * blink, colors.eye);
      line(-6, -38 + bob, 3, -38 + bob, 'rgba(255,255,255,0.22)', 1);
    } else {
      for (let index = -1; index <= 1; index += 1) rounded(index * 4 - 1, -35 + bob, 2, 5, 1, 'rgba(20,35,29,0.3)');
    }
    if (emblem === 'asterisk') {
      line(0, -45 + bob, 0, -50 + bob, colors.head, 2);
      ellipse(0, -51 + bob, 2.5, 2.5, colors.body);
      ellipse(-0.7, -52 + bob, 0.8, 0.8, '#f5d8ba');
    }
    context.restore();
  }

  return { scenery, desk, elevator, avatar };
}
