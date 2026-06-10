# Addendum: Dedup cross-fuente robusto (Gmail vs Google Wallet push)

> Addendum al spec `gmail-sync` (movido a `.kiro/specs/gmail-sync/` local). Este documento cubre **lo único que quedó pendiente** tras la implementación de la v1: endurecer el dedup para cuando las push notifications de Google Wallet (y Bancolombia) corran en `full_pipeline` y el sync de Gmail re-lea el mismo mes después.
>
> Estado al momento de escribir: `dedup-sync.ts` y `fuzzy-matcher.ts` sin cambios respecto del diseño original; los agujeros de abajo están abiertos.

## El problema

El mismo gasto puede llegar por 2–3 canales: wallet push (tiempo real) + push Bancolombia + email Bancolombia, o wallet push + email RappiCard. Nada garantiza que monto/fecha/merchant coincidan textualmente entre canales. La resolución debe ser **determinista** (escalera de claves de identidad), no probabilística.

## Agujeros verificados contra el código y datos reales

1. **Día corrido por timezone** — `src/lib/push-ingest/parsers/google-wallet.ts:71` deriva `tx_date` de `new Date()` del servidor (**UTC en Vercel**); el email trae la fecha local Bogotá en el texto. Compra 20:00 Bogotá → push la registra con fecha del día siguiente → `eq(tx_date)` no matchea → **doble inserción silenciosa**. Afecta toda compra nocturna (~19:00–24:00 local).
2. **Fuzzy limitado a prefijo + Levenshtein ≤3** — "DLO Didi" vs "DIDI" → `no_match` → ruido de `insert_review`. (Sí cubre: "PERGAMINO VIVA ENVIG" vs "PERGAMINO VIVA ENVIGAD" por prefijo; "BOLD SA*COYO TAC" vs "BOLD SA COYO TAC" porque la normalización quita `*`.)
3. **Compras repetidas legítimas** — datos reales del 31/05: dos compras de $9.500 en PQUE ECOLOGICO el mismo día. El dedup actual descarta la segunda del email contra la primera del push → **under-count silencioso**.
4. **Paso 2 demasiado agresivo** — el check contra `push_ingest_log` matchea monto-solo en todo el mes (`dedup-sync.ts:76-88`): un push de $7.500 el día 9 descarta un gasto distinto de $7.500 el día 20.

## Requirements (extienden el Req 7 del spec)

7.6. WHEN se evalúa una candidata contra `transactions`, THEN la búsqueda SHALL usar ventana de fecha **±1 día** (no igualdad exacta), por el corrimiento UTC/Bogotá.

7.7. Los parsers (Gmail y push) SHALL extraer `card_last4` cuando esté presente (email Bancolombia `*5685`, email RappiCard `*3679`, wallet push `••5685`). WHEN candidata y transacción existente coinciden en `card_last4` + monto + fecha ±1 día, THEN SHALL descartarse como duplicado seguro sin importar el merchant.

7.8. `compareMerchants` SHALL agregar **token containment**: si todos los tokens del merchant más corto están contenidos en el más largo (post-normalización) → `match` ("DIDI" ⊂ "DLO DIDI", "MULTIPLEX" ⊂ "MULTIPLEX VIVA ENVIG").

7.9. El dedup SHALL ser consciente de **multiplicidad**: con N candidatas equivalentes en el batch (monto, fecha, merchant-match) y M transacciones equivalentes en DB, SHALL descartar exactamente min(N, M) y procesar las N−M restantes.

7.10. El chequeo contra `push_ingest_log` SHALL acotarse a `created_at` ±1 día respecto del `tx_date` de la candidata (o eliminarse: las transacciones push ya viven en `transactions`).

7.11. Toda decisión de descarte SHALL registrar su motivo (razón del `DedupDecision` → `error_message` del log de idempotencia), de modo que un duplicado mal resuelto sea auditable.

7.12. WHEN el wallet push parsea una notificación, THEN `tx_date` SHALL calcularse en zona `America/Bogota` (fix en origen de 7.6; la ventana ±1 día queda como cinturón de seguridad).

10.4 (postura LLM). Juez de duplicados por IA: **descartado para el camino crítico** — un falso "duplicado" descarta gastos en silencio (rompe under-count auditable), agrega latencia dentro del límite de ~25s y no es reproducible. El `ai-categorizer` existente está bien ubicado: categorizar es bajo riesgo (un error es visible y corregible, no pierde plata) y converge a determinista vía reglas auto-creadas. IF tras un mes el volumen de `insert_review` resulta alto, THEN evaluar en v2 un asistente que opere **solo** sobre transacciones ya insertadas con `needs_review = true`, sugiriendo resolución con razonamiento logueado, sin capacidad de descarte autónomo (puede reusar el cliente OpenAI del ai-categorizer).

