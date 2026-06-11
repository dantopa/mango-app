# Implementation Plan: BBVA MCP Sync

## Overview

Sync de consumos de tarjetas BBVA Argentina (online.bbva.com.ar) via `browser-token-mcp`. Calca el patrón Bancolombia/Nexo: bookmarklet captura token → Edge provider expone tools → route handler adapta + dedup + inserta en `transactions`. Wave 0 es bloqueante: sin los endpoints reales del banco no se puede escribir el provider. Código en inglés, UI en español. El provider Edge corre en Deno; el resto es Next 16.

## Tasks

- [x] 1. Wave 0 — Discovery (BLOQUEANTE, requiere sesión real del dueño)
  - [x] 1.1 Capturar endpoints de BBVA
    - Con sesión logueada en `online.bbva.com.ar`, DevTools → Network: capturar (a) request de listado de tarjetas, (b) request de consumos de una tarjeta
    - Anotar URL, método, headers de auth, params y response shape
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Identificar el session token
    - Determinar qué campos componen el token (bearer/tsec/cookies/device-id) y cuál es el subconjunto mínimo que autentica las dos requests
    - Validar que entre en el límite de 8192 chars de `/refresh`
    - _Requirements: 1.3, 2.5_

  - [x] 1.3 Documentar en design.md
    - Completar la sección "API real de BBVA" con request/response sanitizados
    - Actualizar los tipos `BbvaToken` / `BbvaCard` / `BbvaTx` si el shape real difiere
    - Guardar 2–3 fixtures de consumos reales (sanitizados) para los tests del adapter
    - _Requirements: 1.4, 1.5_

- [x] 2. Wave 1 — Provider Edge Function (depende de Wave 0)
  - [x] 2.1 Implement `providers/bbva.ts`
    - `ProviderModule` con `name: "bbva"`, tools `bbva_get_cards` y `bbva_get_card_transactions`
    - Helpers `err`/`headers`/`bbvaFetch` calcados de `bancolombia.ts` (timeout 15s, 401/403→expirado, `redactToken`/`sanitizeError`)
    - Read-only
    - _Requirements: 3.1–3.8_

  - [x] 2.2 Registrar el provider
    - `register(bbvaProvider)` en `index.ts`
    - Verificar que `tools/list` lo incluya y que `resolveProvider("bbva_get_cards")` rutee bien
    - `/refresh` ya lo acepta vía `isValidProvider`
    - _Requirements: 2.2, 3.1_

  - [x] 2.3 Bookmarklet BBVA
    - Variante del extractor para `online.bbva.com.ar`: lee los campos del token (1.2), valida presencia (alert español si falta), POSTea a `/refresh` con `provider: "bbva"`
    - _Requirements: 2.1, 2.3, 2.4_

  - [ ] 2.4 Deploy + smoke test del provider
    - Deploy de la Edge Function
    - Pushear token con el bookmarklet → `bbva_get_cards` devuelve las 2 tarjetas; `bbva_get_card_transactions` devuelve consumos
    - Sanitizar y volcar a fixtures (1.3)
    - _Requirements: 3.2, 3.3_

- [x] 3. Wave 2 — Adapter + Route Handler (depende de Wave 1)
  - [x] 3.1 Add `SyncSource |= "sync_bbva"`
    - En `src/lib/sync/types.ts`
    - Sin claves nuevas en `ERROR_MESSAGES`
    - _Requirements: 5.5_

  - [x] 3.2 Implement `src/lib/sync/adapters/bbva.ts`
    - `adaptBbva(rawTxs, accountName)`: filtrar no-consumos, respetar USD en compras internacionales, monto de la cuota del período, extraer `card_last4`
    - Molde: `adapters/nexo.ts`
    - _Requirements: 4.1–4.5_

  - [ ] 3.3 Tests del adapter (con fixtures de 1.3)
    - Unit: ARS simple, USD internacional, cuota, línea PAGO/IMPUESTO excluida, comercio vacío
    - Property: total, montos > 0, `native_currency ∈ {ARS,USD}`, ARS sin `fx_rate_to_usd` precargado
    - _Requirements: 4.2–4.5_

  - [x] 3.4 Implement `src/app/api/sync/bbva/route.ts`
    - Molde `api/sync/nexo/route.ts`: sesión → validar month → `bbva_get_cards` → por tarjeta `bbva_get_card_transactions` + `adaptBbva` + `processCandidates` → `recategorizeMonth` → `{ results }`
    - `maxDuration = 60`
    - Map de errores AUTH_EXPIRED/MCP_ERROR
    - _Requirements: 5.1–5.5_

- [x] 4. Wave 3 — UI (depende de Wave 2)
  - [x] 4.1 Update `use-sync.ts`
    - `sync_bbva → /api/sync/bbva`, POST simple sin cursor (como Bancolombia/Nexo)
    - _Requirements: 6.1_

  - [x] 4.2 Update `sync-dialog.tsx`
    - Fuente "BBVA" en `SOURCES`; mostrar resultados por tarjeta (label por `account_name`: "BBVA Visa"/"BBVA Mastercard")
    - _Requirements: 6.2_

  - [x] 4.3 Crear cuentas en `accounts`
    - Verificar/crear "BBVA Visa" y "BBVA Mastercard" (tipo tarjeta) para el `user_id` del dueño antes del primer sync
    - _Requirements: 6.4_

- [ ] 5. Wave 4 — Verificación
  - [x] 5.1 Suite + tsc + build
    - `npm test`, `npx tsc --noEmit` (gate, no solo vitest), `npm run lint`, `npm run build`

  - [ ] 5.2 E2E manual (design §Testing)
    - Token → cards → sync del mes → comparar montos vs resumen real → verificar FX oficial → re-sync 0 nuevas → expiración → AUTH_EXPIRED
    - _Requirements: 3, 4, 5, 6_

  - [ ] 5.3 Doc
    - README: agregar BBVA al listado de fuentes y al instructivo del bookmarklet
    - Nota de alcance v2 (cuenta ARS / resumen cerrado)
    - _Requirements: 7.1, 7.2_

## Notes

- **No empieces Wave 1 sin Wave 0 cerrada.** Si un endpoint no matchea el supuesto del design, actualizá design.md primero (Req 1.4) — la regla es: el código nunca se desvía del spec en silencio.
- El provider Edge **no es testeable en unit** (depende de shapes reales); el gate de tests es el **adapter**. No inventes fixtures: salen del discovery (1.3).
- BBVA es **ARS**; no toques `fx.ts` (open.er-api ya da ARS oficial). Si el FX de ARS fallara, es problema de configuración de FX, no de este código.
- `tsc --noEmit` es gate obligatorio además de vitest (en la ronda anterior un cast roto pasó vitest pero rompía el typecheck).
- Wave 0 es manual y bloqueante — requiere sesión real del dueño del banco.
- Reutiliza infraestructura existente: `browser-token-mcp` Edge Function, `fx.ts`, `categorizer.ts`, `processCandidates`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4"] },
    { "id": 4, "tasks": ["3.1", "3.2"] },
    { "id": 5, "tasks": ["3.3", "3.4"] },
    { "id": 6, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 7, "tasks": ["5.1", "5.2", "5.3"] }
  ]
}
```
