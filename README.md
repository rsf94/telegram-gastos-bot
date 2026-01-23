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

### LLM (recomendado)
- `GEMINI_API_KEY` → habilita enriquecimiento con Gemini
- `GEMINI_MODEL` → opcional, default `gemini-3-flash-preview`
- `LLM_PROVIDER` → `gemini` (default) o `local` (sin LLM)
- `LLM_FALLBACK` → `deepseek` para usar DeepSeek si Gemini falla
- `DEEPSEEK_API_KEY` → requerido si `LLM_FALLBACK=deepseek`

### Cron / Cache
- `CRON_TOKEN` → protege `/cron/daily` y `/cron/enrich`
- `CARD_RULES_CACHE_TTL_MS` → TTL del cache de reglas de tarjetas (ms)

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

Tablas auxiliares:

- `installments` → agenda de MSI (ver `src/installments_tables.sql`)
- `card_rules` → reglas de corte/pago por tarjeta (para análisis y recordatorios)
- `reminder_log` → evita duplicar recordatorios
- `enrichment_retry` → reintentos de enriquecimiento si falla LLM

---

## 🚀 Deploy en Cloud Run (high level)

1) Conecta el repo a Cloud Run (source deploy)
2) Define env vars (sección arriba)
3) Deploy

La app expone:

- `GET /` → `OK`
- `POST /telegram-webhook` → endpoint para webhook de Telegram
- `GET /cron/daily?token=...` → recordatorios diarios (corte/pago)
- `GET /cron/enrich?token=...` → reintentos de enriquecimiento LLM

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
