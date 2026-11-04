/** Authored virtual objects to share with Buddy. These are local drawings, never AI output. */
export const VIRTUAL_OBJECTS = ['plant', 'water orb', 'mini synth'] as const;
export type VirtualObjectKind = (typeof VIRTUAL_OBJECTS)[number];
export function drawVirtualObject(kind: VirtualObjectKind): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 512, 512); bg.addColorStop(0, '#27333e'); bg.addColorStop(1, '#10171e');
  g.fillStyle = bg; g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#ffffff'; g.font = '500 18px system-ui'; g.textAlign = 'center'; g.fillText('VIRTUAL OBJECT', 256, 50);
  if (kind === 'plant') {
    g.fillStyle = '#bd7658'; g.beginPath(); g.moveTo(174, 305); g.lineTo(338, 305); g.lineTo(318, 435); g.lineTo(194, 435); g.closePath(); g.fill();
    g.fillStyle = '#db9271'; g.fillRect(163, 291, 186, 27);
    for (const [x, y, rx, ry, angle] of [[256,185,31,112,0],[194,223,26,90,-.6],[316,223,26,90,.6],[155,260,22,67,-1],[355,260,22,67,1]]) {
      g.fillStyle = x < 256 ? '#68be8c' : '#92d7a6'; g.beginPath(); g.ellipse(x!, y!, rx!, ry!, angle!, 0, Math.PI * 2); g.fill();
    }
  } else if (kind === 'water orb') {
    const orb = g.createRadialGradient(222, 192, 15, 258, 253, 150); orb.addColorStop(0, '#e3ffff'); orb.addColorStop(.35, '#7ed8e8'); orb.addColorStop(1, '#205d90');
    g.fillStyle = orb; g.beginPath(); g.arc(256, 255, 139, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#c8f9fc'; g.lineWidth = 3;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.ellipse(256, 280, 50 + i * 22, 14 + i * 8, -.17, 0, Math.PI * 2); g.stroke(); }
  } else {
    g.fillStyle = '#d9dcd8'; g.beginPath(); g.roundRect(64, 155, 384, 210, 24); g.fill();
    g.fillStyle = '#273740'; g.fillRect(90, 178, 124, 60);
    for (let i = 0; i < 4; i++) { g.fillStyle = ['#4ec4d9','#8dc273','#f3b84b','#df7359'][i]!; g.beginPath(); g.arc(254 + i * 48, 207, 15, 0, Math.PI * 2); g.fill(); }
    for (let i = 0; i < 13; i++) { g.fillStyle = '#fcfaf1'; g.fillRect(89 + i * 26, 266, 24, 75); if ([0,1,3,4,5,7,8,10,11,12].includes(i)) { g.fillStyle = '#202b31'; g.fillRect(105 + i * 26, 266, 14, 43); } }
  }
  g.fillStyle = '#e8eced'; g.font = '500 23px system-ui'; g.fillText(kind, 256, 482);
  return c;
}