## Design: escalera de matching

Reemplaza el árbol del paso 1 de `evaluateCandidate`:

| Nivel | Clave | Veredicto |
|---|---|---|
| 1 | `card_last4` igual + monto igual + fecha ±1 día | `discard` (sin importar merchant) |
| 2 | monto + fecha ±1 día + merchant `match` (fuzzy con token containment) | `discard` |
| 3 | monto + fecha ±1 día + merchant `ambiguous` | `insert_review` |
| 4 | monto + fecha ±1 día + merchant `no_match`, sin last4 común | `insert_review` (`same_amount_date_different_merchant`) |
| 5 | sin coincidencia | `insert` |

Soportes:

- **`card_last4`**: `CandidateTransaction.card_last4?: string | null`. Del lado existente se extrae al comparar con regex `/[*•]{1,2}(\d{4})\b/` sobre `transactions.description_raw` (el wallet push ya lo persiste ahí: `"PERGAMINO... - COP7,500.00 con Debito Mastercard ••5685"`). Sin migración.
- **Token containment**: en `compareMerchants`, entre el check de prefijo y Levenshtein.
- **Multiplicidad**: `evaluateCandidate` recibe el contexto del run (cuántas candidatas equivalentes ya consumieron cada transacción existente) para descontar existencias.
- **Auditabilidad**: motivo del descarte (`duplicate_card_match`, `duplicate_merchant_match`, …) → `push_ingest_log.error_message`.

Choques cubiertos:

| Choque | Resolución |
|---|---|
| Email Bancolombia vs push Bancolombia (misma oración fuente) | nivel 2 |
| Email vs Google Wallet push (merchant truncado distinto, día corrido) | nivel 1 por last4; si no, 2/3 |
| Compra nocturna (UTC vs Bogotá) | ventana ±1 día + fix 7.12 |
| Dos compras idénticas reales el mismo día | multiplicidad — la segunda se inserta |
| Email vs gasto manual mismo monto+fecha, merchant distinto | nivel 4 — entra marcado |

## Tasks — Wave 7 (dedup hardening)

- [ ] **7.1** `CandidateTransaction.card_last4` + extracción en parsers Gmail (bancolombia `*NNNN`, rappicard `Método de pago *NNNN`) y en `google-wallet.ts` (`••NNNN`). _Req: 7.7_
- [ ] **7.2** `fuzzy-matcher.ts`: token containment en `compareMerchants` + tests (casos reales: "DIDI"/"DLO Didi", "MULTIPLEX"/"MULTIPLEX VIVA ENVIG"; propiedad: conmutativo). _Req: 7.8_
- [ ] **7.3** `dedup-sync.ts`: escalera completa — ventana `tx_date` ±1 día, nivel last4, acotar/eliminar paso 2 de `push_ingest_log`, motivos en el `DedupDecision`. _Req: 7.6, 7.7, 7.10, 7.11_
- [ ] **7.4** Multiplicidad: contexto de consumo por run en `processCandidates` → `evaluateCandidate`. Test: batch con 2 candidatas idénticas + 1 existente → 1 discard + 1 insert. _Req: 7.9_
- [ ] **7.5** `google-wallet.ts`: `tx_date` en `America/Bogota` (UTC−5 fijo, igual que `internalDateToLocal` de rappicard). Test con timestamp 01:30 UTC → día anterior local. _Req: 7.12_
- [ ] **7.6** Tests de regresión integrados: wallet push registrado a las 20:30 Bogotá + email Bancolombia del mismo gasto → 0 inserciones nuevas; mismo escenario con merchants divergentes y last4 común → discard nivel 1.

## Notas de la revisión v1 (menores, no bloqueantes)

- `logProcessedEmail` marca `registered` aun cuando el engine descartó la candidata como duplicado — usar `duplicate` cuando `engineResult.inserted === 0 && duplicates > 0` mejora la auditoría.
- `runGmailSource` marca el close item `cargado` con `found === 0`: correcto para Bancolombia (mes sin movimientos), discutible para Arriendo (se espera exactamente 1/mes) — considerar marcar solo si `found > 0` para arriendo.
- Rutas sin `export const maxDuration`: el loop de cursor del cron (N × 20s) y el budget de 20s + AI (hasta 8s extra por merchant nuevo) pueden exceder el default de Vercel. Sugerido: `maxDuration = 300` en cron, `60` en `/api/sync/gmail`.
- Reglas auto-creadas por el ai-categorizer con `priority: 10` superan a reglas manuales con default `0` — invertir (AI por debajo de las manuales) para que una corrección humana siempre gane.
- `categorizeWithAi` dentro del budget del sync: tope de 8s por merchant nuevo puede pasarse del presupuesto medido por mensaje; considerar timeout de 4s o cap de llamadas AI por corrida.
