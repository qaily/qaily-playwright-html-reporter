// Chronoscope view for Monitoring, ported from the Chronoscope design: a fixed WebGL stack of holographic dials on
// a light spindle, glass run cards projected beside each dial, and page scroll lowering the camera back in time.
// Hourly: one 60-minute dial per hour, one ring per run. Daily: one 24-hour dial per day, one ring per lane.
// Arc length is duration, height is test count, and the colour split is passed / failed / flaky / skipped.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { PageContext, RunRow, ViewModule } from '@qaily/contracts';
import { canUseWebGL, html, nothing, render, suiteBadge, svg, type TemplateResult } from '@qaily/ui';
import { BloomPassR147 } from './bloom-r147.ts';
import { TAU, arcShares, bucketRuns, dayArc, hourArc, runProgress, timeParts, waveFrom, type TimeParts } from './dial-math.ts';
import { styles } from './styles.ts';

/** The parts of the Monitoring model this view uses (themes don't import page packages). */
interface RunCardLike {
  run: RunRow;
  laneId: string | null;
  rate: number | null;
  running: boolean;
}
interface MonitoringLike {
  lanes: { id: string; label: string }[];
  runs: RunCardLike[];
  rangeDays: number;
}

type Status = 'passed' | 'failed' | 'flaky' | 'running';
type GroupBy = 'hour' | 'day';
interface V3 {
  x: number;
  y: number;
  z: number;
}

interface Label {
  pos: HTMLElement;
  el: HTMLElement;
  get: () => (V3 & { kind: string }) | { hidden: true };
  offscreen: boolean;
}

interface Group {
  kind: GroupBy;
  key: string;
  day: number;
  parts: TimeParts;
  execs: Exec[];
  y: number;
  dy: number;
  height: number;
  stickTop: number;
  stickBot: number;
  grow: number;
  trig: boolean;
  empty: boolean;
  g: THREE.Group | null;
  prevY: number | null;
  label: Label | null;
}

interface Exec {
  c: RunCardLike;
  id: string;
  num: string;
  status: Status;
  laneLabel: string;
  laneIdx: number;
  env: string;
  parts: TimeParts;
  typical: number | null;
  progress: number;
  wave: number[];
  hr: Group;
  visible: boolean;
  inPack: boolean;
  vis: number;
  hl: number;
  hover: number;
  arcHover: number;
  cg: number;
  ring: number;
  side: number;
  right: boolean;
  a: V3;
  ta: V3 | null;
  anc: V3;
  tanc: V3;
  pos: HTMLElement;
  el: HTMLElement;
  offscreen: boolean;
  mat: THREE.ShaderMaterial | null;
  mesh: THREE.Mesh | null;
  arcLocal: { r: number; mid: number; fail: number; h: number } | null;
  arcL: THREE.Vector3 | null;
  failL: THREE.Vector3 | null;
  arcW: THREE.Vector3 | null;
  failW: THREE.Vector3 | null;
}

interface FailedTest {
  test_id: string;
  title: string;
  status: string;
  file: string;
  project: string;
  err_summary: string | null;
  attempts: number;
}

