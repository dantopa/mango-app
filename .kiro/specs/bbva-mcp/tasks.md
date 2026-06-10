# BBVA MCP Sync — Implementation Plan

Calca el patrón Bancolombia/Nexo. **Wave 0 es bloqueante**: sin los endpoints reales de `online.bbva.com.ar` el provider no se puede escribir. Código en inglés, UI en español. El provider Edge corre en Deno; el resto es Next 16 (leer guías en `node_modules/next/dist/docs/` antes de tocar route handlers).

## Wave 0 — Discovery (BLOQUEANTE, requiere sesión real del dueño)

- [ ] **0.1 Capturar endpoints de BBVA**
  Con sesión logueada en `online.bbva.com.ar`, DevTools → Network: capturar (a) request de listado de tarjetas, (b) request de consumos de una tarjeta. Anotar URL, método, headers de auth, params y response shape.
  _Req: 1.1, 1.2_

- [ ] **0.2 Identificar el session token**
  Determinar qué campos componen el token (bearer/tsec/cookies/device-id) y cuál es el subconjunto mínimo que autentica las dos requests. Validar que entre en el límite de 8192 chars de `/refresh`.
  _Req: 1.3, 2.5_

- [ ] **0.3 Documentar en design.md**
  Completar la sección "API real de BBVA" con request/response sanitizados. Actualizar los tipos `BbvaToken` / `BbvaCard` / `BbvaTx` si el shape real difiere. Guardar 2–3 fixtures de consumos reales (sanitizados) para los tests del adapter.
  _Req: 1.4, 1.5_

## Wave 1 — Provider Edge Function (depende de Wave 0)

- [ ] **1.1 `providers/bbva.ts`**
  `ProviderModule` con `name: "bbva"`, tools `bbva_get_cards` y `bbva_get_card_transactions`. Helpers `err`/`headers`/`bbvaFetch` calcados de `bancolombia.ts` (timeout 15s, 401/403→expirado, `redactToken`/`sanitizeError`). Read-only.
  _Req: 3.1–3.8_

- [ ] **1.2 Registrar el provider**
  `register(bbvaProvider)` en `index.ts`. Verificar que `tools/list` lo incluya y que `resolveProvider("bbva_get_cards")` rutee bien. (`/refresh` ya lo acepta vía `isValidProvider`.)
  _Req: 2.2, 3.1_

- [ ] **1.3 Bookmarklet BBVA**
  Variante del extractor para `online.bbva.com.ar`: lee los campos del token (0.2), valida presencia (alert español si falta), POSTea a `/refresh` con `provider: "bbva"`.
  _Req: 2.1, 2.3, 2.4_

- [ ] **1.4 Deploy + smoke test del provider**
  Deploy de la Edge Function. Pushear token con el bookmarklet → `bbva_get_cards` devuelve las 2 tarjetas; `bbva_get_card_transactions` devuelve consumos. Sanitizar y volcar a fixtures (0.3).
  _Req: 3.2, 3.3_

## Wave 2 — Adapter + Route Handler (depende de Wave 1)

- [ ] **2.1 `SyncSource |= "sync_bbva"`**
  En `src/lib/sync/types.ts`. Sin claves nuevas en `ERROR_MESSAGES`.
  _Req: 5.5_

- [ ] **2.2 `src/lib/sync/adapters/bbva.ts`**
  `adaptBbva(rawTxs, accountName)`: filtrar no-consumos (4.3), respetar USD en compras internacionales (4.4), monto de la cuota del período (4.5), extraer `card_last4`. Molde: `adapters/nexo.ts`.
  _Req: 4.1–4.5_

- [ ] **2.3 Tests del adapter (con fixtures de 0.3)**
  Unit: ARS simple, USD internacional, cuota, línea PAGO/IMPUESTO excluida, comercio vacío. Property: total, montos > 0, `native_currency ∈ {ARS,USD}`, ARS sin `fx_rate_to_usd` precargado.
  _Req: 4.2–4.5_

- [ ] **2.4 `src/app/api/sync/bbva/route.ts`**
  Molde `api/sync/nexo/route.ts`: sesión → validar month → `bbva_get_cards` → por tarjeta `bbva_get_card_transactions` + `adaptBbva` + `processCandidates` → `recategorizeMonth` → `{ results }`. `maxDuration = 60`. Map de errores AUTH_EXPIRED/MCP_ERROR.
  _Req: 5.1–5.5_

## Wave 3 — UI (depende de Wave 2)

- [ ] **3.1 `use-sync.ts`**
  `sync_bbva → /api/sync/bbva`, POST simple sin cursor (como Bancolombia/Nexo).
  _Req: 6.1_

- [ ] **3.2 `sync-dialog.tsx`**
  Fuente "BBVA" en `SOURCES`; mostrar resultados por tarjeta (label por `account_name`: "BBVA Visa"/"BBVA Mastercard").
  _Req: 6.2_

- [ ] **3.3 Crear cuentas en `accounts`**
  Verificar/crear "BBVA Visa" y "BBVA Mastercard" (tipo tarjeta) para el `user_id` del dueño antes del primer sync.
  _Req: 6.4_

## Wave 4 — Verificación

- [ ] **4.1 Suite + tsc + build**
  `npm test`, `npx tsc --noEmit` (gate, no solo vitest), `npm run lint`, `npm run build`.

- [ ] **4.2 E2E manual (design §Testing)**
  Token → cards → sync del mes → comparar montos vs resumen real → verificar FX oficial → re-sync 0 nuevas → expiración → AUTH_EXPIRED.
  _Req: 3, 4, 5, 6_

- [ ] **4.3 Doc**
  README: agregar BBVA al listado de fuentes y al instructivo del bookmarklet. Nota de alcance v2 (cuenta ARS / resumen cerrado).
  _Req: 7.1, 7.2_

## Dependencias

```
Wave 0 (discovery) ──▶ Wave 1 (provider) ──▶ Wave 2 (adapter+route) ──▶ Wave 3 (UI) ──▶ Wave 4 (verif)
   BLOQUEANTE             Deno/Edge              Next                     cliente
```

## Notas para el implementador

- **No empieces Wave 1 sin Wave 0 cerrada.** Si un endpoint no matchea el supuesto del design, actualizá design.md primero (Req 1.4) — la regla es: el código nunca se desvía del spec en silencio.
- El provider Edge **no es testeable en unit** (depende de shapes reales); el gate de tests es el **adapter**. No inventes fixtures: salen del discovery (0.3).
- BBVA es **ARS**; no toques `fx.ts` (open.er-api ya da ARS oficial). Si el FX de ARS fallara, es problema de configuración de FX, no de este código.
- `tsc --noEmit` es gate obligatorio además de vitest (en la ronda anterior un cast roto pasó vitest pero rompía el typecheck).
