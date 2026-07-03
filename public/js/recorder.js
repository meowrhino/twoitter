// ----- grabación de notas de voz vía MediaRecorder -----
//
// Flujo:
//   start()  → pide permiso de mic, abre stream, arranca MediaRecorder
//   stop()   → cierra el recorder + libera el stream, devuelve un File
//              (audio/webm normalmente) listo para pasar a attachFile().
//
// Una sola sesión activa por composer (gestionado por el caller). Pedimos 24
// kbps mono al grabar, pero Safari/iOS IGNORA ese hint y graba a ~189 kbps; por
// eso media.js recomprime la nota a mono 16 kHz MP3 antes de subir (voiceNote →
// audio-transcode.js). Aquí sólo capturamos y entregamos el File a attachFile.

import { uuid } from './utils.js';
import { attachFile } from './media.js';
import { toast } from './utils.js';
import { enqueue } from './queue.js';
import { toMonoMp3 } from './audio-transcode.js';

// Prioridad de mimeTypes: mp4/AAC PRIMERO. Es el único formato que graban TANTO
// iOS (WebKit) como el Chromium moderno (Chrome/Brave ≥111), así que produce una
// nota UNIVERSAL que suena en todos los dispositivos. Los navegadores que no lo
// soporten (Firefox, Safari viejo) caen a webm/opus. Antes íbamos webm primero,
// lo que dejaba las notas grabadas en escritorio sin reproducir en iPhone.
// Si todo falla, dejamos que MediaRecorder elija por defecto.
const PREFERRED_TYPES = [
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
];

// 24 kbps mono pedido al MediaRecorder. Lo respeta el escritorio (Chrome/Brave
// dan ~50 kbps opus); Safari/iOS lo ignora y graba ~189 kbps AAC. En ambos casos
// la nota se recomprime después a mono 16 kHz mp3 (audio-transcode.js), así que
// este valor sólo marca el "techo" en escritorio. Distinto del audio de los
// vídeos (compressor-video PRESET.audioBitrate=128k) y del re-encode al recortar
// (AUDIO_TRIM_BITRATE=96k): contextos/códecs distintos, NO una constante compartida.
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
export function wireRecorderButton({ form, button, preview, pending, parentId = null }) {
  if (!button) return;
  if (sessions.has(form)) {
    // ya cableado — sólo asegúrate de que esté disponible
    return;
  }
  if (!canRecord()) {
    button.hidden = true;
    return;
  }
  // parentId se guarda para que una nota grabada SIN conexión desde un
  // reply-inline se encole como respuesta al post correcto (queue.js).
  sessions.set(form, { active: false, parentId });

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

    if (blob.size === 0) {
      toast('grabación vacía', 'info');
      return;
    }

    // Sin conexión: directo a la cola offline (queue.js) en vez del composer —
    // se subirá, publicará y transcribirá sola al volver la red. Intentamos
    // transcodificar YA a mono 16 kHz mp3 (lamejs es un asset local y puede
    // estar ya cargado); si no se puede, se encola el original: pesa más pero
    // la nota no se pierde. El texto del composer viaja con la nota (será el
    // texto del post publicado desde la cola), por eso se limpia aquí.
    if (!navigator.onLine) {
      const textarea = form.querySelector('textarea');
      const text = textarea?.value.trim() || null;
      const mp3 = await toMonoMp3(file); // null si falla → original
      await enqueue(mp3 || file, { text, parent_id: state.parentId });
      if (textarea) textarea.value = '';
      toast('sin conexión — nota guardada, se publicará al volver la red', 'info');
      return;
    }

    // voiceNote: true → media.js la recomprime a mono 16 kHz MP3 antes de subir
    // (Safari ignora el bitrate al grabar; ver audio-transcode.js).
    await attachFile(file, preview, pending, { voiceNote: true });
  };

  try {
    state.rec.stop();
  } catch (err) {
    console.error('stop failed', err);
  }
}
