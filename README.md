# Telegram Gastos Bot (Cloud Run + BigQuery + Gemini/DeepSeek)

Bot de Telegram para registrar gastos en lenguaje natural con confirmación antes de guardar.  
Guarda todo en **BigQuery** y usa **Gemini** (con fallback a **DeepSeek**) para enriquecer: categoría, comercio y descripción.

## ✨ Features

- ✅ Envía un gasto por Telegram (texto)
- ✅ Parser local + enriquecimiento con LLM (Gemini o fallback a DeepSeek)
- ✅ Preview con botones:
  - ✅ Confirmar
  - ❌ Cancelar
- ✅ Guarda en **BigQuery** con idempotencia
- ✅ Valida métodos de pago y categorías (listas cerradas)
- ✅ Soporta fechas relativas: **hoy / ayer / antier**
- ✅ `Amex` es ambiguo → pide aclaración (American Express vs Amex Aeromexico)
- ✅ MSI y cálculo de mensualidades
- ✅ Borrado seguro por ID con confirmación

---

## 🧠 Formato de mensaje (ejemplos)

Ejemplos válidos:

- `230 Uber American Express ayer`
- `677.35 Santander taqueria los parados`
- `1200 Amazon Banorte Platino 2026-01-15`
- `85 Starbucks Rappi Card hoy`

Luego confirma con botón ✅ o escribiendo `confirmar`.

### MSI (Meses sin intereses)

1) Envía el gasto con MSI (ej. `gasolina 1200 BBVA Platino a MSI`)  
2) El bot pedirá los meses → responde solo el número (`6`, `12`, etc.)

### Borrar un gasto

`borrar <UUID>` (ej. `borrar 123e4567-e89b-12d3-a456-426614174000`)  
El bot mostrará un preview y pedirá confirmación.

### Comandos útiles

- `ayuda` o `/help` → ejemplos y métodos válidos
- `cancelar` o `/cancel` → limpia el borrador
- `/analisis` → menú de análisis
- `/cuentas` → lista cuentas de débito/efectivo (crea “Efectivo” si no existe)
- `/alta_cuenta Nombre | Institución | Tipo` → registra cuenta (tipo: `DEBIT` o `CASH`)
- `/mov ...` → registra movimientos de efectivo/débito (retiro, depósito, transfer)
- `/dashboard` → genera URL de vinculación. Run /dashboard to get a linking URL. Open it while logged in.
- `/viaje nuevo [nombre]` → crea viaje y lo deja activo para ese chat
- `/viaje listar` → muestra los últimos 10 viajes del chat
- `/viaje usar <trip_id>` → cambia el viaje activo (acepta id completo o prefijo)
- `/viaje actual` → muestra el viaje activo

#### Ledger (efectivo / débito)

1) Crear cuentas:

- ` /alta_cuenta Nómina BBVA | BBVA | DEBIT`
- ` /alta_cuenta Caja Chica | Cash | CASH`

> Instituciones permitidas (DEBIT): BBVA, Banorte, Santander.

2) Movimientos:

- Retiro: `/mov retiro 2000 bbva`
- Depósito: `/mov deposito 25000 bbva nomina`
- Transfer: `/mov transfer 5000 bbva -> banorte`

---

## 📊 Modo análisis

Escribe `/analisis` para abrir un menú con:

1. **Gasto del mes (total y por categoría)**  
2. **Qué pago en: Este mes / Próximo mes / Elegir mes**  
3. **Total pendiente MSI**  
4. **Categorías donde más subí (vs mes anterior)**

**¿Qué significa “pagar en mes X”?**  
Se consideran los estados de cuenta cuyo **pay_date** cae dentro del mes X. Para cada tarjeta, el bot calcula:

- **cut_date** del ciclo correspondiente
- **pay_date** = cut_date + `pay_offset_days` (rodando a lunes si aplica)
- **No MSI**: compras entre `prev_cut_date + 1` y `cut_date`
- **MSI**: suma de `installments` con `billing_month` = mes del `cut_date`

---

## 🧰 Tech Stack

- Node.js + Express
- Telegram Bot API (webhook)
- Google Cloud Run
- BigQuery
- Gemini API (default) + DeepSeek (fallback opcional)

---

## 📦 Requisitos

- Un bot de Telegram (via @BotFather) y su token
- Proyecto en Google Cloud con:
  - Cloud Run
  - BigQuery
- Tabla en BigQuery (schema sugerido más abajo)
- API Key de Gemini (recomendado para enriquecer datos)
- API Key de DeepSeek (opcional, para fallback)

