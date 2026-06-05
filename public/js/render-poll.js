// ----- UI de encuestas: markup + wiring de votación -----
//
// Extraído de render.js: las encuestas son un subsistema propio (markup del
// bloque + optimismo de voto) ajeno al render de hilos/activación, que es la
// responsabilidad de aquel módulo. renderPost (render.js) invoca renderPoll
// para el markup y bindPollActions para cablear los botones clicables.

import { fmt, escapeHtml, toast } from './utils.js';
import { api } from './api.js';

// Markup de un bloque de encuesta. Resultados siempre visibles: la barra
// se rellena al % aunque no hayas votado. Si ya votaste (poll.my_vote_id),
// los botones quedan como divs estáticos con marca "tu voto". Si no, son
// botones clicables.
//
// Esquema del payload:
//   poll: {
//     options: [{ id, position, label, votes }],
//     total_votes: number,
//     my_vote_id: number | null,
//   }
export function renderPoll(poll) {
  if (!poll) return '';
  const total = poll.total_votes || 0;
  const voted = poll.my_vote_id != null;
  const items = poll.options
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((o) => {
      const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
      const mine = poll.my_vote_id === o.id;
      const tag = voted ? 'div' : 'button';
      const typeAttr = voted ? '' : 'type="button"';
      const cls = ['poll-option'];
      if (voted) cls.push('poll-option-static');
      if (mine) cls.push('poll-option-mine');
      const mineDot = mine ? '<span class="poll-mine-dot" aria-label="tu voto">●</span>' : '';
      return `
        <${tag} ${typeAttr} class="${cls.join(' ')}" data-option-id="${o.id}">
          <span class="poll-bar" style="width: ${pct}%"></span>
          <span class="poll-row">
            <span class="poll-pct">${pct}%</span>
            <span class="poll-label">${escapeHtml(o.label)}</span>
            ${mineDot}
          </span>
        </${tag}>
      `;
    })
    .join('');
  const totalLabel = total === 1 ? '1 voto' : `${fmt(total)} votos`;
  return `
    <div class="poll" data-poll data-voted="${voted ? '1' : '0'}">
      ${items}
      <div class="poll-foot">${totalLabel}</div>
    </div>
  `;
}

// Wire de los botones clicables del bloque encuesta. Sólo se llama si
// el visitante aún no ha votado (los <div> estáticos no necesitan
// handler). Optimismo controlado: tras éxito repintamos el bloque con
// la respuesta del servidor (que ya trae my_vote_id) en lugar de
// estimar localmente.
export function bindPollActions(postEl, p) {
  const block = postEl.querySelector(':scope > .post-body .poll');
  if (!block) return;
  if (block.dataset.voted === '1') return;
  const buttons = block.querySelectorAll('.poll-option');
  buttons.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      // stopPropagation: en el feed, hacer clic en una opción no debe
      // activar el post (eso lo gestiona activation.js a nivel document).
      e.stopPropagation();
      if (btn.disabled) return;
      const optionId = parseInt(btn.dataset.optionId, 10);
      buttons.forEach((b) => (b.disabled = true));
      const { ok, status, data } = await api(`/api/posts/${p.id}/poll/vote`, {
        method: 'POST',
        body: { option_id: optionId },
      });
      // 409 = ya votaste: aún así el server devuelve poll actualizado.
      if (!ok && status !== 409) {
        toast(data?.error || 'error al votar', 'error');
        buttons.forEach((b) => (b.disabled = false));
        return;
      }
      const newPoll = data?.poll;
      if (newPoll) {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderPoll(newPoll);
        const fresh = wrap.firstElementChild;
        block.replaceWith(fresh);
        // tras votar es estático → no necesita rewire.
      }
    });
  });
}
