# Cross-Source Dedup — Design

## Overview

Hoy hay **dos motores de dedup** que no comparten fuente ni criterios. El diseño los colapsa en **uno**: una función `resolveDuplicate()` que decide contra la tabla `transactions` (fuente canónica) usando una **escalera de identidad** con un nivel nuevo cross-currency. Push y sync la invocan ambos.

```
ANTES                                    DESPUÉS
─────                                    ───────
push  → findCrossSourceDuplicate         push  ┐
         (push_ingest_log, amount exacto)       ├→ resolveDuplicate(candidate, userId)
sync  → evaluateCandidate                sync  ┘     └→ contra `transactions` (canónica)
         (transactions, escalera)                       escalera unificada + cross-currency + upgrade
```

`evaluateCandidate` ya tiene la escalera buena (`dedup-sync.ts`): card_last4 → fuzzy → ambiguous → no_match, con `consumptionMap` para multiplicidad. La estrategia es **promover esa lógica a `resolveDuplicate` y hacer que el push la use**, sumándole el nivel cross-currency y la decisión `upgrade`.

## Por qué fallan hoy (raíz)

- **Bug 1 (PERGAMINO):** ambos COP 7500, mismo día, merchant fuzzy-match. La escalera del sync lo resolvería perfecto — pero el push **nunca consulta `transactions`**, solo `push_ingest_log`. Fix = el push corre la misma escalera contra `transactions`.
- **Bug 2 (COYO TAC):** COP 63 400 vs USD 17.70. Ambos motores clavan `amount_native` como clave dura → distinto número → no matchea. Fix = nivel cross-currency con clave **card_last4 + merchant + ventana fina**, y `amount_usd` como corroborador suave (63 400 COP ≈ 17.63 USD ≈ 17.70 USD del banco).

## Cambios de schema (Req 1)

Migración aditiva `add_dedup_signals_to_transactions`:

```sql
alter table public.transactions
  add column if not exists card_last4  text,
  add column if not exists external_ts timestamptz;

comment on column public.transactions.card_last4 is
  'Últimos 4 dígitos de la tarjeta (señal fuerte de dedup cross-source). Poblada por push y sync.';
comment on column public.transactions.external_ts is
  'Timestamp real de la compra/notificación (push: payload.timestamp). NULL si la fuente solo da día. Usado por la ventana fina cross-currency; distinto de created_at (inserción).';

-- backfill best-effort del last4 desde description_raw
update public.transactions
set card_last4 = (regexp_match(description_raw, '[*•]{1,2}(\d{4})'))[1]
where card_last4 is null and description_raw ~ '[*•]{1,2}\d{4}';

create index if not exists idx_tx_dedup
  on public.transactions (user_id, amount_native, tx_date);
create index if not exists idx_tx_dedup_card
  on public.transactions (user_id, card_last4, external_ts);
```

`card_last4` se indexa junto a `external_ts` para el lookup cross-currency (que NO filtra por amount). El índice `(user_id, amount_native, tx_date)` sirve la escalera same-currency.

## La escalera unificada (`resolveDuplicate`)

Orden de evaluación contra las transacciones candidatas (ventana inicial de query: `tx_date` ±1 día y, en paralelo, `card_last4` + `external_ts` ±90 s para cross-currency):

| Nivel | Condición | Veredicto |
|---|---|---|
| 0 | candidato sin merchant + monto+fecha igual (misma moneda) | `discard` (`no_merchant`) — heredado |
| 1 | `card_last4` igual + monto igual (misma moneda) + fecha ±1 día | `discard` (`card_match`) |
| **1c** | `card_last4` igual + merchant `match` + `external_ts` ±90 s + **monedas distintas** + `amount_usd` ±5 % | `discard`/`upgrade` (`cross_currency_card_match`) — **NUEVO, Bug 2** |
| **1c-rev** | igual que 1c pero `amount_usd` fuera de ±5 % | `insert_review` (`cross_currency_amount_drift`) |
| 2 | monto igual (misma moneda) + fecha ±1 día + merchant `match` | `discard`/`upgrade` (`merchant_match`) — Bug 1 |
| 3 | sin last4 común + merchant `match` + ventana fina + `amount_usd` ±2 % | `insert_review` (`cross_currency_no_card`) |
| 4 | monto+fecha igual + merchant `ambiguous` | `insert_review` |
| 5 | monto+fecha igual + merchant `no_match`, sin last4 común | `insert_review` (`same_amount_date_diff_merchant`) |
| 6 | sin coincidencia | `insert` |

