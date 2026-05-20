/* ============================================================
   Velouria 1200 — Hi-Fi MP3 Player
   ------------------------------------------------------------
   Audio graph (built lazily on first play):
     audio
       -> mediaSource
       -> preGain
       -> bassShelf -> trebleShelf
       -> eq[0..4] (peaking 60/250/1k/4k/12k Hz)
       -> subHP -> hiLP
       -> tapeShaper (waveshaper, identity or tanh)
       -> dryGain ----+
                      mix -> panner -> loudnessLow -> loudnessHigh -> analyser -> destination
       -> convolver -> wetGain ----+
   ------------------------------------------------------------
   Wow & flutter modulates audio.playbackRate via rAF (not via graph).
   ============================================================ */

(() => {
  "use strict";

  /* ---------- DOM refs (cached once) ---------- */
  const $ = (id) => document.getElementById(id);

  const audio        = $("audio");
  const vinyl        = $("vinyl");
  const tonearm      = $("tonearm");
  const cueingLever  = $("cueingLever");
  const platterEl    = $("platter");
  const vinylTitle   = $("vinylTitle");
  const vinylArtist  = $("vinylArtist");

  const ledTitleEl   = $("ledTitle");
  const ledTrackNum  = $("ledTrackNum");
  const ledCurTime   = $("ledCurrentTime");
  const ledTotalTime = $("ledTotalTime");
  const ledBarFill   = $("ledBarFill");
  const ledBarThumb  = $("ledBarThumb");
  const progressBar  = $("progressBar");
  const ledSourceTag = $("ledSourceTag");

  const playBtn   = $("playBtn");
  const playLabel = $("playLabel");
  const iconPlay  = $("iconPlay");
  const iconPause = $("iconPause");
  const prevBtn   = $("prevBtn");
  const nextBtn   = $("nextBtn");
  const shuffleBtn = $("shuffleBtn");
  const repeatBtn  = $("repeatBtn");
  const sfxBtn     = $("sfxBtn");

  const volumeKnob  = $("volumeKnob");
  const volumeValue = $("volumeValue");
  const knobDial    = volumeKnob.querySelector(".knob-dial");

  const fileInput  = $("fileInput");
  const clearBtn   = $("clearBtn");
  const dropzone   = $("dropzone");
  const playlistEl = $("playlist");
  const trackCount = $("trackCount");

  const powerLed   = $("powerLed");
  const speedBtns  = document.querySelectorAll(".speed-btn");
  const vuCanvases = document.querySelectorAll(".vu-canvas");
  const ledMarquee = document.querySelector(".led-marquee");

  /* New refs */
  const dustCover     = $("dustCover");
  const tapeCounterEl = $("tapeCounter");
  const quartzLed     = $("quartzLed");
  const spectrumCanvas = $("spectrum");
  const eqInputs      = document.querySelectorAll(".eq-slider input");
  const bassKnob      = $("bassKnob");
  const trebleKnob    = $("trebleKnob");
  const balanceKnob   = $("balanceKnob");
  const reverbKnob    = $("reverbKnob");
  const sourceKnob    = $("sourceKnob");
  const sourceBtns    = document.querySelectorAll(".src-btn");
  const loudnessBtn   = $("loudnessBtn");
  const subFilterBtn  = $("subFilterBtn");
  const hiFilterBtn   = $("hiFilterBtn");
  const warmBtn       = $("warmBtn");
  const themeButtons  = document.querySelectorAll(".theme-btn");
  const tunerPanel    = $("tunerPanel");
  const tunerDisplay  = $("tunerDisplay");
  const tunerDial     = $("tunerDial");
  const tunerNeedle   = $("tunerNeedle");
  const tunerStereoLed = $("tunerStereoLed");
  const antiSkatingKnob = $("antiSkatingKnob");
  const knobValueElems = {
    bass:    document.querySelector('[data-knob="bass"]'),
    treble:  document.querySelector('[data-knob="treble"]'),
    balance: document.querySelector('[data-knob="balance"]'),
    reverb:  document.querySelector('[data-knob="reverb"]'),
  };

  /* ---------- State ---------- */
  /** @type {{id:string,name:string,title:string,artist:string,url:string,duration:number}[]} */
  const tracks = [];
  let currentIndex = -1;
  let isShuffle = false;
  /** @type {"off"|"all"|"one"} */
  let repeatMode = "off";
  let volume = 0.8;
  let speedRpm = 33;

  const KNOB_MIN = -135;
  const KNOB_MAX = 135;

  /* ---------- Lazy Web Audio graph ---------- */
  let audioCtx = null, mediaSource = null, analyser = null;
  let timeData = null, freqData = null;
  let preGain, bassShelf, trebleShelf;
  let eqBands = [];
  let subHP, hiLP, tapeShaper;
  let dryGain, wetGain, convolver, mixGain;
  let panner, loudnessLow, loudnessHigh;

  function makeIdentityCurve(n = 4096) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = (i / n) * 2 - 1;
    return c;
  }
  function makeTanhCurve(amount, n = 4096) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / n) * 2 - 1;
      c[i] = Math.tanh(amount * x);
    }
    return c;
  }
  function makeReverbImpulse(seconds, decay, type) {
    if (!audioCtx) return null;
    const sr = audioCtx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = audioCtx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        let s = (Math.random() * 2 - 1) * env;
        if (type === "spring") {
          const d1 = Math.floor(sr * 0.04);
          const d2 = Math.floor(sr * 0.067);
          if (i > d1) s += data[i - d1] * 0.55;
          if (i > d2) s += data[i - d2] * 0.35;
        } else if (type === "plate") {
          if (i > 80) s += data[i - 80] * 0.25;
        }
        data[i] = s;
      }
    }
    return buf;
  }

  function ensureAudioGraph() {
    if (audioCtx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      mediaSource = audioCtx.createMediaElementSource(audio);

      preGain = audioCtx.createGain(); preGain.gain.value = 1;

      bassShelf = audioCtx.createBiquadFilter();
      bassShelf.type = "lowshelf";
      bassShelf.frequency.value = 100;
      bassShelf.gain.value = 0;

      trebleShelf = audioCtx.createBiquadFilter();
      trebleShelf.type = "highshelf";
      trebleShelf.frequency.value = 8000;
      trebleShelf.gain.value = 0;

      const eqFreqs = [60, 250, 1000, 4000, 12000];
      eqBands = eqFreqs.map((f) => {
        const b = audioCtx.createBiquadFilter();
        b.type = "peaking";
        b.frequency.value = f;
        b.Q.value = 1.4;
        b.gain.value = 0;
        return b;
      });

      subHP = audioCtx.createBiquadFilter();
      subHP.type = "highpass";
      subHP.frequency.value = 10; // bypass-ish
      subHP.Q.value = 0.7;

      hiLP = audioCtx.createBiquadFilter();
      hiLP.type = "lowpass";
      hiLP.frequency.value = 22000; // bypass-ish
      hiLP.Q.value = 0.7;

      tapeShaper = audioCtx.createWaveShaper();
      tapeShaper.curve = makeIdentityCurve();
      tapeShaper.oversample = "2x";

      dryGain = audioCtx.createGain(); dryGain.gain.value = 1;
      wetGain = audioCtx.createGain(); wetGain.gain.value = 0;
      convolver = audioCtx.createConvolver();
      mixGain = audioCtx.createGain(); mixGain.gain.value = 1;

      panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
      // Fallback for old browsers without StereoPannerNode
      const pannerOut = panner || audioCtx.createGain();

      loudnessLow = audioCtx.createBiquadFilter();
      loudnessLow.type = "lowshelf";
      loudnessLow.frequency.value = 100;
      loudnessLow.gain.value = 0;

      loudnessHigh = audioCtx.createBiquadFilter();
      loudnessHigh.type = "highshelf";
      loudnessHigh.frequency.value = 10000;
      loudnessHigh.gain.value = 0;

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.78;
      timeData = new Uint8Array(analyser.fftSize);
      freqData = new Uint8Array(analyser.frequencyBinCount);

      /* Wire up the chain */
      mediaSource.connect(preGain);
      preGain.connect(bassShelf);
      bassShelf.connect(trebleShelf);
      let prev = trebleShelf;
      for (const b of eqBands) { prev.connect(b); prev = b; }
      prev.connect(subHP);
      subHP.connect(hiLP);
      hiLP.connect(tapeShaper);

      tapeShaper.connect(dryGain);
      tapeShaper.connect(convolver);
      convolver.connect(wetGain);

      dryGain.connect(mixGain);
      wetGain.connect(mixGain);
      mixGain.connect(pannerOut);
      pannerOut.connect(loudnessLow);
      loudnessLow.connect(loudnessHigh);
      loudnessHigh.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (err) {
      console.warn("AudioContext unavailable:", err);
    }
  }

  /* ============================================================
     PROCEDURAL SFX (turntable mechanical sounds)
     Reuses audioCtx; no external samples (CSP-friendly).
     ============================================================ */
  const sfx = (() => {
    const SFX_KEY = "velouria.sfxEnabled";
    let enabled = localStorage.getItem(SFX_KEY) !== "false";
    let firstPlayDone = false;
    let masterGain = null;
    let crackleSrc = null, crackleGain = null;

    function init() {
      if (masterGain) return;
      ensureAudioGraph();
      if (!audioCtx) return;
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.22;
      masterGain.connect(audioCtx.destination);
    }
    function ready() {
      if (!enabled) return false;
      init();
      if (!audioCtx || !masterGain) return false;
      if (audioCtx.state === "suspended") audioCtx.resume();
      return true;
    }
    function click(freq, dur, gain) {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      const len = Math.max(8, Math.floor(audioCtx.sampleRate * dur));
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (audioCtx.sampleRate * 0.005));
      }
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const bp = audioCtx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = 4;
      const g = audioCtx.createGain(); g.gain.value = gain;
      src.connect(bp).connect(g).connect(masterGain);
      src.start(t0); src.stop(t0 + dur + 0.02);
    }
    const transportClick = () => click(3500, 0.04, 0.85);
    const toggleClick    = () => click(1200, 0.05, 0.55);
    function tinyClick() {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(2200, t0);
      o.frequency.exponentialRampToValueAtTime(800, t0 + 0.04);
      g.gain.setValueAtTime(0.18, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
      o.connect(g).connect(masterGain);
      o.start(t0); o.stop(t0 + 0.07);
    }
    function servo(rising) {
      if (!ready()) return;
      const t0 = audioCtx.currentTime, dur = 0.45;
      const o = audioCtx.createOscillator();
      o.type = "sawtooth";
      if (rising) {
        o.frequency.setValueAtTime(220, t0);
        o.frequency.exponentialRampToValueAtTime(380, t0 + dur);
      } else {
        o.frequency.setValueAtTime(380, t0);
        o.frequency.exponentialRampToValueAtTime(180, t0 + dur);
      }
      const lp = audioCtx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 700; lp.Q.value = 2;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.18, t0 + 0.04);
      g.gain.linearRampToValueAtTime(0.12, t0 + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(lp).connect(g).connect(masterGain);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }
    function stylusDrop() {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const og = audioCtx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(95, t0);
      o.frequency.exponentialRampToValueAtTime(40, t0 + 0.18);
      og.gain.setValueAtTime(0, t0);
      og.gain.linearRampToValueAtTime(0.55, t0 + 0.005);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
      o.connect(og).connect(masterGain);
      o.start(t0); o.stop(t0 + 0.3);
      const dur = 0.16, len = Math.floor(audioCtx.sampleRate * dur);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (audioCtx.sampleRate * 0.05));
      }
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const hp = audioCtx.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = 1500;
      const ng = audioCtx.createGain(); ng.gain.value = 0.22;
      src.connect(hp).connect(ng).connect(masterGain);
      src.start(t0);
    }
    function hum() {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      [120, 240].forEach((freq, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = freq;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.07 / (i + 1), t0 + 0.08);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
        o.connect(g).connect(masterGain);
        o.start(t0); o.stop(t0 + 0.75);
      });
    }
    function relayThunk() {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(140, t0);
      o.frequency.exponentialRampToValueAtTime(45, t0 + 0.06);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.7, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      o.connect(g).connect(masterGain);
      o.start(t0); o.stop(t0 + 0.2);
    }
    function startCrackle() {
      if (!ready()) return;
      if (crackleSrc) return;
      const sr = audioCtx.sampleRate;
      const buf = audioCtx.createBuffer(1, Math.floor(sr * 4), sr);
      const ch = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < ch.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        let pink = (b0 + b1 + b2 + w * 0.1848) * 0.04;
        if (Math.random() < 0.00005) pink += (Math.random() * 2 - 1) * 0.7;
        ch[i] = pink;
      }
      const src = audioCtx.createBufferSource(); src.buffer = buf; src.loop = true;
      const hp = audioCtx.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = 600;
      const lp = audioCtx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 6500;
      const g = audioCtx.createGain(); g.gain.value = 0;
      src.connect(hp).connect(lp).connect(g).connect(masterGain);
      const t0 = audioCtx.currentTime;
      src.start(t0);
      g.gain.linearRampToValueAtTime(0.55, t0 + 1.2);
      crackleSrc = src; crackleGain = g;
    }
    function stopCrackle() {
      if (!crackleSrc || !audioCtx) return;
      const t = audioCtx.currentTime;
      const src = crackleSrc, g = crackleGain;
      crackleSrc = null; crackleGain = null;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.4);
        setTimeout(() => { try { src.stop(); } catch(e){} }, 500);
      } catch(e) {}
    }
    function onFirstPlay() { if (firstPlayDone) return; firstPlayDone = true; hum(); }
    function setEnabled(v) {
      enabled = !!v;
      try { localStorage.setItem(SFX_KEY, enabled ? "true" : "false"); } catch(e) {}
      if (!enabled) stopCrackle();
    }
    return {
      transportClick, toggleClick, tinyClick,
      servo, stylusDrop, hum, relayThunk,
      startCrackle, stopCrackle, onFirstPlay,
      setEnabled,
      get enabled() { return enabled; },
      get masterGain() { return masterGain; },
    };
  })();
  window.__sfx = sfx;

  /* ============================================================
     TUNER (FM static synthesizer for decorative TUNER mode)
     ============================================================ */
  const tuner = (() => {
    let noiseSrc = null, noiseGain = null, noiseFilter = null;
    let freq = 88.5;
    function start() {
      if (noiseSrc || !audioCtx) return;
      ensureAudioGraph();
      const sr = audioCtx.sampleRate;
      const buf = audioCtx.createBuffer(1, sr * 2, sr);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.4;
      const src = audioCtx.createBufferSource(); src.buffer = buf; src.loop = true;
      const bp = audioCtx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 0.6;
      const g = audioCtx.createGain(); g.gain.value = 0;
      src.connect(bp).connect(g).connect(audioCtx.destination);
      src.start();
      const t = audioCtx.currentTime;
      g.gain.linearRampToValueAtTime(0.18, t + 0.3);
      noiseSrc = src; noiseGain = g; noiseFilter = bp;
    }
    function stop() {
      if (!noiseSrc || !audioCtx) return;
      const t = audioCtx.currentTime;
      const src = noiseSrc, g = noiseGain;
      noiseSrc = null; noiseGain = null; noiseFilter = null;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.25);
        setTimeout(() => { try { src.stop(); } catch(e){} }, 300);
      } catch(e) {}
    }
    function setFrequency(f) {
      freq = Math.max(88, Math.min(108, f));
      // Nudge filter centre & briefly burst gain to simulate retuning
      if (noiseFilter && noiseGain && audioCtx) {
        const t = audioCtx.currentTime;
        noiseFilter.frequency.setValueAtTime(800 + (freq - 88) / 20 * 1800, t);
        noiseGain.gain.cancelScheduledValues(t);
        noiseGain.gain.setValueAtTime(0.28, t);
        noiseGain.gain.linearRampToValueAtTime(0.18, t + 0.15);
      }
      // Update display
      if (tunerDisplay) tunerDisplay.textContent = freq.toFixed(1) + " MHz";
      if (tunerNeedle) {
        const pct = ((freq - 88) / 20) * 100;
        tunerNeedle.style.left = pct + "%";
      }
      // Pseudo "stereo lock" on certain bands
      const stereoLock = (Math.floor(freq * 10) % 7 === 0);
      if (tunerStereoLed) tunerStereoLed.classList.toggle("is-on", stereoLock);
    }
    return { start, stop, setFrequency, get freq() { return freq; } };
  })();

  /* ============================================================
     PREAMP CONTROLS
     ============================================================ */
  function applyEqBand(i, gainDb) {
    if (eqBands[i]) eqBands[i].gain.value = gainDb;
  }
  function applyBass(v)    { if (bassShelf)   bassShelf.gain.value = v; }
  function applyTreble(v)  { if (trebleShelf) trebleShelf.gain.value = v; }
  function applyBalance(v) { if (panner)      panner.pan.value = Math.max(-1, Math.min(1, v / 100)); }

  let loudnessOn = false;
  function applyLoudness(on) {
    loudnessOn = on;
    if (!loudnessLow) return;
    loudnessLow.gain.value  = on ? 6 : 0;
    loudnessHigh.gain.value = on ? 4 : 0;
  }
  let subFilterOn = false;
  function applySubFilter(on) {
    subFilterOn = on;
    if (!subHP) return;
    subHP.frequency.value = on ? 40 : 10;
  }
  let hiFilterOn = false;
  function applyHiFilter(on) {
    hiFilterOn = on;
    if (!hiLP) return;
    hiLP.frequency.value = on ? 12000 : 22000;
  }
  let warmOn = false;
  function applyWarm(on) {
    warmOn = on;
    if (tapeShaper) tapeShaper.curve = on ? makeTanhCurve(2.5) : makeIdentityCurve();
  }

  let reverbMode = "off";
  function applyReverb(mode) {
    reverbMode = mode;
    if (!audioCtx || !convolver) return;
    const t = audioCtx.currentTime;
    if (mode === "off") {
      wetGain.gain.linearRampToValueAtTime(0, t + 0.2);
      dryGain.gain.linearRampToValueAtTime(1, t + 0.2);
    } else {
      let imp;
      if (mode === "hall")        imp = makeReverbImpulse(2.5, 2.5, "hall");
      else if (mode === "plate")  imp = makeReverbImpulse(1.5, 2.0, "plate");
      else if (mode === "spring") imp = makeReverbImpulse(0.6, 4.0, "spring");
      if (imp) convolver.buffer = imp;
      wetGain.gain.linearRampToValueAtTime(0.32, t + 0.2);
      dryGain.gain.linearRampToValueAtTime(0.85, t + 0.2);
    }
  }

  /* ---------- Wow & flutter (LFO on playbackRate) ---------- */
  let baseRate = 1.0;
  let wfStart  = 0;
  function tickWowFlutter() {
    if (!warmOn || audio.paused) {
      if (audio.playbackRate !== baseRate) audio.playbackRate = baseRate;
      return;
    }
    const t = (performance.now() - wfStart) / 1000;
    const wow     = Math.sin(2 * Math.PI * 1.2 * t) * 0.0028;
    const flutter = Math.sin(2 * Math.PI * 6.0 * t) * 0.0010;
    audio.playbackRate = baseRate * (1 + wow + flutter);
  }

  /* ============================================================
     VU METERS
     ============================================================ */
  const vuMeters = [];
  function setupVuMeters() {
    vuCanvases.forEach((canvas) => {
      const ctx = canvas.getContext("2d");
      vuMeters.push({ canvas, ctx, w: 0, h: 0, dpr: 1 });
    });
    const resizeAll = () => {
      const dpr = window.devicePixelRatio || 1;
      vuMeters.forEach((m) => {
        const rect = m.canvas.getBoundingClientRect();
        m.dpr = dpr;
        m.w = rect.width; m.h = rect.height;
        m.canvas.width  = Math.floor(rect.width  * dpr);
        m.canvas.height = Math.floor(rect.height * dpr);
      });
    };
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(resizeAll);
      vuCanvases.forEach((c) => ro.observe(c));
    } else { window.addEventListener("resize", resizeAll); }
    resizeAll();
  }

  function drawVuMeter(m, level) {
    const { ctx, w, h, dpr } = m;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#efe6d2"); bg.addColorStop(1, "#d9cfb8");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const cx = w * 0.5, cy = h * 1.05;
    const r = Math.min(w * 0.85, h * 1.25);
    const startA = Math.PI * 1.15, endA = Math.PI * 1.85;
    const span = endA - startA;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(40, 110, 50, 0.85)";
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, startA, startA + span * 0.7); ctx.stroke();
    ctx.strokeStyle = "rgba(180, 30, 25, 0.9)";
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, startA + span * 0.7, endA); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = "#2a1a08";
    for (let i = 0; i <= 10; i++) {
      const a = startA + span * (i / 10);
      const inner = (i % 2 === 0) ? r * 0.66 : r * 0.7;
      const outer = r * 0.74;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }
    ctx.fillStyle = "#1a1208";
    ctx.font = `${Math.max(8, h * 0.10)}px "Playfair Display", serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    [0, 0.5, 1].forEach((t) => {
      const a = startA + span * t;
      const lr = r * 0.58;
      const lx = cx + Math.cos(a) * lr;
      const ly = cy + Math.sin(a) * lr;
      ctx.fillText(t === 0 ? "0" : t === 0.5 ? "5" : "10", lx, ly);
    });
    ctx.font = `bold ${Math.max(7, h * 0.09)}px "Playfair Display", serif`;
    ctx.fillStyle = "rgba(26, 18, 8, 0.6)";
    ctx.fillText("VU", cx, h * 0.5);
    const a = startA + span * level;
    const nx = cx + Math.cos(a) * r * 0.74;
    const ny = cy + Math.sin(a) * r * 0.74;
    ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx + 1, cy + 1); ctx.lineTo(nx + 1, ny + 1); ctx.stroke();
    ctx.strokeStyle = "#1a1208"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke();
    ctx.fillStyle = "#0a0604";
    ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#7a4a2c";
    ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.fill();
  }

  /* ============================================================
     SPECTRUM ANALYZER (LED-style bargraph, 16 bands)
     ============================================================ */
  const SPEC_BANDS = 16, SPEC_LEDS = 12;
  const specPeaks = new Float32Array(SPEC_BANDS);
  const specBandValues = new Float32Array(SPEC_BANDS);
  let specCtx = null, specW = 0, specH = 0, specDpr = 1;

  function setupSpectrum() {
    if (!spectrumCanvas) return;
    specCtx = spectrumCanvas.getContext("2d");
    const resize = () => {
      const r = spectrumCanvas.getBoundingClientRect();
      specDpr = window.devicePixelRatio || 1;
      specW = r.width; specH = r.height;
      spectrumCanvas.width  = Math.floor(r.width  * specDpr);
      spectrumCanvas.height = Math.floor(r.height * specDpr);
    };
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(resize).observe(spectrumCanvas);
    } else { window.addEventListener("resize", resize); }
    resize();
  }

  function drawSpectrum() {
    if (!specCtx || !specW) return;
    specCtx.setTransform(specDpr, 0, 0, specDpr, 0, 0);
    specCtx.clearRect(0, 0, specW, specH);

    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      const sr = audioCtx.sampleRate;
      const nyq = sr / 2;
      const minF = 30, maxF = 16000;
      for (let b = 0; b < SPEC_BANDS; b++) {
        const f0 = minF * Math.pow(maxF / minF, b / SPEC_BANDS);
        const f1 = minF * Math.pow(maxF / minF, (b + 1) / SPEC_BANDS);
        const i0 = Math.floor(f0 / nyq * freqData.length);
        const i1 = Math.min(freqData.length, Math.ceil(f1 / nyq * freqData.length));
        let max = 0;
        for (let i = i0; i < i1; i++) if (freqData[i] > max) max = freqData[i];
        specBandValues[b] = max / 255;
      }
    } else {
      for (let b = 0; b < SPEC_BANDS; b++) specBandValues[b] = 0;
    }

    const bandWidth = specW / SPEC_BANDS;
    const ledHeight = specH / SPEC_LEDS;
    for (let b = 0; b < SPEC_BANDS; b++) {
      const v = specBandValues[b];
      const lit = Math.floor(v * SPEC_LEDS);
      if (v > specPeaks[b]) specPeaks[b] = v;
      else specPeaks[b] = Math.max(0, specPeaks[b] - 0.012);
      const peakLed = Math.floor(specPeaks[b] * SPEC_LEDS);
      for (let i = 0; i < SPEC_LEDS; i++) {
        const led = SPEC_LEDS - 1 - i;
        let baseColor;
        if (led >= 11) baseColor = "220, 50, 30";
        else if (led >= 8) baseColor = "230, 165, 40";
        else baseColor = "70, 200, 90";
        let alpha;
        if (led < lit) alpha = 0.95;
        else if (led === peakLed && specPeaks[b] > 0.05) alpha = 0.85;
        else alpha = 0.07;
        specCtx.fillStyle = `rgba(${baseColor}, ${alpha})`;
        const x = b * bandWidth + bandWidth * 0.18;
        const y = i * ledHeight + ledHeight * 0.18;
        specCtx.fillRect(x, y, bandWidth * 0.64, ledHeight * 0.64);
      }
    }
  }

  /* ============================================================
     rAF loop (drives VU + spectrum + wow & flutter + counters)
     ============================================================ */
  let rafId = 0, isAnimating = false;
  let peakL = 0, peakR = 0;
  function animate() {
    rafId = requestAnimationFrame(animate);
    if (!analyser) {
      peakL *= 0.9; peakR *= 0.9;
    } else {
      analyser.getByteTimeDomainData(timeData);
      let sumL = 0, sumR = 0;
      const n = timeData.length, half = n >> 1;
      for (let i = 0; i < half; i++) { const v = (timeData[i] - 128) / 128; sumL += v * v; }
      for (let i = half; i < n; i++) { const v = (timeData[i] - 128) / 128; sumR += v * v; }
      const rmsL = Math.sqrt(sumL / half), rmsR = Math.sqrt(sumR / half);
      peakL += (Math.min(1, rmsL * 2.6) - peakL) * 0.18;
      peakR += (Math.min(1, rmsR * 2.6) - peakR) * 0.18;
      peakL = Math.max(0, peakL - 0.0016);
      peakR = Math.max(0, peakR - 0.0016);
    }
    if (vuMeters[0]) drawVuMeter(vuMeters[0], peakL);
    if (vuMeters[1]) drawVuMeter(vuMeters[1], peakR);
    drawSpectrum();
    tickWowFlutter();
  }
  function startAnim() { if (isAnimating) return; isAnimating = true; animate(); }
  function stopAnim()  { isAnimating = false; cancelAnimationFrame(rafId); }

  /* ============================================================
     UTILITIES
     ============================================================ */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function parseMeta(filename) {
    const base = filename.replace(/\.[^/.]+$/, "");
    const parts = base.split(" - ");
    if (parts.length >= 2) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
    }
    return { artist: "Unknown", title: base.trim() };
  }
  function setSpinDuration() {
    const rev = speedRpm === 45 ? 60 / 45 : 60 / 33.333;
    vinyl.style.setProperty("--spin-duration", rev.toFixed(3) + "s");
    document.documentElement.style.setProperty("--strobe-rpm", String(speedRpm));
  }

  /* ============================================================
     PLAYLIST
     ============================================================ */
  function renderPlaylist() {
    if (!tracks.length) {
      playlistEl.innerHTML = "";
      trackCount.textContent = "0 RECORDS";
      return;
    }
    const parts = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const num = String(i + 1).padStart(2, "0");
      const dur = t.duration ? fmtTime(t.duration) : "—:—";
      const cls = i === currentIndex ? "tl-item is-current" : "tl-item";
      parts.push(
        `<li class="${cls}" data-index="${i}">` +
          `<span class="tl-num">${num}</span>` +
          `<div class="tl-info">` +
            `<div class="tl-title">${escapeHtml(t.title)}</div>` +
            `<div class="tl-sub">${escapeHtml(t.artist)}</div>` +
          `</div>` +
          `<span class="tl-duration">${dur}</span>` +
          `<button class="tl-remove" data-action="remove" aria-label="Eject">×</button>` +
        `</li>`
      );
    }
    playlistEl.innerHTML = parts.join("");
    trackCount.textContent =
      `${String(tracks.length).padStart(2, "0")} RECORD${tracks.length === 1 ? "" : "S"}`;
  }
  playlistEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest("[data-action='remove']");
    const item = e.target.closest(".tl-item");
    if (!item) return;
    const i = Number(item.dataset.index);
    if (removeBtn) { e.stopPropagation(); removeTrack(i); return; }
    loadTrack(i, true);
  });

  /* ============================================================
     TRACKS
     ============================================================ */
  function liftDustCover() {
    if (!dustCover) return;
    dustCover.classList.add("is-open");
    clearTimeout(liftDustCover._t);
    liftDustCover._t = setTimeout(() => dustCover.classList.remove("is-open"), 1600);
  }
  function addFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => (f.type && f.type.startsWith("audio")) || /\.mp3$/i.test(f.name)
    );
    if (!files.length) return;
    liftDustCover();
    for (const file of files) {
      const id = `${file.name}-${file.size}-${file.lastModified}`;
      if (tracks.some((t) => t.id === id)) continue;
      const meta = parseMeta(file.name);
      const url = URL.createObjectURL(file);
      const track = {
        id, name: file.name,
        title: meta.title, artist: meta.artist,
        url, duration: 0,
      };
      tracks.push(track);
      const probe = new Audio();
      probe.preload = "metadata";
      probe.src = url;
      probe.addEventListener("loadedmetadata", () => {
        track.duration = probe.duration || 0;
        const li = playlistEl.querySelector(`.tl-item[data-index="${tracks.indexOf(track)}"]`);
        if (li) li.querySelector(".tl-duration").textContent = fmtTime(track.duration);
        else renderPlaylist();
      }, { once: true });
    }
    renderPlaylist();
    if (currentIndex === -1 && tracks.length) loadTrack(0, false);
  }
  function removeTrack(index) {
    const wasCurrent = index === currentIndex;
    const t = tracks[index];
    if (t) URL.revokeObjectURL(t.url);
    tracks.splice(index, 1);
    if (!tracks.length) { stopAndReset(); renderPlaylist(); return; }
    if (wasCurrent) {
      currentIndex = Math.min(index, tracks.length - 1);
      loadTrack(currentIndex, !audio.paused);
    } else if (index < currentIndex) {
      currentIndex -= 1;
    }
    renderPlaylist();
  }
  function clearAll() {
    for (const t of tracks) URL.revokeObjectURL(t.url);
    tracks.length = 0;
    stopAndReset();
    renderPlaylist();
  }
  function stopAndReset() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentIndex = -1;
    setPlayingUI(false);
    ledTitleEl.textContent = "— NO TRACK LOADED —";
    ledTrackNum.textContent = "--";
    vinylTitle.textContent = "NO RECORD";
    vinylArtist.textContent = "— LOAD A TRACK —";
    ledBarFill.style.width = "0%";
    ledBarThumb.style.left = "0%";
    ledCurTime.textContent = "0:00";
    ledTotalTime.textContent = "0:00";
    powerLed.classList.remove("is-on");
    cueingLever.classList.remove("is-down");
    quartzLockOff();
    updateMarquee();
  }

  /* ============================================================
     PLAYBACK
     ============================================================ */
  function loadTrack(index, autoPlay) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    const t = tracks[index];
    audio.src = t.url;
    audio.load();
    ledTitleEl.textContent = `${t.artist.toUpperCase()} — ${t.title.toUpperCase()}`;
    ledTrackNum.textContent = String(index + 1).padStart(2, "0");
    vinylTitle.textContent = t.title;
    vinylArtist.textContent = t.artist;
    powerLed.classList.add("is-on");
    renderPlaylist();
    updateMarquee();
    if (autoPlay) play();
  }
  function play() {
    if (currentSource === "tuner") return; // tuner mode owns the audio path
    if (currentIndex === -1 && tracks.length) loadTrack(0, false);
    if (!audio.src) return;
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    sfx.onFirstPlay();
    sfx.servo(true);
    setTimeout(() => sfx.stylusDrop(), 280);
    wfStart = performance.now();
    const p = audio.play();
    if (p && p.then) p.catch(() => {});
  }
  function pause() {
    sfx.servo(false);
    audio.pause();
  }
  function togglePlay() { audio.paused ? play() : pause(); }

  function next() {
    if (!tracks.length) return;
    sfx.transportClick();
    let i;
    if (isShuffle) {
      if (tracks.length === 1) i = 0;
      else { do { i = Math.floor(Math.random() * tracks.length); } while (i === currentIndex); }
    } else {
      i = (currentIndex + 1) % tracks.length;
    }
    loadTrack(i, true);
  }
  function prev() {
    if (!tracks.length) return;
    sfx.transportClick();
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const i = (currentIndex - 1 + tracks.length) % tracks.length;
    loadTrack(i, true);
  }

  function setPlayingUI(playing) {
    if (playing) {
      iconPlay.hidden = true;
      iconPause.hidden = false;
      playLabel.textContent = "PAUSE";
      playBtn.classList.add("is-playing");
      playBtn.setAttribute("aria-label", "Pausar");
      vinyl.classList.add("is-playing");
      tonearm.classList.add("is-playing");
      cueingLever.classList.add("is-down");
      powerLed.classList.add("is-on");
    } else {
      iconPlay.hidden = false;
      iconPause.hidden = true;
      playLabel.textContent = "PLAY";
      playBtn.classList.remove("is-playing");
      playBtn.setAttribute("aria-label", "Reproducir");
      vinyl.classList.remove("is-playing");
      tonearm.classList.remove("is-playing");
      cueingLever.classList.remove("is-down");
    }
  }

  function autoReturn() {
    sfx.servo(false);
    tonearm.classList.add("is-returning");
    setTimeout(() => {
      tonearm.classList.remove("is-returning", "is-playing");
    }, 1300);
  }

  /* ---------- Modes ---------- */
  function toggleShuffle() {
    sfx.toggleClick();
    isShuffle = !isShuffle;
    shuffleBtn.classList.toggle("is-active", isShuffle);
    shuffleBtn.setAttribute("aria-pressed", String(isShuffle));
  }
  function cycleRepeat() {
    sfx.toggleClick();
    repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    repeatBtn.dataset.mode = repeatMode;
    repeatBtn.classList.toggle("is-active", repeatMode !== "off");
    repeatBtn.setAttribute("aria-pressed", String(repeatMode !== "off"));
    audio.loop = repeatMode === "one";
  }
  function toggleSfx() {
    sfx.toggleClick();
    const next = !sfx.enabled;
    sfx.setEnabled(next);
    sfxBtn.classList.toggle("is-active", next);
    sfxBtn.setAttribute("aria-pressed", String(next));
  }

  /* ============================================================
     PROGRESS / SEEK
     ============================================================ */
  function updateProgress() {
    const dur = audio.duration || 0;
    const cur = audio.currentTime || 0;
    const pct = dur ? (cur / dur) * 100 : 0;
    ledBarFill.style.width = pct + "%";
    ledBarThumb.style.left = pct + "%";
    progressBar.setAttribute("aria-valuenow", String(Math.round(pct)));
    ledCurTime.textContent = fmtTime(cur);
    ledTotalTime.textContent = fmtTime(dur);
    // Tape counter
    if (tapeCounterEl) {
      tapeCounterEl.textContent = String(Math.floor(cur) % 10000).padStart(4, "0");
    }
    // Tonearm rotation tied to progress (gentle inward motion)
    if (dur && !tonearm.classList.contains("is-returning")) {
      const ratio = Math.min(1, cur / dur);
      tonearm.style.setProperty("--tonearm-progress", ratio.toFixed(3));
    }
  }
  function seekFromPointer(clientX) {
    const rect = progressBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = ratio * audio.duration;
    ledBarFill.style.width = (ratio * 100) + "%";
    ledBarThumb.style.left = (ratio * 100) + "%";
  }

  /* ============================================================
     POINTER DRAG HELPER
     ============================================================ */
  function bindPointerDrag(el, onDown, onMove, onUp) {
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add("is-dragging");
      onDown(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      onMove(e);
    });
    const release = (e) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove("is-dragging");
      if (onUp) onUp(e);
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  }

  bindPointerDrag(progressBar,
    (e) => seekFromPointer(e.clientX),
    (e) => seekFromPointer(e.clientX)
  );

  /* ============================================================
     KNOB FACTORY (general purpose, drag + wheel + keyboard)
     ============================================================ */
  function makeKnob(el, opts) {
    let value = opts.init;
    let startY = 0, startVal = 0;
    function render() {
      const ratio = (value - opts.min) / (opts.max - opts.min);
      const angle = -135 + ratio * 270;
      const dial = el.querySelector(".tk-dial") || el.querySelector(".knob-dial") || el.querySelector(".src-dial") || el.querySelector(".td-dial");
      if (dial) dial.style.setProperty("--knob-angle", angle + "deg");
      el.setAttribute("aria-valuenow", String(opts.format ? opts.format(value, true) : value));
      if (opts.label) opts.label(value);
    }
    bindPointerDrag(el,
      (e) => { startY = e.clientY; startVal = value; },
      (e) => {
        const dy = startY - e.clientY;
        const span = opts.max - opts.min;
        let v = startVal + (dy / opts.dragRange) * span;
        v = Math.max(opts.min, Math.min(opts.max, v));
        if (opts.snap) v = Math.round(v);
        if (v !== value) { value = v; opts.onChange(value); render(); }
      }
    );
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const span = opts.max - opts.min;
      const step = opts.snap ? 1 : span * 0.04;
      let v = value + (e.deltaY < 0 ? step : -step);
      v = Math.max(opts.min, Math.min(opts.max, v));
      if (opts.snap) v = Math.round(v);
      if (v !== value) { value = v; opts.onChange(value); render(); }
    }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const span = opts.max - opts.min;
      const step = opts.snap ? 1 : span * 0.05;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        e.preventDefault();
        let v = Math.min(opts.max, value + step);
        if (opts.snap) v = Math.round(v);
        if (v !== value) { value = v; opts.onChange(value); render(); }
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        e.preventDefault();
        let v = Math.max(opts.min, value - step);
        if (opts.snap) v = Math.round(v);
        if (v !== value) { value = v; opts.onChange(value); render(); }
      }
    });
    render();
    return {
      get value() { return value; },
      set: (v) => { value = Math.max(opts.min, Math.min(opts.max, v)); opts.onChange(value); render(); },
    };
  }

  /* ---------- Volume knob (existing) ---------- */
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    audio.volume = volume;
    const angle = KNOB_MIN + (KNOB_MAX - KNOB_MIN) * volume;
    knobDial.style.setProperty("--knob-angle", angle + "deg");
    const pct = Math.round(volume * 100);
    volumeValue.textContent = String(pct);
    volumeKnob.setAttribute("aria-valuenow", String(pct));
  }
  let knobStartY = 0, knobStartVol = 0;
  bindPointerDrag(volumeKnob,
    (e) => { knobStartY = e.clientY; knobStartVol = volume; },
    (e) => {
      const dy = knobStartY - e.clientY;
      setVolume(knobStartVol + dy / 200);
    }
  );
  volumeKnob.addEventListener("wheel", (e) => {
    e.preventDefault();
    setVolume(volume + (e.deltaY < 0 ? 0.04 : -0.04));
  }, { passive: false });
  volumeKnob.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowRight")  { e.preventDefault(); setVolume(volume + 0.05); }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); setVolume(volume - 0.05); }
  });

  /* ---------- Tone knobs (Bass / Treble / Balance / Reverb) ---------- */
  const bassCtrl = makeKnob(bassKnob, {
    min: -12, max: 12, init: 0, dragRange: 200,
    onChange: applyBass,
    label: (v) => { if (knobValueElems.bass) knobValueElems.bass.textContent = (v > 0 ? "+" : "") + Math.round(v); },
  });
  const trebleCtrl = makeKnob(trebleKnob, {
    min: -12, max: 12, init: 0, dragRange: 200,
    onChange: applyTreble,
    label: (v) => { if (knobValueElems.treble) knobValueElems.treble.textContent = (v > 0 ? "+" : "") + Math.round(v); },
  });
  const balanceCtrl = makeKnob(balanceKnob, {
    min: -100, max: 100, init: 0, dragRange: 200,
    onChange: applyBalance,
    label: (v) => {
      const r = Math.round(v);
      if (!knobValueElems.balance) return;
      knobValueElems.balance.textContent = r === 0 ? "C" : (r < 0 ? "L" + (-r) : "R" + r);
    },
  });
  const reverbCtrl = makeKnob(reverbKnob, {
    min: 0, max: 3, init: 0, dragRange: 220, snap: true,
    onChange: (v) => {
      const modes = ["off", "hall", "plate", "spring"];
      const mode = modes[Math.round(v)];
      applyReverb(mode);
    },
    label: (v) => {
      const labels = ["OFF", "HALL", "PLATE", "SPRING"];
      if (knobValueElems.reverb) knobValueElems.reverb.textContent = labels[Math.round(v)];
    },
  });

  /* ---------- EQ sliders ---------- */
  eqInputs.forEach((input) => {
    const band = Number(input.dataset.band);
    const slider = input.parentElement;
    const updateThumb = () => {
      const v = Number(input.value);
      const pct = ((v - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
      slider.style.setProperty("--eq-pct", pct.toFixed(1) + "%");
      slider.classList.toggle("is-cut",   v < -1);
      slider.classList.toggle("is-boost", v >  1);
    };
    updateThumb();
    input.addEventListener("input", () => {
      const v = Number(input.value);
      applyEqBand(band, v);
      updateThumb();
    });
  });

  /* ---------- Filter rocker switches ---------- */
  function bindRocker(btn, getOn, setOn) {
    btn.addEventListener("click", () => {
      sfx.toggleClick();
      const next = !getOn();
      setOn(next);
      btn.classList.toggle("is-active", next);
      btn.setAttribute("aria-pressed", String(next));
    });
  }
  bindRocker(loudnessBtn,  () => loudnessOn,  applyLoudness);
  bindRocker(subFilterBtn, () => subFilterOn, applySubFilter);
  bindRocker(hiFilterBtn,  () => hiFilterOn,  applyHiFilter);
  bindRocker(warmBtn,      () => warmOn,      (v) => { applyWarm(v); if (v) wfStart = performance.now(); });

  /* ---------- Source selector (PHONO / TUNER / AUX / TAPE) ---------- */
  let currentSource = "phono";
  const SOURCES = ["phono", "tuner", "aux", "tape"];
  const SOURCE_LABELS = { phono: "PHONO", tuner: "TUNER", aux: "AUX", tape: "TAPE" };

  function setSource(src) {
    if (!SOURCES.includes(src) || src === currentSource) return;
    sfx.toggleClick();
    const prev = currentSource;
    currentSource = src;
    sourceBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.source === src));
    if (ledSourceTag) ledSourceTag.textContent = SOURCE_LABELS[src];
    // Sync source knob position
    const idx = SOURCES.indexOf(src);
    if (sourceCtrl) sourceCtrl.set(idx);
    // Tuner panel visibility
    if (tunerPanel) tunerPanel.hidden = (src !== "tuner");
    // Tuner audio control
    if (src === "tuner") {
      if (!audio.paused) audio.pause();
      tuner.start();
    } else if (prev === "tuner") {
      tuner.stop();
    }
    // Display label tweak
    if (src === "tuner") {
      ledTitleEl.textContent = `FM ${tuner.freq.toFixed(1)} MHz   STEREO`;
    } else if (src === "aux") {
      ledTitleEl.textContent = "AUX INPUT — LINE LEVEL";
    } else if (src === "tape") {
      ledTitleEl.textContent = "TAPE DECK — STAND BY";
    } else if (currentIndex >= 0) {
      const t = tracks[currentIndex];
      ledTitleEl.textContent = `${t.artist.toUpperCase()} — ${t.title.toUpperCase()}`;
    } else {
      ledTitleEl.textContent = "— NO TRACK LOADED —";
    }
    updateMarquee();
  }
  sourceBtns.forEach((b) => {
    b.addEventListener("click", () => setSource(b.dataset.source));
  });
  const sourceCtrl = makeKnob(sourceKnob, {
    min: 0, max: 3, init: 0, dragRange: 220, snap: true,
    onChange: (v) => setSource(SOURCES[Math.round(v)]),
    label: () => {},
  });

  /* ---------- Tuner dial (decorative + freq display) ---------- */
  if (tunerDial) {
    let tdStart = 88.5;
    bindPointerDrag(tunerDial,
      (e) => { tdStart = tuner.freq; },
      (e) => {
        const rect = tunerDial.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const angle = Math.atan2(dy, dx); // -PI..PI
        const norm = (angle + Math.PI) / (2 * Math.PI); // 0..1
        let f = 88 + norm * 20;
        f = Math.round(f * 10) / 10;
        tuner.setFrequency(f);
        // rotate dial
        const dialEl = tunerDial.querySelector(".td-dial");
        if (dialEl) dialEl.style.setProperty("--knob-angle", (angle * 180 / Math.PI) + "deg");
      }
    );
    tunerDial.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = tuner.freq + (e.deltaY < 0 ? 0.1 : -0.1);
      tuner.setFrequency(f);
    }, { passive: false });
  }

  /* ---------- Anti-skating knob (decorative) ---------- */
  if (antiSkatingKnob) {
    let asAngle = -135;
    bindPointerDrag(antiSkatingKnob,
      (e) => {},
      (e) => {
        const rect = antiSkatingKnob.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        let a = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (a < -135) a = -135;
        if (a >  135) a =  135;
        asAngle = a;
        antiSkatingKnob.style.setProperty("--knob-angle", a + "deg");
      }
    );
  }

  /* ---------- Theme switcher ---------- */
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.theme === theme));
    try { localStorage.setItem("velouria.theme", theme); } catch(e) {}
  }
  themeButtons.forEach((b) => {
    b.addEventListener("click", () => {
      sfx.tinyClick();
      setTheme(b.dataset.theme);
    });
  });
  try {
    const savedTheme = localStorage.getItem("velouria.theme");
    if (savedTheme) setTheme(savedTheme);
  } catch(e) {}

  /* ---------- Quartz lock LED ---------- */
  let quartzTimer = null;
  function quartzLockBlinkAndLock() {
    if (!quartzLed) return;
    quartzLed.classList.remove("is-locked");
    quartzLed.classList.add("is-blinking");
    clearTimeout(quartzTimer);
    quartzTimer = setTimeout(() => {
      quartzLed.classList.remove("is-blinking");
      quartzLed.classList.add("is-locked");
    }, 1100);
  }
  function quartzLockOff() {
    if (!quartzLed) return;
    clearTimeout(quartzTimer);
    quartzLed.classList.remove("is-blinking", "is-locked");
  }

  /* ============================================================
     MARQUEE
     ============================================================ */
  function updateMarquee() {
    requestAnimationFrame(() => {
      const overflow = ledTitleEl.scrollWidth > ledMarquee.clientWidth + 4;
      ledMarquee.classList.toggle("is-scrolling", overflow);
      if (overflow) {
        const base = ledTitleEl.textContent.replace(/\s+•\s+.*$/, "");
        ledTitleEl.textContent = `${base}     •     ${base}`;
      }
    });
  }

  /* ============================================================
     SPEED BUTTONS (33 / 45 RPM)
     ============================================================ */
  speedBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      sfx.toggleClick();
      speedBtns.forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      speedRpm = Number(btn.dataset.speed);
      setSpinDuration();
      // Re-blink quartz lock briefly
      if (!audio.paused) quartzLockBlinkAndLock();
    });
  });

  /* ============================================================
     AUDIO EVENTS
     ============================================================ */
  audio.addEventListener("timeupdate", updateProgress);
  audio.addEventListener("loadedmetadata", () => {
    updateProgress();
    if (currentIndex >= 0 && tracks[currentIndex] && !tracks[currentIndex].duration) {
      tracks[currentIndex].duration = audio.duration || 0;
      const li = playlistEl.querySelector(`.tl-item[data-index="${currentIndex}"]`);
      if (li) li.querySelector(".tl-duration").textContent = fmtTime(audio.duration || 0);
    }
  });
  audio.addEventListener("ended", () => {
    if (repeatMode === "one") { audio.currentTime = 0; play(); return; }
    if (currentIndex === tracks.length - 1 && repeatMode === "off" && !isShuffle) {
      setPlayingUI(false);
      audio.currentTime = 0;
      autoReturn();
      return;
    }
    next();
  });
  audio.addEventListener("play",  () => { setPlayingUI(true);  sfx.startCrackle(); quartzLockBlinkAndLock(); });
  audio.addEventListener("pause", () => { setPlayingUI(false); sfx.stopCrackle();  quartzLockOff(); });

  /* ============================================================
     BUTTONS
     ============================================================ */
  playBtn.addEventListener("click", () => { sfx.transportClick(); togglePlay(); });
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);
  shuffleBtn.addEventListener("click", toggleShuffle);
  repeatBtn.addEventListener("click", cycleRepeat);
  sfxBtn.addEventListener("click", toggleSfx);
  cueingLever.addEventListener("click", togglePlay);

  progressBar.addEventListener("keydown", (e) => {
    if (!audio.duration) return;
    if (e.key === "ArrowLeft")  { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
    if (e.key === "ArrowRight") { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); e.preventDefault(); }
  });

  /* ============================================================
     FILE I/O
     ============================================================ */
  fileInput.addEventListener("change", (e) => addFiles(e.target.files));
  clearBtn.addEventListener("click", clearAll);
  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("is-dragging"); });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragging"); });
  });
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (e.target.closest(".dropzone")) return;
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  /* ============================================================
     KEYBOARD SHORTCUTS
     ============================================================ */
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    switch (e.code) {
      case "Space":      e.preventDefault(); togglePlay(); break;
      case "ArrowRight": if (e.shiftKey) { e.preventDefault(); next(); } break;
      case "ArrowLeft":  if (e.shiftKey) { e.preventDefault(); prev(); } break;
      case "KeyS":       toggleShuffle(); break;
      case "KeyR":       cycleRepeat(); break;
      case "KeyT":       { const order = ["walnut","rosewood","black"]; const cur = document.documentElement.dataset.theme || "walnut"; const idx = order.indexOf(cur); setTheme(order[(idx + 1) % order.length]); break; }
    }
  });

  /* ---------- Tab visibility ---------- */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAnim();
    else startAnim();
  });

  /* ============================================================
     INIT
     ============================================================ */
  setupVuMeters();
  setupSpectrum();
  setSpinDuration();
  setVolume(volume);
  updateMarquee();

  // Sync SFX button visual with persisted preference
  sfxBtn.classList.toggle("is-active", sfx.enabled);
  sfxBtn.setAttribute("aria-pressed", String(sfx.enabled));

  // Power-on animation: relay thunk after 600ms, full power after 1.2s
  setTimeout(() => {
    document.body.classList.remove("powering-on");
    document.body.classList.add("power-on");
    if (audioCtx) sfx.relayThunk();
  }, 1200);

  startAnim();
})();
