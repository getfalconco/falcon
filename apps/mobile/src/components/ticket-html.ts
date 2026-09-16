/**
 * HTML rebuild of TicketCard from
 * apps/web/app/components/ui/admit-one-ticket.tsx
 * (WaitlistTicket early-access texture + BASE_LAYOUT nameTop).
 *
 * Rendered in a WebView so clip-path, writing-mode, and the warp dither
 * match the site. RN cannot host the vendored WebGL shader mount.
 */

const REF = 741;
export const TICKET_RATIO = 425 / REF;
const PERF = 562 / REF;
const CORNER = 25 / REF;
const NOTCH = 21 / REF;
const NAME_TOP = 220 / REF;

const LAYOUT = {
  padding: 57 / REF,
  labelTop: 58 / REF,
  labelSize: 19.72 / REF,
  labelLead: 28 / REF,
  labelTracking: 0.016,
  nameSize: 64.79 / REF,
  nameLead: 65 / REF,
  nameTracking: -0.01,
  footerTop: 348 / REF,
  footerSize: 19.72 / REF,
  footerTracking: 0.016,
  stubSize: 67.61 / REF,
  stubOpacity: 0.88,
  watermarkSize: 144 / REF,
  watermarkOpacity: 0.6,
};

const EARLY = {
  back: "#05262f",
  front: "#0f7d92",
  ink: "#c2eff5",
  watermark: "#0d4a58",
  label: "#5aa3b2",
};

export type TicketHtmlProps = {
  width: number;
  presenter?: string;
  title?: string;
  memberLabel?: string;
  dateLabel?: string;
};

function ticketClipPath(width: number, height: number): string {
  const r = CORNER * width;
  const n = NOTCH * width;
  const p = PERF * width;
  return [
    `M ${r} 0`,
    `L ${p - n} 0`,
    `A ${n} ${n} 0 0 0 ${p + n} 0`,
    `L ${width - r} 0`,
    `A ${r} ${r} 0 0 0 ${width} ${r}`,
    `L ${width} ${height - r}`,
    `A ${r} ${r} 0 0 0 ${width - r} ${height}`,
    `L ${p + n} ${height}`,
    `A ${n} ${n} 0 0 0 ${p - n} ${height}`,
    `L ${r} ${height}`,
    `A ${r} ${r} 0 0 0 0 ${height - r}`,
    `L 0 ${r}`,
    `A ${r} ${r} 0 0 0 ${r} 0`,
    "Z",
  ].join(" ");
}

function splitName(name: string, max = 3): string[] {
  const clean = name.trim().replace(/\s+/g, " ").toUpperCase();
  if (!clean) return [];
  const lines: string[] = [];
  for (const word of clean.split(" ")) {
    if (lines.length < max) lines.push(word);
    else lines[lines.length - 1] = `${lines[lines.length - 1]} ${word}`;
  }
  return lines;
}

