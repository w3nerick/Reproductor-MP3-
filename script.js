/* ============================================================
   Velouria 1200 — Hi-Fi MP3 Player
   Modules: theme, persistence (IndexedDB + localStorage),
            ID3 parser, EQ (BiquadFilter), Radio (SomaFM),
            VU meters, transport, playlist, tabs.
   ============================================================ */

(() => {
  "use strict";

  /* =========================================================
     0. DOM REFS
     ========================================================= */
  const $ = (id) => document.getElementById(id);

  const audio        = $("audio");
  const vinyl        = $("vinyl");
  const vinylLabel   = $("vinylLabel");
  const labelCover   = $("labelCover");
  const tonearm      = $("tonearm");
  const cueingLever  = $("cueingLever");
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

  // Tabs
  const deck         = document.querySelector(".deck");
  const deckTabs     = document.querySelectorAll(".deck-tab");
  const deckPanels   = document.querySelectorAll(".deck-panel");
  const deckActions  = $("deckActions");

  // Theme
  const themeSwatches = document.querySelectorAll(".theme-swatch");

  // Radio
  const stationListEl = $("stationList");
  const freqStations  = $("freqStations");
  const freqNeedle    = $("freqNeedle");
  const freqValue     = $("freqValue");
  const signalLeds    = $("signalLeds");
  const stereoLed     = $("stereoLed");

  // EQ
  const eqTracks   = document.querySelectorAll(".eq-track");
  const eqPresetEl = $("eqPresets");

  /* =========================================================
     1. STATE
     ========================================================= */

  /** @type {{id:string,name:string,title:string,artist:string,album?:string,coverUrl?:string,url:string,duration:number}[]} */
  const tracks = [];
  let currentIndex = -1;
  let isShuffle = false;
  /** @type {"off"|"all"|"one"} */
  let repeatMode = "off";
  let volume = 0.8;
  let speedRpm = 33;

  /** @type {"library"|"radio"} */
  let currentMode = "library";

  // EQ state (gain in dB, -12..+12)
  const eqState = { low: 0, mid: 0, high: 0 };
  /** @type {Record<string, [number, number, number]>} */
  const EQ_PRESETS = {
    flat:    [ 0,  0,  0],
    rock:    [ 4,  0,  3],
    jazz:    [ 3,  1,  2],
    pop:     [ 2,  3,  2],
    classic: [ 3,  0,  4],
    bass:    [ 8,  2, -2],
  };

  // Radio stations (SomaFM, CORS-friendly streams)
  const STATIONS = [
    { id: "sfm-grove",   freq: 88.5,  name: "GROOVE SALAD",     genre: "Ambient downtempo",   url: "https://ice1.somafm.com/groovesalad-128-mp3" },
    { id: "sfm-drone",   freq: 92.3,  name: "DRONE ZONE",       genre: "Atmospheric ambient", url: "https://ice1.somafm.com/dronezone-128-mp3" },
    { id: "sfm-lush",    freq: 96.7,  name: "LUSH",             genre: "Mellow vocal pop",    url: "https://ice1.somafm.com/lush-128-mp3" },
    { id: "sfm-indie",   freq: 100.1, name: "INDIE POP ROCKS",  genre: "Indie pop",           url: "https://ice1.somafm.com/indiepop-128-mp3" },
    { id: "sfm-secret",  freq: 104.5, name: "SECRET AGENT",     genre: "Spy-fi lounge",       url: "https://ice1.somafm.com/secretagent-128-mp3" },
    { id: "sfm-beats",   freq: 107.9, name: "BEAT BLENDER",     genre: "Deep house",          url: "https://ice1.somafm.com/beatblender-128-mp3" },
  ];
  let currentStationId = null;
  let savedLibraryIndex = -1;  // last library track when switching to radio

  // Knob range
  const KNOB_MIN = -135;
  const KNOB_MAX = 135;

  /* =========================================================
     2. WEB AUDIO GRAPH (lazy)
     ========================================================= */
  let audioCtx = null;
  let mediaSource = null;
  let analyser = null;
  let timeData = null;
  let lowFilter = null;
  let midFilter = null;
  let highFilter = null;

  function ensureAudioGraph() {
    if (audioCtx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      mediaSource = audioCtx.createMediaElementSource(audio);

      lowFilter = audioCtx.createBiquadFilter();
      lowFilter.type = "lowshelf";
      lowFilter.frequency.value = 120;
      lowFilter.gain.value = eqState.low;

      midFilter = audioCtx.createBiquadFilter();
      midFilter.type = "peaking";
      midFilter.frequency.value = 1000;
      midFilter.Q.value = 1;
      midFilter.gain.value = eqState.mid;

      highFilter = audioCtx.createBiquadFilter();
      highFilter.type = "highshelf";
      highFilter.frequency.value = 5000;
      highFilter.gain.value = eqState.high;

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      timeData = new Uint8Array(analyser.fftSize);

      mediaSource
        .connect(lowFilter)
        .connect(midFilter)
        .connect(highFilter)
        .connect(analyser)
        .connect(audioCtx.destination);
    } catch (err) {
      console.warn("AudioContext unavailable:", err);
    }
  }

  /* =========================================================
     3. UTILITIES
     ========================================================= */
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
  function parseFilename(filename) {
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
  }
  function makeId(file) {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  /* =========================================================
     4. ID3v2 PARSER (TIT2, TPE1, TALB, APIC)
     ========================================================= */
  async function parseID3(file) {
    try {
      const headerBuf = await file.slice(0, 10).arrayBuffer();
      const h = new Uint8Array(headerBuf);
      if (h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return null; // no "ID3"
      const major = h[3];
      const flags = h[5];
      const tagSize = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9];
      if (tagSize <= 0 || tagSize > 50 * 1024 * 1024) return null;

      const tagBuf = await file.slice(10, 10 + tagSize).arrayBuffer();
      const tag = new Uint8Array(tagBuf);

      let pos = 0;
      if (flags & 0x40) {
        const extSize = major >= 4
          ? (tag[0] << 21) | (tag[1] << 14) | (tag[2] << 7) | tag[3]
          : (tag[0] << 24) | (tag[1] << 16) | (tag[2] << 8) | tag[3];
        pos += 4 + extSize;
      }

      const out = {};
      while (pos < tag.length - 10) {
        const id = String.fromCharCode(tag[pos], tag[pos+1], tag[pos+2], tag[pos+3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const size = major >= 4
          ? (tag[pos+4] << 21) | (tag[pos+5] << 14) | (tag[pos+6] << 7) | tag[pos+7]
          : (tag[pos+4] << 24) | (tag[pos+5] << 16) | (tag[pos+6] << 8) | tag[pos+7];
        if (size <= 0 || pos + 10 + size > tag.length) break;
        const data = tag.subarray(pos + 10, pos + 10 + size);

        if (id === "TIT2") out.title  = readTextFrame(data);
        else if (id === "TPE1") out.artist = readTextFrame(data);
        else if (id === "TALB") out.album  = readTextFrame(data);
        else if (id === "APIC") out.cover  = readPictureFrame(data);

        pos += 10 + size;
      }
      return out;
    } catch (err) {
      console.warn("ID3 parse error:", err);
      return null;
    }
  }

  function readTextFrame(data) {
    if (data.length < 1) return "";
    const enc = data[0];
    const body = data.subarray(1);
    let text = "";
    try {
      if (enc === 0)      text = new TextDecoder("iso-8859-1").decode(body);
      else if (enc === 1) text = new TextDecoder("utf-16").decode(body);
      else if (enc === 2) text = new TextDecoder("utf-16be").decode(body);
      else if (enc === 3) text = new TextDecoder("utf-8").decode(body);
    } catch { text = ""; }
    return text.replace(/\u0000+$/g, "").trim();
  }

  function readPictureFrame(data) {
    if (data.length < 4) return null;
    const enc = data[0];
    let i = 1;
    // MIME (ISO-8859-1, null-terminated)
    while (i < data.length && data[i] !== 0) i++;
    const mime = new TextDecoder("iso-8859-1").decode(data.subarray(1, i)) || "image/jpeg";
    i++;
    if (i >= data.length) return null;
    // Picture type byte
    i++;
    if (i >= data.length) return null;
    // Description (terminated by null in given encoding)
    if (enc === 1 || enc === 2) {
      while (i < data.length - 1 && !(data[i] === 0 && data[i+1] === 0)) i++;
      i += 2;
    } else {
      while (i < data.length && data[i] !== 0) i++;
      i++;
    }
    if (i >= data.length) return null;
    const picData = data.subarray(i);
    if (picData.length < 8) return null;
    const blob = new Blob([picData], { type: mime });
    return URL.createObjectURL(blob);
  }

  /* =========================================================
     5. PERSISTENCE — IndexedDB (track blobs) + localStorage
     ========================================================= */
  const DB_NAME = "velouria_db";
  const DB_VERSION = 1;
  const TRACK_STORE = "tracks";
  const SETTINGS_KEY = "velouria_settings_v1";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TRACK_STORE)) {
          const store = db.createObjectStore(TRACK_STORE, { keyPath: "id" });
          store.createIndex("addedAt", "addedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(record) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(TRACK_STORE, "readwrite");
        tx.objectStore(TRACK_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { console.warn("dbPut failed:", e); }
  }
  async function dbGetAll() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(TRACK_STORE, "readonly");
        const req = tx.objectStore(TRACK_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { console.warn("dbGetAll failed:", e); return []; }
  }
  async function dbDelete(id) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(TRACK_STORE, "readwrite");
        tx.objectStore(TRACK_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { console.warn("dbDelete failed:", e); }
  }
  async function dbClear() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(TRACK_STORE, "readwrite");
        tx.objectStore(TRACK_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { console.warn("dbClear failed:", e); }
  }

  function saveSettings() {
    try {
      const data = {
        volume, isShuffle, repeatMode, speedRpm,
        theme: document.documentElement.dataset.theme || "walnut",
        currentIndex,
        currentMode,
        currentStationId,
        eq: { ...eqState },
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch {}
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /* =========================================================
     6. THEME
     ========================================================= */
  function setTheme(name) {
    if (!["walnut", "rosewood", "oak"].includes(name)) name = "walnut";
    document.documentElement.dataset.theme = name;
    themeSwatches.forEach((s) => {
      const is = s.dataset.theme === name;
      s.classList.toggle("is-active", is);
      s.setAttribute("aria-checked", String(is));
    });
    saveSettings();
  }
  themeSwatches.forEach((s) => {
    s.addEventListener("click", () => setTheme(s.dataset.theme));
  });

  /* =========================================================
     7. VU METERS (canvas)
     ========================================================= */
  /** @type {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, w:number, h:number, dpr:number}[]} */
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

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#efe6d2");
    bg.addColorStop(1, "#d9cfb8");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 1.05;
    const r = Math.min(w * 0.85, h * 1.25);
    const startA = Math.PI * 1.15;
    const endA   = Math.PI * 1.85;
    const span = endA - startA;

    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(40, 110, 50, 0.85)";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, startA, startA + span * 0.7);
    ctx.stroke();

    ctx.strokeStyle = "rgba(180, 30, 25, 0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, startA + span * 0.7, endA);
    ctx.stroke();

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

    ctx.fillStyle = "#1a1208";
    ctx.font = `${Math.max(8, h * 0.10)}px "Playfair Display", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
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

    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + 1, cy + 1);
    ctx.lineTo(nx + 1, ny + 1);
    ctx.stroke();

    ctx.strokeStyle = "#1a1208";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    ctx.fillStyle = "#0a0604";
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7a4a2c";
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /* =========================================================
     8. SINGLE rAF LOOP (VU + signal indicators)
     ========================================================= */
  let rafId = 0;
  let isAnimating = false;
  let peakL = 0, peakR = 0;
  const peakDecay = 0.08;

  function animate() {
    rafId = requestAnimationFrame(animate);

    if (!analyser) {
      peakL *= 0.9;
      peakR *= 0.9;
    } else {
      analyser.getByteTimeDomainData(timeData);
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
      peakL += (Math.min(1, rmsL * 2.6) - peakL) * 0.18;
      peakR += (Math.min(1, rmsR * 2.6) - peakR) * 0.18;
      peakL = Math.max(0, peakL - peakDecay * 0.02);
      peakR = Math.max(0, peakR - peakDecay * 0.02);
    }

    if (vuMeters[0]) drawVuMeter(vuMeters[0], peakL);
    if (vuMeters[1]) drawVuMeter(vuMeters[1], peakR);

    // Signal indicator follows the average level (when in radio mode)
    if (currentMode === "radio") updateSignalIndicator((peakL + peakR) * 0.5);
  }

  function startAnim() { if (!isAnimating) { isAnimating = true; animate(); } }
  function stopAnim()  { isAnimating = false; cancelAnimationFrame(rafId); }

  /* =========================================================
     9. PLAYLIST RENDER + DELEGATION
     ========================================================= */
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
      const cls = (i === currentIndex && currentMode === "library") ? "tl-item is-current" : "tl-item";
      parts.push(
        `<li class="${cls}" data-index="${i}">` +
          `<span class="tl-num">${num}</span>` +
          `<div class="tl-info">` +
            `<div class="tl-title">${escapeHtml(t.title)}</div>` +
            `<div class="tl-sub">${escapeHtml(t.artist)}${t.album ? " · " + escapeHtml(t.album) : ""}</div>` +
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
    if (removeBtn) {
      e.stopPropagation();
      removeTrack(i);
      return;
    }
    setMode("library");
    loadTrack(i, true);
  });

  /* =========================================================
     10. TRACKS — add / remove / clear / load
     ========================================================= */
  async function addTrackFromBlob(blob, name, addedAt = Date.now(), persist = true) {
    const id = `${name}-${blob.size}-${addedAt}`;
    if (tracks.some((t) => t.id === id)) return null;

    // Read ID3 tags
    const meta = await parseID3(blob);
    const fnameMeta = parseFilename(name);
    const title  = (meta && meta.title)  || fnameMeta.title;
    const artist = (meta && meta.artist) || fnameMeta.artist;
    const album  = (meta && meta.album)  || "";
    const coverUrl = meta && meta.cover ? meta.cover : null;

    const url = URL.createObjectURL(blob);
    const track = { id, name, title, artist, album, coverUrl, url, duration: 0 };
    tracks.push(track);

    // Probe duration
    const probe = new Audio();
    probe.preload = "metadata";
    probe.src = url;
    probe.addEventListener("loadedmetadata", () => {
      track.duration = probe.duration || 0;
      const li = playlistEl.querySelector(`.tl-item[data-index="${tracks.indexOf(track)}"]`);
      if (li) li.querySelector(".tl-duration").textContent = fmtTime(track.duration);
    }, { once: true });

    if (persist) {
      // Store in IndexedDB. We persist the blob itself so it survives reloads.
      dbPut({
        id, name, title, artist, album,
        blob,
        addedAt,
        // We can't persist object URLs; coverBlob stored separately if exists
        coverBlob: meta && meta.coverBlob ? meta.coverBlob : null,
      });
      // Note: we re-parse cover on load to recreate object URL
    }
    return track;
  }

  // Maximum size per file (50 MB) to avoid filling IndexedDB with one huge upload.
  const MAX_FILE_BYTES = 50 * 1024 * 1024;

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => (f.type && f.type.startsWith("audio")) || /\.mp3$/i.test(f.name)
    );
    if (!files.length) return;

    let rejected = 0;
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { rejected++; continue; }
      await addTrackFromBlob(file, file.name, file.lastModified || Date.now(), true);
    }
    if (rejected > 0) {
      console.warn(`Rejected ${rejected} file(s) larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    }
    renderPlaylist();
    if (currentMode === "library" && currentIndex === -1 && tracks.length) {
      loadTrack(0, false);
    }
    saveSettings();
  }

  async function removeTrack(index) {
    const wasCurrent = index === currentIndex;
    const t = tracks[index];
    if (t) {
      URL.revokeObjectURL(t.url);
      if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
      await dbDelete(t.id);
    }
    tracks.splice(index, 1);
    if (!tracks.length) {
      stopAndReset();
      renderPlaylist();
      saveSettings();
      return;
    }
    if (wasCurrent) {
      currentIndex = Math.min(index, tracks.length - 1);
      if (currentMode === "library") loadTrack(currentIndex, !audio.paused);
    } else if (index < currentIndex) {
      currentIndex -= 1;
    }
    renderPlaylist();
    saveSettings();
  }

  async function clearAll() {
    for (const t of tracks) {
      URL.revokeObjectURL(t.url);
      if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
    }
    tracks.length = 0;
    await dbClear();
    stopAndReset();
    renderPlaylist();
    saveSettings();
  }

  function stopAndReset() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentIndex = -1;
    setPlayingUI(false);
    ledTitleEl.textContent = "— NO TRACK LOADED —";
    ledTrackNum.textContent = "--";
    setVinylInfo("NO RECORD", "— LOAD A TRACK —", null);
    ledBarFill.style.width = "0%";
    ledBarThumb.style.left = "0%";
    ledCurTime.textContent = "0:00";
    ledTotalTime.textContent = "0:00";
    powerLed.classList.remove("is-on");
    cueingLever.classList.remove("is-down");
    updateMarquee();
  }

  function setVinylInfo(title, artist, coverUrl) {
    vinylTitle.textContent = title;
    vinylArtist.textContent = artist;
    if (coverUrl) {
      labelCover.style.backgroundImage = `url("${coverUrl}")`;
      labelCover.hidden = false;
      vinylLabel.classList.add("has-cover");
    } else {
      labelCover.hidden = true;
      labelCover.style.backgroundImage = "";
      vinylLabel.classList.remove("has-cover");
    }
  }

  /* =========================================================
     11. PLAYBACK
     ========================================================= */
  function loadTrack(index, autoPlay) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    const t = tracks[index];
    audio.src = t.url;
    audio.load();
    audio.playbackRate = 1.0;

    const display = `${t.artist.toUpperCase()} — ${t.title.toUpperCase()}`;
    ledTitleEl.textContent = display;
    ledTrackNum.textContent = String(index + 1).padStart(2, "0");
    setVinylInfo(t.title, t.artist, t.coverUrl);
    powerLed.classList.add("is-on");
    renderPlaylist();
    updateMarquee();
    saveSettings();
    if (autoPlay) play();
  }

  function play() {
    if (currentMode === "library" && currentIndex === -1 && tracks.length) {
      loadTrack(0, false);
    }
    if (!audio.src) return;
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    const p = audio.play();
    if (p && p.then) p.catch(() => { /* needs gesture */ });
  }
  function pause() { audio.pause(); }
  function togglePlay() { audio.paused ? play() : pause(); }

  function next() {
    if (currentMode === "radio") return tuneNextStation(1);
    if (!tracks.length) return;
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
    if (currentMode === "radio") return tuneNextStation(-1);
    if (!tracks.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const i = (currentIndex - 1 + tracks.length) % tracks.length;
    loadTrack(i, true);
  }

  function setPlayingUI(playing) {
    iconPlay.hidden = playing;
    iconPause.hidden = !playing;
    playLabel.textContent = playing ? "PAUSE" : "PLAY";
    playBtn.classList.toggle("is-playing", playing);
    playBtn.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
    vinyl.classList.toggle("is-playing", playing);
    tonearm.classList.toggle("is-playing", playing);
    cueingLever.classList.toggle("is-down", playing);
    if (playing) powerLed.classList.add("is-on");
  }

  /* =========================================================
     12. MODE TOGGLES (shuffle / repeat)
     ========================================================= */
  function toggleShuffle() {
    isShuffle = !isShuffle;
    shuffleBtn.classList.toggle("is-active", isShuffle);
    shuffleBtn.setAttribute("aria-pressed", String(isShuffle));
    saveSettings();
  }
  function cycleRepeat() {
    repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    repeatBtn.dataset.mode = repeatMode;
    repeatBtn.classList.toggle("is-active", repeatMode !== "off");
    repeatBtn.setAttribute("aria-pressed", String(repeatMode !== "off"));
    audio.loop = repeatMode === "one";
    saveSettings();
  }

  /* =========================================================
     13. PROGRESS / SEEK
     ========================================================= */
  function updateProgress() {
    const dur = audio.duration || 0;
    const cur = audio.currentTime || 0;
    if (!isFinite(dur) || dur <= 0) {
      // streams (radio) → live
      ledBarFill.style.width = "100%";
      ledBarThumb.style.left = "100%";
      ledCurTime.textContent = currentMode === "radio" ? "LIVE" : fmtTime(cur);
      ledTotalTime.textContent = currentMode === "radio" ? "FM" : "0:00";
      return;
    }
    const pct = (cur / dur) * 100;
    ledBarFill.style.width = pct + "%";
    ledBarThumb.style.left = pct + "%";
    progressBar.setAttribute("aria-valuenow", String(Math.round(pct)));
    ledCurTime.textContent = fmtTime(cur);
    ledTotalTime.textContent = fmtTime(dur);
  }

  function seekFromPointer(clientX) {
    if (currentMode === "radio") return;
    const rect = progressBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
    }
    ledBarFill.style.width = (ratio * 100) + "%";
    ledBarThumb.style.left = (ratio * 100) + "%";
  }

  /* =========================================================
     14. POINTER DRAG HELPER
     ========================================================= */
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

  bindPointerDrag(
    progressBar,
    (e) => seekFromPointer(e.clientX),
    (e) => seekFromPointer(e.clientX)
  );

  /* =========================================================
     15. VOLUME KNOB
     ========================================================= */
  function setVolume(v, persist = true) {
    volume = Math.max(0, Math.min(1, v));
    audio.volume = volume;
    const angle = KNOB_MIN + (KNOB_MAX - KNOB_MIN) * volume;
    knobDial.style.setProperty("--knob-angle", angle + "deg");
    const pct = Math.round(volume * 100);
    volumeValue.textContent = String(pct);
    volumeKnob.setAttribute("aria-valuenow", String(pct));
    if (persist) saveSettings();
  }

  let knobStartY = 0, knobStartVol = 0;
  bindPointerDrag(
    volumeKnob,
    (e) => { knobStartY = e.clientY; knobStartVol = volume; },
    (e) => setVolume(knobStartVol + (knobStartY - e.clientY) / 200)
  );
  volumeKnob.addEventListener("wheel", (e) => {
    e.preventDefault();
    setVolume(volume + (e.deltaY < 0 ? 0.04 : -0.04));
  }, { passive: false });
  volumeKnob.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); setVolume(volume + 0.05); }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); setVolume(volume - 0.05); }
  });

  /* =========================================================
     16. MARQUEE
     ========================================================= */
  function updateMarquee() {
    requestAnimationFrame(() => {
      const overflow = ledTitleEl.scrollWidth > ledMarquee.clientWidth + 4;
      ledMarquee.classList.toggle("is-scrolling", overflow);
    });
  }

  /* =========================================================
     17. SPEED (33/45)
     ========================================================= */
  speedBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      speedBtns.forEach((b) => { b.classList.remove("is-active"); b.setAttribute("aria-pressed", "false"); });
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      speedRpm = Number(btn.dataset.speed);
      setSpinDuration();
      saveSettings();
    });
  });

  /* =========================================================
     18. AUDIO ELEMENT EVENTS
     ========================================================= */
  audio.addEventListener("timeupdate", updateProgress);
  audio.addEventListener("loadedmetadata", () => {
    updateProgress();
    if (currentMode === "library" && currentIndex >= 0 && tracks[currentIndex] && !tracks[currentIndex].duration) {
      tracks[currentIndex].duration = audio.duration || 0;
      const li = playlistEl.querySelector(`.tl-item[data-index="${currentIndex}"]`);
      if (li) li.querySelector(".tl-duration").textContent = fmtTime(audio.duration || 0);
    }
  });
  audio.addEventListener("ended", () => {
    if (currentMode === "radio") return; // streams shouldn't end
    if (repeatMode === "one") { audio.currentTime = 0; play(); return; }
    if (currentIndex === tracks.length - 1 && repeatMode === "off" && !isShuffle) {
      setPlayingUI(false);
      audio.currentTime = 0;
      return;
    }
    next();
  });
  audio.addEventListener("play", () => setPlayingUI(true));
  audio.addEventListener("pause", () => setPlayingUI(false));
  audio.addEventListener("error", () => {
    if (currentMode === "radio") {
      // station failed → mark as such
      const station = STATIONS.find((s) => s.id === currentStationId);
      if (station) {
        const item = stationListEl.querySelector(`[data-station="${station.id}"]`);
        if (item) {
          item.classList.remove("is-current", "is-tuning");
          item.querySelector(".st-status").textContent = "ERROR";
        }
      }
    }
  });

  /* =========================================================
     19. BUTTONS / GLOBAL
     ========================================================= */
  playBtn.addEventListener("click", togglePlay);
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);
  shuffleBtn.addEventListener("click", toggleShuffle);
  repeatBtn.addEventListener("click", cycleRepeat);
  cueingLever.addEventListener("click", togglePlay);

  progressBar.addEventListener("keydown", (e) => {
    if (currentMode === "radio") return;
    if (!audio.duration) return;
    if (e.key === "ArrowLeft")  { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
    if (e.key === "ArrowRight") { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); e.preventDefault(); }
  });

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
    if (e.dataTransfer && e.dataTransfer.files.length) {
      setMode("library");
      addFiles(e.dataTransfer.files);
    }
  });

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

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAnim(); else startAnim();
  });

  // Cleanup on unload: revoke object URLs and close AudioContext to release resources.
  window.addEventListener("beforeunload", () => {
    for (const t of tracks) {
      try { URL.revokeObjectURL(t.url); } catch {}
      if (t.coverUrl) { try { URL.revokeObjectURL(t.coverUrl); } catch {} }
    }
    if (audioCtx && typeof audioCtx.close === "function") {
      try { audioCtx.close(); } catch {}
    }
  });

  /* =========================================================
     20. TABS
     ========================================================= */
  function setActiveTab(tabName) {
    deck.dataset.activeTab = tabName;
    deckTabs.forEach((t) => {
      const is = t.dataset.tab === tabName;
      t.classList.toggle("is-active", is);
      t.setAttribute("aria-selected", String(is));
    });
    deckPanels.forEach((p) => {
      p.hidden = p.dataset.panel !== tabName;
    });
    // LOAD/EJECT actions only relevant to library tab
    deckActions.hidden = tabName !== "library";
  }
  deckTabs.forEach((t) => {
    t.addEventListener("click", () => setActiveTab(t.dataset.tab));
  });

  /* =========================================================
     21. RADIO MODE
     ========================================================= */
  function renderStations() {
    // Station list (cards)
    stationListEl.innerHTML = STATIONS.map((s) =>
      `<li class="st-item" data-station="${s.id}">` +
        `<span class="st-freq">${s.freq.toFixed(1)}</span>` +
        `<div class="st-info">` +
          `<div class="st-name">${escapeHtml(s.name)}</div>` +
          `<div class="st-genre">${escapeHtml(s.genre)}</div>` +
        `</div>` +
        `<span class="st-status">TUNE IN</span>` +
      `</li>`
    ).join("");

    // Frequency dial marks (created via DOM API to avoid inline style="")
    const range = 108 - 88;
    freqStations.replaceChildren();
    for (const s of STATIONS) {
      const mark = document.createElement("span");
      mark.className = "freq-station-mark";
      mark.dataset.station = s.id;
      mark.style.left = ((s.freq - 88) / range) * 100 + "%";
      freqStations.appendChild(mark);
    }
  }

  stationListEl.addEventListener("click", (e) => {
    const li = e.target.closest(".st-item");
    if (!li) return;
    tuneStation(li.dataset.station);
  });

  function tuneNextStation(direction) {
    const list = STATIONS.slice().sort((a, b) => a.freq - b.freq);
    const currentIdx = list.findIndex((s) => s.id === currentStationId);
    let nextIdx = currentIdx + direction;
    if (nextIdx < 0) nextIdx = list.length - 1;
    if (nextIdx >= list.length) nextIdx = 0;
    tuneStation(list[nextIdx].id);
  }

  function tuneStation(id) {
    const station = STATIONS.find((s) => s.id === id);
    if (!station) return;
    setMode("radio");

    // Update UI: marks + needle
    currentStationId = station.id;
    const range = 108 - 88;
    const x = ((station.freq - 88) / range) * 100;
    freqNeedle.style.left = x + "%";
    freqValue.textContent = station.freq.toFixed(1);

    // Marks
    document.querySelectorAll(".freq-station-mark").forEach((m) => {
      m.classList.toggle("is-active", m.dataset.station === id);
    });

    // List status
    document.querySelectorAll(".st-item").forEach((it) => {
      const isThis = it.dataset.station === id;
      it.classList.toggle("is-tuning", isThis);
      it.classList.remove("is-current");
      it.querySelector(".st-status").textContent = isThis ? "TUNING…" : "TUNE IN";
    });

    // Static SFX while connecting (~600ms)
    playStaticNoise(600);

    // Update LED display
    ledTrackNum.textContent = "FM";
    ledTitleEl.textContent = `${station.name} — ${station.genre.toUpperCase()}`;
    setVinylInfo(station.name, station.genre, null);
    powerLed.classList.add("is-on");
    updateMarquee();

    // Stream
    audio.src = station.url;
    audio.load();
    setTimeout(() => {
      ensureAudioGraph();
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      const p = audio.play();
      if (p && p.then) {
        p.then(() => {
          document.querySelectorAll(".st-item").forEach((it) => {
            const isThis = it.dataset.station === id;
            it.classList.toggle("is-current", isThis);
            it.classList.remove("is-tuning");
            it.querySelector(".st-status").textContent = isThis ? "ON AIR" : "TUNE IN";
          });
          stereoLed.classList.add("is-on");
        }).catch(() => {
          const item = stationListEl.querySelector(`[data-station="${id}"]`);
          if (item) {
            item.classList.remove("is-current", "is-tuning");
            item.querySelector(".st-status").textContent = "ERROR";
          }
        });
      }
    }, 500);

    saveSettings();
  }

  function playStaticNoise(durationMs) {
    if (!audioCtx) ensureAudioGraph();
    if (!audioCtx) return;
    const sr = audioCtx.sampleRate;
    const buf = audioCtx.createBuffer(1, sr * 0.5, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const noise = audioCtx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    noise.connect(gainNode).connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    const dur = durationMs / 1000;
    gainNode.gain.linearRampToValueAtTime(0.18, now + 0.05);
    gainNode.gain.linearRampToValueAtTime(0,    now + dur);

    noise.start();
    noise.stop(now + dur + 0.05);
  }

  function updateSignalIndicator(level) {
    // light up LEDs by level (0..1)
    const leds = signalLeds.querySelectorAll("i");
    const lit = Math.round(level * leds.length);
    leds.forEach((led, idx) => led.classList.toggle("is-on", idx < lit));
  }

  function setMode(mode) {
    if (mode === currentMode) return;
    if (mode === "radio") {
      // remember library state
      savedLibraryIndex = currentIndex;
      audio.pause();
    } else if (mode === "library") {
      audio.pause();
      stereoLed.classList.remove("is-on");
      // Restore library track if available
      if (savedLibraryIndex >= 0 && tracks[savedLibraryIndex]) {
        loadTrack(savedLibraryIndex, false);
      } else if (tracks.length > 0) {
        loadTrack(0, false);
      } else {
        stopAndReset();
      }
    }
    currentMode = mode;
    setActiveTab(mode === "radio" ? "radio" : "library");
    saveSettings();
  }

  /* =========================================================
     22. EQUALIZER
     ========================================================= */
  function setEqBand(band, db) {
    db = Math.max(-12, Math.min(12, db));
    eqState[band] = db;
    if (band === "low" && lowFilter)  lowFilter.gain.value  = db;
    if (band === "mid" && midFilter)  midFilter.gain.value  = db;
    if (band === "high" && highFilter) highFilter.gain.value = db;

    // UI update
    const track = document.querySelector(`.eq-band[data-band="${band}"] .eq-track`);
    const fill  = track.querySelector(".eq-fill");
    const thumb = track.querySelector(".eq-thumb");
    const readout = document.querySelector(`[data-out="${band}"]`);
    const ratio = (db + 12) / 24; // 0..1 (top=+12, bottom=-12)
    // top of track = +12, but pointer Y flips: ratio 0 (db=-12) means thumb at bottom
    const yFromTop = (1 - ratio) * 100;
    thumb.style.transform = `translate(-50%, calc(-50% + ${(yFromTop - 50)}%))`;

    // Fill from center toward thumb
    if (db >= 0) {
      const h = (db / 12) * 50; // % of track height from center
      fill.style.top = (50 - h) + "%";
      fill.style.height = h + "%";
    } else {
      const h = (-db / 12) * 50;
      fill.style.top = "50%";
      fill.style.height = h + "%";
    }

    if (readout) readout.textContent = (db > 0 ? "+" : "") + db;
    track.setAttribute("aria-valuenow", String(db));

    // unmark presets (they may no longer match)
    eqPresetEl.querySelectorAll(".btn-mech").forEach((b) => b.classList.remove("is-active"));
    // …unless current state exactly matches a preset
    const match = Object.entries(EQ_PRESETS).find(([, vals]) =>
      vals[0] === eqState.low && vals[1] === eqState.mid && vals[2] === eqState.high
    );
    if (match) {
      const btn = eqPresetEl.querySelector(`[data-preset="${match[0]}"]`);
      if (btn) btn.classList.add("is-active");
    }
  }

  function applyPreset(name) {
    const v = EQ_PRESETS[name];
    if (!v) return;
    setEqBand("low", v[0]);
    setEqBand("mid", v[1]);
    setEqBand("high", v[2]);
    eqPresetEl.querySelectorAll(".btn-mech").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.preset === name);
    });
    saveSettings();
  }

  // Bind eq sliders
  eqTracks.forEach((track) => {
    const band = track.closest(".eq-band").dataset.band;
    const dragHandler = (clientY) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      // top = +12, bottom = -12
      const db = Math.round(((1 - ratio) * 24) - 12);
      setEqBand(band, db);
      saveSettings();
    };
    bindPointerDrag(
      track,
      (e) => dragHandler(e.clientY),
      (e) => dragHandler(e.clientY)
    );
    track.addEventListener("keydown", (e) => {
      const cur = eqState[band];
      if (e.key === "ArrowUp")   { setEqBand(band, cur + 1); saveSettings(); e.preventDefault(); }
      if (e.key === "ArrowDown") { setEqBand(band, cur - 1); saveSettings(); e.preventDefault(); }
    });
  });

  // Bind eq presets
  eqPresetEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (btn) applyPreset(btn.dataset.preset);
  });

  /* =========================================================
     23. INITIAL LOAD
     ========================================================= */
  async function restoreLibrary() {
    const records = await dbGetAll();
    records.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    for (const r of records) {
      try {
        // Re-parse cover from blob (safer than persisting URL)
        const meta = await parseID3(r.blob);
        const url = URL.createObjectURL(r.blob);
        const coverUrl = meta && meta.cover ? meta.cover : null;
        const track = {
          id: r.id, name: r.name,
          title: r.title || "Unknown", artist: r.artist || "Unknown", album: r.album || "",
          coverUrl, url, duration: 0,
        };
        tracks.push(track);

        // Probe duration
        const probe = new Audio();
        probe.preload = "metadata";
        probe.src = url;
        probe.addEventListener("loadedmetadata", () => {
          track.duration = probe.duration || 0;
          const idx = tracks.indexOf(track);
          const li = playlistEl.querySelector(`.tl-item[data-index="${idx}"]`);
          if (li) li.querySelector(".tl-duration").textContent = fmtTime(track.duration);
        }, { once: true });
      } catch (e) {
        console.warn("Failed to restore track:", r.id, e);
      }
    }
    renderPlaylist();
  }

  async function init() {
    setupVuMeters();
    setSpinDuration();
    renderStations();
    setActiveTab("library");

    // Initial EQ rendering (zero)
    setEqBand("low", 0);
    setEqBand("mid", 0);
    setEqBand("high", 0);

    const settings = loadSettings();
    if (settings) {
      if (typeof settings.volume === "number") setVolume(settings.volume, false);
      if (settings.theme) setTheme(settings.theme);
      if (settings.isShuffle) toggleShuffle();
      if (settings.repeatMode === "all") cycleRepeat();
      else if (settings.repeatMode === "one") { cycleRepeat(); cycleRepeat(); }
      if (settings.speedRpm === 45) {
        speedBtns.forEach((b) => {
          if (b.dataset.speed === "45") b.click();
        });
      }
      if (settings.eq) {
        setEqBand("low",  settings.eq.low  || 0);
        setEqBand("mid",  settings.eq.mid  || 0);
        setEqBand("high", settings.eq.high || 0);
      }
    } else {
      setVolume(0.8, false);
    }

    await restoreLibrary();

    if (settings) {
      // Restore last loaded track
      if (typeof settings.currentIndex === "number" &&
          settings.currentIndex >= 0 &&
          settings.currentIndex < tracks.length) {
        loadTrack(settings.currentIndex, false);
      } else if (tracks.length > 0) {
        loadTrack(0, false);
      }
    } else if (tracks.length > 0) {
      loadTrack(0, false);
    }

    startAnim();
  }

  init().catch((err) => console.warn("init error:", err));
})();
