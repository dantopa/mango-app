# Cross-Source Dedup — Requirements

## Introduction

Maquinita ingesta el mismo gasto desde múltiples canales:

- **Push pipeline** (`pipeline.ts`): notificaciones en tiempo real (Google Wallet, BBVA Argentina, Bancolombia) → inserta en `transactions` con `source = "push_ingest"`.
- **Sync engine** (`dedup-sync.ts` / `sync-engine.ts`): scraping de APIs (Bancolombia MCP, BBVA MCP) y parsing de Gmail → inserta vía `processCandidates`.

Cada canal puede reportar la **misma compra**. Hay dedup en ambos lados, pero falla en dos escenarios reales. Este spec los corrige unificando la lógica.

### Diagnóstico de raíz (un solo defecto, dos síntomas)

Hay **dos motores de dedup en paralelo** y no comparten ni la fuente de verdad ni los criterios:

| | Push (`findCrossSourceDuplicate`) | Sync (`evaluateCandidate`) |
|---|---|---|
| Fuente que consulta | solo `push_ingest_log` | `transactions` + `push_ingest_log` |
| Clave de match | `amount_native` exacto | card_last4 + fuzzy merchant + ventana fecha ±1 día |
| Cross-currency | no soportado | parcial (amount exacto) |
| Multiplicidad | no | sí (consumptionMap) |

El de sync es el bueno. El de push quedó atrás. **Bug 1** = push no mira `transactions`. **Bug 2** = ambos comparan `amount_native` exacto, que no cruza monedas. La solución es **una sola función de decisión de duplicado**, sobre **una sola fuente de verdad (`transactions`)**, que ambos pipelines invocan.

### Hallazgos de schema (condicionan el diseño)

- `push_ingest_log` **no** guarda `card_last4` ni `tx_date` (solo amount/currency/merchant/created_at). No sirve como fuente canónica de dedup cross-source.
- `transactions` **no** tiene columna `card_last4` ni timestamp de compra (solo `tx_date` día + `created_at` de inserción). El last4 hoy vive embebido en `description_raw` y se extrae por regex (`/[*•]{1,2}(\d{4})\b/`).
- Los parsers push **ya extraen** `card_last4` (`google-wallet.ts` `••NNNN`, `bbva-argentina.ts` y `bancolombia.ts` `*NNNN`) y lo ponen en `ParsedTransaction.card_last4`, pero el pipeline **no lo persiste** en ninguna tabla.
- `created_at` ≈ momento de compra para push (tiempo real), pero para sync = momento del scrape (NO la compra). Por eso una ventana temporal fina solo sirve push-vs-push; push-vs-sync debe caer a granularidad de día (`tx_date`).

### Caso real (los 4 registros)

```
push_ingest_log:
  Google Wallet | 63400 COP | "BOLD SA*COYO TAC"      | 23:23:30   ← *1886
  BBVA Arg      | 17.70 USD | "BOLD SA*COYO TAC"      | 23:23:33   ← *1886  (misma compra, otra moneda)
  Google Wallet |  7500 COP | "PERGAMINO VIVA ENVIGAD"| 23:23:33

transactions (CON los duplicados que no deberían existir):
  sync_bancolombia | "COMPRA EN PERGAMINO VIVA ENVIG" | 7500 COP  | 03:42   ┐ Bug 1
  push_ingest      | "PERGAMINO VIVA ENVIGAD"         | 7500 COP  | 23:23   ┘ (push no miró transactions)
  push_ingest      | "BOLD SA*COYO TAC"               | 63400 COP | 23:23   ┐ Bug 2
  push_ingest      | "BOLD SA*COYO TAC"               | 17.70 USD | 23:23   ┘ (amount_native distinto por moneda)
```

### Principios heredados

- **Under-count**: ante la duda, no insertar / marcar `needs_review`; nunca perder un gasto real en silencio.
- **Multiplicidad**: dos compras genuinas iguales no se colapsan en una.
- **Idempotencia**: re-procesar produce 0 inserciones nuevas.

---

## Requirement 1 — Fuente de verdad única y señales persistidas

**User story:** Como sistema, quiero que el dedup cross-source mire siempre la tabla `transactions` con las señales de identidad disponibles, para que ningún canal sea ciego a lo que insertó otro.

