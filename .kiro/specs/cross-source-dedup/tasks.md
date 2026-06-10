# Cross-Source Dedup — Implementation Plan

Refactor de riesgo medio: toca el camino crítico de dedup de ambos pipelines. Regla de oro: **los tests de regresión de los 3 casos reales (Bug 1, Bug 2, Bug 2 inverso) se escriben ANTES de tocar el push pipeline** y deben pasar al final. `tsc --noEmit` es gate además de vitest.

## Wave 1 — Schema y señales persistidas

- [ ] **1.1 Migración aditiva**
  `card_last4 text` y `external_ts timestamptz` en `transactions` (nullable), índices `(user_id, amount_native, tx_date)` y `(user_id, card_last4, external_ts)`, backfill best-effort de `card_last4` desde `description_raw`. Regenerar `database.types.ts`.
  _Req: 1.2, 1.3, 1.5, 7.3_

- [ ] **1.2 Persistir señales en ambos inserts**
  Push (`pipeline.ts`) y sync (`sync-engine.ts`) setean `card_last4` (ya en `ParsedTransaction`/`CandidateTransaction`) y `external_ts` (push: `payload.timestamp`; sync: null) al insertar.
  _Req: 1.4_

## Wave 2 — Función de decisión compartida (núcleo)

- [ ] **2.1 `src/lib/sync/dedup-core.ts`**
  `DedupCandidate`, `DedupDecision` (con `upgrade`), `DedupOpts`, `resolveDuplicate()`. Implementa la escalera unificada (niveles 0–6 del design), incluyendo **1c cross-currency** (card_last4 + merchant match + `external_ts` ±90 s + `amount_usd` ±5 %) y **1c-rev / nivel 3** → `insert_review`. Función `quality()` para la regla de calidad. Pura salvo la query a `transactions`.
  _Req: 2.1, 3.1–3.4, 5.1_

- [ ] **2.2 Multiplicidad en `resolveDuplicate`**
  Filtrar transacciones ya consumidas: `consumptionMap` (sync) y exclusión por `related_transaction_id` reclamado por otra notificación (push). Neto N−M.
  _Req: 6.1–6.4_

- [ ] **2.3 `evaluateCandidate` → wrapper de `resolveDuplicate`**
  Reescribir `evaluateCandidate` (dedup-sync.ts) para armar `DedupCandidate` y delegar, conservando su firma. Los tests existentes de sync deben seguir verdes sin tocarlos.
  _Req: 2.2, 7.2_

- [ ] **2.4 Tests del núcleo**
  Escala completa + cross-currency edges (drift USD, sin last4, sin external_ts) + multiplicidad. Property: total, determinista, nunca pierde gasto sin marcar.
  _Req: 3.2, 3.3, 6.3, 6.4_

## Wave 3 — Push pipeline usa el núcleo (cierra Bug 1 y Bug 2)

- [ ] **3.1 Tests de regresión de los bugs reales (PRIMERO)**
  Bug 1 (PERGAMINO sync→push), Bug 2 (COYO TAC COP→USD), Bug 2 inverso (USD→COP→upgrade). Con `transactions`/`push_ingest_log` mockeados poblados como el caso real. Deben fallar contra el código actual.
  _Req: 3.1, 4.1, 5.2_

- [ ] **3.2 Reordenar pipeline: FX antes de dedup**
  Mover la conversión FX (paso 6) antes del paso 5.5 para tener `amount_usd` del candidato al evaluar cross-currency. Mantener `fx_pending` si FX falla.
  _Req: 3.2_

- [ ] **3.3 Reemplazar `findCrossSourceDuplicate` por `resolveDuplicate`**
  Push llama `resolveDuplicate(candidate{amount_usd, card_last4, external_ts: payload.timestamp}, userId)` contra `transactions`. Manejar las 4 ramas: `discard` (log + return), `upgrade` (UPDATE in-place de la tx matcheada, log, return), `insert_review` (needs_review=true), `insert` (normal). Eliminar `findCrossSourceDuplicate` de `dedup.ts`.
  _Req: 2.3, 4.1–4.3, 5.2, 5.3_

- [ ] **3.4 `upgrade` in-place**
  UPDATE de `transactions[matchedTxId]` con merchant/amount_native/native_currency/amount_usd/fx_rate/card_last4/source del candidato mejor; `id` estable. Registrar `related_transaction_id` en el log para multiplicidad.
  _Req: 5.2, 5.4, 6.2_

## Wave 4 — Verificación

- [ ] **4.1 Suite + tsc + build**
  `npm test` (incluye 3.1 y toda la regresión de sync), `npx tsc --noEmit`, `npm run lint`, `npm run build`. Los 3 bugs reales verdes; la suite previa sin romper.
  _Req: 7.2, 7.4_

- [ ] **4.2 Validación con datos reales**
  Reproducir el mes del caso: confirmar que tras correr push+sync el neto es 1 transacción por compra (PERGAMINO ×1, COYO TAC ×1 en COP), y que dos compras genuinas iguales siguen apareciendo dos veces.
  _Req: 4.1, 5.4, 6.4_

- [ ] **4.3 Limpieza de los duplicados ya existentes (one-off)**
  Script/migración de saneamiento para los duplicados ya insertados del caso real (mergear/borrar el peor de cada par). Manual y revisado, no automático.
  _Req: 5.4_

## Dependencias

```
Wave 1 (schema) ──▶ Wave 2 (dedup-core) ──▶ Wave 3 (push usa core) ──▶ Wave 4 (verif)
                         │ 2.3 mantiene sync verde
                         └ 3.1 tests de bug ANTES de 3.2/3.3
```

## Notas para el implementador

- **No dupliques la lógica**: el objetivo es UNA escalera (`resolveDuplicate`). Si te encontrás copiando criterios de `evaluateCandidate` al push, parás — el push debe **llamar** al núcleo, no reimplementarlo.
- **`upgrade` es la pieza delicada**: un UPDATE in-place mal hecho puede pisar una transacción buena. Cubrila con los tests de Bug 2 en ambos órdenes antes de confiar.
- **No toques el `dedup_key` por-notificación** (idempotencia de reproceso); es ortogonal.
- **Decisión de moneda ya tomada**: local POS (COP) gana sobre settlement (USD). No reabrir; está en Req 5.1.
- `external_ts` es la clave de que el cross-currency no rompa multiplicidad — sin él, NO se aplica la ventana fina. No la sustituyas por `created_at` (que es inserción, no compra).