function fitScale(
  lines: string[],
  availableWidth: number,
  availableHeight: number,
  fontSize: number,
  lineHeight: number,
  tracking: number,
): number {
  if (lines.length === 0 || fontSize <= 0 || availableWidth <= 0) return 1;
  const longest = Math.max(...lines.map((l) => l.length));
  const charWidth = (0.6 + tracking) * fontSize;
  const block = lines.length * lineHeight;
  return Math.max(
    0.05,
    Math.min(
      1,
      charWidth > 0 ? availableWidth / (longest * charWidth) : 1,
      block > 0 && availableHeight > 0 ? availableHeight / block : 1,
    ),
  );
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildTicketHtml({
  width,
  presenter = "",
  title = "Early Access",
  memberLabel = "Member #001",
  dateLabel = "Granted Aug 2026",
}: TicketHtmlProps): string {
  const height = width * TICKET_RATIO;
  const perfX = PERF * width;
  const pad = LAYOUT.padding * width;
  const lines = splitName(title);
  const scale = fitScale(
    lines,
    perfX - pad - 0.03 * width,
    LAYOUT.footerTop * width - NAME_TOP * width - 0.02 * width,
    LAYOUT.nameSize * width,
    LAYOUT.nameLead * width,
    LAYOUT.nameTracking,
  );
  const nameSize = LAYOUT.nameSize * width * scale;
  const nameLead = LAYOUT.nameLead * width * scale;
  const name = presenter.trim();
  const clip = ticketClipPath(width, height);

  const presenterRow = name
    ? `<div class="label" style="left:${pad}px;top:${LAYOUT.labelTop * width}px;font-size:${LAYOUT.labelSize * width}px;line-height:${LAYOUT.labelLead * width}px;letter-spacing:${LAYOUT.labelTracking}em">${esc(name.toUpperCase())}</div>`
    : "";

  const titleRows = lines
    .map((line) => `<div>${esc(line)}</div>`)
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=${width}, height=${height}, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${width}px;height:${height}px;}
  .ticket{
    position:relative;width:${width}px;height:${height}px;
    clip-path:path('${clip}');
    -webkit-clip-path:path('${clip}');
    font-family:-apple-system,BlinkMacSystemFont,"Geist","SF Pro Text",sans-serif;
  }
  canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
  .fill{position:absolute;inset:0;background:${EARLY.back};}
  .perf{
    position:absolute;top:0;bottom:0;left:${perfX}px;
    width:${Math.max(1, 0.0022 * width)}px;
    background-image:repeating-linear-gradient(to bottom, ${EARLY.ink}55 0 ${0.012 * width}px, transparent ${0.012 * width}px ${0.024 * width}px);
  }
  .watermark{
    pointer-events:none;position:absolute;display:grid;place-items:center;
    left:${perfX}px;top:0;width:${width - perfX}px;height:${height}px;
    color:${EARLY.watermark};opacity:${LAYOUT.watermarkOpacity};
    font-weight:700;font-variant-numeric:tabular-nums;
  }
  .watermark span{
    writing-mode:vertical-rl;
    font-size:${LAYOUT.watermarkSize * width}px;
    line-height:1;letter-spacing:-0.04em;
  }
  .ink{position:absolute;inset:0;color:${EARLY.ink};}
  .label{
    position:absolute;white-space:pre;text-transform:uppercase;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    color:${EARLY.label};
  }
  .title{
    position:absolute;left:${pad}px;top:${NAME_TOP * width}px;
    font-weight:500;font-size:${nameSize}px;line-height:${nameLead}px;
    letter-spacing:${LAYOUT.nameTracking}em;text-align:left;
  }
  .footer{
    position:absolute;white-space:nowrap;text-transform:uppercase;
    left:${pad}px;top:${LAYOUT.footerTop * width}px;
    font-size:${LAYOUT.footerSize * width}px;letter-spacing:${LAYOUT.footerTracking}em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    color:${EARLY.label};
  }
  .stub{
    position:absolute;display:grid;place-items:center;
    left:${perfX}px;top:0;width:${width - perfX}px;height:${height}px;
    font-weight:500;white-space:nowrap;text-transform:uppercase;
    font-size:${LAYOUT.stubSize * width}px;opacity:${LAYOUT.stubOpacity};
  }
  .stub span{writing-mode:vertical-rl;}
</style>
</head>
<body>
<div class="ticket">
  <div class="fill"></div>
  <canvas id="dither"></canvas>
  <div class="perf"></div>
  <div class="watermark"><span>2026</span></div>
  <div class="ink">
    ${presenterRow}
    <div class="title">${titleRows}</div>
    <div class="footer">${esc(memberLabel)} · ${esc(dateLabel)}</div>
    <div class="stub"><span>Admit one</span></div>
  </div>
</div>
<script>
(function(){
  var c=document.getElementById('dither');
  var W=${Math.round(width)}, H=${Math.round(height)};
  var dpr=Math.min(2, window.devicePixelRatio||1);
  c.width=Math.round(W*dpr); c.height=Math.round(H*dpr);
  var gl=c.getContext('webgl');
  if(!gl){
    c.getContext('2d').fillStyle='${EARLY.back}';
    c.getContext('2d').fillRect(0,0,c.width,c.height);
    return;
  }
  var vs=gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs,'attribute vec2 a;void main(){gl_Position=vec4(a,0,1);}');
  gl.compileShader(vs);
  var fs=gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs,[
    'precision mediump float;',
    'uniform vec2 u_res;',
    'uniform vec3 u_back;',
    'uniform vec3 u_front;',
    'uniform float u_time;',
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy;',
    ' vec2 s=uv*0.003;',
    ' float t=0.5*u_time;',
    ' for(float i=1.0;i<6.0;i++){',
    '  s.x+=0.6/i*cos(i*2.5*s.y+t);',
    '  s.y+=0.6/i*cos(i*1.5*s.x+t);',
    ' }',
    ' float shape=0.15/max(0.001,abs(sin(t-s.y-s.x)));',
    ' shape=smoothstep(0.02,1.0,shape);',
    ' float h=fract(sin(dot(floor(uv),vec2(12.9898,78.233)))*43758.5453);',
    ' float res=step(0.5,shape+(h-0.5));',
    ' gl_FragColor=vec4(mix(u_back,u_front,res),1.0);',
    '}'
  ].join('\\n'));
  gl.compileShader(fs);
  var p=gl.createProgram();
  gl.attachShader(p,vs); gl.attachShader(p,fs); gl.linkProgram(p); gl.useProgram(p);
  var buf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  var loc=gl.getAttribLocation(p,'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  gl.uniform2f(gl.getUniformLocation(p,'u_res'),c.width,c.height);
  gl.uniform3f(gl.getUniformLocation(p,'u_back'),5/255,38/255,47/255);
  gl.uniform3f(gl.getUniformLocation(p,'u_front'),15/255,125/255,146/255);
  gl.viewport(0,0,c.width,c.height);
  var timeLoc=gl.getUniformLocation(p,'u_time');
  var t0=performance.now();
  var speed=0.4;
  function frame(now){
    gl.uniform1f(timeLoc,((now-t0)/1000)*speed);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>`;
}
