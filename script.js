"use strict";

/* Noodle Box — a tiny modular synth. No libraries, just the Web Audio API.
   Modules own a few AudioNodes; cables either connect audio outputs to
   audio inputs / AudioParams, or carry gate (trigger) events as plain JS
   callbacks with pre-scheduled audio-clock timestamps. */

const AC = new (window.AudioContext || window.webkitAudioContext)();
if (AC.state === "running") AC.suspend();

/* ---------------- little helpers ---------------- */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

const curveVal = (c, min, max, t) =>
  c === "log" ? min * Math.pow(max / min, t) :
  c === "sq"  ? min + (max - min) * t * t :
  c === "cu"  ? min + (max - min) * t * t * t :
                min + (max - min) * t;
const curveT = (c, min, max, v) =>
  c === "log" ? Math.log(v / min) / Math.log(max / min) :
  c === "sq"  ? Math.sqrt((v - min) / (max - min)) :
  c === "cu"  ? Math.cbrt((v - min) / (max - min)) :
                (v - min) / (max - min);

const fHz = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + " kHz" : v >= 100 ? Math.round(v) + " Hz" : v.toFixed(1) + " Hz");
const fS = (v) => (v >= 1 ? v.toFixed(2) + " s" : Math.round(v * 1000) + " ms");
const fPct = (v) => Math.round(v * 100) + "%";
const fNum = (v) => String(Math.round(v * 100) / 100);
const fNote = (v) => noteName(Math.round(v));
const fBpm = (v) => Math.round(v) + " bpm";
const fInt = (v) => String(Math.round(v));

const smooth = (p, v, tc = 0.015) => p.setTargetAtTime(v, AC.currentTime, tc);
const holdParam = (p, t) => {
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
};

