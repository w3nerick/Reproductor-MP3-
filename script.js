/* ============================================================
   Velouria 1200 — Hi-Fi MP3 Player
   Optimizations:
   - Single rAF loop driving VU meters + marquee
   - Pointer Events for sliders/knob (works on mouse + touch + pen)
   - ResizeObserver + DPR-aware canvas resizing
   - Event delegation on the playlist
   - Lazy AudioContext (created on first user gesture)
   - Cached DOM lookups, no per-frame allocations
   ============================================================ */

(() => {
  "use strict";

  // ----- DOM refs (cached once) -----
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

  const powerLed = $("powerLed");
  const speedBtns = document.querySelectorAll(".speed-btn");
  const vuCanvases = document.querySelectorAll(".vu-canvas");
  const ledMarquee = document.querySelector(".led-marquee");

  // ----- State -----
  /** @type {{id:string,name:string,title:string,artist:string,url:string,duration:number}[]} */
  const tracks = [];
  let currentIndex = -1;
  let isShuffle = false;
  /** @type {"off"|"all"|"one"} */
  let repeatMode = "off";
  let volume = 0.8;
  let speedRpm = 33; // 33 or 45

  // Knob: angle range -135deg (min) → +135deg (max)
  const KNOB_MIN = -135;
  const KNOB_MAX = 135;

  // ----- Lazy Web Audio -----
  let audioCtx = null;
  let analyser = null;
  let timeData = null;
  let mediaSource = null;

  function ensureAudioGraph() {
    if (audioCtx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      mediaSource = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      timeData = new Uint8Array(analyser.fftSize);
      mediaSource.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (err) {
      console.warn("AudioContext unavailable:", err);
    }
  }

  // ----- Procedural SFX (Web Audio, no external samples) -----
  const sfx = (() => {
    const SFX_KEY = "velouria.sfxEnabled";
    let enabled = localStorage.getItem(SFX_KEY) !== "false"; // default ON
    let firstPlayDone = false;
    let masterGain = null;
    let crackleSrc = null;
    let crackleGain = null;

    function init() {
      if (masterGain) return;
      ensureAudioGraph();
      if (!audioCtx) return;
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.22;
      masterGain.connect(audioCtx.destination);
    }

    // Resume context if suspended (autoplay policy)
    function ready() {
      if (!enabled) return false;
      init();
      if (!audioCtx || !masterGain) return false;
      if (audioCtx.state === "suspended") audioCtx.resume();
      return true;
    }

    // Short noise burst, bandpass-filtered → mechanical "click"
    function click(freq, dur, gain) {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      const len = Math.max(8, Math.floor(audioCtx.sampleRate * dur));
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const env = Math.exp(-i / (audioCtx.sampleRate * 0.005));
        ch[i] = (Math.random() * 2 - 1) * env;
      }
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const bp = audioCtx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 4;
      const g = audioCtx.createGain();
      g.gain.value = gain;
      src.connect(bp).connect(g).connect(masterGain);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    }

    // Public click variants
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
      o.start(t0);
      o.stop(t0 + 0.07);
    }

    // Servo whoosh: sawtooth sweep through lowpass
    function servo(rising) {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      const dur = 0.45;
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
      lp.type = "lowpass";
      lp.frequency.value = 700;
      lp.Q.value = 2;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.18, t0 + 0.04);
      g.gain.linearRampToValueAtTime(0.12, t0 + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(lp).connect(g).connect(masterGain);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }

    // Stylus drop: low thump + scratchy noise
    function stylusDrop() {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;

      // Low thump
      const o = audioCtx.createOscillator();
      const og = audioCtx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(95, t0);
      o.frequency.exponentialRampToValueAtTime(40, t0 + 0.18);
      og.gain.setValueAtTime(0, t0);
      og.gain.linearRampToValueAtTime(0.55, t0 + 0.005);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
      o.connect(og).connect(masterGain);
      o.start(t0);
      o.stop(t0 + 0.3);

      // Scratchy high-pass noise
      const dur = 0.16;
      const len = Math.floor(audioCtx.sampleRate * dur);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const env = Math.exp(-i / (audioCtx.sampleRate * 0.05));
        ch[i] = (Math.random() * 2 - 1) * env;
      }
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const hp = audioCtx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1500;
      const ng = audioCtx.createGain();
      ng.gain.value = 0.22;
      src.connect(hp).connect(ng).connect(masterGain);
      src.start(t0);
    }

    // Power hum (only on first play of session): 120 + 240 Hz blip
    function hum() {
      if (!ready()) return;
      const t0 = audioCtx.currentTime;
      [120, 240].forEach((freq, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.07 / (i + 1), t0 + 0.08);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
        o.connect(g).connect(masterGain);
        o.start(t0);
        o.stop(t0 + 0.75);
      });
    }

    // Continuous vinyl crackle: pink-ish noise + sparse pops, looped
    function startCrackle() {
      if (!ready()) return;
      if (crackleSrc) return;
      const sr = audioCtx.sampleRate;
      const seconds = 4;
      const buf = audioCtx.createBuffer(1, Math.floor(sr * seconds), sr);
      const ch = buf.getChannelData(0);
      // Voss-McCartney 3-pole pink noise approximation + sparse pops
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
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const hp = audioCtx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 600;
      const lp = audioCtx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 6500;
      const g = audioCtx.createGain();
      g.gain.value = 0;
      src.connect(hp).connect(lp).connect(g).connect(masterGain);
      const t0 = audioCtx.currentTime;
      src.start(t0);
      g.gain.linearRampToValueAtTime(0.55, t0 + 1.2);
      crackleSrc = src;
      crackleGain = g;
    }

    function stopCrackle() {
      if (!crackleSrc || !audioCtx) return;
      const t = audioCtx.currentTime;
      const src = crackleSrc;
      const g = crackleGain;
      crackleSrc = null;
      crackleGain = null;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.4);
        setTimeout(() => { try { src.stop(); } catch (e) {} }, 500);
      } catch (e) { /* node already gone */ }
    }

    function onFirstPlay() {
      if (firstPlayDone) return;
      firstPlayDone = true;
      hum();
    }

    function setEnabled(v) {
      enabled = !!v;
      try { localStorage.setItem(SFX_KEY, enabled ? "true" : "false"); } catch (e) {}
      if (!enabled) stopCrackle();
    }

    return {
      transportClick, toggleClick, tinyClick,
      servo, stylusDrop, hum,
      startCrackle, stopCrackle, onFirstPlay,
      setEnabled,
      get enabled() { return enabled; },
      get masterGain() { return masterGain; },
    };
  })();
  // expose for tweaking from devtools (e.g. __sfx.masterGain.gain.value = 0.3)
  window.__sfx = sfx;

  // ----- VU meters (analog needle) -----
  /** @type {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, w:number, h:number, dpr:number, value:number}[]} */
  const vuMeters = [];

  function setupVuMeters() {
    vuCanvases.forEach((canvas) => {
      const ctx = canvas.getContext("2d");
      vuMeters.push({ canvas, ctx, w: 0, h: 0, dpr: 1, value: 0 });
    });

    const resizeAll = () => {
      const dpr = window.devicePixelRatio || 1;
      vuMeters.forEach((m) => {
        const rect = m.canvas.getBoundingClientRect();
        m.dpr = dpr;
        m.w = rect.width;
        m.h = rect.height;
        m.canvas.width = Math.floor(rect.width * dpr);
        m.canvas.height = Math.floor(rect.height * dpr);
      });
    };

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(resizeAll);
      vuCanvases.forEach((c) => ro.observe(c));
    } else {
      window.addEventListener("resize", resizeAll);
    }
    resizeAll();
  }

  function drawVuMeter(m, level) {
    const { ctx, w, h, dpr } = m;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Cream paper background gradient
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#efe6d2");
    bg.addColorStop(1, "#d9cfb8");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Pivot at bottom-center, arc above
    const cx = w * 0.5;
    const cy = h * 1.05;
    const r = Math.min(w * 0.85, h * 1.25);

    // Arc tick marks
    const startA = Math.PI * 1.15; // ~207deg
    const endA   = Math.PI * 1.85; // ~333deg
    const span = endA - startA;

    // Green zone
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(40, 110, 50, 0.85)";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, startA, startA + span * 0.7);
    ctx.stroke();

    // Red zone (overload)
    ctx.strokeStyle = "rgba(180, 30, 25, 0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, startA + span * 0.7, endA);
    ctx.stroke();

    // Tick lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2a1a08";
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = startA + span * t;
      const inner = i % 2 === 0 ? r * 0.66 : r * 0.7;
      const outer = r * 0.74;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }

    // Number labels (just a few)
    ctx.fillStyle = "#1a1208";
    ctx.font = `${Math.max(8, h * 0.10)}px "Playfair Display", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    [0, 0.5, 1].forEach((t) => {
      const a = startA + span * t;
      const lr = r * 0.58;
      const lx = cx + Math.cos(a) * lr;
      const ly = cy + Math.sin(a) * lr;
      const label = t === 0 ? "0" : t === 0.5 ? "5" : "10";
      ctx.fillText(label, lx, ly);
    });

    // VU label
    ctx.font = `bold ${Math.max(7, h * 0.09)}px "Playfair Display", serif`;
    ctx.fillStyle = "rgba(26, 18, 8, 0.6)";
    ctx.fillText("VU", cx, h * 0.5);

    // Needle
    const a = startA + span * level;
    const nx = cx + Math.cos(a) * r * 0.74;
    const ny = cy + Math.sin(a) * r * 0.74;

    // Needle shadow
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + 1, cy + 1);
    ctx.lineTo(nx + 1, ny + 1);
    ctx.stroke();

    // Needle
    ctx.strokeStyle = "#1a1208";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    // Pivot dot
    ctx.fillStyle = "#0a0604";
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7a4a2c";
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ----- Single rAF loop -----
  let rafId = 0;
  let isAnimating = false;
  // Reusable peak holders to avoid allocations
  const peakDecay = 0.08;
  let peakL = 0, peakR = 0;

  function animate() {
    rafId = requestAnimationFrame(animate);

    if (!analyser) {
      // No audio graph yet — let needles fall to rest
      peakL *= 0.9;
      peakR *= 0.9;
    } else {
      analyser.getByteTimeDomainData(timeData);
      // Compute RMS for L/R approximation (mono signal here, so we
      // separate by alternating sample halves for visual variety).
      let sumL = 0, sumR = 0;
      const n = timeData.length;
      const half = n >> 1;
      for (let i = 0; i < half; i++) {
        const v = (timeData[i] - 128) / 128;
        sumL += v * v;
      }
      for (let i = half; i < n; i++) {
        const v = (timeData[i] - 128) / 128;
        sumR += v * v;
      }
      const rmsL = Math.sqrt(sumL / half);
      const rmsR = Math.sqrt(sumR / half);

      // Smooth the needle (heavy needle physics ~ low-pass)
      peakL += (Math.min(1, rmsL * 2.6) - peakL) * 0.18;
      peakR += (Math.min(1, rmsR * 2.6) - peakR) * 0.18;

      // Decay if signal stops
      peakL = Math.max(0, peakL - peakDecay * 0.02);
      peakR = Math.max(0, peakR - peakDecay * 0.02);
    }

    if (vuMeters[0]) drawVuMeter(vuMeters[0], peakL);
    if (vuMeters[1]) drawVuMeter(vuMeters[1], peakR);
  }

  function startAnim() {
    if (isAnimating) return;
    isAnimating = true;
    animate();
  }
  function stopAnim() {
    isAnimating = false;
    cancelAnimationFrame(rafId);
  }

  // ----- Utilities -----
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
    // 33⅓ rpm → 1.8 s/rev,  45 rpm → 1.333 s/rev
    const rev = speedRpm === 45 ? 60 / 45 : 60 / 33.333;
    vinyl.style.setProperty("--spin-duration", rev.toFixed(3) + "s");
  }

  // ----- Playlist render (event-delegated, single innerHTML build) -----
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

  // Single delegated handler for the whole list
  playlistEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest("[data-action='remove']");
    const item = e.target.closest(".tl-item");
    if (!item) return;
    const i = Number(item.dataset.index);
    if (removeBtn) {
      e.stopPropagation();
      removeTrack(i);
      return;
    }
    loadTrack(i, true);
  });

  // ----- Tracks -----
  function addFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => (f.type && f.type.startsWith("audio")) || /\.mp3$/i.test(f.name)
    );
    if (!files.length) return;

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

      // Compute duration off-thread without re-rendering everything
      const probe = new Audio();
      probe.preload = "metadata";
      probe.src = url;
      probe.addEventListener("loadedmetadata", () => {
        track.duration = probe.duration || 0;
        // Update only the duration cell of this track, if present
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

    if (!tracks.length) {
      stopAndReset();
      renderPlaylist();
      return;
    }
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
    updateMarquee();
  }

  // ----- Playback -----
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
    if (currentIndex === -1 && tracks.length) loadTrack(0, false);
    if (!audio.src) return;
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    sfx.onFirstPlay();
    sfx.servo(true);
    setTimeout(() => sfx.stylusDrop(), 280);
    const p = audio.play();
    if (p && p.then) p.catch(() => {/* user gesture required, no-op */});
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

  // ----- Modes -----
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
    // Click *before* flipping state so you can hear the OFF click
    sfx.toggleClick();
    const next = !sfx.enabled;
    sfx.setEnabled(next);
    sfxBtn.classList.toggle("is-active", next);
    sfxBtn.setAttribute("aria-pressed", String(next));
  }

  // ----- Progress (LED bar) -----
  function updateProgress() {
    const dur = audio.duration || 0;
    const cur = audio.currentTime || 0;
    const pct = dur ? (cur / dur) * 100 : 0;
    ledBarFill.style.width = pct + "%";
    ledBarThumb.style.left = pct + "%";
    progressBar.setAttribute("aria-valuenow", String(Math.round(pct)));
    ledCurTime.textContent = fmtTime(cur);
    ledTotalTime.textContent = fmtTime(dur);
  }

  function seekFromPointer(clientX) {
    const rect = progressBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = ratio * audio.duration;
    ledBarFill.style.width = (ratio * 100) + "%";
    ledBarThumb.style.left = (ratio * 100) + "%";
  }

  // ----- Pointer-based slider helper (works for mouse, touch, pen) -----
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
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      el.classList.remove("is-dragging");
      if (onUp) onUp(e);
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  }

  bindPointerDrag(
    progressBar,
    (e) => seekFromPointer(e.clientX),
    (e) => seekFromPointer(e.clientX)
  );

  // ----- Volume knob (vertical drag) -----
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    audio.volume = volume;
    const angle = KNOB_MIN + (KNOB_MAX - KNOB_MIN) * volume;
    knobDial.style.setProperty("--knob-angle", angle + "deg");
    const pct = Math.round(volume * 100);
    volumeValue.textContent = String(pct);
    volumeKnob.setAttribute("aria-valuenow", String(pct));
  }

  let knobStartY = 0;
  let knobStartVol = 0;
  bindPointerDrag(
    volumeKnob,
    (e) => { knobStartY = e.clientY; knobStartVol = volume; },
    (e) => {
      // 200px drag = full range, vertical (up = louder)
      const dy = knobStartY - e.clientY;
      setVolume(knobStartVol + dy / 200);
    }
  );
  // Wheel for fine control on knob
  volumeKnob.addEventListener("wheel", (e) => {
    e.preventDefault();
    setVolume(volume + (e.deltaY < 0 ? 0.04 : -0.04));
  }, { passive: false });
  // Keyboard
  volumeKnob.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); setVolume(volume + 0.05); }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); setVolume(volume - 0.05); }
  });

  // ----- Marquee toggle (only animate when overflow) -----
  function updateMarquee() {
    // Defer to next frame so layout is up-to-date
    requestAnimationFrame(() => {
      const overflow = ledTitleEl.scrollWidth > ledMarquee.clientWidth + 4;
      ledMarquee.classList.toggle("is-scrolling", overflow);
      if (overflow) {
        // Duplicate text so the marquee loops seamlessly via translateX(-50%)
        const base = ledTitleEl.textContent.replace(/\s+•\s+.*$/, "");
        ledTitleEl.textContent = `${base}     •     ${base}`;
      }
    });
  }

  // ----- Speed buttons (33 / 45 RPM) -----
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
      // Subtle pitch nudge for fun (45 = +35%, 33 = normal)
      audio.playbackRate = speedRpm === 45 ? 1.0 : 1.0; // keep 1.0 for music sanity
    });
  });

  // ----- Audio events -----
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
      return;
    }
    next();
  });
  audio.addEventListener("play", () => { setPlayingUI(true); sfx.startCrackle(); });
  audio.addEventListener("pause", () => { setPlayingUI(false); sfx.stopCrackle(); });

  // ----- Buttons -----
  playBtn.addEventListener("click", () => { sfx.transportClick(); togglePlay(); });
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);
  shuffleBtn.addEventListener("click", toggleShuffle);
  repeatBtn.addEventListener("click", cycleRepeat);
  sfxBtn.addEventListener("click", toggleSfx);

  cueingLever.addEventListener("click", togglePlay);

  // Progress bar keyboard
  progressBar.addEventListener("keydown", (e) => {
    if (!audio.duration) return;
    if (e.key === "ArrowLeft")  { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
    if (e.key === "ArrowRight") { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); e.preventDefault(); }
  });

  // ----- File input + dropzone -----
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
  // Window-level drop (so users can drop anywhere)
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (e.target.closest(".dropzone")) return;
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // ----- Keyboard shortcuts -----
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    switch (e.code) {
      case "Space":      e.preventDefault(); togglePlay(); break;
      case "ArrowRight": if (e.shiftKey) { e.preventDefault(); next(); } break;
      case "ArrowLeft":  if (e.shiftKey) { e.preventDefault(); prev(); } break;
      case "KeyS":       toggleShuffle(); break;
      case "KeyR":       cycleRepeat(); break;
    }
  });

  // ----- Pause animation when tab hidden -----
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAnim();
    else startAnim();
  });

  // ----- Init -----
  setupVuMeters();
  setSpinDuration();
  setVolume(volume);
  updateMarquee();
  // Sync SFX button visual state with persisted preference
  sfxBtn.classList.toggle("is-active", sfx.enabled);
  sfxBtn.setAttribute("aria-pressed", String(sfx.enabled));
  startAnim();
})();
