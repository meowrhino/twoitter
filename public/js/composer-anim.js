// ----- animación de apertura/cierre del composer inline (reply) -----
//
// El composer inline crece/encoge en altura (0 ↔ natural) + fade, con la MISMA
// curva y duración que el rail amarillo, de modo que ambos se mueven juntos.
// lockstepRail (rails.js) pega el rail a esta animación frame a frame mientras
// dura. height:auto no es animable en CSS, así que medimos la altura natural y
// animamos con la Web Animations API; al terminar, el form vuelve a su CSS
// natural (height auto) y el textarea puede volver a crecer al escribir.

import { refreshActiveRail, lockstepRail } from './rails.js';

const RAIL_CURVE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const COMPOSER_ANIM_MS = 320;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Dos keyframes [colapsado, natural]. Colapsamos también padding y márgenes (no
// sólo height) para que el composer nazca desde ~0px: con box-sizing:border-box,
// height:0 dejaría visible el padding+borde (~30px) y no se leería como "crece
// desde la nada". Leemos el estado natural del computed style en vez de
// hardcodear valores, por si el CSS de .reply-inline cambia.
function composerFrames(form) {
  const cs = getComputedStyle(form);
  const natural = {
    height: `${form.offsetHeight}px`, // border-box completo en reposo
    paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop, marginBottom: cs.marginBottom,
    opacity: 1, overflow: 'hidden',
  };
  const collapsed = {
    height: '0px', paddingTop: '0px', paddingBottom: '0px',
    marginTop: '0px', marginBottom: '0px', opacity: 0, overflow: 'hidden',
  };
  return { collapsed, natural };
}

export function animateComposerOpen(form) {
  // Sin animación (reduced-motion): sólo ajustar el rail a la nueva altura
  // (openReplyComposer ya no llama refreshActiveRail — delega aquí).
  if (prefersReducedMotion()) { refreshActiveRail(); return; }
  const { collapsed, natural } = composerFrames(form);
  lockstepRail(COMPOSER_ANIM_MS + 60); // el rail crece pegado al composer
  const anim = form.animate([collapsed, natural], { duration: COMPOSER_ANIM_MS, easing: RAIL_CURVE });
  // Asegura el estado final del rail aunque el lockstep/ResizeObserver no haya
  // corrido (p.ej. pestaña en background, donde WAAPI y RO se pausan).
  const settle = () => refreshActiveRail();
  anim.onfinish = settle;
  anim.oncancel = settle;
}

// Encoge el composer y ejecuta `done` (lógica que puede ser CRÍTICA, p.ej.
// insertar la respuesta enviada). `done` se ejecuta SIEMPRE y SÓLO una vez:
//   - guard `fired` evita doble ejecución (onfinish + fallback a la vez)
//   - fallback setTimeout garantiza que corre aunque la animación nunca termine
//     (en background WAAPI se pausa y onfinish no dispara → sin esto, la
//     respuesta no se insertaría y el composer no se cerraría).
export function animateComposerClose(form, done) {
  let fired = false;
  const finish = () => {
    if (fired) return;
    fired = true;
    form.remove();
    done();
    refreshActiveRail(); // asienta el rail a su altura final ya sin composer
  };
  if (prefersReducedMotion()) { finish(); return; }
  const { collapsed, natural } = composerFrames(form);
  lockstepRail(COMPOSER_ANIM_MS + 60); // el rail encoge pegado al composer
  const anim = form.animate([natural, collapsed], { duration: COMPOSER_ANIM_MS, easing: RAIL_CURVE });
  anim.onfinish = finish;
  anim.oncancel = finish;
  setTimeout(finish, COMPOSER_ANIM_MS + 120);
}