function whiteNoiseBuffer(seconds) {
  const buf = AC.createBuffer(1, Math.floor(AC.sampleRate * seconds), AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function impulseBuffer(seconds) {
  const len = Math.max(1, Math.floor(AC.sampleRate * seconds));
  const buf = AC.createBuffer(2, len, AC.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  return buf;
}

/* ---------------- state ---------------- */

const modules = [];
const conns = []; // {a: outPort, b: inPort, el, vis}
let playing = false;
let uid = 0;

const field = document.getElementById("field");
const fieldSizer = document.getElementById("fieldSizer");
const work = document.getElementById("work");
const svg = document.getElementById("cables");
const CABLE_COLOR = { audio: "#6ee7ff", gate: "#ffb066" };

/* board zoom: #field keeps its native 1750x1050 coordinate space (module
   x/y, port and cable math all live there) and is just visually scaled;
   #fieldSizer's own box is resized to match so #work's scroll range lines
   up with what's actually on screen. Everything that reads real pointer
   coordinates against #field has to divide by `zoom` to land back in that
   native space — see portCenter, moveWire, bindModuleDrag, and the palette
   "+module" placement below. */
const ZOOM_MIN = 0.35, ZOOM_MAX = 1.25;
let zoom = clamp(window.innerWidth / 900, ZOOM_MIN, 1);
function setZoom(z, anchorClientX, anchorClientY) {
  const wr = work.getBoundingClientRect();
  const ax = anchorClientX != null ? anchorClientX - wr.left : wr.width / 2;
  const ay = anchorClientY != null ? anchorClientY - wr.top : wr.height / 2;
  // the local-space point currently under the anchor, so we can keep it
  // under the same screen position after the zoom changes (no jarring jump)
  const localX = (work.scrollLeft + ax) / zoom;
  const localY = (work.scrollTop + ay) / zoom;
  zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
  field.style.transform = `scale(${zoom})`;
  fieldSizer.style.width = 1750 * zoom + "px";
  fieldSizer.style.height = 1050 * zoom + "px";
  work.scrollLeft = localX * zoom - ax;
  work.scrollTop = localY * zoom - ay;
  zoomReset.textContent = Math.round(zoom * 100) + "%";
}

/* step clocks (seq + arp): eighth notes at the module's tempo */
const stepDur = (m) => 60 / knobVal(m, "tempo") / 2;

function fireGate(m, portId, ev) {
  for (const c of conns) {
    if (c.a.m === m && c.a.id === portId && c.b.m.spec.gate) c.b.m.spec.gate(c.b.m, c.b.id, ev);
  }
}
const hasConnTo = (m, portId) => conns.some((c) => c.b.m === m && c.b.id === portId);

function makeClock(m, onStep) {
  m.pos = -1;
  m.nextT = AC.currentTime + 0.1;
  m.tick = () => {
    if (hasConnTo(m, "clock")) return; // an external clock is driving us
    while (m.nextT < AC.currentTime + 0.15) {
      onStep(m, m.nextT);
      m.nextT += stepDur(m);
    }
  };
  m.clockStep = onStep; // used by the clock-in gate handler
}

/* ---------------- module catalogue ---------------- */

const TYPES = {
  osc: {
    title: "oscillator", color: "#7cd6ff",
    selects: [{ id: "wave", opts: ["sine", "triangle", "sawtooth", "square"], v0: "sawtooth" }],
    knobs: [
      { id: "freq", label: "freq", min: 0, max: 2000, curve: "sq", v0: 110, fmt: fHz },
      { id: "fm", label: "fm amt", min: 0, max: 2000, curve: "cu", v0: 0, fmt: fHz },
    ],
    ins: [{ id: "pitch", kind: "audio" }, { id: "fm", kind: "audio" }],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const o = AC.createOscillator();
      o.frequency.value = 0;
      o.start();
      const fm = AC.createGain();
      fm.gain.value = 0;
      fm.connect(o.frequency);
      m.n = { o, fm };
      m.inT = { pitch: o.frequency, fm };
      m.outN = { out: o };
    },
    knob(m, id, v) { id === "freq" ? smooth(m.n.o.frequency, v) : smooth(m.n.fm.gain, v); },
    select(m, id, v) { m.n.o.type = v; },
  },

  lfo: {
    title: "lfo", color: "#c39bff",
    selects: [{ id: "wave", opts: ["sine", "triangle", "sawtooth", "square"], v0: "sine" }],
    knobs: [{ id: "rate", label: "rate", min: 0.02, max: 30, curve: "log", v0: 2, fmt: fHz }],
    ins: [],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const o = AC.createOscillator();
      o.frequency.value = 2;
      o.start();
      m.n = { o };
      m.inT = {};
      m.outN = { out: o };
    },
    knob(m, id, v) { smooth(m.n.o.frequency, v); },
    select(m, id, v) { m.n.o.type = v; },
  },

  env: {
    title: "envelope", color: "#ffd166",
    knobs: [
      { id: "atk", label: "attack", min: 0.002, max: 3, curve: "log", v0: 0.005, fmt: fS },
      { id: "dec", label: "decay", min: 0.01, max: 4, curve: "log", v0: 0.25, fmt: fS },
      { id: "sus", label: "sustain", min: 0, max: 1, curve: "lin", v0: 0.4, fmt: fPct },
      { id: "rel", label: "release", min: 0.01, max: 6, curve: "log", v0: 0.3, fmt: fS },
    ],
    ins: [{ id: "gate", kind: "gate" }],
    outs: [{ id: "out", kind: "audio", role: "cv" }],
    create(m) {
      const cs = AC.createConstantSource();
      cs.offset.value = 0;
      cs.start();
      m.n = { cs };
      m.inT = {};
      m.outN = { out: cs };
    },
    gate(m, portId, ev) {
      const p = m.n.cs.offset;
      const a = knobVal(m, "atk"), d = knobVal(m, "dec"), s = knobVal(m, "sus"), r = knobVal(m, "rel");
      const t = Math.max(ev.t, AC.currentTime);
      holdParam(p, t);
      p.linearRampToValueAtTime(1, t + a);
      p.setTargetAtTime(s, t + a, Math.max(0.01, d / 3));
      if (ev.dur != null) {
        const tr = t + Math.max(ev.dur, a + 0.01);
        holdParam(p, tr);
        p.setTargetAtTime(0, tr, Math.max(0.01, r / 3));
      }
    },
  },

  amp: {
    title: "amp", color: "#7cffb2",
    knobs: [{ id: "level", label: "level", min: 0, max: 1, curve: "lin", v0: 0.7, fmt: fPct }],
    ins: [{ id: "in", kind: "audio", strict: true }, { id: "cv", kind: "audio" }],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const g = AC.createGain();
      m.n = { g };
      m.inT = { in: g, cv: g.gain };
      m.outN = { out: g };
    },
    knob(m, id, v) { smooth(m.n.g.gain, v); },
  },

  filter: {
    title: "filter", color: "#ffab6b",
    selects: [{ id: "type", opts: ["lowpass", "highpass", "bandpass"], v0: "lowpass" }],
    knobs: [
      { id: "cut", label: "cutoff", min: 40, max: 12000, curve: "log", v0: 1200, fmt: fHz },
      { id: "res", label: "res", min: 0, max: 20, curve: "sq", v0: 2, fmt: fNum },
      { id: "mod", label: "mod amt", min: 0, max: 8000, curve: "cu", v0: 0, fmt: fHz },
    ],
    ins: [{ id: "in", kind: "audio", strict: true }, { id: "cut", kind: "audio" }],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const f = AC.createBiquadFilter();
      const mg = AC.createGain();
      mg.gain.value = 0;
      mg.connect(f.frequency);
      m.n = { f, mg };
      m.inT = { in: f, cut: mg };
      m.outN = { out: f };
    },
    knob(m, id, v) {
      if (id === "cut") smooth(m.n.f.frequency, v);
      else if (id === "res") smooth(m.n.f.Q, v);
      else smooth(m.n.mg.gain, v);
    },
    select(m, id, v) { m.n.f.type = v; },
  },

  noise: {
    title: "noise", color: "#aab6d6",
    knobs: [{ id: "level", label: "level", min: 0, max: 1, curve: "sq", v0: 0.5, fmt: fPct }],
    ins: [],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const src = AC.createBufferSource();
      src.buffer = whiteNoiseBuffer(2);
      src.loop = true;
      src.start();
      const g = AC.createGain();
      src.connect(g);
      m.n = { src, g };
      m.inT = {};
      m.outN = { out: g };
    },
    knob(m, id, v) { smooth(m.n.g.gain, v); },
  },

  seq: {
    title: "sequencer", color: "#ff8bd0",
    knobs: [
      { id: "tempo", label: "tempo", min: 40, max: 240, curve: "lin", v0: 120, fmt: fBpm },
      { id: "gate", label: "gate len", min: 0.05, max: 0.95, curve: "lin", v0: 0.6, fmt: fPct },
      { id: "glide", label: "glide", min: 0, max: 0.4, curve: "cu", v0: 0, fmt: fS },
    ],
    ins: [{ id: "clock", kind: "gate" }],
    outs: [{ id: "pitch", kind: "audio", role: "cv" }, { id: "gate", kind: "gate" }],
    create(m) {
      const cs = AC.createConstantSource();
      cs.offset.value = 0;
      cs.start();
      m.n = { cs };
      m.inT = {};
      m.outN = { pitch: cs };
      if (!m.stepsData) m.stepsData = [57, 60, 62, 64, 67, 69, 64, 62].map((n) => ({ n, on: true }));
      makeClock(m, (mm, t) => {
        mm.pos = (mm.pos + 1) % mm.stepsData.length;
        const st = mm.stepsData[mm.pos];
        if (st.on) {
          const g = knobVal(mm, "glide");
          const p = mm.n.cs.offset;
          if (g > 0.003) p.setTargetAtTime(midiHz(st.n), t, g / 3);
          else p.setValueAtTime(midiHz(st.n), t);
          fireGate(mm, "gate", { t, dur: stepDur(mm) * knobVal(mm, "gate") });
        }
        litCell(mm, mm.pos, t);
      });
    },
    gate(m, portId, ev) { if (playing) m.clockStep(m, ev.t); },
    custom(m, body) {
      const row = document.createElement("div");
      row.className = "steps";
      m.cells = m.stepsData.map((st, i) => {
        const c = document.createElement("div");
        c.className = "cell";
        c.innerHTML = '<div class="fill"></div><div class="nn"></div>';
        bindCell(m, c, i);
        row.appendChild(c);
        return c;
      });
      body.appendChild(row);
      refreshSteps(m);
    },
  },

  arp: {
    title: "arpeggio", color: "#ff8b7c",
    selects: [
      { id: "chord", opts: ["minor", "major", "min7", "maj7", "sus4"], v0: "minor" },
      { id: "pattern", opts: ["up", "down", "up-down", "random"], v0: "up" },
    ],
    knobs: [
      { id: "root", label: "root", min: 36, max: 72, curve: "lin", step: 1, v0: 45, fmt: fNote },
      { id: "tempo", label: "tempo", min: 40, max: 240, curve: "lin", v0: 120, fmt: fBpm },
      { id: "oct", label: "octaves", min: 1, max: 3, curve: "lin", step: 1, v0: 2, fmt: fInt },
      { id: "gate", label: "gate len", min: 0.05, max: 0.95, curve: "lin", v0: 0.5, fmt: fPct },
    ],
    ins: [{ id: "clock", kind: "gate" }],
    outs: [{ id: "pitch", kind: "audio", role: "cv" }, { id: "gate", kind: "gate" }],
    create(m) {
      const cs = AC.createConstantSource();
      cs.offset.value = 0;
      cs.start();
      m.n = { cs };
      m.inT = {};
      m.outN = { pitch: cs };
      const IV = { minor: [0, 3, 7], major: [0, 4, 7], min7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7] };
      makeClock(m, (mm, t) => {
        mm.pos++;
        const root = Math.round(knobVal(mm, "root"));
        const octs = Math.round(knobVal(mm, "oct"));
        const notes = [];
        for (let o = 0; o < octs; o++) for (const iv of IV[mm.sel.chord]) notes.push(root + iv + 12 * o);
        const N = notes.length;
        const pat = mm.sel.pattern;
        let i;
        if (pat === "up") i = mm.pos % N;
        else if (pat === "down") i = N - 1 - (mm.pos % N);
        else if (pat === "random") i = Math.floor(Math.random() * N);
        else { const L = Math.max(1, 2 * N - 2), k = mm.pos % L; i = k < N ? k : L - k; }
        const note = notes[i];
        mm.n.cs.offset.setValueAtTime(midiHz(note), t);
        fireGate(mm, "gate", { t, dur: stepDur(mm) * knobVal(mm, "gate") });
        if (mm.readEl) {
          setTimeout(() => { mm.readEl.textContent = noteName(note); },
            Math.max(0, (t - AC.currentTime) * 1000));
        }
      });
    },
    gate(m, portId, ev) { if (playing) m.clockStep(m, ev.t); },
    custom(m, body) {
      const r = document.createElement("div");
      r.className = "aread";
      r.textContent = "—";
      m.readEl = r;
      body.appendChild(r);
    },
  },

  delay: {
    title: "delay", color: "#6bd7c9",
    knobs: [
      { id: "time", label: "time", min: 0.03, max: 1, curve: "log", v0: 0.3, fmt: fS },
      { id: "fb", label: "feedback", min: 0, max: 0.9, curve: "lin", v0: 0.35, fmt: fPct },
      { id: "mix", label: "mix", min: 0, max: 1, curve: "lin", v0: 0.35, fmt: fPct },
    ],
    ins: [{ id: "in", kind: "audio", strict: true }],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const inG = AC.createGain(), outG = AC.createGain(), wet = AC.createGain(), fb = AC.createGain();
      const dl = AC.createDelay(2);
      inG.connect(outG);          // dry
      inG.connect(dl);
      dl.connect(wet);
      wet.connect(outG);
      dl.connect(fb);
      fb.connect(dl);
      m.n = { inG, outG, wet, fb, dl };
      m.inT = { in: inG };
      m.outN = { out: outG };
    },
    knob(m, id, v) {
      if (id === "time") smooth(m.n.dl.delayTime, v, 0.08); // slow slew = tape-style pitch warp
      else if (id === "fb") smooth(m.n.fb.gain, v);
      else smooth(m.n.wet.gain, v);
    },
  },

  dist: {
    title: "distort", color: "#ff5c6c",
    knobs: [
      { id: "drive", label: "drive", min: 1, max: 60, curve: "log", v0: 8, fmt: fNum },
      { id: "level", label: "level", min: 0, max: 1, curve: "lin", v0: 0.6, fmt: fPct },
    ],
    ins: [{ id: "in", kind: "audio", strict: true }],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const pre = AC.createGain(), post = AC.createGain();
      const sh = AC.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(3 * (i / 511.5 - 1));
      sh.curve = curve;
      sh.oversample = "2x";
      pre.connect(sh);
      sh.connect(post);
      m.n = { pre, post, sh };
      m.inT = { in: pre };
      m.outN = { out: post };
    },
    knob(m, id, v) {
      if (id === "drive") {
        smooth(m.n.pre.gain, v);
        if (m.k.level != null) this.knob(m, "level", knobVal(m, "level"));
      } else smooth(m.n.post.gain, v / (1 + knobVal(m, "drive") / 10));
    },
  },

  verb: {
    title: "reverb", color: "#8ba7ff",
    knobs: [
      { id: "size", label: "size", min: 0.3, max: 5, curve: "log", v0: 2, fmt: fS },
      { id: "mix", label: "mix", min: 0, max: 1, curve: "lin", v0: 0.3, fmt: fPct },
    ],
    ins: [{ id: "in", kind: "audio", strict: true }],
    outs: [{ id: "out", kind: "audio" }],
    create(m) {
      const inG = AC.createGain(), outG = AC.createGain(), wet = AC.createGain();
      const cv = AC.createConvolver();
      cv.buffer = impulseBuffer(2);
      inG.connect(outG);
      inG.connect(cv);
      cv.connect(wet);
      wet.connect(outG);
      m.n = { inG, outG, wet, cv };
      m.inT = { in: inG };
      m.outN = { out: outG };
    },
    knob(m, id, v) {
      if (id === "mix") smooth(m.n.wet.gain, v);
      else {
        clearTimeout(m.sizeTimer);
        m.sizeTimer = setTimeout(() => { m.n.cv.buffer = impulseBuffer(v); }, 250);
      }
    },
    dispose(m) { clearTimeout(m.sizeTimer); },
  },

  out: {
    title: "speaker", color: "#e8ecff",
    knobs: [{ id: "vol", label: "volume", min: 0, max: 1, curve: "lin", v0: 0.8, fmt: fPct }],
    ins: [{ id: "in", kind: "audio", strict: true }],
    outs: [],
    create(m) {
      const g = AC.createGain();
      const clip = AC.createWaveShaper(); // gentle safety limiter
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = i / 511.5 - 1;
        curve[i] = Math.tanh(2.5 * x) / Math.tanh(2.5);
      }
      clip.curve = curve;
      const mute = AC.createGain();
      mute.gain.value = playing ? 1 : 0; // transport controls this
      const an = AC.createAnalyser();
      an.fftSize = 1024;
      g.connect(clip);
      clip.connect(mute);
      mute.connect(AC.destination);
      mute.connect(an);
      m.n = { g, clip, mute, an };
      m.inT = { in: g };
      m.outN = {};
    },
    knob(m, id, v) { smooth(m.n.g.gain, v); },
    custom(m, body) {
      const c = document.createElement("canvas");
      c.className = "scope";
      c.width = 300;
      c.height = 108;
      m.scope = c;
      body.appendChild(c);
    },
  },
};

