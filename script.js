/* ============================================================
   Retro Vinyl Player — lógica de reproducción
   ============================================================ */

(() => {
  "use strict";

  // ----- Referencias del DOM -----
  const audio = document.getElementById("audio");
  const vinyl = document.getElementById("vinyl");
  const tonearm = document.getElementById("tonearm");
  const vinylTitle = document.getElementById("vinylTitle");
  const vinylArtist = document.getElementById("vinylArtist");
  const trackTitle = document.getElementById("trackTitle");
  const trackArtist = document.getElementById("trackArtist");
  const currentTimeEl = document.getElementById("currentTime");
  const totalTimeEl = document.getElementById("totalTime");
  const progressBar = document.getElementById("progressBar");
  const progressFill = document.getElementById("progressFill");
  const progressThumb = document.getElementById("progressThumb");
  const playBtn = document.getElementById("playBtn");
  const iconPlay = document.getElementById("iconPlay");
  const iconPause = document.getElementById("iconPause");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const shuffleBtn = document.getElementById("shuffleBtn");
  const repeatBtn = document.getElementById("repeatBtn");
  const volumeBar = document.getElementById("volumeBar");
  const volumeFill = document.getElementById("volumeFill");
  const volumeThumb = document.getElementById("volumeThumb");
  const fileInput = document.getElementById("fileInput");
  const clearBtn = document.getElementById("clearBtn");
  const dropzone = document.getElementById("dropzone");
  const playlistEl = document.getElementById("playlist");
  const visualizerCanvas = document.getElementById("visualizer");
  const statusText = document.getElementById("statusText");
  const statusPill = document.getElementById("statusPill");

  // ----- Estado -----
  /** @type {{ id:string, name:string, artist:string, url:string, file:File, duration:number }[]} */
  const tracks = [];
  let currentIndex = -1;
  let isShuffle = false;
  /** @type {"off"|"all"|"one"} */
  let repeatMode = "off";
  let volume = 0.8;

  // ----- Web Audio API (visualizador) -----
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  const ctx2d = visualizerCanvas.getContext("2d");

  function ensureAudioGraph() {
    if (audioCtx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      sourceNode = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (err) {
      console.warn("AudioContext no disponible:", err);
    }
  }

  // ----- Utilidades -----
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function parseMeta(filename) {
    // "Artista - Titulo.mp3" -> { title, artist }
    const base = filename.replace(/\.[^/.]+$/, "");
    const parts = base.split(" - ");
    if (parts.length >= 2) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
    }
    return { artist: "Desconocido", title: base.trim() };
  }

  function setStatus(text, playing = false) {
    statusText.textContent = text;
    statusPill.classList.toggle("is-playing", playing);
  }

  // ----- Render de la lista de reproducción -----
  function renderPlaylist() {
    playlistEl.innerHTML = "";
    tracks.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = "playlist-item" + (i === currentIndex ? " is-current" : "");
      li.dataset.index = String(i);
      li.innerHTML = `
        <span class="pl-index">${i + 1}</span>
        <div class="pl-info">
          <div class="pl-title">${escapeHtml(t.title)}</div>
          <div class="pl-sub">${escapeHtml(t.artist)}</div>
        </div>
        <span class="pl-duration">${t.duration ? fmtTime(t.duration) : "—:—"}</span>
        <button class="pl-remove" aria-label="Eliminar pista" title="Eliminar">×</button>
      `;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".pl-remove")) return;
        loadTrack(i, true);
      });
      li.querySelector(".pl-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        removeTrack(i);
      });
      playlistEl.appendChild(li);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ----- Manipulación de pistas -----
  function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("audio") || /\.mp3$/i.test(f.name));
    if (!files.length) return;
    files.forEach((file) => {
      const meta = parseMeta(file.name);
      const url = URL.createObjectURL(file);
      const id = `${file.name}-${file.size}-${file.lastModified}`;
      // Evitar duplicados
      if (tracks.some((t) => t.id === id)) {
        URL.revokeObjectURL(url);
        return;
      }
      const track = {
        id,
        name: file.name,
        title: meta.title,
        artist: meta.artist,
        url,
        file,
        duration: 0,
      };
      tracks.push(track);
      // Pre-calcular duración con un audio temporal
      const tmp = new Audio();
      tmp.preload = "metadata";
      tmp.src = url;
      tmp.addEventListener("loadedmetadata", () => {
        track.duration = tmp.duration || 0;
        renderPlaylist();
      });
    });
    renderPlaylist();
    if (currentIndex === -1 && tracks.length) {
      loadTrack(0, false);
    }
    setStatus(`${tracks.length} pista${tracks.length === 1 ? "" : "s"} en cola`);
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
    tracks.forEach((t) => URL.revokeObjectURL(t.url));
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
    trackTitle.textContent = "Selecciona una canción";
    trackArtist.textContent = "Tu biblioteca está vacía";
    vinylTitle.textContent = "Sin pista";
    vinylArtist.textContent = "Carga un MP3";
    progressFill.style.width = "0%";
    progressThumb.style.left = "0%";
    currentTimeEl.textContent = "0:00";
    totalTimeEl.textContent = "0:00";
    setStatus("Listo");
  }

  // ----- Reproducción -----
  function loadTrack(index, autoPlay) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    const t = tracks[index];
    audio.src = t.url;
    audio.load();
    trackTitle.textContent = t.title;
    trackArtist.textContent = t.artist;
    vinylTitle.textContent = t.title;
    vinylArtist.textContent = t.artist;
    renderPlaylist();
    if (autoPlay) {
      play();
    } else {
      setStatus(`Cargado: ${t.title}`);
    }
  }

  function play() {
    if (currentIndex === -1 && tracks.length) {
      loadTrack(0, false);
    }
    if (!audio.src) return;
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    const p = audio.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        setPlayingUI(true);
        startVisualizer();
      }).catch((err) => {
        console.warn("No se pudo reproducir:", err);
        setStatus("Toca para reproducir");
      });
    }
  }

  function pause() {
    audio.pause();
    setPlayingUI(false);
  }

  function togglePlay() {
    if (audio.paused) play(); else pause();
  }

  function next() {
    if (!tracks.length) return;
    let i;
    if (isShuffle) {
      if (tracks.length === 1) i = 0;
      else {
        do { i = Math.floor(Math.random() * tracks.length); } while (i === currentIndex);
      }
    } else {
      i = (currentIndex + 1) % tracks.length;
    }
    loadTrack(i, true);
  }

  function prev() {
    if (!tracks.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const i = (currentIndex - 1 + tracks.length) % tracks.length;
    loadTrack(i, true);
  }

  function setPlayingUI(playing) {
    iconPlay.style.display = playing ? "none" : "";
    iconPause.style.display = playing ? "" : "none";
    playBtn.classList.toggle("is-playing", playing);
    playBtn.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
    vinyl.classList.toggle("is-playing", playing);
    tonearm.classList.toggle("is-playing", playing);
    if (playing) {
      const t = tracks[currentIndex];
      setStatus(t ? `Reproduciendo · ${t.title}` : "Reproduciendo", true);
    } else {
      setStatus("En pausa");
    }
  }

  // ----- Modos shuffle/repeat -----
  function toggleShuffle() {
    isShuffle = !isShuffle;
    shuffleBtn.classList.toggle("is-active", isShuffle);
    shuffleBtn.setAttribute("aria-pressed", String(isShuffle));
  }

  function cycleRepeat() {
    repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    repeatBtn.dataset.mode = repeatMode;
    repeatBtn.classList.toggle("is-active", repeatMode !== "off");
    repeatBtn.setAttribute("aria-pressed", String(repeatMode !== "off"));
    audio.loop = repeatMode === "one";
  }

  // ----- Progreso -----
  function updateProgress() {
    const dur = audio.duration || 0;
    const cur = audio.currentTime || 0;
    const pct = dur ? (cur / dur) * 100 : 0;
    progressFill.style.width = pct + "%";
    progressThumb.style.left = pct + "%";
    progressBar.setAttribute("aria-valuenow", String(Math.round(pct)));
    currentTimeEl.textContent = fmtTime(cur);
    totalTimeEl.textContent = fmtTime(dur);
  }

  function seekFromEvent(ev) {
    const rect = progressBar.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    if (audio.duration) {
      audio.currentTime = ratio * audio.duration;
    }
    progressFill.style.width = ratio * 100 + "%";
    progressThumb.style.left = ratio * 100 + "%";
  }

  function setupSliderDrag(barEl, onMove) {
    let dragging = false;
    const start = (e) => {
      dragging = true;
      barEl.classList.add("is-dragging");
      onMove(e);
      e.preventDefault();
    };
    const move = (e) => { if (dragging) onMove(e); };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      barEl.classList.remove("is-dragging");
    };
    barEl.addEventListener("mousedown", start);
    barEl.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", end);
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  }

  // ----- Volumen -----
  function setVolumeFromEvent(ev) {
    const rect = volumeBar.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    setVolume(ratio);
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    audio.volume = volume;
    const pct = volume * 100;
    volumeFill.style.width = pct + "%";
    volumeThumb.style.left = pct + "%";
    volumeBar.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  // ----- Visualizador -----
  let rafId = null;
  function startVisualizer() {
    if (!analyser) return;
    cancelAnimationFrame(rafId);
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      rafId = requestAnimationFrame(draw);
      // Resize canvas a su tamaño visible (sin perder calidad)
      const dpr = window.devicePixelRatio || 1;
      const w = visualizerCanvas.clientWidth;
      const h = visualizerCanvas.clientHeight;
      if (visualizerCanvas.width !== Math.floor(w * dpr) || visualizerCanvas.height !== Math.floor(h * dpr)) {
        visualizerCanvas.width = Math.floor(w * dpr);
        visualizerCanvas.height = Math.floor(h * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);

      analyser.getByteFrequencyData(buffer);
      const bars = 48;
      const step = Math.floor(buffer.length / bars);
      const gap = 3;
      const bw = (w - gap * (bars - 1)) / bars;

      for (let i = 0; i < bars; i++) {
        const v = buffer[i * step] / 255;
        const bh = Math.max(2, v * h * 0.95);
        const x = i * (bw + gap);
        const y = h - bh;

        const grad = ctx2d.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, "#00f0ff");
        grad.addColorStop(0.55, "#ff2bd6");
        grad.addColorStop(1, "#b14bff");
        ctx2d.fillStyle = grad;
        ctx2d.shadowColor = "rgba(255, 43, 214, 0.5)";
        ctx2d.shadowBlur = 8;
        roundRect(ctx2d, x, y, bw, bh, Math.min(3, bw / 2));
        ctx2d.fill();
      }
      ctx2d.shadowBlur = 0;
    };
    draw();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  // ----- Eventos del audio -----
  audio.addEventListener("timeupdate", updateProgress);
  audio.addEventListener("loadedmetadata", () => {
    updateProgress();
    if (currentIndex >= 0 && tracks[currentIndex] && !tracks[currentIndex].duration) {
      tracks[currentIndex].duration = audio.duration || 0;
      renderPlaylist();
    }
  });
  audio.addEventListener("ended", () => {
    if (repeatMode === "one") {
      audio.currentTime = 0;
      play();
      return;
    }
    if (currentIndex === tracks.length - 1 && repeatMode === "off" && !isShuffle) {
      setPlayingUI(false);
      audio.currentTime = 0;
      return;
    }
    next();
  });
  audio.addEventListener("play", () => setPlayingUI(true));
  audio.addEventListener("pause", () => setPlayingUI(false));
  audio.addEventListener("error", () => setStatus("Error al cargar la pista"));

  // ----- Event listeners de controles -----
  playBtn.addEventListener("click", togglePlay);
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);
  shuffleBtn.addEventListener("click", toggleShuffle);
  repeatBtn.addEventListener("click", cycleRepeat);

  setupSliderDrag(progressBar, seekFromEvent);
  setupSliderDrag(volumeBar, setVolumeFromEvent);

  // Teclas en sliders
  progressBar.addEventListener("keydown", (e) => {
    if (!audio.duration) return;
    const step = 5;
    if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - step);
    if (e.key === "ArrowRight") audio.currentTime = Math.min(audio.duration, audio.currentTime + step);
  });
  volumeBar.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") setVolume(volume - 0.05);
    if (e.key === "ArrowRight") setVolume(volume + 0.05);
  });

  // ----- Carga de archivos -----
  fileInput.addEventListener("change", (e) => addFiles(e.target.files));
  clearBtn.addEventListener("click", clearAll);

  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  // También aceptar drop a nivel de window (sin abrir archivo en navegador)
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (e.target.closest(".dropzone")) return; // ya manejado
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // ----- Atajos de teclado -----
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const isFormField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    if (isFormField) return;
    switch (e.code) {
      case "Space": e.preventDefault(); togglePlay(); break;
      case "ArrowRight": if (e.shiftKey) next(); break;
      case "ArrowLeft":  if (e.shiftKey) prev(); break;
      case "KeyS": toggleShuffle(); break;
      case "KeyR": cycleRepeat(); break;
    }
  });

  // ----- Inicialización -----
  setVolume(volume);
  setStatus("Listo");
})();