### Acceptance criteria

1.1. El dedup cross-source SHALL resolverse contra `transactions` (fuente canónica), no contra `push_ingest_log` como fuente primaria.

1.2. `transactions` SHALL ganar una columna `card_last4 text` (nullable), poblada en la inserción por **ambos** pipelines (push y sync) cuando el dato exista.

1.3. `transactions` SHALL ganar una columna `external_ts timestamptz` (nullable) = timestamp real de la compra/notificación cuando se conozca (push: `payload.timestamp`; sync: null si la fuente solo da día). Permite la ventana temporal fina del Req 3 sin confundirla con `created_at` (momento de inserción).

1.4. WHEN un pipeline inserta una transacción, THEN SHALL setear `card_last4` y `external_ts` si los tiene; el dedup SHALL degradar con gracia si faltan (fallback a `tx_date` ±1 día y a extraer last4 de `description_raw`).

1.5. La migración SHALL backfillear `card_last4` de las filas existentes vía el regex sobre `description_raw` (best-effort), sin bloquear si no matchea.

---

## Requirement 2 — Función de decisión de duplicado compartida

**User story:** Como mantenedor, quiero una sola función que decida "esto es duplicado de X / es nuevo / revisar", usada por push y por sync, para no tener dos lógicas divergentes.

### Acceptance criteria

2.1. SHALL existir una función `resolveDuplicate(candidate, userId, opts)` que, dado un candidato normalizado (amount_native, native_currency, amount_usd, merchant, card_last4, tx_date, external_ts), devuelva una decisión: `insert` | `discard(reason, matchedTxId)` | `insert_review(reason)` | `upgrade(matchedTxId)` (ver Req 5).

2.2. `evaluateCandidate` (sync) SHALL delegar en `resolveDuplicate` (o ser reemplazada por ella), conservando su comportamiento actual de escalera (card_last4 → fuzzy → ambiguous → no_match) y la multiplicidad por `consumptionMap`.

2.3. El push pipeline SHALL llamar a `resolveDuplicate` en el paso 5.5 (donde hoy llama `findCrossSourceDuplicate`), contra `transactions`. `findCrossSourceDuplicate` queda obsoleta y se elimina.

2.4. La función SHALL ser determinista y auditable: cada decisión lleva `reason` y, si aplica, el `id` de la transacción matcheada, persistido para trazabilidad (`push_ingest_log.related_dedup_key`/`related_transaction_id` o el log del sync).

---

## Requirement 3 — Match cross-currency (Bug 2)

**User story:** Como usuario, quiero que la misma compra notificada en COP (POS) y en USD (tarjeta) se reconozca como una sola.

### Acceptance criteria

3.1. WHEN candidato y transacción existente tienen **el mismo `card_last4`** y **merchant `match`** (fuzzy: igual / prefijo / token containment / Levenshtein≤3) y **proximidad temporal fina** (`external_ts` dentro de ±90 s, ventana del spread de notificaciones), THEN SHALL considerarse duplicado **aunque `amount_native` y `native_currency` difieran**.

3.2. En el caso 3.1, `amount_usd` SHALL usarse como **corroborador suave**, no como clave: si ambos `amount_usd` están dentro de ±5 %, refuerza el match; si difieren más, se degrada a `insert_review` (puede ser FX raro o compras distintas).

3.3. WHEN no hay `card_last4` en común pero sí merchant match + ventana fina + `amount_usd` dentro de ±2 %, THEN SHALL marcarse `insert_review` (no descartar: sin last4 la evidencia no alcanza para perder plata).

3.4. La ventana fina (±90 s) SHALL aplicarse solo cuando **ambos** lados tienen `external_ts`. Si uno no lo tiene (sync sin timestamp de compra), el match cross-currency NO aplica y se cae al match por día/monto del Req 4.

---

## Requirement 4 — Push ve las transacciones de sync (Bug 1)

**User story:** Como usuario, quiero que una push no duplique algo que el sync ya insertó (y viceversa).

### Acceptance criteria