const PALETTE_ORDER = ["osc", "lfo", "env", "amp", "filter", "seq", "arp", "noise", "delay", "dist", "verb", "out"];

/* Hot-swap: two module types are drop-in replacements for each other only
   if their ports match exactly — same ids, same kind, same cv/strict role,
   on both ins and outs. That's true for a few natural families as-is
   (delay/dist/verb, seq/arp, lfo/noise) without any extra bookkeeping here;
   it's derived from TYPES so it never drifts out of sync with the port
   declarations above. */
function portSetSig(list) {
  return list.map((p) => `${p.id}|${p.kind}|${p.role || ""}|${p.strict ? 1 : 0}`).sort().join(",");
}
function moduleSig(spec) { return portSetSig(spec.ins) + "::" + portSetSig(spec.outs); }
const SWAP_GROUPS = {};
for (const t of Object.keys(TYPES)) {
  SWAP_GROUPS[t] = Object.keys(TYPES).filter((o) => o !== t && moduleSig(TYPES[o]) === moduleSig(TYPES[t]));
}

/* ---------------- knobs / selects ---------------- */

function knobDef(m, id) { return m.spec.knobs.find((k) => k.id === id); }
function knobVal(m, id) {
  const k = knobDef(m, id);
  let v = curveVal(k.curve, k.min, k.max, m.k[id]);
  if (k.step) v = Math.round(v / k.step) * k.step;
  return v;
}
function setKnobT(m, id, t, silentSave) {
  const k = knobDef(m, id);
  m.k[id] = clamp(t, 0, 1);
  const w = m.kEls[id];
  w.querySelector(".kdot").style.setProperty("--rot", (-135 + m.k[id] * 270) + "deg");
  const v = knobVal(m, id);
  if (w.classList.contains("live")) w.querySelector(".klab").textContent = k.fmt(v);
  if (m.spec.knob) m.spec.knob(m, id, v);
  if (!silentSave) saveSoon();
}
function setKnobValue(m, id, v) {
  const k = knobDef(m, id);
  setKnobT(m, id, curveT(k.curve, k.min, k.max, v), true);
}
function setSel(m, id, v) {
  m.sel[id] = v;
  m.selEls[id].value = v;
  if (m.spec.select) m.spec.select(m, id, v);
}

