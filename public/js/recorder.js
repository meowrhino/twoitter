// ----- grabación de notas de voz vía MediaRecorder -----
//
// Flujo:
//   start()  → pide permiso de mic, abre stream, arranca MediaRecorder
//   stop()   → cierra el recorder + libera el stream, devuelve un File
//              (audio/webm normalmente) listo para pasar a attachFile().
//
// Una sola sesión activa por composer (gestionado por el caller). No
// re-comprimimos: grabamos Opus directo a 24 kbps mono (ver opts abajo), que
// ya es tamaño de nota de voz. El default del navegador serían ~128 kbps.

import { uuid } from './utils.js';
import { attachFile } from './media.js';
import { toast } from './utils.js';

// Prioridad de mimeTypes: opus webm → ogg opus → mp4. Safari (~iOS) puede
// negar el primero, así que probamos el siguiente. Si todo falla, dejamos
// que MediaRecorder elija por defecto.
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

// 24 kbps mono: calidad de voz por encima de WhatsApp (~16 kbps) y ~5× más
// ligero que el default del navegador (~128 kbps). Un minuto y medio ≈ 270 KB.
// Distinto del audio de los vídeos (compressor-video PRESET.audioBitrate=128k) y
// del re-encode al recortar una nota (AUDIO_TRIM_BITRATE=96k): contextos/códecs
// distintos, NO una constante compartida.
const VOICE_NOTE_BITRATE = 24000;

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of PREFERRED_TYPES) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return ''; // default del browser
}

// Estado por composer. WeakMap → GC automático cuando el form sale del DOM.
const sessions = new WeakMap();

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Devuelve true si el navegador puede grabar audio (existe getUserMedia +
// MediaRecorder). Para HTTPS o localhost; un http:// público no tiene mic.
export function canRecord() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

// Cablea el botón "grabar" de un composer. El caller pasa los nodos
// necesarios. Idempotente: si ya está cableado para este form, no repite.
export function wireRecorderButton({ form, button, preview, pending }) {
  if (!button) return;
  if (sessions.has(form)) {
    // ya cableado — sólo asegúrate de que esté disponible
    return;
  }
  if (!canRecord()) {
    button.hidden = true;
    return;
  }
  sessions.set(form, { active: false });

  button.addEventListener('click', async (e) => {
    e.preventDefault();
    const state = sessions.get(form);
    if (state.active) {
      stopRecording(form, button, preview, pending);
    } else {
      await startRecording(form, button, preview, pending);
    }
  });
}

async function startRecording(form, button, preview, pending) {
  const state = sessions.get(form);
  if (state.active) return;

  let stream;
  try {
    // Mono + DSP de voz. channelCount:1 deja que Opus gaste todos los bits en
    // un canal (mejor calidad por bit); echo/noise/gain limpian la captura.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    console.error('mic permission denied', err);
    toast('no se pudo abrir el micro', 'error');
    return;
  }

  const mimeType = pickMimeType();
  const opts = { audioBitsPerSecond: VOICE_NOTE_BITRATE };
  if (mimeType) opts.mimeType = mimeType;
  let rec;
  try {
    rec = new MediaRecorder(stream, opts);
  } catch (err) {
    console.error('MediaRecorder init failed', err);
    stream.getTracks().forEach((t) => t.stop());
    toast('grabación no soportada en este navegador', 'error');
    return;
  }

  const chunks = [];
  rec.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  // Lock visual: cambia label + clase para feedback inequívoco.
  button.classList.add('is-recording');
  button.dataset.idleLabel = button.dataset.idleLabel || button.textContent;
  const startedAt = Date.now();
  const tick = () => {
    button.textContent = `■ parar · ${fmtTime(Date.now() - startedAt)}`;
  };
  tick();
  const timer = setInterval(tick, 500);

  state.active = true;
  state.rec = rec;
  state.stream = stream;
  state.chunks = chunks;
  state.timer = timer;
  state.mimeType = mimeType || rec.mimeType || 'audio/webm';

  rec.start();
}

function stopRecording(form, button, preview, pending) {
  const state = sessions.get(form);
  if (!state?.active || !state.rec) return;

  state.rec.onstop = async () => {
    clearInterval(state.timer);
    state.stream.getTracks().forEach((t) => t.stop());

    const mime = (state.mimeType || 'audio/webm').split(';')[0];
    const ext = mime === 'audio/ogg' ? 'ogg' : mime === 'audio/mp4' ? 'm4a' : 'webm';
    const blob = new Blob(state.chunks, { type: mime });
    const filename = `nota-${uuid()}.${ext}`;
    const file = new File([blob], filename, { type: mime });

    // reset visual. La etiqueta original se guardó en dataset.idleLabel al
    // empezar a grabar (startRecording). Antes había también `state._idleLabel`,
    // que nunca se asignaba en ningún sitio → rama muerta; eliminada.
    button.classList.remove('is-recording');
    button.textContent = button.dataset.idleLabel || 'grabar';

    state.active = false;
    state.rec = null;
    state.stream = null;
    state.chunks = null;
    state.timer = null;

    if (blob.size > 0) {
      await attachFile(file, preview, pending);
    } else {
      toast('grabación vacía', 'info');
    }
  };

  try {
    state.rec.stop();
  } catch (err) {
    console.error('stop failed', err);
  }
}