`discard` vs `upgrade` lo decide la regla de calidad del Req 5 (ver abajo). La multiplicidad (Req 6) filtra, antes de evaluar, las transacciones ya consumidas.

### Contrato

```ts
// src/lib/sync/dedup-core.ts (nuevo módulo compartido)
export interface DedupCandidate {
  amount_native: number;
  native_currency: string;
  amount_usd: number | null;     // si se conoce al momento de evaluar
  merchant: string | null;
  card_last4: string | null;
  tx_date: string;               // YYYY-MM-DD
  external_ts: string | null;    // ISO; null si la fuente no lo tiene
}

export type DedupDecision =
  | { action: "insert" }
  | { action: "insert_review"; reason: string }
  | { action: "discard"; reason: string; matchedTxId: string }
  | { action: "upgrade"; reason: string; matchedTxId: string };

export interface DedupOpts {
  consumptionMap?: ConsumptionMap;   // multiplicidad (sync batch; push pasa uno persistente)
  fineWindowSec?: number;            // default 90
  usdTolerancePct?: number;          // default 5 (nivel 1c) / 2 (nivel 3)
}

export async function resolveDuplicate(
  candidate: DedupCandidate, userId: string, opts?: DedupOpts
): Promise<DedupDecision>;
```

- `evaluateCandidate` pasa a ser un wrapper delgado que arma el `DedupCandidate` desde `CandidateTransaction` y llama `resolveDuplicate` (mantiene su firma para no tocar `sync-engine.ts` ni sus tests). `amount_usd` puede ir null en sync (se calcula después de FX); en ese caso los niveles que dependen de `amount_usd` no aplican y se cae al match same-currency.
- `findCrossSourceDuplicate` se elimina; el push llama `resolveDuplicate`.

## Integración en el push pipeline (`pipeline.ts`)

El paso 5.5 cambia. Hoy: parsea → inserta en log → classify → `findCrossSourceDuplicate` (log) → FX → insert. Problema adicional: el orden actual hace FX **después** del cross-dedup, así que en el cross-currency no tenemos `amount_usd` del candidato al evaluar. Reordenar:

```
5.  classify (igual)
6.  FX → amount_usd del candidato            ← se adelanta (antes era paso 6 post-dedup)
5.5 resolveDuplicate(candidate{...,amount_usd, card_last4, external_ts=payload.timestamp})
     ├ discard  → marcar log deduped_cross_source(related_transaction_id), return
     ├ upgrade  → UPDATE transactions[matchedTxId] con datos del candidato (mejor info),
     │            marcar log, return  (no inserta fila nueva)
     ├ insert_review → seguir, needs_review=true
     └ insert   → seguir normal
8/9 resolver cuenta + insert (con card_last4, external_ts)  (solo si insert/insert_review)
```

`external_ts` del push = `payload.timestamp` (epoch real de la notificación). `card_last4` ya lo trae el parser. `amount_usd` ya está tras adelantar FX.

> Nota de orden: adelantar FX antes del dedup agrega una llamada FX a candidatos que terminan descartados. Es aceptable (FX está cacheada/es barata y resolvió bien hasta ahora); el beneficio es tener `amount_usd` para el corroborador cross-currency. Alternativa si molesta: calcular `amount_usd` del candidato on-demand solo cuando el nivel 1c lo necesita.

## Regla de calidad / upgrade (Req 5)

```ts
// mayor score = mejor versión
function quality(tx): number {
  let s = 0;
  if (tx.merchant) s += 4;
  if (tx.card_last4) s += 2;
  if (isLocalPosCurrency(tx)) s += 1;   // COP para compra en CO > USD settlement de BBVA
  return s;
}
```