function bindKnob(m, k, wrap) {
  const knob = wrap.querySelector(".knob");
  const lab = wrap.querySelector(".klab");
  let y0 = 0, t0 = 0;
  knob.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    y0 = e.clientY;
    t0 = m.k[k.id];
    wrap.classList.add("live");
    lab.textContent = k.fmt(knobVal(m, k.id));
  });
  knob.addEventListener("pointermove", (e) => {
    if (!wrap.classList.contains("live")) return;
    const fine = e.shiftKey ? 0.18 : 1;
    setKnobT(m, k.id, t0 + ((y0 - e.clientY) / 160) * fine);
  });
  const done = () => { wrap.classList.remove("live"); lab.textContent = k.label; };
  knob.addEventListener("pointerup", done);
  knob.addEventListener("pointercancel", done);
  knob.addEventListener("dblclick", () => { setKnobValue(m, k.id, k.v0); saveSoon(); });
}

/* ---------------- sequencer cells ---------------- */

function refreshSteps(m) {
  m.stepsData.forEach((st, i) => {
    const c = m.cells[i];
    c.classList.toggle("off", !st.on);
    c.querySelector(".fill").style.height = (12 + ((st.n - 36) / 48) * 84) + "%";
    c.querySelector(".nn").textContent = noteName(st.n);
  });
}
function bindCell(m, c, i) {
  let y0 = 0, n0 = 0, moved = false;
  c.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    y0 = e.clientY;
    n0 = m.stepsData[i].n;
    moved = false;
    c.dataset.held = "1";
  });
  c.addEventListener("pointermove", (e) => {
    if (!c.dataset.held) return;
    const dn = Math.round((y0 - e.clientY) / 6);
    if (dn !== 0) moved = true;
    if (moved) {
      m.stepsData[i].n = clamp(n0 + dn, 36, 84);
      refreshSteps(m);
    }
  });
  const done = () => {
    if (!c.dataset.held) return;
    delete c.dataset.held;
    if (!moved) { m.stepsData[i].on = !m.stepsData[i].on; refreshSteps(m); }
    saveSoon();
  };
  c.addEventListener("pointerup", done);
  c.addEventListener("pointercancel", done);
}
function litCell(m, i, t) {
  if (!m.cells) return;
  setTimeout(() => {
    m.cells.forEach((c, j) => c.classList.toggle("lit", j === i));
    setTimeout(() => m.cells[i] && m.cells[i].classList.remove("lit"), stepDur(m) * 900);
  }, Math.max(0, (t - AC.currentTime) * 1000));
}

/* ---------------- module DOM ---------------- */