---

## 🔐 Variables de entorno

Configura estas env vars en Cloud Run:

### Obligatorias
- `TELEGRAM_BOT_TOKEN` → token del bot de Telegram
- `BQ_PROJECT_ID` → ID del proyecto GCP
- `BQ_DATASET` → dataset (ej. `gastos`)
- `BQ_TABLE` → tabla principal (ej. `expenses`)
- `DASHBOARD_BASE_URL` → URL base de corte-web (ej. `https://corte-web.example`)
- `LINK_TOKEN_SECRET` → secreto para firmar link tokens de vinculación

### LLM (recomendado)
- `GEMINI_API_KEY` → habilita enriquecimiento con Gemini
- `GEMINI_MODEL` → opcional, default `gemini-3-flash-preview`
- `LLM_PROVIDER` → `gemini` (default) o `local` (sin LLM)
- `LLM_FALLBACK` → `deepseek` para usar DeepSeek si Gemini falla
- `DEEPSEEK_API_KEY` → requerido si `LLM_FALLBACK=deepseek`

### Cron / Cache
- `CRON_TOKEN` → protege `/cron/daily` y `/cron/enrich`
- `CARD_RULES_CACHE_TTL_MS` → TTL del cache de reglas de tarjetas (ms)

### FX
- `FX_BASE_URL` → opcional, default `https://api.frankfurter.dev/v1`

### Tablas extra
- `BQ_ENRICHMENT_RETRY_TABLE` → tabla para reintentos de enriquecimiento (default `enrichment_retry`)

> Nota: para autenticación a BigQuery, Cloud Run debe ejecutar con un Service Account con permisos.  
> Recomendación: `BigQuery Data Editor` en el dataset.

---

## 🗃️ BigQuery: tablas sugeridas

Dataset: `gastos`  
Tabla principal: `expenses`

Campos (sugerido):

- `id` STRING
- `created_at` TIMESTAMP (o STRING ISO)
- `purchase_date` DATE (o STRING `YYYY-MM-DD`)
- `amount_mxn` NUMERIC
- `payment_method` STRING
- `category` STRING
- `merchant` STRING
- `description` STRING
- `raw_text` STRING
- `source` STRING
- `chat_id` STRING
- `is_msi` BOOL
- `msi_months` INT64
- `msi_start_month` DATE
- `msi_total_amount` NUMERIC
- `trip_id` STRING (nullable, para asociar gasto a viaje activo)
- `original_amount` NUMERIC (nullable, reservado para FX)
- `original_currency` STRING (nullable, reservado para FX)
- `fx_rate` NUMERIC (nullable, reservado para FX)
- `fx_provider` STRING (nullable, reservado para FX)
- `fx_date` DATE (nullable, reservado para FX)
- `amount_mxn_source` STRING (nullable, reservado para FX)

Tablas nuevas para viajes:

- `trips` → catálogo de viajes por chat
- `trip_state` → estado append-only del viaje activo por chat

Tablas auxiliares:

- `installments` → agenda de MSI (ver `src/installments_tables.sql`)
- `card_rules` → reglas de corte/pago por tarjeta (para análisis y recordatorios)
- `reminder_log` → evita duplicar recordatorios
- `enrichment_retry` → reintentos de enriquecimiento si falla LLM
- `accounts` → catálogo de cuentas débito/efectivo (ver `docs/diagnostics/create_accounts.sql`)
- `ledger_movements` → movimientos de efectivo (ver `docs/diagnostics/create_ledger_movements.sql`)

---

## 🚀 Deploy en Cloud Run (high level)

1) Conecta el repo a Cloud Run (source deploy)
2) Define env vars (sección arriba)
3) Deploy

La app expone:

- `GET /` → `OK`
- `POST /telegram-webhook` → endpoint para webhook de Telegram
- `GET /cron/daily?token=...` → recordatorios diarios (corte/pago)
- `GET /cron/payment-reminders?token=...` → recordatorios de pago (1 día antes, JSON)
- `GET /cron/enrich?token=...` → reintentos de enriquecimiento LLM (devuelve JSON con summary)

---

## ⏰ Cloud Scheduler (recordatorios de pago)

Configura un job diario en Cloud Scheduler para enviar recordatorios 1 día antes del pago:

- **URL**: `https://<TU_CLOUD_RUN_URL>/cron/payment-reminders?token=<CRON_TOKEN>&limitChats=50`
- **Método**: `GET`
- **Horario sugerido**: 9:00am hora local (CDMX)
- **Servicio**: mismo Cloud Run de `telegram-gastos-bot`
- **Token**: usa el mismo `CRON_TOKEN` que ya existe (no se agrega ninguna variable nueva)

