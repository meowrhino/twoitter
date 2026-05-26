# twoitter

mi twitter privado para guardar notas, citas, capturas, screen recordings y notas de voz. una sola persona (yo), protegido por contraseña.

stack: cloudflare workers + hono + d1 + r2 + workers ai (whisper).

## features

- composer con paste (cmd+v) de imágenes, vídeos y texto
- drag & drop de archivos (imagen / vídeo / audio)
- **notas de voz**: botón "grabar" en el composer (MediaRecorder, opus)
- **transcripción** de notas de voz vía Workers AI Whisper (botón "transcribir" en las acciones del post; cachea en BD, no llama dos veces)
- multi-media por post, hilos (replies), hashtags `#tag` con sidebar
- thumbnail de vídeo generado en cliente
- player de audio custom (monoespaciado, accent, sin chrome nativo feo)
- permalinks por post (`/post/:id`) para citar
- export json completo (`/api/export`)

## setup

```bash
npm install

# crear d1, copiar el database_id al wrangler.toml
npm run db:create

# aplicar schema en remoto
npm run db:migrate:remote

# crear bucket r2
npm run r2:create

# secrets
wrangler secret put PASSWORD        # tu contraseña
wrangler secret put AUTH_SECRET     # cualquier string largo aleatorio

# login para que el binding `AI` (Workers AI) funcione desde wrangler dev
# y deploy. Sólo hace falta la primera vez.
wrangler login

# deploy
npm run deploy
```

## migraciones

los `npm run db:migrate:NNN[:remote]` aplican `migrations/NNN_*.sql` y son **idempotentes en intención** pero NO con `ALTER TABLE`: si una migración ya está aplicada da "duplicate column" — se ignora, la columna ya existe.

| migración | qué hace |
|-----------|----------|
| 001       | `posts.deleted_at` (soft delete) |
| 002       | `media.transcript` (cache de transcripciones de audio) |

al añadir una migración nueva: actualizar `schema.sql` (para clones desde cero) Y crear el `.sql` en `migrations/` (para DBs vivas).

## notas de voz + transcripción

- el botón "grabar" usa `MediaRecorder` con prioridad `audio/webm;codecs=opus` → `audio/ogg;codecs=opus` → `audio/mp4`. opus pesa ~16 KB/s, no recomprimimos en cliente.
- al pulsar "transcribir" en las acciones del post (sólo visible si hay audio sin transcript y estás logueado), se llama a `POST /api/posts/:id/transcribe` que descarga el blob de R2 y lo pasa por `@cf/openai/whisper-large-v3-turbo` con `language: "es"`. el resultado se guarda en `media.transcript` y queda cacheado.
- cuota: el free tier de Workers AI da ~10k neuronas/día, suficiente para decenas de minutos de transcripción. para cambiar el idioma (auto-detectar o forzar otro), editar `WHISPER_LANGUAGE` en `src/index.ts`.

dominio: `twoitter.meowrhino.studio`