function addModule(type, x, y) {
  const spec = TYPES[type];
  const m = { id: ++uid, type, spec, x, y, k: {}, sel: {}, kEls: {}, selEls: {}, portEls: {} };

  const el = document.createElement("div");
  el.className = "mod";
  el.style.setProperty("--mc", spec.color);
  el.style.left = x + "px";
  el.style.top = y + "px";

  const head = document.createElement("div");
  head.className = "mhead";
  head.innerHTML = `<span>${spec.title}</span>`;
  if (SWAP_GROUPS[type].length) {
    const swapSel = document.createElement("select");
    swapSel.className = "swap";
    swapSel.title = "swap for a compatible module — cables stay put";
    swapSel.innerHTML = '<option value="">swap</option>';
    for (const o of SWAP_GROUPS[type]) {
      const op = document.createElement("option");
      op.value = o;
      op.textContent = "→ " + TYPES[o].title;
      swapSel.appendChild(op);
    }
    swapSel.addEventListener("pointerdown", (e) => e.stopPropagation());
    swapSel.addEventListener("change", () => { if (swapSel.value) swapModule(m, swapSel.value); });
    head.appendChild(swapSel);
  }
  const xBtn = document.createElement("button");
  xBtn.className = "mx";
  xBtn.textContent = "×";
  xBtn.title = "remove module";
  xBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  xBtn.addEventListener("click", () => removeModule(m));
  head.appendChild(xBtn);
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "mbody";
  el.appendChild(body);

  spec.create(m);
  if (spec.custom) spec.custom(m, body);

  const row = document.createElement("div");
  row.className = "mrow";
  for (const s of spec.selects || []) {
    const sel = document.createElement("select");
    for (const o of s.opts) {
      const op = document.createElement("option");
      op.value = op.textContent = o;
      sel.appendChild(op);
    }
    sel.addEventListener("change", () => { setSel(m, s.id, sel.value); saveSoon(); });
    sel.addEventListener("pointerdown", (e) => e.stopPropagation());
    m.selEls[s.id] = sel;
    row.appendChild(sel);
    setSel(m, s.id, s.v0);
  }
  for (const k of spec.knobs || []) {
    const w = document.createElement("div");
    w.className = "kwrap";
    w.innerHTML = `<div class="knob"><div class="kdot"></div></div><div class="klab">${k.label}</div>`;
    m.kEls[k.id] = w;
    row.appendChild(w);
    bindKnob(m, k, w);
    setKnobValue(m, k.id, k.v0);
  }
  if (row.children.length) body.appendChild(row);

  const ports = document.createElement("div");
  ports.className = "mports";
  const mkGroup = (list, dir) => {
    const g = document.createElement("div");
    g.className = "pgroup " + dir + "s";
    for (const p of list) {
      const wrap = document.createElement("div");
      wrap.className = "pwrap";
      const j = document.createElement("div");
      j.className = `port ${dir} ${p.kind}`;
      const port = { m, id: p.id, dir, kind: p.kind, role: p.role, strict: p.strict, el: j };
      m.portEls[dir + ":" + p.id] = port;
      j.addEventListener("pointerdown", (e) => portDown(e, port));
      wrap.appendChild(j);
      const lab = document.createElement("span");
      lab.textContent = p.id;
      wrap.appendChild(lab);
      g.appendChild(wrap);
    }
    return g;
  };
  ports.appendChild(mkGroup(spec.ins, "in"));
  ports.appendChild(mkGroup(spec.outs, "out"));
  if (spec.ins.length || spec.outs.length) el.appendChild(ports);

  bindModuleDrag(m, el, head);
  m.el = el;
  field.appendChild(el);
  modules.push(m);
  return m;
}

function removeModule(m) {
  for (const c of conns.filter((c) => c.a.m === m || c.b.m === m)) removeConn(c);
  if (m.spec.dispose) m.spec.dispose(m);
  for (const node of Object.values(m.n || {})) {
    try { node.stop && node.stop(); } catch (e) {}
    try { node.disconnect && node.disconnect(); } catch (e) {}
  }
  m.el.remove();
  modules.splice(modules.indexOf(m), 1);
  saveSoon();
}

/* Swap m for a same-shaped module of type newType in place: build the
   replacement, re-point every cable that touched m onto the equivalent
   port of the replacement (same id, guaranteed to exist by SWAP_GROUPS),
   carry over any knob/select an id in common, then drop the original. */
function swapModule(m, newType) {
  if (!SWAP_GROUPS[m.type].includes(newType)) return;
  const spec = TYPES[newType];
  const touching = conns.filter((c) => c.a.m === m || c.b.m === m);
  const nm = addModule(newType, m.x, m.y);
  for (const k of spec.knobs || []) {
    if (knobDef(m, k.id)) setKnobValue(nm, k.id, knobVal(m, k.id));
  }
  for (const s of spec.selects || []) {
    const v = m.sel[s.id];
    if (v != null && s.opts.includes(v)) setSel(nm, s.id, v);
  }
  for (const c of touching) {
    connect(c.a.m === m ? port(nm, "out", c.a.id) : c.a, c.b.m === m ? port(nm, "in", c.b.id) : c.b);
  }
  removeModule(m);
  redrawAll();
  saveSoon();
}

function bindModuleDrag(m, el, head) {
  let x0 = 0, y0 = 0, mx0 = 0, my0 = 0, held = false;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    held = true;
    x0 = e.clientX;
    y0 = e.clientY;
    mx0 = m.x;
    my0 = m.y;
    el.classList.add("dragging");
  });
  head.addEventListener("pointermove", (e) => {
    if (!held) return;
    // pointer deltas are real screen pixels; #field's own x/y units aren't,
    // so scale the delta back down to field-space before moving the module
    m.x = clamp(mx0 + (e.clientX - x0) / zoom, 0, field.clientWidth - 60);
    m.y = clamp(my0 + (e.clientY - y0) / zoom, 0, field.clientHeight - 40);
    el.style.left = m.x + "px";
    el.style.top = m.y + "px";
    redrawConnsOf(m);
  });
  const done = () => { if (held) { held = false; el.classList.remove("dragging"); saveSoon(); } };
  head.addEventListener("pointerup", done);
  head.addEventListener("pointercancel", done);
}

/* ---------------- cables ---------------- */

function portCenter(port) {
  const r = port.el.getBoundingClientRect();
  const f = field.getBoundingClientRect();
  // getBoundingClientRect is in real screen pixels; the SVG cables live
  // inside #field's own (unscaled) coordinate space, so divide out the zoom
  return [(r.left + r.width / 2 - f.left) / zoom, (r.top + r.height / 2 - f.top) / zoom];
}
function cablePath(x1, y1, x2, y2) {
  const sag = Math.min(90, Math.hypot(x2 - x1, y2 - y1) * 0.35) + 16;
  return `M ${x1} ${y1} C ${x1} ${y1 + sag}, ${x2} ${y2 + sag}, ${x2} ${y2}`;
}