const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad = (n: number) => String(n).padStart(2, '0');
const fmtDur = (ms: number | null) => {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${s}s`;
};
const fmtShort = (ms: number | null) => (ms == null ? '–' : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
const fmtN = (n: number) => n.toLocaleString('en-US');
const STATUS_LABEL: Record<Status, string> = { passed: 'Passed', failed: 'Failed', flaky: 'Flaky', running: 'Running' };
const COL: Record<Status, string> = { passed: '#34f3a0', failed: '#ff4d6d', flaky: '#ffc247', running: '#4db6ff' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
/** Colours reach the screen as written, like the original design (three.js r147 had no colour management). */
const raw = (c: number | string) => new THREE.Color().setStyle(typeof c === 'number' ? `#${c.toString(16).padStart(6, '0')}` : c, THREE.LinearSRGBColorSpace);

function envClass(env: string): string {
  if (/prod/i.test(env)) return 'prod';
  if (/acc|stag|uat|pre|qa/i.test(env)) return 'staging';
  return 'dev';
}
/** Run folders end in the CI run number (`<ts>_<sha>_<n>`); fall back to the commit. */
function runNumber(r: RunRow): string {
  const m = /_(\d+)$/.exec(r.run_id);
  return m ? m[1] : (r.commit ?? r.run_id).slice(0, 7);
}
function wavePts(w: number[], W: number, H: number): string {
  return w.map((v, i) => `${((i / (w.length - 1)) * W).toFixed(1)},${(v * H).toFixed(1)}`).join(' ');
}
/** Per-viewer view preferences; blocked storage just means they aren't remembered. */
function pref(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
  return null;
}

/* ================= SHADERS (the original design's; the day tint now cycles through any number of days) ================= */
const MAX_MARKS = 64;
const GLSL_DAY = `uniform float uMk[${MAX_MARKS}];
vec3 pal(float i){i=mod(i,3.);return i<.5?vec3(.45,.86,1.):i<1.5?vec3(.68,.56,1.):vec3(.32,1.,.78);}
vec3 dayCol(float y){float s=0.;for(int i=0;i<${MAX_MARKS};i++){float m=uMk[i];s+=1.-smoothstep(m-1.8,m+1.8,y);}
 float i0=floor(s);return mix(pal(i0),pal(i0+1.),s-i0);}`;
const ARC_VS = `varying vec3 vL;varying vec3 vN;varying vec3 vV;
void main(){vL=position;vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);vN=normalize(normalMatrix*normal);gl_Position=projectionMatrix*mv;}`;
const ARC_FS = `uniform float uTime,uA0,uLen,uP,uF,uK,uProg,uRun,uHi,uGrow,uVis,uH;
uniform vec3 cP,cF,cK,cS,cR;
varying vec3 vL;varying vec3 vN;varying vec3 vV;
const float TAU=6.28318530718;
void main(){
 if(uVis<.02)discard;
 float a=atan(vL.y,vL.x);
 float t=mod(uA0-a+.0005,TAU)/uLen;
 t=t>1.5?0.:min(t,1.);
 if(t>uGrow)discard;
 vec3 c;float lit=1.;
 if(uRun>.5){c=cR;float on=step(t,uProg);lit=mix(.2,1.,on)*mix(1.,.72+.28*sin(t*70.-uTime*9.),on);}
 else if(t<uP)c=cP;else if(t<uP+uF)c=cF;else if(t<uP+uF+uK)c=cK;else c=cS;
 float f=pow(1.-abs(dot(normalize(vN),normalize(vV))),1.5);
 float top=step(uH*.98,vL.z);
 float hA=mod(1.5707963-uTime*.8,TAU);
 float sw=exp(-mod(a-hA,TAU)*2.2);
 vec3 col=c*(.26+.44*top+f*.85)*lit+c*sw*.85*lit+vec3(1.)*uHi*.32+vec3(1.)*top*pow(f,4.)*.25;
 gl_FragColor=vec4(col,(.8+.18*top)*uVis);
}`;
const PLATE_VS = `varying vec3 vL;varying vec3 vW;void main(){vL=position;vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`;
const PLATE_FS = `uniform float uTime,uR,uRin,uTicks,uMajor;varying vec3 vL;varying vec3 vW;${GLSL_DAY}
const float TAU=6.28318530718;
void main(){float r=length(vL.xy);float a=atan(vL.y,vL.x);vec3 col=dayCol(vW.y);
 float m=fract(a/TAU*uTicks);float dm=min(m,1.-m)*TAU/uTicks*r;
 float tick=(1.-smoothstep(.005,.012,dm))*step(uR+.01,r)*step(r,uR+.07);
 float q=fract(a/TAU*uMajor);float dq=min(q,1.-q)*TAU/uMajor*r;
 float five=(1.-smoothstep(.008,.017,dq))*step(uR-.02,r)*step(r,uR+.11);
 float z=fract(a/TAU-.25+.5)-.5;float noon=(1.-smoothstep(.01,.03,abs(z)*TAU*r))*step(uR-.05,r)*step(r,uR+.12);
 float inner=1.-smoothstep(0.,.012,abs(r-(uRin-.04)));
 float edge=1.-smoothstep(0.,.008,abs(r-uR));
 float hA=mod(1.5707963-uTime*.8,TAU);float sw=exp(-mod(a-hA,TAU)*1.5)*smoothstep(uRin-.06,uRin+.1,r)*step(r,uR);
 float base=.04+.07*smoothstep(uRin,uR,r);
 float al=base+tick*.5+five*.85+noon+inner*.55+edge*.45+sw*.17;
 gl_FragColor=vec4(col*(.55+tick+five*1.3+noon*2.+edge)+col*sw*.6,min(al,1.));}`;
const SPINDLE_FS = `uniform float uTime;varying vec3 vL;varying vec3 vW;${GLSL_DAY}
void main(){vec3 c=dayCol(vW.y);float p=smoothstep(.86,1.,fract(vW.y*.22-uTime*.5));gl_FragColor=vec4(c*(.5+p*2.2),.3+p*.6);}`;
const FLOW_VS = `attribute vec3 seed;uniform float uTime,uTop,uRange,uPR;varying float vA;varying vec3 vC;${GLSL_DAY}
void main(){float sp=.6+seed.z*1.2;float bottom=uTop-uRange;float y=bottom+mod(seed.x*uRange+uTime*sp,uRange);
 float r=.03+seed.z*.2;vec3 p=vec3(cos(seed.y+uTime*.9)*r,y,sin(seed.y+uTime*.9)*r);
 vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=(1.+seed.z*2.4)*uPR*(18./-mv.z);
 vA=smoothstep(uTop,uTop-1.,y)*(.4+seed.z*.6);vC=mix(dayCol(y),vec3(1.),.4);}`;
const FLOW_FS = `varying float vA;varying vec3 vC;void main(){float d=length(gl_PointCoord-.5);gl_FragColor=vec4(vC,smoothstep(.5,0.,d)*vA);}`;

const FOV = 50;
const CAMZ = 10;
const PXU = 95;
const TOPCAM = 1.0;
const ZC = 0.3;
const tanH = Math.tan(((FOV / 2) * Math.PI) / 180);

class ChronoscopeView extends HTMLElement {
  model!: MonitoringLike;
  ctx!: PageContext;

  private root: ShadowRoot;
  private canvas!: HTMLCanvasElement;
  private world!: HTMLElement;
  private spacer!: HTMLElement;
  private controls!: HTMLElement;
  private kpis!: HTMLElement;
  private track!: HTMLElement;
  private hint!: HTMLElement;
  private drawer!: HTMLElement;
  private scrim!: HTMLElement;

  private execs: Exec[] = [];
  private hours: Group[] = [];
  private days: Group[] = [];
  private dayMarks: { i: number; y: number; label: Label }[] = [];
  private labels: Label[] = [];
  private nowLabel: Label | null = null;
  private maxTotal = 1;

  private GROUP: GroupBy = pref('qaily.chrono.group') === 'day' ? 'day' : 'hour';
  private perRow = Number(pref('qaily.chrono.perRow') ?? -1) || 0;
  private F = { lane: 'all', env: new Set<string>(), envAll: [] as string[], status: new Set<Status>(['passed', 'failed', 'flaky', 'running']), q: '' };
  private packed = false;
  private glideNext = false;
  private selected: Exec | null = null;
  private failures: { id: string; rows: FailedTest[] | null; error: string } = { id: '', rows: null, error: '' };

  private narrow = false;
  private worldBottom = 0;
  private VW = innerWidth;
  private VH = innerHeight;
  private PU = 1;
  private cardWpx = 236;
  private STAG = false;
  private STW = 2.45;
  private DIAL = { R: 1.55, tilt: 0.62 };

  private renderer: THREE.WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.1, 200);
  private uni = { uTime: { value: 0 }, uMk: { value: new Array<number>(MAX_MARKS).fill(-1e6) }, uPR: { value: 1 } };
  private dialU = { uR: { value: 1.55 }, uRin: { value: 0.78 }, uTicks: { value: 60 }, uMajor: { value: 12 } };
  private CU: Record<string, { value: THREE.Color }> = {};
  private flowMat!: THREE.ShaderMaterial;
  private linkObj!: THREE.LineSegments;
  private sparkObj!: THREE.Points;
  private burstObj!: THREE.Points;
  private dustObj!: THREE.Points;
  private plateMat!: THREE.ShaderMaterial;
  private handMat!: THREE.MeshBasicMaterial;
  private dialRoot: THREE.Group | null = null;
  private spindle: THREE.Mesh | null = null;
  private net: THREE.LineSegments | null = null;
  private beacon!: THREE.Group;
  private dotTexC: THREE.CanvasTexture | null = null;
  private arcMeshes: THREE.Mesh[] = [];
  private hands: THREE.Mesh[] = [];
  private linkExecs: Exec[] = [];
  private sparkMeta: { e: Exec; ph: number; sp: number; j: number; jz: number }[] = [];
  private burstState = { n: 1500, vel: new Float32Array(1500 * 3), life: new Float32Array(1500), base: new Float32Array(1500 * 3), head: 0 };
  private ray = new THREE.Raycaster();
  private mvec = new THREE.Vector2();
  private v3 = new THREE.Vector3();

  private camY = TOPCAM;
  private camYT = TOPCAM;
  private dolly = 0;
  private dollyT = 0;
  private pan = 0;
  private panT = 0;
  private mx = 0;
  private my = 0;
  private smx = 0;
  private smy = 0;
  private ptrDirty = false;
  private ptrX = 0;
  private ptrY = 0;
  private hoverArc: Exec | null = null;
  private last = performance.now();
  private raf = 0;
  private tick = 0;
  private rz = 0;
  private built = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.adoptedStyleSheets = [styles.styleSheet!];
  }

  connectedCallback(): void {
    if (this.built) return;
    this.built = true;
    render(
      html`<canvas id="gl" aria-hidden="true"></canvas>
        <div class="filters"></div>
        <div id="spacer"></div>
        <div id="world" aria-label="Test runs timeline"></div>
        <section class="hud kpis" aria-label="Today"></section>
        <nav class="hud mini" aria-label="Timeline overview" @click=${this.onMini}><div class="track"></div></nav>
        <div class="hint"><span>Scroll back in time</span><i></i></div>
        <div class="scrim" @click=${() => this.closeExec()}></div>
        <aside class="drawer" aria-label="Run details" aria-hidden="true"></aside>`,
      this.root,
    );
    const $ = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
    this.canvas = $('#gl');
    this.world = $('#world');
    this.spacer = $('#spacer');
    this.controls = $('.filters');
    this.kpis = $('.kpis');
    this.track = $('.track');
    this.hint = $('.hint');
    this.drawer = $('.drawer');
    this.scrim = $('.scrim');

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    } catch {
      this.renderer = null;
    }
    this.buildData();
    if (this.renderer) this.initScene();
    this.resize();
    this.renderKpis();
    this.renderControls();

    addEventListener('scroll', this.onScroll, { passive: true });
    addEventListener('pointermove', this.onPointer, { passive: true });
    addEventListener('resize', this.onResize);
    addEventListener('keydown', this.onKey);
    this.canvas.addEventListener('click', this.onCanvasClick);
    document.fonts?.ready.then(() => this.isConnected && this.resize());
    this.raf = requestAnimationFrame(this.frame);
    // Running runs creep forward and the NOW label keeps time.
    this.tick = window.setInterval(() => this.liveTick(), 5000);
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.raf);
    clearInterval(this.tick);
    clearTimeout(this.rz);
    removeEventListener('scroll', this.onScroll);
    removeEventListener('pointermove', this.onPointer);
    removeEventListener('resize', this.onResize);
    removeEventListener('keydown', this.onKey);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.dotTexC?.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
  }

  /** A new model (refresh, shell filter change): rebuild, keeping scroll, grouping, filters and the open drawer. */
  setModel(model: MonitoringLike, ctx: PageContext): void {
    this.model = model;
    this.ctx = ctx;
    if (!this.built) return;
    const sel = this.selected?.id;
    this.selected = null;
    this.hoverArc = null;
    this.buildData();
    this.resize();
    this.renderKpis();
    this.renderControls();
    const again = sel ? this.execs.find((e) => e.id === sel) : undefined;
    if (again && this.drawer.classList.contains('on')) {
      this.selected = again;
      again.el.classList.add('sel');
      this.renderDrawer(again);
    } else if (sel) this.closeExec();
  }

  private get utc(): boolean {
    return this.ctx.settings.display.timeZone === 'UTC';
  }

  /* ================= DATA ================= */
  private buildData(): void {
    this.world.replaceChildren();
    this.labels = [];
    this.dayMarks = [];
    const lanes = this.model.lanes;
    const laneIdx = new Map(lanes.map((l, i) => [l.id, i]));
    const runs = this.model.runs;
    this.maxTotal = Math.max(1, ...runs.map((c) => c.run.total));

    // Typical duration per lane (median of finished runs), for a running run's progress.
    const typical = new Map<string, number>();
    for (const l of lanes) {
      const d = runs.filter((c) => c.laneId === l.id && !c.running && c.run.dur_ms).map((c) => c.run.dur_ms!).sort((a, b) => a - b);
      if (d.length) typical.set(l.id, d[Math.floor(d.length / 2)]);
    }
    // The card's wave is its lane's pass rate over the runs up to this one.
    const byLane = new Map<string, RunCardLike[]>();
    for (const c of [...runs].reverse()) {
      const list = byLane.get(c.laneId ?? '') ?? [];
      list.push(c);
      byLane.set(c.laneId ?? '', list);
    }
    const waveOf = (c: RunCardLike) => {
      const list = byLane.get(c.laneId ?? '') ?? [];
      const i = list.indexOf(c);
      return waveFrom(list.slice(Math.max(0, i - 33), i + 1).filter((x) => !x.running).map((x) => x.rate));
    };

    const { hours, days } = bucketRuns(runs, (c) => new Date(c.run.started_at), this.utc);
    const mkGroup = (kind: GroupBy, b: (typeof hours)[number]): Group => ({
      kind, key: b.key, day: b.day, parts: b.parts, execs: [], y: 0, dy: 0, height: 0, stickTop: 0, stickBot: 0,
      grow: RM ? 9 : 0, trig: RM, empty: false, g: null, prevY: null, label: null,
    });
    const refresh = this.execs.length > 0;
    this.hours = hours.map((b) => mkGroup('hour', b));
    this.days = days.map((b) => mkGroup('day', b));
    this.execs = [];
    const now = this.ctx.now().getTime();
    hours.forEach((b, hi) => {
      const hr = this.hours[hi];
      for (const c of b.items) {
        const r = c.run;
        const e: Exec = {
          c, id: r.run_id, num: runNumber(r),
          status: c.running ? 'running' : r.failed ? 'failed' : r.flaky ? 'flaky' : 'passed',
          laneLabel: lanes.find((l) => l.id === c.laneId)?.label ?? r.category ?? 'Run',
          laneIdx: laneIdx.get(c.laneId ?? '') ?? lanes.length - 1,
          env: r.environment ?? 'n/a', parts: timeParts(new Date(r.started_at), this.utc),
          typical: typical.get(c.laneId ?? '') ?? null, progress: 1, wave: waveOf(c), hr,
          visible: true, inPack: true, vis: 1, hl: 0, hover: 0, arcHover: 0, cg: RM || refresh ? 1 : 0, ring: 0, side: 1, right: false,
          a: { x: 0, y: 0, z: 0 }, ta: null, anc: { x: 0, y: 0, z: 0 }, tanc: { x: 0, y: 0, z: 0 },
          pos: document.createElement('div'), el: document.createElement('article'), offscreen: true,
          mat: null, mesh: null, arcLocal: null, arcL: null, failL: null, arcW: null, failW: null,
        };
        if (c.running) e.progress = runProgress(Date.parse(r.started_at), now, e.typical);
        hr.execs.push(e);
        this.days[hr.day].execs.push(e);
        this.execs.push(e);
        this.buildCard(e);
      }
    });
    // A refresh doesn't replay the assembly animation.
    if (refresh) [...this.hours, ...this.days].forEach((g) => ((g.grow = 9), (g.trig = true)));

    const envs = [...new Set(this.execs.map((e) => e.env))].sort();
    for (const env of envs) if (!this.F.envAll.includes(env)) this.F.env.add(env);
    this.F.envAll = envs;
    if (this.F.lane !== 'all' && !lanes.some((l) => l.id === this.F.lane)) this.F.lane = 'all';
    this.execs.forEach((e) => {
      e.visible = this.passes(e);
      e.inPack = e.visible;
      this.renderCard(e);
    });
    this.packed = this.packed && this.execs.some((e) => !e.visible);

    this.hours.forEach((hr) => {
      hr.label = this.addLabel('hour', () => this.groupLabel(hr), () =>
        this.GROUP === 'hour' && !hr.empty ? { x: 0, y: this.gy(hr), z: 0, kind: 'hour' } : { hidden: true },
      );
    });
    this.days.forEach((d) => {
      d.label = this.addLabel('hour', () => this.groupLabel(d), () =>
        this.GROUP === 'day' && !d.empty ? { x: 0, y: this.gy(d), z: 0, kind: 'hour' } : { hidden: true },
      );
    });
    this.days.forEach((d, i) => {
      if (i === 0) return;
      const m = { i, y: 0, label: null as unknown as Label };
      m.label = this.addLabel(
        'day',
        () => html`${DAY_NAMES[d.parts.dow]} ${d.parts.dom}<span>${MONTHS[d.parts.month].toUpperCase()} ${d.parts.year}</span>`,
        () => ({ x: 0, y: m.y, z: -2.4, kind: 'day' }),
      );
      this.dayMarks.push(m);
    });
    this.nowLabel = this.addLabel('now', () => this.nowHtml(), () => ({ x: 0.5, y: this.beaconY(), z: 0, kind: 'now' }));
  }

  private nowHtml(): TemplateResult {
    const p = timeParts(this.ctx.now(), this.utc);
    return html`<i></i>NOW · ${pad(p.h)}:${pad(p.min)} · ${DAY_NAMES[p.dow].toUpperCase()} ${p.dom} ${MONTHS[p.month].slice(0, 3).toUpperCase()}`;
  }

  private members = (gr: Group) => (this.packed ? gr.execs.filter((e) => e.inPack) : gr.execs);
  private gy = (gr: Group) => (gr.g ? gr.g.position.y : gr.dy);
  private groups = () => (this.GROUP === 'day' ? this.days : this.hours);
  private G = (e: Exec) => (this.GROUP === 'day' ? this.days[e.hr.day] : e.hr);
  private beaconY = () => (this.groups()[0]?.y ?? 0) + 0.45;

  private runsTxt(gr: Group): string {
    const m = this.members(gr).length;
    const n = gr.execs.length;
    return this.packed && m !== n ? `${m} OF ${n} RUNS` : `${n} RUN${n === 1 ? '' : 'S'}`;
  }
  private groupLabel(gr: Group): TemplateResult {
    const head = gr.kind === 'hour' ? `${pad(gr.parts.h)}:00` : `${DAY_NAMES[gr.parts.dow]} ${gr.parts.dom}`;
    return html`${head}<small>${this.runsTxt(gr)}</small>`;
  }
  private refreshLabels(): void {
    [...this.hours, ...this.days].forEach((g) => g.label && render(this.groupLabel(g), g.label.el));
  }

  private addLabel(cls: string, content: () => TemplateResult, get: Label['get']): Label {
    const pos = document.createElement('div');
    pos.className = 'pos off';
    const el = document.createElement('div');
    el.className = cls;
    render(content(), el);
    pos.append(el);
    this.world.append(pos);
    const L: Label = { pos, el, get, offscreen: true };
    this.labels.push(L);
    return L;
  }

  /* ================= CARDS ================= */
  private buildCard(e: Exec): void {
    const { pos, el } = e;
    pos.className = 'pos off';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    pos.append(el);
    this.world.append(pos);
    el.addEventListener('click', () => this.openExec(e));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.openExec(e);
      }
    });
    el.addEventListener('mouseenter', () => (e.hover = 1));
    el.addEventListener('mouseleave', () => (e.hover = 0));
    el.addEventListener('focus', () => (e.hover = 1));
    el.addEventListener('blur', () => (e.hover = 0));
  }

  private renderCard(e: Exec): void {
    const r = e.c.run;
    const running = e.status === 'running';
    const val = running ? e.progress * 100 : e.c.rate ?? 0;
    const C = 2 * Math.PI * 21;
    const wave = running ? e.wave.slice(0, Math.max(2, Math.round(e.wave.length * e.progress))) : e.wave;
    e.el.className = `card s-${e.status}${e.visible ? '' : ' gone'}${this.selected === e ? ' sel' : ''}${e.arcHover ? ' hl' : ''}`;
    e.el.setAttribute('aria-label', `Run ${e.num}, ${e.laneLabel}, ${e.env}, ${STATUS_LABEL[e.status]}`);
    render(
      html`<div class="c-top"><span>EXEC #${e.num}</span><span class="pill">${running ? `${Math.round(e.progress * 100)}%` : STATUS_LABEL[e.status]}</span></div>
        <div class="c-main">
          <div class="c-text">
            <div class="c-suite">${e.laneLabel}</div>
            <div class="c-meta">${suiteBadge(r.tag)}<span class="proj">${r.branch ?? r.category ?? ''}</span><span class="env env-${envClass(e.env)}">${e.env}</span></div>
          </div>
          <svg class="gauge" viewBox="0 0 52 52" aria-hidden="true">
            <circle class="bg" cx="26" cy="26" r="21"></circle>
            <circle class="fg" cx="26" cy="26" r="21" stroke-dasharray="${((val / 100) * C).toFixed(1)} ${C.toFixed(1)}"></circle>
            <text x="26" y="28.5">${val >= 99.95 ? '100' : val.toFixed(val >= 10 ? 1 : 0)}</text>
            <text class="u" x="26" y="36">${running ? 'DONE' : 'PASS %'}</text>
          </svg>
        </div>
        <svg class="wave" viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden="true">${svg`<polyline points=${wavePts(wave, 200, 24)}></polyline>`}</svg>
        <div class="c-counts">
          <span class="n-p">✓ <b>${fmtN(r.passed)}</b></span><span class="n-f${r.failed ? '' : ' z'}">✕ <b>${r.failed}</b></span>${r.flaky && !running
            ? html`<span class="n-k">↻ <b>${r.flaky}</b></span>`
            : html`<span class="n-s">⊘ <b>${r.skipped}</b></span>`}<span class="dur">${running ? 'live' : fmtShort(r.dur_ms)} · ${pad(e.parts.h)}:${pad(e.parts.min)}</span>
        </div>`,
      e.el,
    );
  }

  /* ================= LAYOUT (the original design's, unchanged) ================= */
  private unitPx = (d: number) => this.VH / (2 * d * tanH);
  private effPer(): number {
    let n = this.perRow > 0 ? this.perRow : this.narrow ? 1 : 4;
    if (this.narrow) n = Math.min(n, 3);
    return n;
  }
  private place(e: Exec, a: V3, anc: V3): void {
    e.ta = a;
    e.tanc = anc;
    if (!this.glideNext) {
      e.a = { ...a };
      e.anc = { ...anc };
    }
  }

  private layout(): void {
    const VW = (this.VW = innerWidth);
    const VH = (this.VH = innerHeight);
    const narrow = (this.narrow = VW < 760);
    const N = this.effPer();
    const PU = (this.PU = this.unitPx(CAMZ - ZC));
    const gapPx = narrow ? 10 : 14;
    let Rd: number;
    const cols: { x: number; side: number }[] = [];
    const STAG = (this.STAG = !narrow && this.perRow === -1);
    if (STAG) {
      this.DIAL.tilt = 0.62;
      this.cardWpx = 236;
      const hw = (z: number) => (CAMZ - z) * tanH * (VW / VH) * (1 - (2 * 84) / VW);
      Rd = 1.55;
      let cw = Math.min(2.45, (hw(-1.7) - (Rd + 0.45)) / 2.08);
      if (cw < 1.8) {
        Rd = Math.max(0.9, Rd - (1.8 - cw) * 1.4);
        cw = Math.min(2.45, (hw(-1.7) - (Rd + 0.45)) / 2.08);
      }
      this.STW = Math.max(1.1, cw);
    } else if (narrow) {
      Rd = Math.min(1.3, (VW * 0.34) / PU);
      this.DIAL.tilt = 0.78;
      const avail = VW - 32 - 26;
      this.cardWpx = Math.floor((avail - (N - 1) * gapPx) / N);
      for (let c = 0; c < N; c++) cols.push({ x: (16 + c * (this.cardWpx + gapPx) - VW / 2) / PU, side: 0 });
    } else {
      this.DIAL.tilt = 0.62;
      const halfAvail = VW / 2 - 84;
      const L = Math.floor(N / 2);
      const Rn = N - L;
      const cnt = Math.max(L, Rn);
      Rd = Math.max(0.75, Math.min(1.55, (halfAvail * (N >= 6 ? 0.15 : 0.21)) / PU));
      const inner = (Rd + 0.4) * PU;
      this.cardWpx = Math.floor(Math.max(72, Math.min(300, (halfAvail - inner - (cnt - 1) * gapPx) / cnt)));
      for (let j = L - 1; j >= 0; j--) cols.push({ x: -(inner + j * (this.cardWpx + gapPx) + this.cardWpx) / PU, side: -1 });
      for (let j = 0; j < Rn; j++) cols.push({ x: (inner + j * (this.cardWpx + gapPx)) / PU, side: 1 });
    }
    this.DIAL.R = Rd;
    this.execs.forEach((e) => (e.el.style.width = `${this.cardWpx}px`));
    let h = 0;
    for (let i = 0; i < Math.min(10, this.execs.length); i++) h = Math.max(h, this.execs[i].el.offsetHeight);
    const cardH = h || 150;
    const rowStep = (cardH + gapPx) / PU;
    const wU = this.cardWpx / PU;
    const hU = cardH / PU;
    const slots = narrow ? cols : [...cols].sort((p, q) => Math.abs(p.x + wU / 2) - Math.abs(q.x + wU / 2) || q.side - p.side);
    let y = 0;
    const GR = this.groups();
    const isDay = this.GROUP === 'day';
    GR.forEach((hr, i) => {
      if (i > 0 && hr.day !== GR[i - 1].day) {
        const m = this.dayMarks.find((d) => d.i === hr.day);
        y -= narrow ? 1.2 : 1.6;
        if (m) m.y = y - 0.4;
        y -= narrow ? 2.2 : 3.2;
      }
      hr.y = y;
      const list = this.members(hr);
      hr.empty = !list.length;
      if (hr.empty) {
        hr.dy = hr.stickTop = hr.stickBot = y;
        hr.height = 0;
        return;
      }
      const rows = Math.ceil(list.length / N);
      const block = rows * rowStep - gapPx / PU;
      let top: number;
      if (narrow) {
        hr.dy = y - 0.2 - Rd * 0.72;
        top = hr.dy - Rd * 0.78 - 0.5;
        hr.height = y - top + block + 0.55;
      } else if (isDay) {
        top = y - 0.55;
        hr.height = 0.55 + Math.max(block, Rd * 1.3 + 0.7) + 1.1;
        hr.stickTop = top - Rd * 0.65 - 0.1;
        hr.stickBot = Math.min(hr.stickTop, top - block + Rd * 0.65);
        hr.dy = hr.stickTop;
      } else {
        const H = Math.max(block, Rd * 1.3 + 0.7);
        top = y - 0.55 - (H - block) / 2;
        hr.dy = y - 0.55 - H / 2;
        hr.height = 0.55 + H + 1.1;
      }
      if (!isDay || narrow) hr.stickTop = hr.stickBot = hr.dy;
      if (STAG) {
        const cw = this.STW;
        const hS = (cw * cardH) / 236;
        const step = hS * 0.92;
        const per = [0, 0];
        list.forEach((e, k) => {
          const side = k % 2 === 0 ? 1 : -1;
          const j = per[side > 0 ? 0 : 1]++;
          const outer = j % 2 === 1;
          const x0 = Rd + 0.45 + (outer ? cw * 1.08 : 0);
          const z = outer ? -1.7 : 0.7;
          const mid = y - 1.05 - j * step;
          e.side = side;
          e.right = side < 0;
          this.place(e, { x: side * x0, y: mid + hS / 2, z }, { x: side * x0, y: mid, z });
        });
        const rws = Math.max(per[0], per[1]);
        hr.dy = y - 1.05 - ((rws - 1) * step) / 2 - 0.15;
        hr.height = Math.max(rws * step + 2.1, 3.6);
        if (isDay) {
          hr.stickTop = y - 1.05 - Rd * 0.25;
          hr.stickBot = Math.min(hr.stickTop, y - 1.05 - (rws - 1) * step);
          hr.dy = hr.stickTop;
        } else hr.stickTop = hr.stickBot = hr.dy;
      } else {
        list.forEach((e, k) => {
          const col = slots[k % N];
          const ay = top - Math.floor(k / N) * rowStep;
          e.side = col.side;
          e.right = false;
          this.place(e, { x: col.x, y: ay, z: ZC }, { x: col.side < 0 ? col.x + wU : col.x, y: ay - hU / 2, z: ZC });
        });
      }
      y -= hr.height;
    });
    this.worldBottom = y;
    const mk = this.uni.uMk.value;
    mk.fill(-1e6);
    this.dayMarks.slice(0, MAX_MARKS).forEach((m, i) => (mk[i] = m.y));
    this.dialU.uR.value = Rd;
    this.dialU.uRin.value = Rd * 0.5;
    this.spacer.style.height = `${Math.round((TOPCAM - (this.worldBottom + 3)) * PXU + VH)}px`;
    [...this.hours, ...this.days].forEach((g) => g.label && (g.label.el.style.fontSize = `${Math.max(14, Math.round(0.22 * Rd * PU))}px`));
    this.dayMarks.forEach((m) => (m.label.el.style.fontSize = `${Math.round((narrow ? 0.62 : 1.25) * this.unitPx(CAMZ))}px`));
    this.glideNext = false;
  }

  /* ================= FILTERS ================= */
  private passes(e: Exec): boolean {
    const F = this.F;
    if (F.lane !== 'all' && e.c.laneId !== F.lane) return false;
    if (!F.env.has(e.env)) return false;
    if (!F.status.has(e.status)) return false;
    if (F.q) {
      const r = e.c.run;
      const hay = `#${e.num} ${e.id} ${e.laneLabel} ${r.category ?? ''} ${e.env} ${r.branch ?? ''} ${r.commit ?? ''} ${r.tag ?? ''}`.toLowerCase();
      if (!hay.includes(F.q)) return false;
    }
    return true;
  }

  private applyFilters(): void {
    this.execs.forEach((e) => {
      const v = this.passes(e);
      if (v !== e.visible) {
        e.visible = v;
        if (!v && !e.offscreen && e.arcW) this.burst(e.arcW, COL[e.status]);
        e.el.classList.toggle('gone', !v);
      }
    });
    if (this.packed && this.execs.some((e) => e.visible && !e.inPack)) {
      this.doPack(true);
      return;
    }
    this.rebuildLinks();
    this.buildMini();
    this.renderControls();
  }

  private doPack(quiet: boolean): void {
    this.execs.forEach((e) => (e.inPack = e.visible));
    this.packed = this.execs.some((e) => !e.visible);
    this.glideNext = true;
    if (this.drawer.classList.contains('on')) this.closeExec();
    this.refreshLabels();
    this.resize();
    this.renderControls();
    if (!quiet) {
      const n = this.execs.filter((e) => e.visible).length;
      this.ctx.notify(this.packed ? `Rearranged ${n} visible runs` : 'All runs shown in their full layout');
    }
  }

  private setGroup(g: GroupBy): void {
    if (this.GROUP === g) return;
    this.GROUP = g;
    pref('qaily.chrono.group', g);
    [...this.hours, ...this.days].forEach((x) => (x.g = null));
    this.groups().forEach((x) => ((x.grow = RM ? 9 : 0), (x.trig = RM)));
    this.execs.forEach((e) => (e.cg = RM ? 1 : 0));
    if (this.drawer.classList.contains('on')) this.closeExec();
    this.resize();
    this.renderControls();
    this.renderKpis();
    window.scrollTo({ top: 0, behavior: 'auto' });
    this.ctx.notify(g === 'day' ? 'Grouped by day: one 24-hour dial per day, one ring per lane' : 'Grouped by hour: one 60-minute dial per hour');
  }

  private setPerRow(n: number): void {
    this.perRow = n;
    pref('qaily.chrono.perRow', String(n));
    this.resize();
    this.renderControls();
  }

  private renderControls(): void {
    const F = this.F;
    const stale = this.execs.some((e) => !e.visible && (!this.packed || e.inPack));
    const on = this.packed && !stale;
    const toggle = <T>(set: Set<T>, v: T) => {
      if (set.has(v)) set.delete(v);
      else set.add(v);
      this.applyFilters();
    };
    const chip = (pressed: boolean, label: unknown, click: () => void, cls = '', title = '') =>
      html`<button type="button" class="chip ${cls}" aria-pressed=${String(pressed)} title=${title || nothing} @click=${click}>${label}</button>`;
    render(
      html`<div class="fgroup brand" role="group" aria-label="Group runs by"><label>View</label>
          ${chip(this.GROUP === 'hour', 'Hourly', () => this.setGroup('hour'))}${chip(this.GROUP === 'day', 'Daily', () => this.setGroup('day'))}</div>
        <div class="fgroup brand" role="group" aria-label="Runs per row"><label>Per row</label>
          ${[0, 1, 2, 3, 4, 6, 8, -1].map((n) =>
            chip(
              this.perRow === n,
              n === -1 ? '3D stagger' : n ? String(n) : 'Auto',
              () => this.setPerRow(n),
              n > 3 || n === -1 ? 'wide' : '',
              n === -1 ? 'Big cards near the dial, smaller ones further back' : n ? `${n} run${n > 1 ? 's' : ''} per row` : 'Fit to screen',
            ),
          )}</div>
        <div class="fgroup"><label for="lane">Lane</label>
          <select id="lane" class="chip" @change=${(ev: Event) => ((F.lane = (ev.target as HTMLSelectElement).value), this.applyFilters())}>
            <option value="all" ?selected=${F.lane === 'all'}>All lanes</option>
            ${this.model.lanes.map((l) => html`<option value=${l.id} ?selected=${F.lane === l.id}>${l.label}</option>`)}
          </select></div>
        <div class="fgroup"><label>Env</label>${F.envAll.map((env) => chip(F.env.has(env), env, () => toggle(F.env, env)))}</div>
        <div class="fgroup"><label>Status</label>
          ${(['passed', 'failed', 'flaky', 'running'] as Status[]).map((s) =>
            chip(F.status.has(s), html`<span class="d" style="--c:${COL[s]}"></span>${STATUS_LABEL[s]}`, () => toggle(F.status, s)),
          )}</div>
        <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
          <input type="search" placeholder="Search lane, branch or #run" autocomplete="off" .value=${F.q}
            @input=${(ev: Event) => ((F.q = (ev.target as HTMLInputElement).value.trim().toLowerCase()), this.applyFilters())} /></label>
        <button class="rearr ${stale ? 'stale' : on ? 'on' : ''}" type="button" aria-pressed=${String(on)}
          title="Move the runs you can see together and close the gaps" @click=${() => this.doPack(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M4 12h16M4 17h7"></path><path d="m17 4 3 3-3 3"></path></svg>
          <span>${on ? 'Rearranged' : 'Rearrange'}</span></button>`,
      this.controls,
    );
  }

  /* ================= KPIs ================= */
  private renderKpis(): void {
    const now = this.ctx.now();
    const todayKey = timeParts(now, this.utc).dayKey;
    const today = this.execs.filter((e) => e.parts.dayKey === todayKey);
    const done = today.filter((e) => e.status !== 'running');
    const flakyOk = this.ctx.settings.metrics.flakyCountsAsPassed;
    const rateOf = (list: Exec[]) => {
      let p = 0;
      let f = 0;
      for (const e of list) {
        const r = e.c.run;
        p += r.passed + (flakyOk ? r.flaky : 0);
        f += r.failed + (flakyOk ? 0 : r.flaky);
      }
      return p + f ? (p / (p + f)) * 100 : null;
    };
    const rate = rateOf(done);
    const flaky = done.reduce((a, e) => a + e.c.run.flaky, 0);
    const running = this.execs.filter((e) => e.status === 'running').length;
    // Pass rate per hour over the last 24 hours; an hour without runs carries the previous value.
    const vals: number[] = [];
    let carry = 100;
    for (let i = 23; i >= 0; i--) {
      const from = now.getTime() - (i + 1) * 3_600_000;
      const inHour = this.execs.filter((e) => {
        const t = Date.parse(e.c.run.started_at);
        return e.status !== 'running' && t >= from && t < from + 3_600_000;
      });
      carry = rateOf(inHour) ?? carry;
      vals.push(carry);
    }
    const lo = Math.min(80, Math.floor(Math.min(...vals) / 10) * 10);
    const W = 300;
    const H = 42;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - ((Math.max(lo, v) - lo) / (100 - lo)) * H]);
    const line = pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
    const lp = pts[pts.length - 1];
    const lanes = this.model.lanes;
    render(
      html`<div class="k"><span>Pass rate</span><b>${rate == null ? '–' : rate.toFixed(1)}<em>%</em></b></div>
        <div class="k"><span>Runs today</span><b>${today.length}</b></div>
        <div class="k"><span>Flaky</span><b style="color:var(--flaky)">${flaky}</b></div>
        <div class="k"><span>Running</span><b style="color:var(--run)">${running}</b></div>
        <div class="pulse"><span><span>Pass rate · last 24 h</span><span>${lo}–100%</span></span>
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg`
            <defs><linearGradient id="hg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8fe6ff" stop-opacity=".35"></stop><stop offset="1" stop-color="#8fe6ff" stop-opacity="0"></stop></linearGradient></defs>
            <line x1="0" x2=${W} y1=${H / 2} y2=${H / 2} stroke="rgba(255,255,255,.07)" stroke-dasharray="2 4"></line>
            <polygon points="0,${H} ${line} ${W},${H}" fill="url(#hg)"></polygon>
            <polyline points=${line} fill="none" stroke="#8fe6ff" stroke-width="1.6" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 4px #8fe6ff)"></polyline>
            ${vals.map((v, i) => {
              const lvl = this.ctx.health('passRate', v);
              return lvl === 'good' || lvl === 'none'
                ? nothing
                : svg`<circle cx=${pts[i][0].toFixed(1)} cy=${pts[i][1].toFixed(1)} r="2.6" fill=${lvl === 'bad' ? COL.failed : COL.flaky}></circle>`;
            })}
            <circle cx=${lp[0]} cy=${lp[1]} r="3.5" fill="#fff" style="filter:drop-shadow(0 0 6px #8fe6ff)"></circle>`}</svg></div>
        <div class="legend"><b>Reading a dial</b> ${this.GROUP === 'day'
          ? `Each dial is a 24-hour day. Rings are lanes (inner: ${lanes[0]?.label ?? '–'}, outer: ${lanes[lanes.length - 1]?.label ?? '–'}), and each arc is a run at its time of day.`
          : 'Each ring is one run, placed at its start minute.'} Arc length is duration, height is test count, and the color split is passed / failed / flaky.</div>`,
      this.kpis,
    );
  }

  /* ================= MINIMAP ================= */
  private camBottom = () => this.worldBottom + 3;
  private yToFrac = (y: number) => (TOPCAM - y) / (TOPCAM - this.camBottom());
  private buildMini(): void {
    const pct = (y: number) => `${(this.yToFrac(y) * 100).toFixed(2)}%`;
    render(
      html`${this.groups().map(
          (hr) => html`<div class="mh" style="top:${pct(hr.y)}"></div>
            ${hr.execs.map((e, k) =>
              e.visible
                ? html`<div class="md" style="top:${pct(e.a.y)};left:${(e.side < 0 ? 0 : 22) + (k >> 1) * 7}px;background:${COL[e.status]};box-shadow:0 0 6px ${COL[e.status]}"></div>`
                : nothing,
            )}`,
        )}
        ${this.dayMarks.map((m) => html`<div class="mday" style="top:${pct(m.y)}">${DAY_NAMES[this.days[m.i].parts.dow].toUpperCase()}</div>`)}
        <div class="view" id="mview"></div>`,
      this.track,
    );
  }
  private onMini = (ev: MouseEvent) => {
    const r = this.track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
    this.scrollToCamY(TOPCAM - f * (TOPCAM - this.camBottom()));
  };
  private scrollToCamY(cy: number): void {
    window.scrollTo({ top: Math.max(0, (TOPCAM - cy) * PXU), behavior: RM ? 'auto' : 'smooth' });
  }

  /* ================= THREE ================= */
  private dotTex(): THREE.CanvasTexture {
    if (this.dotTexC) return this.dotTexC;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 32, 32);
    this.dotTexC = new THREE.CanvasTexture(c);
    return this.dotTexC;
  }

  private initScene(): void {
    const renderer = this.renderer!;
    const scene = this.scene;
    const add = THREE.AdditiveBlending;
    renderer.setClearColor(raw(0x04060c), 1);
    this.CU = {
      cP: { value: raw(COL.passed) },
      cF: { value: raw(COL.failed) },
      cK: { value: raw(COL.flaky) },
      cS: { value: raw(0x5a6682) },
      cR: { value: raw(COL.running) },
    };
    const uni = this.uni;
    this.plateMat = new THREE.ShaderMaterial({
      uniforms: { uTime: uni.uTime, uMk: uni.uMk, ...this.dialU },
      vertexShader: PLATE_VS,
      fragmentShader: PLATE_FS,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.handMat = new THREE.MeshBasicMaterial({ color: raw(0xdff6ff), transparent: true, opacity: 0.85, blending: add, depthWrite: false, side: THREE.DoubleSide });
    // Rising particles in the spindle.
    const N = this.narrow ? 700 : 1600;
    const seed = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      seed[i * 3] = Math.random();
      seed[i * 3 + 1] = Math.random() * TAU;
      seed[i * 3 + 2] = Math.random();
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    pg.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
    this.flowMat = new THREE.ShaderMaterial({
      uniforms: { uTime: uni.uTime, uMk: uni.uMk, uPR: uni.uPR, uTop: { value: 2.6 }, uRange: { value: 60 } },
      transparent: true,
      depthWrite: false,
      blending: add,
      vertexShader: FLOW_VS,
      fragmentShader: FLOW_FS,
    });
    const flow = new THREE.Points(pg, this.flowMat);
    flow.frustumCulled = false;
    scene.add(flow);
    this.dustObj = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: raw(0x6f8cc8), size: 0.05, transparent: true, opacity: 0.5, depthWrite: false }));
    scene.add(this.dustObj);
    this.linkObj = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, blending: add, depthWrite: false }));
    this.linkObj.frustumCulled = false;
    scene.add(this.linkObj);
    const dots = () => new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, depthWrite: false, blending: add, map: this.dotTex() });
    this.sparkObj = new THREE.Points(new THREE.BufferGeometry(), dots());
    this.sparkObj.frustumCulled = false;
    scene.add(this.sparkObj);
    const BN = this.burstState.n;
    this.burstObj = new THREE.Points(new THREE.BufferGeometry(), dots());
    (this.burstObj.material as THREE.PointsMaterial).size = 0.08;
    this.burstObj.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BN * 3), 3));
    this.burstObj.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(BN * 3), 3));
    this.burstObj.frustumCulled = false;
    scene.add(this.burstObj);
    // Beacon: the "now" crystal at the top.
    const beacon = (this.beacon = new THREE.Group());
    beacon.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), new THREE.MeshBasicMaterial({ color: raw(0x8fe6ff), wireframe: true, transparent: true, opacity: 0.95, blending: add, depthWrite: false })));
    beacon.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.17, 0), new THREE.MeshBasicMaterial({ color: raw(0x4db6ff), transparent: true, opacity: 0.55, blending: add, depthWrite: false })));
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.008, 6, 80), new THREE.MeshBasicMaterial({ color: raw(0xb6a6ff), transparent: true, opacity: 0.8, blending: add, depthWrite: false }));
    halo.rotation.x = Math.PI / 2 - 0.3;
    beacon.add(halo);
    beacon.userData.halo = halo;
    scene.add(beacon);
    try {
      // 8-bit buffers and r147's bloom, like the original design: colours clip at 1 and the glow stays tight. r186's
      // defaults (HalfFloat, wider blur) wash the dials out.
      this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(this.VW, this.VH, { type: THREE.UnsignedByteType }));
      this.composer.addPass(new RenderPass(scene, this.camera));
      this.composer.addPass(new BloomPassR147(new THREE.Vector2(this.VW, this.VH), this.narrow ? 0.7 : 0.85, 0.5, 0.18));
    } catch {
      this.composer = null;
    }
  }

  private arcMat(h: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uni.uTime,
        uA0: { value: 0 },
        uLen: { value: 1 },
        uP: { value: 1 },
        uF: { value: 0 },
        uK: { value: 0 },
        uProg: { value: 1 },
        uRun: { value: 0 },
        uHi: { value: 0 },
        uGrow: { value: 1 },
        uVis: { value: 1 },
        uH: { value: h },
        ...this.CU,
      },
      transparent: true,
      vertexShader: ARC_VS,
      fragmentShader: ARC_FS,
    });
  }
  private setArcU(e: Exec): void {
    if (!e.mat) return;
    const u = e.mat.uniforms;
    if (e.status === 'running') {
      u.uRun.value = 1;
      u.uProg.value = e.progress;
    } else {
      const s = arcShares(e.c.run);
      u.uRun.value = 0;
      u.uP.value = s.p;
      u.uF.value = s.f;
      u.uK.value = s.k;
    }
  }

  private disposeTree(o: THREE.Object3D): void {
    o.traverse((n) => {
      const m = n as THREE.Mesh;
      m.geometry?.dispose();
      if (n.userData?.ownMat && m.material) (m.material as THREE.Material).dispose();
    });
  }

  private rebuildWorld(): void {
    if (!this.renderer) return;
    const scene = this.scene;
    const add = THREE.AdditiveBlending;
    if (this.dialRoot) {
      scene.remove(this.dialRoot);
      this.disposeTree(this.dialRoot);
    }
    this.groups().forEach((gr) => (gr.prevY = gr.g ? gr.g.position.y : null));
    this.execs.forEach((e) => {
      e.mat = null;
      e.mesh = null;
      e.arcW = e.failW = e.arcL = e.failL = null;
      e.arcLocal = null;
    });
    const dialRoot = (this.dialRoot = new THREE.Group());
    scene.add(dialRoot);
    this.arcMeshes = [];
    this.hands = [];
    const Rd = this.DIAL.R;
    const rIn = Rd * 0.5;
    const plateGeo = new THREE.RingGeometry(rIn - 0.1, Rd + 0.14, 160, 1);
    const handLen = Rd - rIn + 0.06;
    const handGeo = new THREE.PlaneGeometry(handLen, 0.018);
    handGeo.translate(rIn - 0.02 + handLen / 2, 0, 0.012);
    const isDay = this.GROUP === 'day';
    this.dialU.uTicks.value = isDay ? 24 : 60;
    this.dialU.uMajor.value = isDay ? 4 : 12;
    const lanesN = Math.max(1, this.model.lanes.length);
    const now = timeParts(this.ctx.now(), this.utc);
    this.groups().forEach((hr, hi) => {
      hr.g = null;
      const list = this.members(hr);
      if (!list.length) return;
      const g = new THREE.Group();
      g.position.set(0, hr.prevY != null ? hr.prevY : hr.dy, 0);
      g.rotation.x = -(Math.PI / 2 - this.DIAL.tilt);
      dialRoot.add(g);
      hr.g = g;
      const plate = new THREE.Mesh(plateGeo, this.plateMat);
      plate.renderOrder = 0;
      g.add(plate);
      const fails = list.some((e) => e.status === 'failed');
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(Rd + 0.15, 0.011, 6, 128),
        new THREE.MeshBasicMaterial({ color: raw(fails ? 0xff5c7a : 0x9fe8ff), transparent: true, opacity: fails ? 0.95 : 0.6, blending: add, depthWrite: false }),
      );
      rim.userData.ownMat = true;
      g.add(rim);
      const hand = new THREE.Mesh(handGeo, this.handMat);
      g.add(hand);
      this.hands.push(hand);
      const sorted = isDay ? list : [...list].sort((a, b) => a.parts.min - b.parts.min || a.id.localeCompare(b.id));
      // At least four rings, as in the original design: a lone run is a thin arc, not a band filling the dial.
      const n = Math.max(4, isDay ? lanesN : sorted.length);
      const band = (Rd - 0.04 - rIn) / n;
      sorted.forEach((e, k) => {
        if (isDay) k = Math.min(e.laneIdx, lanesN - 1);
        e.ring = k;
        const r0 = rIn + k * band + band * 0.13;
        const r1 = r0 + band * 0.74;
        const { a0, len } = isDay ? dayArc(e.parts.h, e.parts.min, e.c.run.dur_ms) : hourArc(e.parts.min, e.c.run.dur_ms);
        // Height from test count relative to the biggest run (the original design's mock data used /460); sqrt and a floor
        // keep small suites readable as solid blocks, like the original design's 0.1–0.34 range.
        const h = (this.narrow ? 0.06 : 0.09) + Math.sqrt(Math.min(1, e.c.run.total / this.maxTotal)) * (this.narrow ? 0.16 : 0.25);
        const sh = new THREE.Shape();
        sh.absarc(0, 0, r1, a0, a0 - len, true);
        sh.absarc(0, 0, r0, a0 - len, a0, false);
        const geo = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false, curveSegments: Math.max(10, Math.round(len * 30)) });
        const mat = this.arcMat(h);
        mat.uniforms.uA0.value = a0;
        mat.uniforms.uLen.value = len;
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = 1;
        m.userData = { e, ownMat: true };
        g.add(m);
        this.arcMeshes.push(m);
        e.mesh = m;
        e.mat = mat;
        this.setArcU(e);
        mat.uniforms.uVis.value = e.vis;
        mat.uniforms.uGrow.value = RM ? 1 : e.cg;
        const s = arcShares(e.c.run);
        const fp = s.p + s.k + s.f * 0.5;
        e.arcLocal = { r: (r0 + r1) / 2, mid: a0 - len * 0.5, fail: a0 - len * Math.min(0.98, fp), h };
      });
      // The "now" hand, on the dial that holds the current hour (or day).
      if (hi === 0 && (isDay ? hr.parts.dayKey === now.dayKey : hr.parts.hourKey === now.hourKey)) {
        const nowA = isDay ? Math.PI / 2 - ((now.h + now.min / 60) / 24) * TAU : Math.PI / 2 - (now.min / 60) * TAU;
        const nm = new THREE.Mesh(new THREE.BoxGeometry(0.03, Rd - rIn + 0.3, 0.03), new THREE.MeshBasicMaterial({ color: raw(0x4db6ff), transparent: true, opacity: 0.95, blending: add }));
        nm.userData.ownMat = true;
        const piv = new THREE.Group();
        nm.position.set(0, rIn + (Rd - rIn + 0.3) / 2 - 0.05, 0.02);
        piv.add(nm);
        piv.rotation.z = nowA - Math.PI / 2;
        g.add(piv);
      }
    });
    dialRoot.updateMatrixWorld(true);
    this.execs.forEach((e) => {
      const L = e.arcLocal;
      const g = this.G(e).g;
      if (!L || !g) return;
      e.arcL = new THREE.Vector3(L.r * Math.cos(L.mid), L.r * Math.sin(L.mid), L.h);
      e.failL = new THREE.Vector3(L.r * Math.cos(L.fail), L.r * Math.sin(L.fail), L.h);
      e.arcW = e.arcL.clone().applyMatrix4(g.matrixWorld);
      e.failW = e.failL.clone().applyMatrix4(g.matrixWorld);
    });
    // The spindle through all dial centres.
    const top = this.beaconY();
    const bot = this.worldBottom - 14;
    if (this.spindle) {
      scene.remove(this.spindle);
      this.spindle.geometry.dispose();
      (this.spindle.material as THREE.Material).dispose();
    }
    this.spindle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, top - bot, 10, 1, true),
      new THREE.ShaderMaterial({ uniforms: { uTime: this.uni.uTime, uMk: this.uni.uMk }, vertexShader: PLATE_VS, fragmentShader: SPINDLE_FS, transparent: true, depthWrite: false, blending: add }),
    );
    this.spindle.position.set(0, (top + bot) / 2, 0);
    scene.add(this.spindle);
    this.flowMat.uniforms.uRange.value = top - bot;
    this.flowMat.uniforms.uTop.value = top;
    this.beacon.scale.setScalar(this.narrow ? 0.8 : 1);
    this.beacon.position.set(0, top, 0);
    // Dust and the faint background network.
    const D = this.narrow ? 700 : 1600;
    const dp = new Float32Array(D * 3);
    for (let i = 0; i < D; i++) {
      dp[i * 3] = (Math.random() - 0.5) * 34;
      dp[i * 3 + 1] = top + 4 - Math.random() * (top + 4 - bot);
      dp[i * 3 + 2] = -18 + Math.random() * 16;
    }
    this.dustObj.geometry.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    this.dustObj.geometry.computeBoundingSphere();
    if (this.net) {
      scene.remove(this.net);
      this.net.geometry.dispose();
      (this.net.material as THREE.Material).dispose();
    }
    const nl: number[] = [];
    const nodes: number[][] = [];
    for (let i = 0; i < Math.round((top - bot) * 2.2); i++) nodes.push([(Math.random() - 0.5) * 40, top + 3 - Math.random() * (top + 3 - bot), -22 - Math.random() * 10]);
    nodes.forEach((a, i) => {
      for (let k = 0; k < 2; k++) {
        const b = nodes[(i + 1 + Math.floor(Math.random() * 4)) % nodes.length];
        if (Math.abs(a[1] - b[1]) < 9) nl.push(...a, ...b);
      }
    });
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nl), 3));
    this.net = new THREE.LineSegments(ng, new THREE.LineBasicMaterial({ color: raw(0x2d4170), transparent: true, opacity: 0.35, depthWrite: false }));
    scene.add(this.net);
    this.rebuildLinks();
  }

  private linkFar = (e: Exec) => this.GROUP === 'day' && Math.abs(e.anc.y - this.gy(this.G(e))) > 4.2;

  private rebuildLinks(): void {
    if (!this.renderer) return;
    this.linkExecs = this.narrow ? [] : this.execs.filter((e) => e.visible && e.arcW);
    const n = Math.max(1, this.linkExecs.length);
    const col = new Float32Array(n * 6);
    const sp: number[] = [];
    const spc: number[] = [];
    const meta: typeof this.sparkMeta = [];
    this.linkExecs.forEach((e, i) => {
      const c = raw(COL[e.status]);
      col.set([c.r * 0.9, c.g * 0.9, c.b * 0.9, c.r * 0.25, c.g * 0.25, c.b * 0.25], i * 6);
      if (e.status === 'failed' || e.status === 'running') {
        const k = e.status === 'failed' ? 9 : 5;
        for (let q = 0; q < k; q++) {
          meta.push({ e, ph: Math.random(), sp: 0.22 + Math.random() * 0.35, j: (Math.random() - 0.5) * 0.25, jz: (Math.random() - 0.5) * 0.25 });
          sp.push(0, 0, 0);
          spc.push(c.r, c.g, c.b);
        }
      }
    });
    const g = this.linkObj.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const sg = this.sparkObj.geometry;
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sp.length ? sp : [0, 0, 0]), 3));
    sg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(spc.length ? spc : [0, 0, 0]), 3));
    this.sparkMeta = meta;
    this.refreshLinkPos();
  }

  private refreshLinkPos(): void {
    const P = this.linkObj.geometry.attributes.position.array as Float32Array;
    this.linkExecs.forEach((e, i) => {
      const o = e.arcW!;
      const A = this.linkFar(e) ? o : e.anc;
      P.set([o.x, o.y, o.z, A.x, A.y, A.z], i * 6);
    });
    this.linkObj.geometry.attributes.position.needsUpdate = true;
  }

  private burst(pt: THREE.Vector3, hexCol: string): void {
    if (!this.renderer || RM) return;
    const B = this.burstState;
    const P = this.burstObj.geometry.attributes.position.array as Float32Array;
    const c = raw(hexCol);
    for (let i = 0; i < 60; i++) {
      const k = B.head;
      B.head = (B.head + 1) % B.n;
      P[k * 3] = pt.x + (Math.random() - 0.5) * 0.3;
      P[k * 3 + 1] = pt.y + (Math.random() - 0.5) * 0.2;
      P[k * 3 + 2] = pt.z + (Math.random() - 0.5) * 0.3;
      B.vel[k * 3] = (Math.random() - 0.5) * 1.8;
      B.vel[k * 3 + 1] = Math.random() * 1.6 + 0.4;
      B.vel[k * 3 + 2] = (Math.random() - 0.5) * 1.8;
      B.life[k] = 1;
      B.base[k * 3] = c.r;
      B.base[k * 3 + 1] = c.g;
      B.base[k * 3 + 2] = c.b;
    }
  }

  /* ================= POINTER / SCROLL ================= */
  private onPointer = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch') return;
    this.mx = ev.clientX / this.VW - 0.5;
    this.my = ev.clientY / this.VH - 0.5;
    this.ptrX = ev.clientX;
    this.ptrY = ev.clientY;
    this.ptrDirty = true;
  };
  private setHoverArc(e: Exec | null): void {
    if (e === this.hoverArc) return;
    if (this.hoverArc) {
      this.hoverArc.arcHover = 0;
      this.hoverArc.el.classList.remove('hl');
    }
    this.hoverArc = e;
    if (e) {
      e.arcHover = 1;
      e.el.classList.add('hl');
    }
    this.canvas.style.cursor = e ? 'pointer' : '';
  }
  private pickArc(x: number, y: number, near: number, span: number): Exec | null {
    this.mvec.set((x / this.VW) * 2 - 1, -((y / this.VH) * 2 - 1));
    this.ray.setFromCamera(this.mvec, this.camera);
    const cand = this.arcMeshes.filter((m) => (m.userData.e as Exec).visible && Math.abs(this.G(m.userData.e as Exec).dy - near) < span);
    const hit = this.ray.intersectObjects(cand, false)[0];
    return hit ? (hit.object.userData.e as Exec) : null;
  }
  private onCanvasClick = (ev: MouseEvent) => {
    if (!this.renderer) return;
    const e = this.pickArc(ev.clientX, ev.clientY, this.camY, 7);
    if (e) this.openExec(e);
  };
  private onScroll = () => {
    this.camYT = TOPCAM - scrollY / PXU;
    this.hint.style.opacity = scrollY > 40 ? '0' : '1';
  };
  private onResize = () => {
    clearTimeout(this.rz);
    this.rz = window.setTimeout(() => this.resize(), 120);
  };
  private onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && this.drawer.classList.contains('on')) this.closeExec();
  };

  /* ================= FRAME LOOP ================= */
  private project(x: number, y: number, z: number) {
    const v = this.v3.set(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.VW, y: (-v.y * 0.5 + 0.5) * this.VH, ndcY: v.y, ok: v.z < 1 };
  }

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    if (document.hidden) return;
    const { camera, narrow, VH } = this;
    const k = RM ? 1 : 1 - Math.pow(0.0009, dt);
    this.camY += (this.camYT - this.camY) * k;
    this.dolly += (this.dollyT - this.dolly) * k * 0.8;
    this.pan += (this.panT - this.pan) * k * 0.8;
    this.smx += (this.mx - this.smx) * k * 0.5;
    this.smy += (this.my - this.smy) * k * 0.5;
    const camY = this.camY;
    if (!RM) this.uni.uTime.value += dt;
    if (narrow) {
      camera.position.set(0, camY + 0.5, CAMZ + this.dolly);
      camera.lookAt(0, camY - 0.5, 0);
    } else {
      camera.position.set(this.pan + this.smx * 0.9, camY + 0.6 - this.smy * 0.5, CAMZ + this.dolly);
      camera.lookAt(this.pan * 0.9, camY - 0.9, 0);
    }
    camera.updateMatrixWorld();
    const lookY = camY - (narrow ? 0.5 : 0.9);
    // Cards glide after a rearrange; in the Daily view the dial sticks beside its day's cards.
    let moved = false;
    const kk = RM ? 1 : Math.min(1, dt * 7);
    for (const e of this.execs) {
      const a = e.a;
      const tg = e.ta;
      if (!tg) continue;
      if (Math.abs(a.x - tg.x) + Math.abs(a.y - tg.y) + Math.abs(a.z - tg.z) < 0.002) {
        e.a = { ...tg };
        e.anc = { ...e.tanc };
        e.ta = null;
      } else {
        a.x += (tg.x - a.x) * kk;
        a.y += (tg.y - a.y) * kk;
        a.z += (tg.z - a.z) * kk;
        const c = e.anc;
        const u = e.tanc;
        c.x += (u.x - c.x) * kk;
        c.y += (u.y - c.y) * kk;
        c.z += (u.z - c.z) * kk;
      }
      moved = true;
    }
    if (this.renderer) {
      for (const d of this.groups()) {
        if (!d.g) continue;
        const target = this.GROUP === 'day' && !narrow ? Math.min(d.stickTop, Math.max(d.stickBot, lookY)) : d.dy;
        const cur = d.g.position.y;
        if (Math.abs(target - cur) <= 1e-4) continue;
        d.g.position.y = Math.abs(target - cur) < 0.003 ? target : cur + (target - cur) * Math.min(1, RM ? 1 : dt * 8);
        d.g.updateMatrixWorld(true);
        moved = true;
        for (const e of d.execs) {
          if (e.arcL && this.G(e) === d) {
            e.arcW!.copy(e.arcL).applyMatrix4(d.g.matrixWorld);
            e.failW!.copy(e.failL!).applyMatrix4(d.g.matrixWorld);
          }
        }
      }
      if (moved) this.refreshLinkPos();
    }
    // Dials assemble when they first come into view.
    for (const hr of this.groups()) {
      if (!hr.trig && hr.dy > lookY - 5.2 && hr.dy < lookY + 5.5) hr.trig = true;
      if (hr.trig && hr.grow < 3) {
        hr.grow += dt * 0.85;
        for (const e of hr.execs) {
          const gv = ease(clamp01(hr.grow * 1.7 - (e.ring || 0) * 0.16));
          e.cg = gv;
          if (e.mat) e.mat.uniforms.uGrow.value = gv;
        }
      }
    }
    // Arc states: filter fade, hover lift.
    for (const e of this.execs) {
      if (!e.mat || !e.mesh) continue;
      e.vis += ((e.visible ? 1 : 0) - e.vis) * Math.min(1, dt * 5);
      e.mat.uniforms.uVis.value = e.vis;
      const ht = e.hover || e.arcHover || this.selected === e ? 1 : 0;
      e.hl += (ht - e.hl) * Math.min(1, dt * 9);
      e.mat.uniforms.uHi.value = e.hl;
      e.mesh.position.z = e.hl * 0.24;
    }
    if (this.ptrDirty && !narrow && this.renderer) {
      this.ptrDirty = false;
      this.setHoverArc(this.pickArc(this.ptrX, this.ptrY, lookY, 6));
    }
    // Project the DOM cards next to their dials.
    for (const e of this.execs) {
      const off = () => {
        if (!e.offscreen) {
          e.pos.classList.add('off');
          e.offscreen = true;
        }
      };
      if (Math.abs(e.a.y - camY) > 9) {
        off();
        continue;
      }
      const p = this.project(e.a.x, e.a.y, e.a.z);
      const ay = Math.abs(p.ndcY);
      if (ay > 1.4 || !p.ok) {
        off();
        continue;
      }
      if (e.offscreen) {
        e.pos.classList.remove('off');
        e.offscreen = false;
      }
      const dx = camera.position.x - e.a.x;
      const dy = camera.position.y - e.a.y;
      const dz = camera.position.z - e.a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const s = this.STAG ? Math.max(0.3, Math.min(1.8, (this.STW * this.unitPx(dist)) / 236)) : Math.max(0.5, Math.min(1.7, this.unitPx(dist) / this.PU));
      const cg = e.cg;
      const op = (1 - Math.max(0, Math.min(1, (ay - 0.92) / 0.4))) * clamp01(cg * 1.4);
      const px = p.x - (e.right ? 236 : 0) + (narrow ? 0 : (1 - cg) * e.side * -40);
      const py = p.y + (narrow ? (1 - cg) * 30 : 0);
      const tilt = narrow ? 0 : e.side * (this.STAG ? -16 : -8) * (e.hover ? 0.2 : 1);
      e.pos.style.transformOrigin = e.right ? '100% 0' : '0 0';
      e.pos.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) perspective(900px) rotateY(${tilt}deg) rotateX(${narrow ? ((1 - cg) * 30).toFixed(1) : 0}deg) scale(${s.toFixed(3)})`;
      e.pos.style.opacity = op.toFixed(3);
      e.pos.style.zIndex = String(Math.round(2000 - dist * 60) + (e.hover ? 500 : 0) + (this.selected === e ? 800 : 0));
    }
    for (const L of this.labels) {
      const a = L.get();
      const off = () => {
        if (!L.offscreen) {
          L.pos.classList.add('off');
          L.offscreen = true;
        }
      };
      if ('hidden' in a || Math.abs(a.y - camY) > 10) {
        off();
        continue;
      }
      const p = this.project(a.x, a.y, a.z);
      const ay = Math.abs(p.ndcY);
      if (ay > 1.4 || !p.ok) {
        off();
        continue;
      }
      if (L.offscreen) {
        L.pos.classList.remove('off');
        L.offscreen = false;
      }
      let tr = 'translate(-50%,-50%)';
      if (a.kind === 'hour') tr = `translate(-50%,-50%) perspective(600px) rotateX(${narrow ? 30 : 36}deg)`;
      if (a.kind === 'now') tr = 'translate(0,-50%)';
      const op = 1 - Math.max(0, Math.min(1, (ay - 0.9) / 0.45));
      L.pos.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) ${tr}`;
      L.pos.style.opacity = (a.kind === 'day' ? op * 0.9 : op).toFixed(3);
      L.pos.style.zIndex = a.kind === 'hour' ? '1500' : '1';
    }
    const mv = this.root.getElementById('mview') as HTMLElement | null;
    if (mv) {
      const span = VH / PXU;
      const f0 = this.yToFrac(camY + span * 0.25);
      const f1 = this.yToFrac(camY - span * 0.55);
      mv.style.top = `${Math.max(0, f0) * 100}%`;
      mv.style.height = `${Math.max(2, (f1 - f0) * 100)}%`;
    }
    if (!this.renderer) return;
    const hA = Math.PI / 2 - this.uni.uTime.value * 0.8;
    for (const h of this.hands) h.rotation.z = hA;
    this.beacon.rotation.y += dt * 0.8;
    (this.beacon.userData.halo as THREE.Mesh).rotation.z += dt * 0.5;
    // Sparks flow from failed and running arcs to their cards.
    const P = this.sparkObj.geometry.attributes.position.array as Float32Array;
    this.sparkMeta.forEach((m, i) => {
      m.ph = (m.ph + dt * m.sp) % 1;
      const e = m.e;
      const o = e.status === 'failed' ? e.failW : e.arcW;
      if (!o) return;
      if (this.linkFar(e)) {
        P.set([0, -9999, 0], i * 3);
        return;
      }
      const A = e.anc;
      const q = m.ph;
      P.set([o.x + (A.x - o.x) * q + m.j * Math.sin(q * 3.14), o.y + (A.y - o.y) * q + Math.sin(q * 3.14) * 0.5, o.z + (A.z - o.z) * q + m.jz], i * 3);
    });
    this.sparkObj.geometry.attributes.position.needsUpdate = true;
    const B = this.burstState;
    const BP = this.burstObj.geometry.attributes.position.array as Float32Array;
    const BC = this.burstObj.geometry.attributes.color.array as Float32Array;
    let alive = false;
    for (let i = 0; i < B.n; i++) {
      if (B.life[i] <= 0) continue;
      alive = true;
      B.life[i] -= dt * 0.9;
      const l = Math.max(0, B.life[i]);
      BP[i * 3] += B.vel[i * 3] * dt;
      BP[i * 3 + 1] += B.vel[i * 3 + 1] * dt;
      BP[i * 3 + 2] += B.vel[i * 3 + 2] * dt;
      B.vel[i * 3 + 1] -= dt * 0.3;
      BC[i * 3] = B.base[i * 3] * l;
      BC[i * 3 + 1] = B.base[i * 3 + 1] * l;
      BC[i * 3 + 2] = B.base[i * 3 + 2] * l;
    }
    if (alive) {
      this.burstObj.geometry.attributes.position.needsUpdate = true;
      this.burstObj.geometry.attributes.color.needsUpdate = true;
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, camera);
  };

  private resize(): void {
    this.layout();
    if (this.renderer) {
      const { VW, VH, narrow } = this;
      this.camera.aspect = VW / VH;
      this.camera.updateProjectionMatrix();
      const pr = Math.min(devicePixelRatio || 1, narrow ? 1.6 : 2);
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(VW, VH, false);
      this.uni.uPR.value = pr;
      if (this.composer) {
        this.composer.setPixelRatio(pr);
        this.composer.setSize(VW, VH);
      }
      this.rebuildWorld();
    }
    this.buildMini();
    this.onScroll();
  }

  private liveTick(): void {
    if (this.nowLabel) render(this.nowHtml(), this.nowLabel.el);
    const now = this.ctx.now().getTime();
    for (const e of this.execs) {
      if (e.status !== 'running') continue;
      e.progress = runProgress(Date.parse(e.c.run.started_at), now, e.typical);
      this.setArcU(e);
      this.renderCard(e);
      if (this.selected === e) this.renderDrawer(e);
    }
    this.renderKpis();
  }

  /* ================= DRAWER ================= */
  private openExec(e: Exec): void {
    if (this.selected && this.selected !== e) this.selected.el.classList.remove('sel');
    this.selected = e;
    e.el.classList.add('sel');
    if (this.narrow) this.scrollToCamY(e.a.y - 2.3);
    else {
      this.scrollToCamY(this.GROUP === 'day' ? e.anc.y + 0.9 : e.hr.dy + 0.9);
      this.dollyT = -2.2;
      this.panT = e.a.x * 0.22;
    }
    this.renderDrawer(e);
    void this.loadFailures(e);
    this.drawer.classList.add('on');
    this.scrim.classList.add('on');
    this.drawer.setAttribute('aria-hidden', 'false');
    setTimeout(() => this.drawer.querySelector<HTMLElement>('.x')?.focus({ preventScroll: true }), 350);
  }

  private closeExec(): void {
    if (this.selected) {
      const el = this.selected.el;
      el.classList.remove('sel');
      this.selected = null;
      el.focus({ preventScroll: true });
    }
    this.dollyT = 0;
    this.panT = 0;
    this.drawer.classList.remove('on');
    this.scrim.classList.remove('on');
    this.drawer.setAttribute('aria-hidden', 'true');
  }

  private async loadFailures(e: Exec): Promise<void> {
    const r = e.c.run;
    if (this.failures.id === e.id && this.failures.rows) return;
    this.failures = { id: e.id, rows: null, error: '' };
    if (!r.failed && !r.flaky) {
      this.failures.rows = [];
      this.renderDrawer(e);
      return;
    }
    try {
      const start = Date.parse(r.started_at);
      const rows = await this.ctx.data.query<FailedTest>(
        `SELECT test_id, title, status, file, project, err_summary, attempts FROM tests
         WHERE run_id = '${e.id.replaceAll("'", "''")}' AND status IN ('failed', 'flaky')
         ORDER BY status, title LIMIT 40`,
        { from: new Date(start - 86_400_000), to: new Date(start + 2 * 86_400_000) },
      );
      if (this.failures.id === e.id) this.failures.rows = rows;
    } catch (err) {
      if (this.failures.id === e.id) this.failures.error = err instanceof Error ? err.message : String(err);
    }
    if (this.selected === e) this.renderDrawer(e);
  }

  private renderDrawer(e: Exec): void {
    const r = e.c.run;
    const running = e.status === 'running';
    const ex = r.passed + r.flaky + r.failed + r.skipped || 1;
    const hist = this.execs
      .filter((x) => x.c.laneId === e.c.laneId && x.status !== 'running' && x.c.run.started_at <= r.started_at)
      .slice(0, 14)
      .reverse();
    const W = 380;
    const H = 86;
    const lo = 50;
    const bw = W / Math.max(hist.length, 8);
    const topY = H - (H - 14 + 2);
    const fl = this.failures.id === e.id ? this.failures : { rows: null, error: '' };
    const nav = this.ctx.nav;
    const month = MONTHS[e.parts.month].slice(0, 3);
    render(
      html`<div class="dh s-${e.status}"><span class="pill">${STATUS_LABEL[e.status]}</span><span class="id">EXEC #${e.num}</span>
          <button class="x" type="button" aria-label="Close details" @click=${() => this.closeExec()}>×</button></div>
        <h2>${e.laneLabel}</h2>
        <div class="sub">${r.category ? html`<span>${r.category}</span>` : nothing}<span class="env env-${envClass(e.env)}">${e.env}</span>
          ${r.branch ? html`<code>${r.branch}</code>` : nothing}${r.commit ? html`<code>${r.commit.slice(0, 7)}</code>` : nothing}</div>
        <div class="sub" style="margin-top:6px">${suiteBadge(r.tag)}
          <span>Started ${DAY_NAMES[e.parts.dow]} ${e.parts.dom} ${month} · ${pad(e.parts.h)}:${pad(e.parts.min)}</span>
          <span>${running ? 'In progress' : fmtDur(r.dur_ms)}</span></div>
        ${running ? html`<div class="prog"><i style="width:${(e.progress * 100).toFixed(0)}%"></i></div>` : nothing}
        <div class="stats">
          <div><span>Passed</span><b style="color:var(--pass)">${fmtN(r.passed)}</b></div>
          <div><span>Failed</span><b style="color:var(--fail)">${r.failed}</b></div>
          <div><span>Flaky</span><b style="color:var(--flaky)">${r.flaky}</b></div>
          <div><span>Skipped</span><b style="color:var(--mute)">${r.skipped}</b></div>
        </div>
        <div class="stack" aria-hidden="true"><i style="width:${(r.passed / ex) * 100}%;background:var(--pass)"></i><i style="width:${(r.flaky / ex) * 100}%;background:var(--flaky)"></i><i style="width:${(r.failed / ex) * 100}%;background:var(--fail)"></i><i style="width:${(r.skipped / ex) * 100}%;background:var(--mute)"></i></div>
        <div class="sec"><h3><span>${r.failed ? 'Failed tests' : 'Flaky tests'}</span><span>${r.failed + r.flaky}</span></h3>
          ${fl.error
            ? html`<div class="ft"><div class="t">Couldn't load the tests</div><pre>${fl.error}</pre></div>`
            : fl.rows == null
              ? html`<div class="f muted">Loading…</div>`
              : fl.rows.length
                ? fl.rows.map(
                    (t) => html`<a class="ft${t.status === 'flaky' ? ' flk' : ''}" href=${nav.href('tests', { run: e.id, test: t.test_id })}>
                      <div class="t">${t.title}</div>
                      <div class="f"><span>${t.file}</span><span>${t.project} · attempts ${t.attempts}</span></div>
                      ${t.err_summary ? html`<pre>${t.err_summary}</pre>` : nothing}</a>`,
                  )
                : html`<div class="ok">${running ? 'No failures so far. Results stream in as the run goes.' : 'All executed tests passed on the first attempt.'}</div>`}
          ${fl.rows && r.failed + r.flaky > fl.rows.length && fl.rows.length >= 40 ? html`<div class="f muted">+ ${r.failed + r.flaky - fl.rows.length} more in Tests</div>` : nothing}</div>
        <div class="sec trend"><h3><span>This lane · last ${hist.length} runs</span><span>pass %</span></h3>
          <svg viewBox="0 0 ${W} ${H + 14}" preserveAspectRatio="none">${svg`
            <line x1="0" x2=${W} y1=${topY} y2=${topY} stroke="rgba(255,255,255,.1)" stroke-dasharray="3 4"></line>
            <line x1="0" x2=${W} y1=${H} y2=${H} stroke="rgba(255,255,255,.15)"></line>
            <text class="ax" x=${W} y=${topY - 3} text-anchor="end">100%</text><text class="ax" x=${W} y=${H + 11} text-anchor="end">50%</text>
            ${hist.map((x, i) => {
              const v = Math.max(lo, x.c.rate ?? 0);
              const h = ((v - lo) / (100 - lo)) * (H - 14) + 2;
              return svg`<rect x=${(i * bw + 3).toFixed(1)} y=${(H - h).toFixed(1)} width=${(bw - 6).toFixed(1)} height=${h.toFixed(1)} rx="2" fill=${COL[x.status]} opacity=${x === e ? 1 : 0.55}><title>#${x.num} · ${(x.c.rate ?? 0).toFixed(1)}%</title></rect>`;
            })}`}</svg></div>
        <div class="actions">
          <a class="btn" href=${nav.href('tests', { run: e.id, ...(r.failed ? { status: 'failed' } : {}) })}>Open in Tests</a>
          <a class="btn ghost" href=${nav.href('issues', { run: e.id })}>Issues</a>
          ${r.ci_url ? html`<a class="btn ghost" href=${r.ci_url} target="_blank" rel="noopener">CI run ↗</a>` : nothing}
          <button class="btn ghost" type="button" @click=${() => this.copyLink(e)}>Copy link</button>
        </div>`,
      this.drawer,
    );
  }

  private copyLink(e: Exec): void {
    const url = new URL(this.ctx.nav.href('tests', { run: e.id }), location.href).href;
    navigator.clipboard.writeText(url).then(
      () => this.ctx.notify(`Link to #${e.num} copied`),
      () => this.ctx.notify('Could not copy', 'error'),
    );
  }
}

const tag = 'q-chronoscope';
if (!customElements.get(tag)) customElements.define(tag, ChronoscopeView);

const view: ViewModule<MonitoringLike> = {
  isSupported(ctx) {
    if (ctx.theme.reducedMotion) return 'reduced motion is on, and this view is animated.';
    if (!canUseWebGL()) return 'this browser has no WebGL.';
    return true;
  },
  mount(host, model, ctx) {
    const el = document.createElement(tag) as ChronoscopeView;
    el.model = model;
    el.ctx = ctx;
    host.append(el);
    return {
      update(next, nextCtx) {
        el.setModel(next, nextCtx);
      },
      destroy() {
        el.remove();
      },
    };
  },
};

export default view;
