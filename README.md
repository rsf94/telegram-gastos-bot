# Telegram Gastos Bot (Cloud Run + BigQuery + DeepSeek)

Bot de Telegram para registrar gastos por texto (natural) con confirmación antes de guardar.  
Guarda todo en **BigQuery** y usa **DeepSeek** para extraer: monto, método de pago, categoría, fecha, comercio y descripción.

## ✨ Features

- ✅ Envías un gasto por Telegram (texto)
- ✅ El bot lo parsea (IA + fallback)
- ✅ Te muestra un **preview** con **botones**:
  - ✅ Confirmar
  - ❌ Cancelar
- ✅ Guarda el gasto en **BigQuery**
- ✅ Valida métodos de pago y categorías (listas cerradas)
- ✅ Soporta fechas relativas: **hoy / ayer / antier**
- ✅ `Amex` es ambiguo → pide aclaración (American Express vs Amex Aeromexico)

---

## 🧠 Formato de mensaje (ejemplos)

Ejemplos válidos:

- `230 Uber American Express ayer`
- `677.35 Santander taqueria los parados`
- `1200 Amazon Banorte Platino 2026-01-15`
- `85 Starbucks Rappi Card hoy`

Luego confirma con botón ✅ o escribiendo `confirmar`.

---

## 🧰 Tech Stack

- Node.js + Express
- Telegram Bot API (webhook)
- Google Cloud Run
- BigQuery
- DeepSeek API (`deepseek-chat`)

---

## 📦 Requisitos

- Un bot de Telegram (via @BotFather) y su token
- Proyecto en Google Cloud con:
  - Cloud Run
  - BigQuery
- Tabla en BigQuery (schema sugerido más abajo)
- API Key de DeepSeek (opcional, si no, usa fallback naive)

---

## 🔐 Variables de entorno

Configura estas env vars en Cloud Run:

### Obligatorias
- `TELEGRAM_BOT_TOKEN` → token del bot de Telegram
- `BQ_PROJECT_ID` → ID del proyecto GCP
- `BQ_DATASET` → dataset (ej. `gastos`)
- `BQ_TABLE` → tabla (ej. `expenses`)

### Opcional (pero recomendado)
- `DEEPSEEK_API_KEY` → si no está, el bot usa parseo naive (menos inteligente)

> Nota: para autenticación a BigQuery, Cloud Run debe ejecutar con un Service Account con permisos.  
> Recomendación: `BigQuery Data Editor` en el dataset.

---

## 🗃️ Schema sugerido en BigQuery

Dataset: `gastos`  
Tabla: `expenses`

Campos:

- `id` STRING
- `created_at` TIMESTAMP (o STRING ISO)
- `purchase_date` DATE (o STRING `YYYY-MM-DD`)
- `amount_mxn` FLOAT64
- `payment_method` STRING
- `category` STRING
- `merchant` STRING
- `description` STRING
- `raw_text` STRING
- `source` STRING
- `chat_id` STRING

---

## 🚀 Deploy en Cloud Run (high level)

1) Conecta el repo a Cloud Run (source deploy)
2) Define env vars (sección arriba)
3) Deploy

La app expone:

- `GET /` → `OK`
- `POST /telegram-webhook` → endpoint para webhook de Telegram

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