/* Same-kind isn't the whole story on cyan jacks: a "cv" output (a plain Hz
   value like a sequencer's pitch, or an envelope's 0-1 shape) has no
   waveform in it, so it's a dead end at a "strict" input — the plain
   audio-in jack of anything that just passes a signal through (amp, filter,
   delay, distortion, reverb, the speaker). Everything else — the actual
   modulation jacks (fm, cut, cv) and an oscillator's pitch input — is happy
   to take either an audio-rate wave or a slow CV, so both stay wide open. */
function portsCompatible(a, b) {
  if (a.kind !== b.kind || a.dir === b.dir) return false;
  if (a.kind !== "audio") return true;
  const outp = a.dir === "out" ? a : b;
  const inp = a.dir === "out" ? b : a;
  return !inp.strict || (outp.role || "signal") === "signal";
}

function connect(a, b) {
  if (a.dir !== "out") [a, b] = [b, a];
  if (a.dir !== "out" || b.dir !== "in" || !portsCompatible(a, b)) return;
  if (conns.some((c) => c.a === a && c.b === b)) return;
  if (a.kind === "audio") {
    const target = b.m.inT[b.id];
    if (!target) return;
    a.m.outN[a.id].connect(target);
  }
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hit.setAttribute("class", "hit");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "14");
  hit.setAttribute("fill", "none");
  const vis = document.createElementNS("http://www.w3.org/2000/svg", "path");
  vis.setAttribute("class", "vis");
  vis.setAttribute("stroke", CABLE_COLOR[a.kind]);
  vis.setAttribute("stroke-width", "2.5");
  vis.setAttribute("stroke-linecap", "round");
  vis.setAttribute("fill", "none");
  vis.setAttribute("opacity", "0.85");
  g.appendChild(hit);
  g.appendChild(vis);
  svg.appendChild(g);
  const c = { a, b, el: g, hit, vis };
  hit.addEventListener("click", () => { removeConn(c); saveSoon(); });
  conns.push(c);
  redrawConn(c);
  return c;
}

function removeConn(c) {
  if (c.a.kind === "audio") {
    try { c.a.m.outN[c.a.id].disconnect(c.b.m.inT[c.b.id]); } catch (e) {}
  }
  c.el.remove();
  const i = conns.indexOf(c);
  if (i >= 0) conns.splice(i, 1);
}

function redrawConn(c) {
  const [x1, y1] = portCenter(c.a);
  const [x2, y2] = portCenter(c.b);
  const d = cablePath(x1, y1, x2, y2);
  c.hit.setAttribute("d", d);
  c.vis.setAttribute("d", d);
}
function redrawConnsOf(m) { for (const c of conns) if (c.a.m === m || c.b.m === m) redrawConn(c); }
function redrawAll() { for (const c of conns) redrawConn(c); }

/* dragging a new cable */
let dragWire = null; // {src, path}
function portDown(e, port) {
  e.preventDefault();
  e.stopPropagation();
  let src = port;
  if (port.dir === "in") {
    const existing = conns.filter((c) => c.b === port).pop();
    if (existing) { src = existing.a; removeConn(existing); }
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("stroke", CABLE_COLOR[src.kind]);
  path.setAttribute("stroke-width", "2.5");
  path.setAttribute("stroke-dasharray", "6 5");
  path.setAttribute("fill", "none");
  path.setAttribute("opacity", "0.9");
  svg.appendChild(path);
  dragWire = { src, path };
  field.classList.add("cabling");
  for (const m of modules) {
    for (const key in m.portEls) {
      const p = m.portEls[key];
      if (portsCompatible(src, p)) p.el.classList.add("want");
    }
  }
  moveWire(e);
  window.addEventListener("pointermove", moveWire);
  window.addEventListener("pointerup", dropWire);
}
function moveWire(e) {
  if (!dragWire) return;
  const f = field.getBoundingClientRect();
  const [x1, y1] = portCenter(dragWire.src);
  dragWire.path.setAttribute("d", cablePath(x1, y1, (e.clientX - f.left) / zoom, (e.clientY - f.top) / zoom));
}
function dropWire(e) {
  if (!dragWire) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const jack = el && el.closest && el.closest(".port");
  if (jack) {
    outer:
    for (const m of modules) {
      for (const key in m.portEls) {
        const p = m.portEls[key];
        if (p.el === jack && portsCompatible(dragWire.src, p)) {
          connect(dragWire.src, p);
          break outer;
        }
      }
    }
  }
  dragWire.path.remove();
  dragWire = null;
  field.classList.remove("cabling");
  document.querySelectorAll(".port.want").forEach((p) => p.classList.remove("want"));
  window.removeEventListener("pointermove", moveWire);
  window.removeEventListener("pointerup", dropWire);
  saveSoon();
}

/* ---------------- transport ---------------- */

const playBtn = document.getElementById("play");

/* iOS Safari (16.4+): ask for the "playback" audio session so sound plays
   even with the ring/silent switch flipped to silent */
try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}

function toast(msg, ms = 4500) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