- `isLocalPosCurrency`: heurística — la moneda del POS (la que reporta Google Wallet / Bancolombia, típicamente COP) gana sobre la de settlement de la tarjeta extranjera (USD de BBVA). Implementación pragmática: preferir la moneda que **no** es la de la tarjeta emisora cuando hay dos monedas en conflicto; en la práctica, COP > USD para compras en Colombia. Documentar el supuesto.
- WHEN `quality(candidato) > quality(existente)` → `upgrade` (UPDATE in-place del existente con los campos del candidato; `id` estable). ELSE → `discard`.
- Caso real COYO TAC: si entró primero el USD de BBVA y después llega el COP de Google Wallet (más calidad: moneda local), se hace `upgrade` → la fila queda COP 63 400 con su FX del día. Si entró primero el COP, el USD entrante es peor → `discard`.

## Multiplicidad persistida (Req 6)

- **Sync**: sin cambios, sigue el `consumptionMap` en memoria del batch.
- **Push** (uno por vez, sin batch): al `discard`/`upgrade` contra T, escribir `related_transaction_id = T.id` en el `push_ingest_log` de esa notificación. Antes de evaluar, `resolveDuplicate` excluye las transacciones que ya figuran como `related_transaction_id` de **otra** notificación dentro de la ventana — esas ya fueron "reclamadas" por otra compra-instancia. Así dos compras genuinas de COP 7500 el mismo día (dos notificaciones cada una) no colapsan: la primera notificación de la 2da compra no encuentra T libre y → `insert`.
- La ventana fina (±90 s) es el discriminante principal cross-currency: dos canales de la misma compra llegan en segundos; dos compras humanas iguales rara vez en <90 s.

## Error handling / degradación

| Situación | Comportamiento |
|---|---|
| Candidato sin `card_last4` | salta niveles 1/1c; usa same-currency (Req 4) o `insert_review` |
| Existente sin `external_ts` (sync viejo) | cross-currency (1c) no aplica; cae a same-currency día |
| `amount_usd` desconocido al evaluar | niveles con tolerancia USD no aplican; same-currency sigue |
| Query a `transactions` falla | fail-open → `insert` (no perder gasto), log del error |
| FX falla al adelantarse | mantener `fx_pending` como hoy; el dedup cross-currency se saltea (sin amount_usd) |

## Testing strategy

Vitest. La lógica pura (`resolveDuplicate`, `quality`, fuzzy) se testea aislada con `transactions` mockeada.

### Regresión de los bugs reales (obligatorios)
1. **Bug 1**: sync inserta PERGAMINO COP 7500 (03:42); luego push Google Wallet "PERGAMINO VIVA ENVIGAD" COP 7500 mismo día → `discard` (nivel 2). Neto: 1 transacción.
2. **Bug 2**: push Google Wallet COYO TAC COP 63 400 (23:23:30, *1886) inserta; luego push BBVA COYO TAC USD 17.70 (23:23:33, *1886) → `discard`/`upgrade` (nivel 1c). Neto: 1 transacción, en COP (moneda local gana).
3. **Bug 2 orden inverso**: BBVA USD primero, Google Wallet COP después → `upgrade` (la fila final queda COP). Neto: 1, en COP.

### Multiplicidad
4. Dos compras genuinas COP 7500 mismo día, separadas 3 h, cada una con su push → 2 transacciones (T reclamada no se re-consume).
5. M=2 existentes, N=3 candidatas equivalentes → 1 insert (neto N−M).

### Cross-currency edge
6. card_last4 igual + merchant match + dentro de 90 s + `amount_usd` drift >5 % → `insert_review` (no descartar).
7. merchant match + ventana fina pero **sin** last4 común + USD ±2 % → `insert_review`.
8. monedas distintas pero `external_ts` ausente en un lado → NO cross-currency; cae a same-currency.

### No-regresión
9. Toda la suite actual de `evaluateCandidate` / `fuzzy-matcher` / multiplicidad verde tras el refactor a `resolveDuplicate`.
10. `tsc --noEmit` limpio.
