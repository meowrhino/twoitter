// ----- animación de apertura/cierre del composer inline (reply) -----
//
// El composer inline crece/encoge en altura (0 ↔ natural) + fade, con la MISMA
// curva y duración que el rail amarillo, de modo que ambos se mueven juntos.
// lockstepRail (rails.js) pega el rail a esta animación frame a frame mientras
// dura. height:auto no es animable en CSS, así que medimos la altura natural y
// animamos con la Web Animations API; al terminar, el form vuelve a su CSS
// natural (height auto) y el textarea puede volver a crecer al escribir.

import { refreshActiveRail, animateHeight } from './rails.js';
import { prefersReducedMotion, STANDARD_CURVE, ANIM_MS } from './utils.js';

// Curva y duración compartidas con el rail/acordeón → utils.js (STANDARD_CURVE/ANIM_MS).

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
  // Sin fallback: si onfinish no llega, asentar el rail no es crítico al abrir
  // (el ResizeObserver acaba poniéndolo a medida); evitamos un timer redundante.
  animateHeight(form, [collapsed, natural], {
    duration: ANIM_MS,
    easing: STANDARD_CURVE,
    fallback: false,
    onSettle: () => refreshActiveRail(),
  });
}

// Encoge el composer y ejecuta `done` (lógica que puede ser CRÍTICA, p.ej.
// insertar la respuesta enviada). `done` se ejecuta SIEMPRE y SÓLO una vez: el
// onSettle idempotente de animateHeight + su fallback setTimeout garantizan que
// corre aunque la animación nunca termine (en background WAAPI se pausa y
// onfinish no dispara → sin esto, la respuesta no se insertaría).
export function animateComposerClose(form, done = () => {}) {
  const settle = () => {
    form.remove();
    done();
    refreshActiveRail(); // asienta el rail a su altura final ya sin composer
  };
  if (prefersReducedMotion()) { settle(); return; }
  const { collapsed, natural } = composerFrames(form);
  animateHeight(form, [natural, collapsed], {
    duration: ANIM_MS,
    easing: STANDARD_CURVE,
    onSettle: settle,
  });
}