const SILENT_WAV = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
let silentLoop = null;
function setSpeakerMutes(on) {
  for (const m of modules) {
    if (m.type === "out") smooth(m.n.mute.gain, on ? 1 : 0, 0.02);
  }
}
function play() {
  playing = true;
  const p = AC.resume();
  if (p && p.catch) p.catch(() => {});
  // iOS audio unlock: start a silent one-sample buffer inside the gesture
  try {
    const s = AC.createBufferSource();
    s.buffer = AC.createBuffer(1, 1, AC.sampleRate);
    s.connect(AC.destination);
    s.start(0);
  } catch (e) {}
  // iOS ring/silent switch: keep a looping silent <audio> playing so the
  // audio session counts as media playback (which the switch doesn't mute)
  try {
    if (!silentLoop) {
      silentLoop = new Audio(SILENT_WAV);
      silentLoop.loop = true;
      silentLoop.setAttribute("playsinline", "");
    }
    const lp = silentLoop.play();
    if (lp && lp.catch) lp.catch(() => {});
  } catch (e) {}
  setSpeakerMutes(true);
  for (const m of modules) {
    if (m.tick) { m.pos = -1; m.nextT = AC.currentTime + 0.12; }
  }
  playBtn.textContent = "■";
  playBtn.classList.add("on");
  setTimeout(() => {
    if (!playing) return;
    if (AC.state !== "running") {
      toast("🔇 The browser is blocking audio — tap ▶ again. On iPhone, also check the silent switch and media volume.");
    } else if (!modules.some((m) => m.type === "out")) {
      toast("🔈 There's no speaker module — add one (+ speaker) and cable into its “in” jack.");
    } else if (!conns.some((c) => c.b.m.type === "out")) {
      toast("🔌 Nothing is plugged into the speaker — cable something into its “in” jack.");
    }
  }, 700);
}
/* if the context gets blocked or interrupted while playing, any tap revives it */
document.addEventListener("pointerdown", () => {
  if (playing && AC.state !== "running") {
    const p = AC.resume();
    if (p && p.catch) p.catch(() => {});
  }
}, true);
function stop() {
  playing = false;
  setSpeakerMutes(false); // keep the context running: Safari's suspend/resume can wedge silently
  if (silentLoop) silentLoop.pause();
  playBtn.textContent = "▶";
  playBtn.classList.remove("on");
  for (const m of modules) if (m.cells) m.cells.forEach((c) => c.classList.remove("lit"));
}
playBtn.addEventListener("click", () => (playing ? stop() : play()));
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.target.closest("select, input, button")) {
    e.preventDefault();
    playing ? stop() : play();
  }
});

setInterval(() => {
  if (!playing) return;
  for (const m of modules) if (m.tick) m.tick();
}, 30);

/* Catch a common silent-patch cause: a control-voltage output (a sequencer's
   or arpeggio's pitch, say — a plain Hz value, not a ±1 waveform) wired
   straight into an audio jack with no oscillator in between to turn it into
   an actual wave. It's genuinely connected, but the value is wildly outside
   normal audio range, so the speaker's safety limiter clamps it to a flat
   non-oscillating ceiling — connected, yet nothing to hear. Flag it: a real
   (even loud/clipped) signal always swings between its analyser extremes
   over any short window; a pinned, unmoving value away from center doesn't. */
let pinnedStreak = 0, pinnedWarned = false;
const pinBuf = new Uint8Array(256);
setInterval(() => {
  if (!playing) { pinnedStreak = 0; pinnedWarned = false; return; }
  const speakers = modules.filter((m) => m.type === "out" && hasConnTo(m, "in"));
  if (!speakers.length) { pinnedStreak = 0; return; }
  const stuck = speakers.every((m) => {
    m.n.an.getByteTimeDomainData(pinBuf);
    let min = 255, max = 0;
    for (const b of pinBuf) { if (b < min) min = b; if (b > max) max = b; }
    return max - min <= 2 && Math.abs((max + min) / 2 - 128) > 40;
  });
  if (!stuck) { pinnedStreak = 0; pinnedWarned = false; return; }
  pinnedStreak++;
  if (pinnedStreak >= 6 && !pinnedWarned) {
    pinnedWarned = true;
    toast("📉 Something's overloading a jack and getting clamped flat by the safety limiter — a pitch or envelope CV wired straight into an audio input has no waveform to hear. Route it through an oscillator (or amp) first.");
  }
}, 250);

/* scope */
const scopeBuf = new Uint8Array(1024);
(function drawScopes() {
  requestAnimationFrame(drawScopes);
  for (const m of modules) {
    if (!m.scope) continue;
    const ctx = m.scope.getContext("2d");
    const { width: W, height: H } = m.scope;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#6ee7ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    m.n.an.getByteTimeDomainData(scopeBuf);
    const n = m.n.an.fftSize;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const y = H - (scopeBuf[i] / 255) * H;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
})();

/* ---------------- save / load ---------------- */

const SAVE_KEY = "noodlebox.v1";
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize())); } catch (e) {}
  }, 400);
}
function serialize() {
  return {
    mods: modules.map((m) => ({
      t: m.type, x: Math.round(m.x), y: Math.round(m.y),
      k: { ...m.k }, s: { ...m.sel },
      st: m.stepsData ? m.stepsData.map((s) => ({ n: s.n, on: s.on ? 1 : 0 })) : undefined,
    })),
    cables: conns.map((c) => [modules.indexOf(c.a.m), c.a.id, modules.indexOf(c.b.m), c.b.id]),
  };
}
function clearAll() {
  while (modules.length) removeModule(modules[modules.length - 1]);
}
function loadPatch(data) {
  clearAll();
  for (const md of data.mods) {
    const m = addModule(md.t, md.x, md.y);
    if (md.st && m.stepsData) {
      m.stepsData = md.st.map((s) => ({ n: s.n, on: !!s.on }));
      refreshSteps(m);
    }
    for (const id in md.k || {}) if (knobDef(m, id)) setKnobT(m, id, md.k[id], true);
    for (const id in md.s || {}) if (m.selEls[id]) setSel(m, id, md.s[id]);
  }
  for (const [ai, aid, bi, bid] of data.cables || []) {
    const a = modules[ai] && modules[ai].portEls["out:" + aid];
    const b = modules[bi] && modules[bi].portEls["in:" + bid];
    if (a && b) connect(a, b);
  }
  redrawAll();
  saveSoon();
}

/* ---------------- presets ---------------- */

const port = (m, dir, id) => m.portEls[dir + ":" + id];

function presetStarter() {
  clearAll();
  const seq = addModule("seq", 40, 60);
  const osc = addModule("osc", 470, 60);
  const flt = addModule("filter", 710, 60);
  const amp = addModule("amp", 1000, 60);
  const spk = addModule("out", 1160, 260);
  const env = addModule("env", 430, 330);
  const lfo = addModule("lfo", 720, 330);
  setKnobValue(osc, "freq", 0);
  setSel(osc, "wave", "sawtooth");
  setKnobValue(flt, "cut", 900);
  setKnobValue(flt, "res", 4);
  setKnobValue(flt, "mod", 500);
  setKnobValue(amp, "level", 0);
  setKnobValue(lfo, "rate", 0.3);
  setKnobValue(env, "dec", 0.3);
  setKnobValue(env, "sus", 0.35);
  connect(port(seq, "out", "pitch"), port(osc, "in", "pitch"));
  connect(port(seq, "out", "gate"), port(env, "in", "gate"));
  connect(port(env, "out", "out"), port(amp, "in", "cv"));
  connect(port(osc, "out", "out"), port(flt, "in", "in"));
  connect(port(flt, "out", "out"), port(amp, "in", "in"));
  connect(port(amp, "out", "out"), port(spk, "in", "in"));
  connect(port(lfo, "out", "out"), port(flt, "in", "cut"));
  saveSoon();
}

