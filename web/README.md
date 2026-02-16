# Web dashboard (read-only)

## Requisitos

Variables de entorno (mismas credenciales que el bot, sin exponer en frontend):

- `BQ_PROJECT_ID`
- `BQ_DATASET`
- `BQ_TABLE`
- `DASHBOARD_TOKEN` (solo para modo legacy con `token` + `chat_id`)

Tablas requeridas para identidad multiusuario:

- `gastos.users`
- `gastos.chat_links`
- `gastos.user_links` (pendings de Telegram + auditoría append-only)

Autenticación esperada en requests al backend (normalmente la añade el proxy/login):

- `x-user-email` **o** `x-goog-authenticated-user-email`

## Correr local

```bash
npm install
npm run web:dev
```

## Uso recomendado

1. En Telegram ejecuta `/dashboard`.
2. Abre la URL con `link_token` mientras estás autenticado en web.
3. La web crea/asegura `users`, consume el `link_token` en modo append-only y guarda `chat_links`.
4. Los siguientes accesos usan resolución `email -> user_id -> latest chat_id`.

## Modo legacy (compatibilidad)

También sigue funcionando:

```
http://localhost:3000/dashboard?token=TU_TOKEN&chat_id=TU_CHAT_ID&from=2024-01-01&to=2024-12-01
```

## Deploy

Compatible con Vercel o Cloud Run. Asegura las env vars arriba y expone el endpoint:

```
GET /api/cashflow?from=YYYY-MM-01&to=YYYY-MM-01&link_token=...
```

Compatibilidad legacy:

```
GET /api/cashflow?token=...&chat_id=...&from=YYYY-MM-01&to=YYYY-MM-01
```
