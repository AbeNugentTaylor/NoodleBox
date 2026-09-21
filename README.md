# Noodle Box

A tiny modular synth playground for [abe.cool](https://abe.cool): little
machines with knobs and jacks that you patch together with drag-and-drop
cables to make music. Built on the raw Web Audio API — no build step, no
dependencies, three files.

## How it works

- **Modules** (`TYPES` in `script.js`) each own a few AudioNodes and
  declare their knobs, selects, and ports. Twenty-three of them: oscillator,
  lfo, envelope, amp, filter, a master clock, step sequencer, arpeggiator,
  noise, delay, distortion, reverb, and a speaker with a live oscilloscope
  and a soft safety limiter; six one-shot percussion/pluck voices — kick,
  snare, hihat, clap, cymbal, and a Karplus-Strong plucked string — all
  gate-in/audio-out, so they're a hot-swappable drum kit; and four more
  pedals alongside delay/dist/reverb — fuzz, crush (a native WaveShaper
  bit-crusher, no ScriptProcessor/Worklet needed), chorus, and phaser —
  joining them into one seven-way swappable pedalboard.
- **Cables** come in two kinds. Cyan jacks carry audio/CV as real
  AudioNode → AudioNode/AudioParam connections; orange jacks carry
  gate/trigger events as JS callbacks with pre-scheduled audio-clock
  timestamps, so envelopes and chained clocks stay sample-accurate. Not
  every cyan-to-cyan pairing is worth making, though: a "cv" output (a
  sequencer/arpeggiator's `pitch`, a plain Hz value with no waveform in
  it) plugged straight into a "strict" input (the plain audio-in jack of
  amp/filter/delay/dist/verb/the speaker — anything that just passes a
  signal through) is a dead end, since there's nothing there for it to
  pass through. `portsCompatible()` in `script.js` encodes exactly that
  rule, and it's what decides which jacks light up as you drag a cable
  and which drop is actually accepted — true modulation jacks (`fm`,
  `cut`, `cv`, an oscillator's `pitch`) still take either a wave or a CV.
  Every port also carries a one-line `help` string (in `TYPES`) describing
  what it does; tapping a jack without dragging shows it in a toast and
  (a friendlier touch-target alternative to dragging) arms that jack —
  tap a second, compatible jack to land the cable there, tap the same
  jack again to back out, or tap any other jack to re-arm from there
  instead. `armedPort`/`handleTap()` in `script.js` run that state
  machine; an actual drag (movement past a small threshold) still works
  exactly as it always has and isn't affected by anything armed.
- The **sequencer** and **arpeggiator** run tiny lookahead schedulers
  against `AudioContext.currentTime`; each has a clock input so a
  **clock** module (or another sequencer's gate) can drive several of them
  off one shared beat. Each track then sets its own `rate` (÷8…x8,
  multiplying or dividing against the incoming pulse — `handleExternalClock()`
  in `script.js`) and its own pattern length (the sequencer's `steps`
  knob, 1-32, no longer a fixed 8), which is what makes polyrhythmic
  phasing possible: an 8-step pattern against a 6-step one drifts in and
  out of phase with it, exactly like the `beats` demo patch does. Click a
  step to mute it, drag it to change its note — a sequencer's `scale`
  dropdown constrains dragged notes to a chosen scale or chord instead of
  fully free chromatic placement. An unconnected sequencer also offers a
  sound-preset dropdown (Strings, Pluck, Pad, Drums) that auto-builds a
  full oscillator/noise + envelope + filter chain behind it
  (`buildSoundChain()`); it's just pre-populating the patch, so anything it
  builds can still be swapped, rewired, or removed afterward. And since a
  sequencer/arpeggiator only outputs pitch/gate control data, one with no
  oscillator (or other audio-rate source) anywhere downstream in its
  signal chain shows a non-blocking ⚠ next to its title
  (`chainHasSource()`) instead of just silently staying silent.
- **Hot-swapping**: a module can be replaced in place by another one with
  the exact same ports (same ids, kinds, and cv/strict roles on every in
  and out) — `SWAP_GROUPS` in `script.js` derives this from `TYPES` itself,
  so it never drifts out of sync with the port declarations. That's
  delay/dist/verb/fuzz/crush/chorus/phaser, seq/arp, lfo/noise, and
  kick/snare/hat/clap/cymbal/pluck as of this writing. Swapping rebuilds
  the module and re-points its existing cables at the same port ids on
  the replacement rather than dropping them, and carries over any
  knob/select the two share an id for (e.g. delay and verb both have a
  `mix` knob). Modules with no same-shaped sibling (osc, env, amp,
  filter, the speaker) just don't get a swap control.
- Patches autosave to `localStorage`; four demo patches (starter, acid,
  drift, beats) live at the bottom of `script.js`.

## Development

Serve the directory with any static server, e.g. `npx serve .`, then open
the printed URL. Knobs drag up/down (shift = fine, double-click = reset);
press space or ▶ to start the clock.

## Deploying

Deployed on Netlify (`netlify.toml` publishes the repo root as-is), same
as the other abe.cool apps: create a Netlify site from this repo, then
add a `noodle` CNAME record under `*.abe.cool` pointing at it. The
globe homepage in the `abe-cool` repo links to
`https://noodle.abe.cool`.
