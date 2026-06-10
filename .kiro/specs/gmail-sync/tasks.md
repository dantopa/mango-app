# Gmail Expense Sync — Implementation Plan

Convenciones: código en inglés, UI en español. Antes de escribir route handlers, leer las guías de Next 16 en `node_modules/next/dist/docs/` (AGENTS.md — hay breaking changes vs. el conocimiento previo). Cada wave depende de la anterior; las tareas dentro de una wave son paralelizables.

## Wave 0 — Setup y fundaciones

- [x] **0.1 Google Cloud setup (manual, fuera del repo)**
  Crear proyecto en Google Cloud Console → habilitar Gmail API → OAuth client (Web application) con redirect URI `https://<app>.vercel.app/api/gmail/callback` (+ `http://localhost:3000/api/gmail/callback` para dev). Configurar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` en Vercel y `.env.local`. App en modo "Testing" con el Gmail del owner como test user alcanza (single-user).
  _Req: 1.1_

- [x] **0.2 Migración `20260101000009_gmail_vault_rpc.sql`**
  RPCs `vault_upsert_secret` / `vault_get_secret` (SECURITY DEFINER, revoke a anon/authenticated, grant a service_role) según design §5. Incluir en la misma migración el seed de `transfer_classification_rules`: pattern `PALOMMA`, `match_type: 'ilike'`, `list_type: 'allowlist'`, description "Pago de arriendo vía Palomma — la transferencia Bancolombia es el mismo gasto".
  _Req: 1.6, 5.4_

- [x] **0.3 Capturar fixtures reales**
  Guardar en `src/lib/sync/gmail/__fixtures__/` los bodies sanitizados (montos/cuentas/llaves ficticias, estructura intacta): 6 variantes Bancolombia + 2 descartes, 1 RappiCard resumen de transacción + 1 extracto, 1 Palomma aprobado. **Confirmar el formato exacto del campo "Fecha de la transacción" de RappiCard** con un email real (pendiente del diseño, §2) y documentarlo en el fixture.
  _Req: 3.x, 4.1, 5.1_

## Wave 1 — Capa Gmail (auth + cliente)

- [x] **1.1 `src/lib/sync/gmail/types.ts`**
  `GmailSourceId`, `GmailSourceDef`, `ParsedEmail`, `GmailSyncCursor`, `GmailSyncResponse` (design §4). Extender `SyncSource` y `SyncErrorCode` en `src/lib/sync/types.ts` y agregar mensajes a `ERROR_MESSAGES` (`GMAIL_AUTH_REQUIRED`, `GMAIL_API_ERROR`, en español).
  _Req: 7.2, 8.5_

- [x] **1.2 `src/lib/sync/gmail/token-store.ts`**
  `storeRefreshToken(token)` / `getRefreshToken()` vía `supabase.rpc("vault_upsert_secret"|"vault_get_secret")` con admin client. Nunca loguear el valor.
  _Req: 1.2, 1.6_

- [x] **1.3 `src/lib/sync/gmail/client.ts`**
  `refreshAccessToken()` (mapear `invalid_grant` → error tipado `GmailAuthError`), `listMessageIds(q, pageToken?)` con paginación, `getMessage(id)` → `ParsedEmail` (base64url decode; preferir parte text/plain, fallback `html-to-text`). Timeout 10s + 1 retry con backoff en 429/5xx (patrón de `mcp-client.ts`).
  _Req: 1.3, 1.4, 2.1, 2.3_

- [x] **1.4 `src/lib/sync/gmail/html-to-text.ts`**
  Strip de tags/estilos/comentarios, decode de entidades comunes (`&aacute;` etc.), colapso de whitespace. Puro, sin dependencias nuevas.
  _Req: 4.3_

- [x] **1.5 OAuth route handlers**
  `/api/gmail/auth` (sesión requerida, state→cookie httpOnly, redirect a Google con scope `gmail.readonly`, `access_type=offline`, `prompt=consent`), `/api/gmail/callback` (validar state, intercambiar code, guardar en Vault, redirect `/?gmail=connected`), `/api/gmail/status` (GET → `{ connected }` consultando Vault).
  _Req: 1.1, 1.2, 1.5, 8.4_

## Wave 2 — Parsers (dependen de 0.3 y 1.1)

- [x] **2.1 `src/lib/sync/gmail/money.ts`**
  Extraer `parseCopAmount` y `normalizeDate` desde `src/lib/push-ingest/parsers/bancolombia.ts` a este módulo compartido; el parser push pasa a importarlos (sin cambio de comportamiento — los tests existentes deben seguir verdes).
  _Req: 3.6_

- [x] **2.2 Parser Bancolombia (`sources/bancolombia.ts`)**
  `buildQuery(month)` = `from:(an.notificacionesbancolombia.com) after:... before:...`. Parser sobre `bodyText`: extraer la oración transaccional ("Bancolombia: ..." / "Notificación Transaccional ..."); regex por variante (compra/pago/QR/Bre-b/transferencia); skip ingresos y no-transaccionales devolviendo `[]`. Tests con los fixtures de 0.3, una aserción por variante.
  _Req: 2.2, 2.4, 3.1–3.8_

- [x] **2.3 Parser RappiCard (`sources/rappicard.ts`)**
  Query con subject "Resumen de transacción". Extraer Monto/Comercio/Fecha del texto plano derivado del HTML; fallback de fecha: header `internalDate` en zona `America/Bogota`. Skip extracto/marketing. Tests con fixtures.
  _Req: 2.2, 4.1–4.4_

- [x] **2.4 Parser Arriendo (`sources/arriendo.ts`)**
  Query con subject "Confirmación de Pago". Solo Estado "Aprobado" → 1 candidato (`merchant: "Arriendo"`, `expense_type: "fixed"`, description = descripción + N. referencia). Tests con fixtures.
  _Req: 2.2, 5.1–5.3_

- [x] **2.5 Registry (`sources/index.ts`)**
  `GMAIL_SOURCES: GmailSourceDef[]` en orden de ejecución **arriendo → rappicard → bancolombia** (razón documentada: dedup del pago Palomma, design §6).
  _Req: 5.4, 7.4_

- [x] **2.6 Property tests de parsers**
  Las propiedades 1–4 del design §11: parsers totales (no lanzan, nunca emiten monto ≤ 0/NaN), round-trip de montos CO, normalización de fechas, determinismo del dedup_key.
  _Req: 3.6, 3.7, 6.1_

## Wave 3 — Orquestador + engine (depende de Wave 2)

- [x] **3.1 `expense_type` opcional en el engine**
  `CandidateTransaction.expense_type?: "fixed" | "variable"` (default `"variable"`) y que `sync-engine.ts` lo use en el insert. Único cambio de comportamiento al engine; verificar que los sources existentes (bancolombia/nexo adapters) no se ven afectados.
  _Req: 5.3_

- [x] **3.2 Idempotencia (`orchestrator.ts`, parte 1)**
  `gmailDedupKey(messageId)`, filtro batch de procesados (`select dedup_key from push_ingest_log where dedup_key in (...)`, chunks de 200), y escritura post-proceso de cada email (`package_name: "gmail.<source>"`, status `registered`/`duplicate`/`no_parser`/`transfer` + `error_message` con el motivo de descarte).
  _Req: 6.1–6.5_

- [x] **3.3 Orquestador (`orchestrator.ts`, parte 2)**
  `runGmailSource(sourceDef, month, userId, budget)` y `runGmailMonth(month, sources, cursor, budgetMs)`: list → filter → chunks de 20 gets → `parse` → `processCandidates` por sub-fuente → resultado `SyncSourceResult` con cursor de reanudación al agotar presupuesto. Aislamiento de fallas por email y por sub-fuente (design §9).
  _Req: 7.1, 7.3–7.5, 8.2_

- [x] **3.4 Marcado de cierre mensual**
  Al completar sub-fuente sin errores: update `monthly_close_items` (`item_type='gmail_auto'`, `source ilike closeItemSource`, join a `monthly_close` por `period = month`) → `status='cargado'`, `loaded_at=now()`. Silencioso si no existe.
  _Req: 9.1, 9.2_

- [x] **3.5 Test de idempotencia end-to-end**
  Propiedad 5 del design §11: misma lista de emails dos veces (Supabase mockeado) → segunda corrida inserta 0. Incluir caso del choque Palomma/Bancolombia verificando `insert_review` + `is_payment`.
  _Req: 5.4, 6.2, 7.3_

## Wave 4 — API + UI (depende de Wave 3)

- [x] **4.1 `POST /api/sync/gmail`**
  Esqueleto de `/api/sync/bancolombia/route.ts`: sesión Supabase → validar `month` → `runGmailMonth` con presupuesto ~20s → `{ results, next }`. Mapeo de errores a `GMAIL_AUTH_REQUIRED` (401) / `GMAIL_API_ERROR` (502).
  _Req: 8.1, 8.2, 8.5_

- [x] **4.2 `use-sync.ts`: fuente gmail con loop de cursor**
  Entrada `sync_gmail` en el flujo del hook: POST en loop mientras `next !== null`, merge de resultados parciales por `source` en `progress.completed`. Invalidation de queries sin cambios.
  _Req: 8.2, 8.3_

- [x] **4.3 `sync-dialog.tsx`: checkbox Gmail + sub-resultados + CTA**
  Fuente "Gmail" en `SOURCES`; al abrir, `GET /api/gmail/status` → si no conectado, botón "Conectar Gmail" (redirect a `/api/gmail/auth`) en lugar del checkbox; resultados por sub-fuente con labels "Gmail · Bancolombia/RappiCard/Arriendo". Textos en español.
  _Req: 8.3, 8.4_

## Wave 5 — Cron (depende de Wave 3; paralelizable con Wave 4)

- [x] **5.1 Extender `/api/sync/cron`**
  Paso Gmail tras Bancolombia/Nexo: loop server-side del cursor hasta `next: null`; si `now.getDate() <= 5`, correr también el mes anterior. Errores al array `errors` existente sin abortar.
  _Req: 9.3, 9.4_

- [x] **5.2 `vercel.json` crons**
  Verificar/crear schedule (sugerido: diario 09:00 UTC = 04:00 Bogotá) apuntando a `/api/sync/cron`. Documentar `SYNC_CRON_SECRET` en README.
  _Req: 9.3_

## Wave 6 — Hardening y verificación

- [x] **6.1 Suite completa + lint + build**
  `npm test` (incluye los tests pre-existentes de push-ingest, que deben seguir verdes tras 2.1 y 3.1), `npm run lint`, `npm run build`.

- [x] **6.2 E2E manual (checklist del design §11)**
  Conectar Gmail real → sync del mes corriente → validar conteos contra el inbox → re-sync = 0 nuevas → revocar en Google y verificar CTA de reconexión → verificar ítems `gmail_auto` del cierre marcados `cargado`.
  _Req: 1.4, 6.2, 9.1_

- [x] **6.3 Documentación**
  Sección en README: setup de Google Cloud, env vars, cómo agregar una fuente Gmail nueva (un archivo en `sources/` + entrada en registry), y la nota de alcance BBVA v2 (design §2).
  _Req: 10.1, 10.2_

## Dependencias resumidas

```
Wave 0 ──▶ Wave 1 ──▶ Wave 2 ──▶ Wave 3 ──▶ Wave 4 ──▶ Wave 6
  (0.3 ─────────────▶ 2.x)         └──────▶ Wave 5 ──▶ Wave 6
```
