# twoitter

mi twitter privado para guardar notas, citas, capturas y screen recordings. una sola persona (yo), protegido por contraseña.

stack: cloudflare workers + hono + d1 + r2.

## features

- composer con paste (cmd+v) de imágenes, videos y texto
- drag & drop de archivos
- multi-media por post, hilos (replies), hashtags `#tag` con sidebar
- thumbnail de video generado en cliente
- permalinks por post (`/post/:id`) para citar
- export json completo (`/api/export`)

## setup

```bash
npm install

# crear d1, copiar el database_id al wrangler.toml
npm run db:create

# aplicar schema en remoto
npm run db:migrate

# crear bucket r2
npm run r2:create

# secrets
wrangler secret put PASSWORD        # tu contraseña
wrangler secret put AUTH_SECRET     # cualquier string largo aleatorio

# deploy
npm run deploy
```

dominio: `twoitter.meowrhino.studio`