4.1. WHEN llega una push y ya existe en `transactions` (de cualquier `source`) una fila con **misma moneda + monto igual + `tx_date` ±1 día + merchant `match`**, THEN la push SHALL descartarse (escenario PERGAMINO: ambos COP 7500, fuzzy "PERGAMINO VIVA ENVIG" ≈ "PERGAMINO VIVA ENVIGAD").

4.2. El match del Req 4.1 SHALL reutilizar exactamente la escalera de identidad existente del sync (card_last4 → fuzzy merchant → ambiguous/no_match), ahora corriendo también desde el push pipeline contra `transactions`.

4.3. El chequeo de `push_ingest_log` por monto+ventana SHALL dejar de usarse como mecanismo de cross-source dedup (lo reemplaza el match contra `transactions`); `push_ingest_log` queda solo como registro de idempotencia por notificación (el `dedup_key` por minuto sigue evitando reprocesar la misma notificación).

---

## Requirement 5 — Resolución de conflicto: cuál se queda

**User story:** Como usuario, quiero que cuando se detecta un duplicado quede la versión con mejor información.

### Acceptance criteria

5.1. La "calidad" de una versión SHALL ordenarse por: (a) tiene `merchant` no nulo > nulo; (b) tiene `card_last4` > no; (c) **moneda nativa del país de la compra** (ej. COP para una compra en Colombia = monto del POS, ground truth) > moneda de settlement de la tarjeta (ej. USD de BBVA, incluye spread). Desempate: la más reciente.

> Decisión del dueño (confirmada): la moneda local del POS es la preferida porque es el monto real cobrado en el comercio; la conversión a USD la hace el engine con la tasa del día, en vez de tomar el USD ya liquidado por el banco.

5.2. WHEN el candidato entrante es **mejor** que la transacción existente matcheada, THEN el sistema SHALL **actualizar in-place** la transacción existente (merchant, amount_native, native_currency, amount_usd, fx_rate, card_last4, source) en lugar de insertar una nueva — manteniendo el `id` estable (evita romper `push_ingest_log.transaction_id`). Decisión: `upgrade(matchedTxId)`.

5.3. WHEN el candidato entrante es **peor o igual**, THEN SHALL descartarse (`discard`) y la transacción existente queda intacta.

5.4. En todos los casos el resultado neto SHALL ser **una sola** transacción por compra física.

---

## Requirement 6 — Multiplicidad (no romper compras genuinas repetidas)

**User story:** Como usuario, si compré dos veces lo mismo el mismo día, quiero ver los dos gastos.

### Acceptance criteria

6.1. Una transacción existente SHALL poder ser "consumida" como target de dedup **una sola vez**. Si una compra ya fue deduplicada contra la transacción T, una segunda notificación de una compra **distinta** no SHALL deduplicar también contra T.

6.2. Para sync (batch) la multiplicidad SHALL seguir resuelta por el `consumptionMap` existente. Para push (tiempo real, una por vez) la "consumición" SHALL persistirse: al deduplicar/upgradear contra T, registrar el vínculo (`related_transaction_id`) de modo que un match posterior excluya las T ya reclamadas por otra compra-instancia.

6.3. La ventana temporal fina (±90 s) del cross-currency SHALL ser el discriminante natural: dos notificaciones de la **misma** compra llegan con segundos de diferencia; dos compras **genuinas** iguales en el mismo comercio difícilmente caen dentro de 90 s. Fuera de la ventana fina y sin otra evidencia → `insert` (no colapsar).

6.4. WHEN existen M transacciones equivalentes y llegan N candidatas equivalentes, THEN el neto SHALL ser exactamente max(0, N−M) inserciones (ni duplica ni pierde la repetida).

---

## Requirement 7 — Compatibilidad y no-regresión

7.1. El `dedup_key` por-notificación (hash minuto-truncado) del push SHALL mantenerse para idempotencia de reprocesamiento; este spec NO lo toca.

7.2. Los tests existentes de `evaluateCandidate`, `fuzzy-matcher` y multiplicidad SHALL seguir verdes tras la refactorización a `resolveDuplicate`.

7.3. La migración de schema SHALL ser aditiva (columnas nullable + backfill best-effort), sin romper inserts existentes.

7.4. `tsc --noEmit` SHALL ser gate además de la suite de tests.
