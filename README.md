# Noodle Box

A tiny modular synth playground for [abe.cool](https://abe.cool): little
machines with knobs and jacks that you patch together with drag-and-drop
cables to make music. Built on the raw Web Audio API — no build step, no
dependencies, three files.

## How it works

- **Modules** (`TYPES` in `script.js`) each own a few AudioNodes and
  declare their knobs, selects, and ports. Twelve of them: oscillator,
  lfo, envelope, amp, filter, step sequencer, arpeggiator, noise, delay,
  distortion, reverb, and a speaker with a live oscilloscope and a soft
  safety limiter.
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
- The **sequencer** and **arpeggiator** run tiny lookahead schedulers
  against `AudioContext.currentTime`; each has a clock input so one can
  drive another (polyrhythms). Click a step to mute it, drag it to change
  its note.
- Patches autosave to `localStorage`; three demo patches (starter, acid,
  drift) live at the bottom of `script.js`.

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