function presetAcid() {
  clearAll();
  const seq = addModule("seq", 40, 60);
  const osc = addModule("osc", 470, 60);
  const flt = addModule("filter", 710, 60);
  const dst = addModule("dist", 1000, 60);
  const amp = addModule("amp", 1170, 60);
  const spk = addModule("out", 1330, 260);
  const env = addModule("env", 620, 340);
  setKnobValue(seq, "tempo", 140);
  setKnobValue(seq, "gate", 0.35);
  setKnobValue(seq, "glide", 0.06);
  seq.stepsData = [45, 45, 57, 45, 48, 45, 60, 43].map((n, i) => ({ n, on: i !== 5 }));
  refreshSteps(seq);
  setKnobValue(osc, "freq", 0);
  setSel(osc, "wave", "sawtooth");
  setKnobValue(flt, "cut", 300);
  setKnobValue(flt, "res", 12);
  setKnobValue(flt, "mod", 2500);
  setKnobValue(dst, "drive", 14);
  setKnobValue(amp, "level", 0);
  setKnobValue(env, "atk", 0.003);
  setKnobValue(env, "dec", 0.14);
  setKnobValue(env, "sus", 0.0);
  setKnobValue(env, "rel", 0.08);
  connect(port(seq, "out", "pitch"), port(osc, "in", "pitch"));
  connect(port(seq, "out", "gate"), port(env, "in", "gate"));
  connect(port(env, "out", "out"), port(amp, "in", "cv"));
  connect(port(env, "out", "out"), port(flt, "in", "cut"));
  connect(port(osc, "out", "out"), port(flt, "in", "in"));
  connect(port(flt, "out", "out"), port(dst, "in", "in"));
  connect(port(dst, "out", "out"), port(amp, "in", "in"));
  connect(port(amp, "out", "out"), port(spk, "in", "in"));
  saveSoon();
}

function presetDrift() {
  clearAll();
  const arp = addModule("arp", 40, 60);
  const osc = addModule("osc", 420, 60);
  const amp = addModule("amp", 665, 60);
  const dly = addModule("delay", 810, 60);
  const vrb = addModule("verb", 1070, 60);
  const spk = addModule("out", 1260, 260);
  const env = addModule("env", 380, 340);
  const lfo = addModule("lfo", 700, 340);
  setKnobValue(arp, "root", 45);
  setSel(arp, "chord", "min7");
  setSel(arp, "pattern", "up-down");
  setKnobValue(arp, "tempo", 96);
  setKnobValue(arp, "oct", 2);
  setKnobValue(osc, "freq", 0);
  setSel(osc, "wave", "triangle");
  setKnobValue(osc, "fm", 6);
  setKnobValue(amp, "level", 0);
  setKnobValue(env, "atk", 0.02);
  setKnobValue(env, "dec", 0.5);
  setKnobValue(env, "sus", 0.2);
  setKnobValue(env, "rel", 0.6);
  setKnobValue(lfo, "rate", 5);
  setKnobValue(dly, "time", 0.42);
  setKnobValue(dly, "fb", 0.5);
  setKnobValue(dly, "mix", 0.45);
  setKnobValue(vrb, "size", 3.2);
  setKnobValue(vrb, "mix", 0.4);
  connect(port(arp, "out", "pitch"), port(osc, "in", "pitch"));
  connect(port(arp, "out", "gate"), port(env, "in", "gate"));
  connect(port(env, "out", "out"), port(amp, "in", "cv"));
  connect(port(lfo, "out", "out"), port(osc, "in", "fm"));
  connect(port(osc, "out", "out"), port(amp, "in", "in"));
  connect(port(amp, "out", "out"), port(dly, "in", "in"));
  connect(port(dly, "out", "out"), port(vrb, "in", "in"));
  connect(port(vrb, "out", "out"), port(spk, "in", "in"));
  saveSoon();
}

const PRESETS = { starter: presetStarter, acid: presetAcid, drift: presetDrift };

/* ---------------- toolbar ---------------- */

const palette = document.getElementById("palette");
for (const t of PALETTE_ORDER) {
  const b = document.createElement("button");
  b.textContent = "+ " + TYPES[t].title;
  b.style.setProperty("--mc", TYPES[t].color);
  b.addEventListener("click", () => {
    addModule(t, work.scrollLeft / zoom + 60 + Math.random() * 120, work.scrollTop / zoom + 80 + Math.random() * 120);
    saveSoon();
  });
  palette.appendChild(b);
}

const zoomOut = document.getElementById("zoomOut");
const zoomIn = document.getElementById("zoomIn");
const zoomReset = document.getElementById("zoomReset");
zoomOut.addEventListener("click", () => setZoom(zoom - 0.15));
zoomIn.addEventListener("click", () => setZoom(zoom + 0.15));
zoomReset.addEventListener("click", () => setZoom(1));

document.querySelectorAll("[data-preset]").forEach((b) => {
  b.addEventListener("click", () => {
    if (!modules.length || confirm("Load the “" + b.dataset.preset + "” patch? Your current patch will be replaced.")) {
      PRESETS[b.dataset.preset]();
    }
  });
});

document.getElementById("clear").addEventListener("click", () => {
  if (confirm("Remove every module and cable?")) { clearAll(); saveSoon(); }
});

const help = document.getElementById("help");
document.getElementById("helpbtn").addEventListener("click", () => (help.hidden = false));
document.getElementById("helpclose").addEventListener("click", () => (help.hidden = true));
help.addEventListener("click", (e) => { if (e.target === help) help.hidden = true; });

window.addEventListener("resize", redrawAll);
window.addEventListener("load", redrawAll);
work.addEventListener("scroll", redrawAll);

/* ---------------- boot ---------------- */

setZoom(zoom); // apply the width-based starting zoom picked above

let saved = null;
try { saved = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) {}
if (saved && saved.mods && saved.mods.length) {
  loadPatch(saved);
} else {
  presetStarter();
  help.hidden = false; // first visit: show the crash course
}