---

## 💱 FX provider: Frankfurter

El módulo de FX expone `getFxRate` para consultar tipo de cambio histórico (UTC) con fallback de hasta 7 días hacia atrás y cache en memoria por proceso.

```js
import { getFxRate } from "./src/fx/index.js";

const fx = await getFxRate({
  date: "2025-01-13",
  base: "JPY",
  quote: "MXN"
});

// { ok: true, date: "2025-01-13", base: "JPY", quote: "MXN", rate: 0.12345, provider: "frankfurter" }
```

## 🧪 Debug de `/cron/enrich`

Puedes pegar el URL directamente en el navegador o `curl` y ver un JSON de resumen:

```json
{
  "ok": true,
  "limit": 50,
  "claimed": 3,
  "processed": 3,
  "done": 2,
  "failed": 1,
  "skipped_not_due": 4,
  "skipped_noop": 0,
  "llm_ms": 1200,
  "bq_ms": 350,
  "total_ms": 1700,
  "provider": "gemini"
}
```

Notas:
- `claimed` = filas “due” tomadas del queue.
- `skipped_not_due` = filas pendientes pero aún no toca procesarlas.
- `skipped_noop` = no había nada por hacer.
- `provider` = `gemini`, `deepseek`, `mixed` o `none`.

### Cola `enrichment_retry` (append-only)

El cron escribe eventos con `INSERT` (sin `UPDATE/DELETE`) para evitar fallos por streaming buffer.
La lectura siempre usa el **último estado por `expense_id`** (ventana + `QUALIFY`), así que el
workflow es:

1) Insert `RUNNING`
2) Insert `SUCCEEDED` o `FAILED` con `next_attempt_at` futuro

Si necesitas depurar, consulta los eventos por `expense_id` y ordena por `updated_at`.

---

## ✅ Tests (smoke)

```bash
npm run smoke
```

---

## 🤖 Configurar el Webhook de Telegram

En Cloud Shell:

```bash
export TG_TOKEN="TU_TOKEN"
export WEBHOOK="https://TU-CLOUD-RUN-URL/telegram-webhook"

curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/deleteWebhook" \
  -H "Content-Type: application/json" \
  -d '{"drop_pending_updates":true}'

curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK\"}"

curl -s "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo"
```

---

## 🔁 Cómo re-enriquecer gastos existentes (backfill)

Para corregir gastos recientes que quedaron con categoría `Other` o con `merchant`/`description` vacíos:

1) Abre `docs/diagnostics/enrichment_backfill.sql` y ajusta:
   - `PROJECT_ID.DATASET`
   - `days_back` (ventana en días a revisar)

2) Ejecuta el SQL en BigQuery (es un one-shot que encola en `enrichment_retry`):

```sql
-- backfill
```

3) Lanza el cron de enriquecimiento para procesar la cola:

```bash
curl -s "https://TU-CLOUD-RUN-URL/cron/enrich?token=TU_CRON_TOKEN"
```

> Nota: el backfill evita duplicados si ya hay eventos `PENDING/PROCESSING` para el mismo `expense_id` + `chat_id`. El `run_id` y un UUID se guardan en `last_error` para trazabilidad sin cambiar el esquema.

---

## 🧪 Desarrollo local rápido

```bash
npm install
npm start
```

Si quieres correr el smoke test:

```bash
npm run smoke
```

---

## 🌐 Dashboard web (read-only)

MVP con Next.js + Tailwind en `web/`.

```bash
npm run web:dev
```

Más detalles y variables de entorno en `web/README.md`.

## ✈️ Migraciones: Trips (viajes)

Ejecuta estas queries en BigQuery Console (en orden):

1. `docs/migrations/001_create_trips.sql`
2. `docs/migrations/002_create_trip_state.sql`
3. `docs/migrations/003_alter_expenses_add_trip_columns.sql`

Notas:
- `trip_state` es append-only (sin UPDATE/DELETE) para evitar problemas con streaming buffer.
- `expenses.trip_id` se llena automáticamente cuando el chat tiene viaje activo; si no hay viaje activo se guarda `NULL`.
- No se requiere backfill de gastos históricos.

Comandos en Telegram:
- `/viaje nuevo [nombre]`
- `/viaje listar`
- `/viaje usar <trip_id>`
- `/viaje actual`
