# Web dashboard (read-only)

## Requisitos

Variables de entorno (mismas credenciales que el bot, sin exponer en frontend):

- `BQ_PROJECT_ID`
- `BQ_DATASET`
- `BQ_TABLE`
- `DASHBOARD_TOKEN`

## Correr local

```bash
npm install
npm run web:dev
```

Visita:

```
http://localhost:3000/dashboard?token=TU_TOKEN&chat_id=TU_CHAT_ID
```

Opcionalmente define un rango de meses:

```
http://localhost:3000/dashboard?token=TU_TOKEN&chat_id=TU_CHAT_ID&from=2024-01-01&to=2024-12-01
```

## Deploy

Compatible con Vercel o Cloud Run. Asegura las env vars arriba y expone el endpoint:

```
GET /api/cashflow?token=...&chat_id=...&from=YYYY-MM-01&to=YYYY-MM-01
```
