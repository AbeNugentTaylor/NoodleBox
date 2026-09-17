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
  AudioNode → AudioNode/AudioParam connections, so anything can modulate
  anything. Orange jacks carry gate/trigger events as JS callbacks with
  pre-scheduled audio-clock timestamps, so envelopes and chained clocks
  stay sample-accurate.
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
