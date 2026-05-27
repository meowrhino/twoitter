// ----- player de audio custom (markup + lógica colocados juntos aquí) -----
//
// Markup (audioPlayerMarkup) y wiring (setupAudioPlayers) viven en el mismo
// módulo para que cualquier cambio en uno fuerce mirar el otro. Quien quiera
// pintar un audio en el feed importa audioPlayerMarkup desde aquí; el resto
// (play/pause, seek, tiempo, teclado) lo gestiona setupAudioPlayers via
// delegación global desde document.
//
// Política: sin autoplay — el usuario pulsa play. Solo un audio sonando a la
// vez (modelo radio: empezar uno pausa los demás).

import { escapeHtml } from './utils.js';

// Devuelve el HTML de un player + (si lo hay) bloque de transcripción. El
// caller decide dónde insertarlo. r2_key se interpola en el src del <audio>
// y se escapa por defensa en profundidad (puede venir de import/export).
//
//   - `transcript: string | null`. Si llega texto, se pinta visible debajo
//     del player; si es null, dejamos el bloque oculto para que el botón
//     "transcribir" pueda rellenarlo in-place sin recrear DOM.
//   - `src: string | undefined`. Si llega, se usa tal cual (caso composer
//     con blob: URL). Si no, se construye `/r2/${r2_key}` como antes.
export function audioPlayerMarkup({ r2_key, transcript, src } = {}) {
  const audioSrc = src ? escapeHtml(src) : `/r2/${escapeHtml(r2_key)}`;
  const tr = transcript ? escapeHtml(transcript) : '';
  const trBlock = tr
    ? `<div class="audio-transcript" data-transcript="1">${tr}</div>`
    : `<div class="audio-transcript" data-transcript="0" hidden></div>`;
  return `<div class="audio-player" data-state="paused">
    <button class="ap-play" type="button" aria-label="reproducir">
      <span class="ap-icon-play" aria-hidden="true">▶</span>
      <span class="ap-icon-pause" aria-hidden="true">❚❚</span>
    </button>
    <div class="ap-progress" role="slider" aria-label="progreso" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="ap-progress-fill"></div>
    </div>
    <span class="ap-time" aria-live="off">0:00<span class="ap-time-sep"> / </span><span class="ap-time-dur">--:--</span></span>
    <audio src="${audioSrc}" preload="metadata"></audio>
  </div>${trBlock}`;
}

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '--:--';
  const total = Math.floor(t);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Pinta tiempo actual + duración en el player. Si la duración aún no se
// cargó (loadedmetadata pendiente), deja --:--.
function paintTime(player) {
  const audio = player.querySelector(':scope > audio');
  if (!audio) return;
  const curEl = player.querySelector('.ap-time');
  const durEl = player.querySelector('.ap-time-dur');
  if (curEl) {
    // Reescribir sólo el texto del current (primer text node), preservando
    // los spans hijos (separador + duración).
    const first = curEl.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      first.nodeValue = fmt(audio.currentTime);
    }
  }
  if (durEl) durEl.textContent = fmt(audio.duration);
}

function paintProgress(player) {
  const audio = player.querySelector(':scope > audio');
  if (!audio) return;
  const fill = player.querySelector('.ap-progress-fill');
  const slider = player.querySelector('.ap-progress');
  if (!fill || !slider) return;
  const pct = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0;
  fill.style.width = `${pct}%`;
  slider.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function setPaused(player, paused) {
  player.dataset.state = paused ? 'paused' : 'playing';
  const btn = player.querySelector('.ap-play');
  if (btn) {
    btn.setAttribute('aria-label', paused ? 'reproducir' : 'pausar');
  }
}

// Engancha listeners al <audio> de un player. Marca el player como wired
// con dataset para no duplicar listeners si el setup global se llama dos veces
// sobre el mismo nodo.
function wirePlayer(player) {
  if (player.dataset.wired === '1') return;
  const audio = player.querySelector(':scope > audio');
  if (!audio) return;
  player.dataset.wired = '1';

  // Estado inicial pintado en cuanto sepamos la duración.
  audio.addEventListener('loadedmetadata', () => {
    paintTime(player);
    paintProgress(player);
  });
  audio.addEventListener('timeupdate', () => {
    paintTime(player);
    paintProgress(player);
  });
  audio.addEventListener('play', () => setPaused(player, false));
  audio.addEventListener('pause', () => setPaused(player, true));
  audio.addEventListener('ended', () => {
    setPaused(player, true);
    // resetea posición visual a 0 — el audio.currentTime ya queda en duration
    // por el browser, pero queremos que al volver a darle play arranque desde
    // el principio (UX más intuitiva para una nota corta).
    try { audio.currentTime = 0; } catch {}
    paintTime(player);
    paintProgress(player);
  });

  // Si los metadatos ya estaban (cache), pinta de una.
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    paintTime(player);
    paintProgress(player);
  }
}

// Pausa todos los demás players (1 audio sonando a la vez). Modelo radio.
function pauseOthers(except) {
  document.querySelectorAll('.audio-player > audio').forEach((a) => {
    if (a === except) return;
    if (!a.paused) {
      try { a.pause(); } catch {}
    }
  });
}

function seekFromPointer(player, clientX) {
  const audio = player.querySelector(':scope > audio');
  const slider = player.querySelector('.ap-progress');
  if (!audio || !slider || !Number.isFinite(audio.duration)) return;
  const rect = slider.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  try { audio.currentTime = audio.duration * pct; } catch {}
  paintTime(player);
  paintProgress(player);
}

let wired = false;
export function setupAudioPlayers() {
  if (wired) return;
  wired = true;

  // Cualquier player que entre al DOM (via render inicial o swapStage) lo
  // wireamos al hacer click la primera vez — pero también de forma eager
  // observando mutations, para que paintTime() corra en cuanto loadedmetadata
  // dispare aunque el user no haya interactuado.
  const observeNew = () => {
    document.querySelectorAll('.audio-player').forEach(wirePlayer);
  };
  observeNew();
  const mo = new MutationObserver(observeNew);
  mo.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', (e) => {
    // Play/pause
    const playBtn = e.target.closest('.audio-player .ap-play');
    if (playBtn) {
      e.stopPropagation();
      const player = playBtn.closest('.audio-player');
      const audio = player.querySelector(':scope > audio');
      if (!audio) return;
      if (audio.paused) {
        pauseOthers(audio);
        audio.play().catch((err) => console.warn('play failed', err));
      } else {
        audio.pause();
      }
      return;
    }
    // Seek
    const slider = e.target.closest('.audio-player .ap-progress');
    if (slider) {
      e.stopPropagation();
      const player = slider.closest('.audio-player');
      seekFromPointer(player, e.clientX);
      return;
    }
  });

  // Teclado en el slider: flechas mueven ±5s, Home/End van a 0/dur.
  document.addEventListener('keydown', (e) => {
    const slider = e.target.closest?.('.audio-player .ap-progress');
    if (!slider) return;
    const player = slider.closest('.audio-player');
    const audio = player.querySelector(':scope > audio');
    if (!audio || !Number.isFinite(audio.duration)) return;
    let handled = true;
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
    else if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    else if (e.key === 'Home') audio.currentTime = 0;
    else if (e.key === 'End') audio.currentTime = audio.duration;
    else if (e.key === ' ' || e.key === 'Enter') {
      if (audio.paused) {
        pauseOthers(audio);
        audio.play().catch(() => {});
      } else audio.pause();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      paintTime(player);
      paintProgress(player);
    }
  });
}
