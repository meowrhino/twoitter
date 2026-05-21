# Aviso legal — notas de sesión

> Documento de traspaso. Resume qué se ha añadido al proyecto en relación al
> aviso legal, qué decisiones se tomaron y qué queda pendiente, para poder
> retomarlo en una conversación nueva (deep repo review).

## 1. Contexto del proyecto a efectos legales

- `twoitter` es una **obra artística experimental, sin ánimo de lucro**: no hay
  publicidad, no se comercializa nada, no se recogen datos de visitantes.
- El registro de usuarios **no está abierto**: solo el autor publica
  (se autentica por contraseña, ver `login.html`).
- El sitio puede incluir capturas/recortes de obras de terceros (películas,
  series, vídeos de YouTube, etc.), capturadas por el propio autor.

Eso lo sitúa en el régimen español/UE como **pastiche + cita + parodia**
(arts. 32 y 39 LPI; pastiche introducido por el RDL 24/2021 que transpone
la directiva DSM, art. 17.7). **No existe "fair use"** en España.

Como **no hay actividad económica**, técnicamente no se aplica la
LSSI-CE art. 10 (aviso legal obligatorio). Aun así se publica por
transparencia y como escudo defensivo.

## 2. Archivos añadidos / modificados

### Nuevo
- `public/aviso-legal.html` — página completa de aviso legal con 9 secciones:
  1. Naturaleza del sitio (declaración artística no comercial)
  2. Autoría y contacto
  3. Uso de obras de terceros (arts. 32 y 39 LPI, doctrina TJUE
     *Svensson* / *BestWater* para embeds)
  4. Procedimiento de retirada (notice & takedown)
  5. Contenido publicado en el sitio
  6. Datos personales (RGPD / LOPDGDD)
  7. Propiedad intelectual sobre la obra propia
  8. Exclusión de responsabilidad
  9. Legislación aplicable

  Estilo coherente con el resto del sitio (vars de `style.css`,
  `single-post` como base, todo en minúsculas, accent dorado).

  Incluye un script inline pequeño que gestiona el toggle del menú,
  porque la página es estática y no necesita cargar `app.js` (no hay
  composer, ni auth, ni timeline).

### Modificados
- `public/index.html` — añadido divider + enlace `aviso legal` al final
  del `#menuPanel`.
- `public/post.html` — añadido divider + enlace `aviso legal` al final
  del `#menuPanel`.
- `public/login.html` — añadido enlace discreto en el pie de la tarjeta
  de login (estilo muted, fuera del menú hamburguesa que aquí no existe).

## 3. Decisiones tomadas (valores configurables)

| Campo | Valor actual | Aparece en |
|---|---|---|
| Alias del autor | `meowrhino` | `aviso-legal.html` §2 |
| Email de contacto | `contacto@meowrhino.studio` | `aviso-legal.html` §2, §4, §6 |
| Dominio referenciado | `twoitter.meowrhino.studio` | `aviso-legal.html` §2 |
| Domicilio físico | **omitido** | — |
| Fecha de última actualización | `mayo de 2026` | `aviso-legal.html` pie |

**Domicilio**: omitido deliberadamente porque al no haber actividad
económica no es obligatorio (LSSI no aplica). Si en algún momento se
monetiza (publi, donaciones, ventas), **toca añadir nombre real + NIF
+ domicilio fiscal**.

## 4. Pendiente / a revisar en la deep review

### Pendiente concreto
- [ ] **Verificar que `contacto@meowrhino.studio` recibe correo de verdad**
  (MX records, alias en el dominio). Si no, cambiar a un email que sí
  funcione antes de desplegar — un takedown que no se contesta deja
  de proteger.
- [ ] **Validar visualmente** la página en móvil y escritorio (tamaños,
  legibilidad, colores). Las `<style>` están inline en el `<head>` de
  `aviso-legal.html`; si te molesta tener CSS inline, moverlas a
  `style.css` bajo una sección `/* ---------- legal page ---------- */`.
- [ ] **Decidir consistencia del menú** en `aviso-legal.html`:
  actualmente solo muestra `← timeline`. Las otras páginas muestran
  además `iniciar sesión` / `salir` / `export json` etc. condicionados
  por auth. Como esta página no carga `app.js`, esos enlaces no se
  pueden mostrar/ocultar dinámicamente sin replicar la lógica. Tres
  opciones:
  1. Dejarlo simple como ahora (recomendado: la página es estática
     y de "información", no operativa).
  2. Cargar `app.js` también aquí y replicar la estructura del menú.
  3. Mostrar siempre todos los links sin gating (más feo,
     pero unificado).
- [ ] **Considerar `<meta name="robots">`** si no quieres que los
  buscadores indexen el aviso legal (poco crítico).
- [ ] **Sección 5** asume autor único. Si en el futuro abres el registro
  a otras personas, reescribir como "términos de uso" reales con
  cláusulas de contenido prohibido, responsabilidad del usuario, etc.

### A revisar en la deep repo review (más allá del aviso legal)
- [ ] **Trabajo en paralelo**: durante esta sesión otros agentes/linters
  modificaron `index.html` y `post.html` añadiendo `coi-serviceworker.js`
  y `ffmpeg.js`. Verificar que mis ediciones al `#menuPanel` no
  rompieron nada de eso. Los cambios mios son aditivos (no toqué los
  scripts ni el `<head>`), pero conviene confirmar.
- [ ] **Refactor opcional**: el script de toggle del menú está
  duplicado entre `app.js` (para index/post) y `aviso-legal.html`
  (inline). Si añades más páginas estáticas, valdría la pena extraer
  a un `menu.js` ligero.
- [ ] **Accesibilidad**: comprobar que el `aria-expanded` del menú
  funciona también en la nueva página y que la navegación por teclado
  llega a todos los enlaces de la página legal.
- [ ] **SEO básico**: la página no tiene `<meta name="description">`
  ni `<meta name="author">`. Añadir si interesa.

## 5. Referencias legales utilizadas

- Ley de Propiedad Intelectual (RDL 1/1996) — arts. 32 (cita) y 39 (parodia/pastiche).
- Directiva (UE) 2019/790 ("DSM"), art. 17.7 — caricatura, parodia, pastiche.
- Real Decreto-ley 24/2021 — transposición española de la directiva DSM.
- Ley 34/2002 (LSSI-CE) — art. 10 (info aviso legal) y art. 17 (takedown).
- TJUE C-466/12 (*Svensson*) y C-348/13 (*BestWater*) — embeds con
  iframe no comunican a "público nuevo".
- Reglamento (UE) 2016/679 (RGPD) y LO 3/2018 (LOPDGDD) — datos
  personales.

## 6. Aviso

Esto se ha redactado por un asistente de IA basándose en investigación
web abierta. **No es asesoramiento legal profesional**. Antes de
publicarlo en producción, especialmente si en algún momento existe
ánimo de lucro o si recibes una reclamación, conviene revisarlo con
un abogado especializado en propiedad intelectual.
