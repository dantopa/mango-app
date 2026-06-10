# Implementation Plan: Gmail Expense Sync

## Overview

Implementación de Gmail como tercera familia de fuentes del sync engine existente. La capa de adquisición (OAuth + Gmail API + parsers de email) emite `CandidateTransaction[]` hacia `processCandidates()`, reutilizando dedup, FX, clasificación, categorización e insert. Convenciones: código en inglés, UI en español. Antes de escribir route handlers, leer las guías de Next 16 en `node_modules/next/dist/docs/` (AGENTS.md — hay breaking changes vs. el conocimiento previo). Cada wave depende de la anterior; las tareas dentro de una wave son paralelizables.

## Tasks

- [x] 1. Setup y fundaciones (Wave 0)
  - [x] 1.1 Google Cloud setup (manual, fuera del repo)
    - Crear proyecto en Google Cloud Console → habilitar Gmail API → OAuth client (Web application) con redirect URI `https://<app>.vercel.app/api/gmail/callback` (+ `http://localhost:3000/api/gmail/callback` para dev). Configurar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` en Vercel y `.env.local`. App en modo "Testing" con el Gmail del owner como test user alcanza (single-user).
    - _Requirements: 1.1_

  - [x] 1.2 Migración `20260101000009_gmail_vault_rpc.sql`
    - RPCs `vault_upsert_secret` / `vault_get_secret` (SECURITY DEFINER, revoke a anon/authenticated, grant a service_role) según design §5. Incluir en la misma migración el seed de `transfer_classification_rules`: pattern `PALOMMA`, `match_type: 'ilike'`, `list_type: 'allowlist'`, description "Pago de arriendo vía Palomma — la transferencia Bancolombia es el mismo gasto".
    - _Requirements: 1.6, 5.4_

  - [x] 1.3 Capturar fixtures reales
    - Guardar en `src/lib/sync/gmail/__fixtures__/` los bodies sanitizados (montos/cuentas/llaves ficticias, estructura intacta): 6 variantes Bancolombia + 2 descartes, 1 RappiCard resumen de transacción + 1 extracto, 1 Palomma aprobado. Confirmar el formato exacto del campo "Fecha de la transacción" de RappiCard con un email real y documentarlo en el fixture.
    - _Requirements: 3.x, 4.1, 5.1_

- [x] 2. Capa Gmail — auth + cliente (Wave 1)
  - [x] 2.1 `src/lib/sync/gmail/types.ts`
    - `GmailSourceId`, `GmailSourceDef`, `ParsedEmail`, `GmailSyncCursor`, `GmailSyncResponse` (design §4). Extender `SyncSource` y `SyncErrorCode` en `src/lib/sync/types.ts` y agregar mensajes a `ERROR_MESSAGES` (`GMAIL_AUTH_REQUIRED`, `GMAIL_API_ERROR`, en español).
    - _Requirements: 7.2, 8.5_

  - [x] 2.2 `src/lib/sync/gmail/token-store.ts`
    - `storeRefreshToken(token)` / `getRefreshToken()` vía `supabase.rpc("vault_upsert_secret"|"vault_get_secret")` con admin client. Nunca loguear el valor.
    - _Requirements: 1.2, 1.6_

  - [x] 2.3 `src/lib/sync/gmail/client.ts`
    - `refreshAccessToken()` (mapear `invalid_grant` → error tipado `GmailAuthError`), `listMessageIds(q, pageToken?)` con paginación, `getMessage(id)` → `ParsedEmail` (base64url decode; preferir parte text/plain, fallback `html-to-text`). Timeout 10s + 1 retry con backoff en 429/5xx (patrón de `mcp-client.ts`).
    - _Requirements: 1.3, 1.4, 2.1, 2.3_

  - [x] 2.4 `src/lib/sync/gmail/html-to-text.ts`
    - Strip de tags/estilos/comentarios, decode de entidades comunes (`&aacute;` etc.), colapso de whitespace. Puro, sin dependencias nuevas.
    - _Requirements: 4.3_

  - [x] 2.5 OAuth route handlers
    - `/api/gmail/auth` (sesión requerida, state→cookie httpOnly, redirect a Google con scope `gmail.readonly`, `access_type=offline`, `prompt=consent`), `/api/gmail/callback` (validar state, intercambiar code, guardar en Vault, redirect `/?gmail=connected`), `/api/gmail/status` (GET → `{ connected }` consultando Vault).
    - _Requirements: 1.1, 1.2, 1.5, 8.4_

- [x] 3. Parsers (Wave 2 — dependen de 1.3 y 2.1)
  - [x] 3.1 `src/lib/sync/gmail/money.ts`
    - Extraer `parseCopAmount` y `normalizeDate` desde `src/lib/push-ingest/parsers/bancolombia.ts` a este módulo compartido; el parser push pasa a importarlos (sin cambio de comportamiento — los tests existentes deben seguir verdes).
    - _Requirements: 3.6_

  - [x] 3.2 Parser Bancolombia (`sources/bancolombia.ts`)
    - `buildQuery(month)` = `from:(an.notificacionesbancolombia.com) after:... before:...`. Parser sobre `bodyText`: extraer la oración transaccional; regex por variante (compra/pago/QR/Bre-b/transferencia); skip ingresos y no-transaccionales devolviendo `[]`. Tests con los fixtures de 1.3, una aserción por variante.
    - _Requirements: 2.2, 2.4, 3.1–3.8_

  - [x] 3.3 Parser RappiCard (`sources/rappicard.ts`)
    - Query con subject "Resumen de transacción". Extraer Monto/Comercio/Fecha del texto plano derivado del HTML; fallback de fecha: header `internalDate` en zona `America/Bogota`. Skip extracto/marketing. Tests con fixtures.
    - _Requirements: 2.2, 4.1–4.4_

  - [x] 3.4 Parser Arriendo (`sources/arriendo.ts`)
    - Query con subject "Confirmación de Pago". Solo Estado "Aprobado" → 1 candidato (`merchant: "Arriendo"`, `expense_type: "fixed"`, description = descripción + N. referencia). Tests con fixtures.
    - _Requirements: 2.2, 5.1–5.3_

  - [x] 3.5 Registry (`sources/index.ts`)
    - `GMAIL_SOURCES: GmailSourceDef[]` en orden de ejecución arriendo → rappicard → bancolombia (razón documentada: dedup del pago Palomma, design §6).
    - _Requirements: 5.4, 7.4_

  - [x] 3.6 Property tests de parsers
    - Las propiedades 1–4 del design §11: parsers totales (no lanzan, nunca emiten monto ≤ 0/NaN), round-trip de montos CO, normalización de fechas, determinismo del dedup_key.
    - _Requirements: 3.6, 3.7, 6.1_

- [x] 4. Orquestador + engine (Wave 3 — depende de Wave 2)
  - [x] 4.1 `expense_type` opcional en el engine
    - `CandidateTransaction.expense_type?: "fixed" | "variable"` (default `"variable"`) y que `sync-engine.ts` lo use en el insert. Único cambio de comportamiento al engine; verificar que los sources existentes (bancolombia/nexo adapters) no se ven afectados.
    - _Requirements: 5.3_

  - [x] 4.2 Idempotencia (`orchestrator.ts`, parte 1)
    - `gmailDedupKey(messageId)`, filtro batch de procesados (`select dedup_key from push_ingest_log where dedup_key in (...)`, chunks de 200), y escritura post-proceso de cada email (`package_name: "gmail.<source>"`, status `registered`/`duplicate`/`no_parser`/`transfer` + `error_message` con el motivo de descarte).
    - _Requirements: 6.1–6.5_

  - [x] 4.3 Orquestador (`orchestrator.ts`, parte 2)
    - `runGmailSource(sourceDef, month, userId, budget)` y `runGmailMonth(month, sources, cursor, budgetMs)`: list → filter → chunks de 20 gets → `parse` → `processCandidates` por sub-fuente → resultado `SyncSourceResult` con cursor de reanudación al agotar presupuesto. Aislamiento de fallas por email y por sub-fuente (design §9).
    - _Requirements: 7.1, 7.3–7.5, 8.2_

  - [x] 4.4 Marcado de cierre mensual
    - Al completar sub-fuente sin errores: update `monthly_close_items` (`item_type='gmail_auto'`, `source ilike closeItemSource`, join a `monthly_close` por `period = month`) → `status='cargado'`, `loaded_at=now()`. Silencioso si no existe.
    - _Requirements: 9.1, 9.2_

  - [x] 4.5 Test de idempotencia end-to-end
    - Propiedad 5 del design §11: misma lista de emails dos veces (Supabase mockeado) → segunda corrida inserta 0. Incluir caso del choque Palomma/Bancolombia verificando `insert_review` + `is_payment`.
    - _Requirements: 5.4, 6.2, 7.3_

- [x] 5. API + UI (Wave 4 — depende de Wave 3)
  - [x] 5.1 `POST /api/sync/gmail`
    - Esqueleto de `/api/sync/bancolombia/route.ts`: sesión Supabase → validar `month` → `runGmailMonth` con presupuesto ~20s → `{ results, next }`. Mapeo de errores a `GMAIL_AUTH_REQUIRED` (401) / `GMAIL_API_ERROR` (502).
    - _Requirements: 8.1, 8.2, 8.5_

  - [x] 5.2 `use-sync.ts`: fuente gmail con loop de cursor
    - Entrada `sync_gmail` en el flujo del hook: POST en loop mientras `next !== null`, merge de resultados parciales por `source` en `progress.completed`. Invalidation de queries sin cambios.
    - _Requirements: 8.2, 8.3_

  - [x] 5.3 `sync-dialog.tsx`: checkbox Gmail + sub-resultados + CTA
    - Fuente "Gmail" en `SOURCES`; al abrir, `GET /api/gmail/status` → si no conectado, botón "Conectar Gmail" (redirect a `/api/gmail/auth`) en lugar del checkbox; resultados por sub-fuente con labels "Gmail · Bancolombia/RappiCard/Arriendo". Textos en español.
    - _Requirements: 8.3, 8.4_

- [x] 6. Cron (Wave 5 — depende de Wave 3; paralelizable con Wave 4)
  - [x] 6.1 Extender `/api/sync/cron`
    - Paso Gmail tras Bancolombia/Nexo: loop server-side del cursor hasta `next: null`; si `now.getDate() <= 5`, correr también el mes anterior. Errores al array `errors` existente sin abortar.
    - _Requirements: 9.3, 9.4_

  - [x] 6.2 `vercel.json` crons
    - Verificar/crear schedule (sugerido: diario 09:00 UTC = 04:00 Bogotá) apuntando a `/api/sync/cron`. Documentar `SYNC_CRON_SECRET` en README.
    - _Requirements: 9.3_

- [x] 7. Hardening y verificación (Wave 6)
  - [x] 7.1 Suite completa + lint + build
    - `npm test` (incluye los tests pre-existentes de push-ingest, que deben seguir verdes tras 3.1 y 4.1), `npm run lint`, `npm run build`.

  - [x] 7.2 E2E manual (checklist del design §11)
    - Conectar Gmail real → sync del mes corriente → validar conteos contra el inbox → re-sync = 0 nuevas → revocar en Google y verificar CTA de reconexión → verificar ítems `gmail_auto` del cierre marcados `cargado`.
    - _Requirements: 1.4, 6.2, 9.1_

  - [x] 7.3 Documentación
    - Sección en README: setup de Google Cloud, env vars, cómo agregar una fuente Gmail nueva (un archivo en `sources/` + entrada en registry), y la nota de alcance BBVA v2 (design §2).
    - _Requirements: 10.1, 10.2_

- [x] 8. Dedup hardening (Wave 7 — bloqueante antes de prender Google Wallet push en `full_pipeline`)
  - [x] 8.1 `card_last4` en candidatas y parsers
    - `CandidateTransaction.card_last4?: string | null`; extracción en parsers Gmail (bancolombia `*NNNN`, rappicard `Método de pago *NNNN`) y en `google-wallet.ts` (`••NNNN`). Los adapters existentes (bancolombia API, nexo) lo dejan `undefined`.
    - _Requirements: 7.7_

  - [x] 8.2 Token containment en `fuzzy-matcher.ts`
    - En `compareMerchants`, entre el check de prefijo y Levenshtein: tokens(corto) ⊆ tokens(largo) → `match`. Tests con casos reales ("DIDI"/"DLO Didi", "MULTIPLEX"/"MULTIPLEX VIVA ENVIG") + propiedad de conmutatividad.
    - _Requirements: 7.8_

  - [x] 8.3 Escalera en `dedup-sync.ts`
    - Ventana `tx_date` ±1 día en la query a `transactions`; nivel 1 por `card_last4` (regex `/[*•]{1,2}(\d{4})\b/` sobre `description_raw` existente); acotar el paso 2 de `push_ingest_log` a `created_at` ±1 día (o eliminarlo); razón del veredicto en todo `DedupDecision`.
    - _Requirements: 7.6, 7.7, 7.10, 7.11_

  - [x] 8.4 Multiplicidad
    - Contexto de consumo por run: `processCandidates` pasa a `evaluateCandidate` cuántas candidatas equivalentes ya consumieron cada transacción existente. Test: batch con 2 candidatas idénticas + 1 existente → 1 discard + 1 insert.
    - _Requirements: 7.9_

  - [x] 8.5 Fix timezone en `google-wallet.ts`
    - `tx_date` en `America/Bogota` (UTC−5 fijo, reusar el patrón de `internalDateToLocal` de rappicard). Test: timestamp 01:30 UTC → fecha del día anterior local.
    - _Requirements: 7.12_

  - [x] 8.6 Tests de regresión integrados
    - (a) wallet push registrado 20:30 Bogotá + email Bancolombia del mismo gasto → 0 inserciones nuevas; (b) mismo monto+fecha con merchants divergentes pero last4 común → discard nivel 1; (c) propiedades 7–10 del design §11.
    - _Requirements: 7.6–7.12_

- [x] 9. Ajustes menores de la revisión v1 (Wave 8 — no bloqueantes)
  - [x] 9.1 Fix status en `logProcessedEmail`
    - Usar status `duplicate` cuando `engineResult.inserted === 0 && duplicates > 0` (hoy marca `registered` aunque el engine haya descartado) — mejora auditoría.

  - [x] 9.2 Close item de Arriendo con `requiresResults`
    - No marcar `cargado` con `found === 0` (se espera exactamente 1 email/mes; para Bancolombia 0 es válido). Sugerencia: flag `requiresResults` en `GmailSourceDef`.

  - [x] 9.3 `export const maxDuration` en rutas
    - `300` en `/api/sync/cron` (loop de cursor N×20s), `60` en `/api/sync/gmail` (budget 20s + AI hasta 8s extra).

  - [x] 9.4 Prioridad de reglas AI
    - Las auto-creadas por `ai-categorizer` usan `priority: 10` y superan a las manuales con default `0` — invertir (AI por debajo) para que una corrección humana siempre gane.

  - [x] 9.5 Cap de AI en sync
    - Timeout de `categorizeWithAi` a 4s y/o tope de llamadas por corrida, para no exceder el presupuesto medido por mensaje.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Fuentes se procesan en orden arriendo → rappicard → bancolombia para dedup cross-fuente correcto
- Waves dentro de cada grupo son paralelizables; las dependencias entre grupos son secuenciales
- Wave 7 (task group 8) es bloqueante antes de prender Google Wallet push en `full_pipeline`
- Wave 8 (task group 9) es independiente y puede ejecutarse en cualquier momento

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3", "4.4", "4.5"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3", "6.1", "6.2"] },
    { "id": 5, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 6, "tasks": ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5"] }
  ]
}
```
