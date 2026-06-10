# BBVA MCP Sync — Design

## Overview

BBVA Argentina entra como cuarta fuente del sync engine, **clonando el patrón Bancolombia/Nexo**: provider read-only en `browser-token-mcp` (Deno Edge Function) + adapter + route handler del lado app. La única capa nueva es la adquisición (provider + bookmarklet); dedup/FX/clasificación/categorización/insert/UI se reutilizan intactos.

```
Bookmarklet (online.bbva.com.ar) ──POST /refresh──▶ Vault (provider:bbva:token)
                                                          │
  /api/sync/bbva ──callMcpTool("bbva_get_cards")──▶ browser-token-mcp ──▶ readToken ──▶ BBVA API
       │          ──callMcpTool("bbva_get_card_transactions", {card_id})─▶          ◀── consumos ARS
       ▼
  adaptBbva() ──▶ CandidateTransaction[] ──▶ processCandidates() ──▶ [dedup→FX(ARS→USD)→classify→categorize→insert]
       (una llamada por tarjeta)                                          (todo YA EXISTE)
```

## ⚠️ API real de BBVA — A COMPLETAR EN EL DISCOVERY (Wave 0)

Esta sección está **vacía a propósito**. No conocemos los endpoints internos de `online.bbva.com.ar`. El implementador la completa capturando del navegador (DevTools → Network, sesión logueada) antes de escribir el provider. Hasta entonces, los shapes de abajo son **supuestos de trabajo** que el discovery debe confirmar o corregir (Req 1.4).

A documentar acá tras el discovery:
- **Listar tarjetas** — `GET <url?>` · headers de auth · response shape (id de tarjeta, last4, marca, nombre).
- **Consumos por tarjeta** — `GET/POST <url?>` · params (card id, período/fechas) · shape del movimiento (fecha, comercio, monto ARS, moneda, cuotas, tipo).
- **Token de sesión** — qué campos lo componen (BBVA suele usar header `tsec`, JWT bearer, cookies, `device-id`). Diferencias con Bancolombia.
- Ejemplos request/response **sanitizados** (sin tokens ni datos personales).

> Riesgo a evaluar en el discovery: BBVA tiene WAF/antifraude más agresivo que Bancolombia; puede requerir headers de device/fingerprint que caduquen junto con la sesión. Si el token resulta inestable (dura minutos), dejarlo documentado — afecta la UX (el usuario tendría que pushear token justo antes de syncar).

## Tipos (Edge Function)

```ts
// providers/bbva.ts — token guardado en Vault como JSON (forma a confirmar en discovery)
interface BbvaToken {
  bearer: string;        // o tsec, según discovery
  device_id?: string;
  // ...campos que revele el discovery
}

// Salida de bbva_get_cards
interface BbvaCard { id: string; brand: "VISA" | "MASTERCARD"; last4: string; name: string; }

// Salida de bbva_get_card_transactions (un item por consumo)
interface BbvaTx {
  date: string;          // YYYY-MM-DD
  merchant: string;
  amount: number;        // ARS (o USD si compra internacional — ver currency)
  currency: "ARS" | "USD";
  installments?: string; // "3/12" si aplica
  type: string;          // CONSUMO | PAGO | INTERES | IMPUESTO ...
}
```

## Provider (`providers/bbva.ts`)

Calca `bancolombia.ts` 1:1 en estructura:

```ts
export const bbvaProvider: ProviderModule = {
  name: "bbva",
  tools: [
    { name: "bbva_get_cards", description: "Lista tarjetas de crédito BBVA (Visa, Mastercard) con last4 y marca.", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "bbva_get_card_transactions", description: "Consumos en curso de una tarjeta BBVA. Devuelve fecha, comercio, monto ARS, cuotas, tipo.",
      inputSchema: { type: "object", properties: {
        card_id:   { type: "string", description: "id de tarjeta de bbva_get_cards" },
        date_from: { type: "string", description: "YYYY-MM-DD (opcional)" },
        date_to:   { type: "string", description: "YYYY-MM-DD (opcional)" },
      }, required: ["card_id"] } },
  ],
  async handle(toolName, params, token) {
    const s = parseToken(token); // → ERROR si faltan campos
    switch (toolName) {
      case "bbva_get_cards": return await getCards(s, token);
      case "bbva_get_card_transactions": return await getCardTransactions(s, token, params);
      default: return err(`Unknown tool: ${toolName}`);
    }
  },
};
```

Helpers calcados: `err()`, `headers(s)` (con los headers de auth/device del discovery), `bbvaFetch()` (timeout 15s, 401/403→token expirado, `redactToken`/`sanitizeError` en errores). Registro: `register(bbvaProvider)` en `index.ts` junto a los otros dos.

**Clasificación de líneas (Req 4.3)** — el provider devuelve todo con su `type`; el filtrado fino lo hace el adapter del lado app (donde ya existe la lógica de `transfer_classification_rules`). El provider solo etiqueta `type` lo mejor que pueda desde la respuesta de BBVA.

## Adapter (`src/lib/sync/adapters/bbva.ts`)

Molde: `adapters/nexo.ts`. Diferencia clave: Nexo ya viene en USD; BBVA viene en ARS y el engine convierte.

```ts
export function adaptBbva(rawTxs: BbvaTx[], accountName: string): CandidateTransaction[] {
  return rawTxs
    .filter(isConsumo)                 // excluir PAGO/INTERES/IMPUESTO (o marcarlos para el classifier)
    .map((tx) => {
      const isUsd = tx.currency === "USD";
      return {
        amount_native: tx.amount,
        native_currency: isUsd ? "USD" : "ARS",
        ...(isUsd ? { fx_rate_to_usd: 1, amount_usd: tx.amount } : {}),  // Req 4.4
        merchant: tx.merchant || null,
        tx_date: tx.date,
        description_raw: tx.installments ? `${tx.merchant} (cuota ${tx.installments})` : tx.merchant,
        account_name: accountName,       // "BBVA Visa" | "BBVA Mastercard"
        source: "sync_bbva" as const,
        card_last4: cardLast4ForAccount,  // del card de bbva_get_cards (Req 4.2)
      };
    });
}
```

- **FX**: `native_currency: "ARS"` → `processCandidates` llama `resolveRate("ARS")` → `open.er-api.com/v6/latest/ARS` (oficial). Verificado: `fx.ts` ya soporta cualquier ISO que devuelva open.er-api; ARS está. Nada nuevo.
- **Cuotas (Req 4.5)**: se registra el monto de la cuota del período, no el total. El total iría en `description_raw` para trazabilidad.
- **Compra internacional (Req 4.4)**: si BBVA reporta el movimiento en USD, se respeta; no se fuerza ARS.

## Route Handler (`src/app/api/sync/bbva/route.ts`)

Molde: `api/sync/nexo/route.ts`. Diferencia: dos cuentas → dos pasadas por `processCandidates`.

```
POST /api/sync/bbva { month }
  1. verificar sesión Supabase; validar month YYYY-MM
  2. cards = callMcpTool("bbva_get_cards", {})
  3. para cada card:
       account_name = card.brand === "VISA" ? "BBVA Visa" : "BBVA Mastercard"
       raw = callMcpTool("bbva_get_card_transactions", { card_id: card.id, date_from, date_to })
       candidates = adaptBbva(raw, account_name)  // card_last4 = card.last4
       results.push(await processCandidates(candidates, user.id, month))
  4. recategorizeMonth(user.id, month)
  5. return { results }   // un SyncSourceResult por tarjeta
  catch McpError → AUTH_EXPIRED:401 / otros:502
```

`maxDuration`: dos tarjetas × (1 list + N gets) + AI fallback — poner `export const maxDuration = 60` como en `/api/sync/gmail`.

## Tipos compartidos y UI

- `src/lib/sync/types.ts`: `SyncSource |= "sync_bbva"`. `ERROR_MESSAGES` sin cambios (reusa `AUTH_EXPIRED`/`MCP_ERROR`).
- `mcp-client.ts`: sin cambios (genérico).
- `sync-dialog.tsx`: agregar `{ id: "sync_bbva", label: "BBVA" }` a `SOURCES`. Los resultados ya se renderizan por `source`; agregar labels "BBVA Visa"/"BBVA Mastercard" al mapa de display si se quiere nombre lindo (el `source` es `sync_bbva` para ambas, así que el desglose por tarjeta se ve por `account_name` en el `SyncSourceResult` — confirmar que el componente muestre la cuenta, o incluir el nombre de tarjeta en el result).
- `use-sync.ts`: `sync_bbva → /api/sync/bbva`, POST simple sin cursor.

## Bookmarklet

Variante de `bookmarklet.html` para BBVA: lee los campos del token (según discovery) desde `document.cookie` / storage de `online.bbva.com.ar`, valida que estén presentes (si no, `alert` en español), y POSTea a `/refresh` con `{ provider: "bbva", token: JSON.stringify(campos) }` y el `BROWSER_MCP_REFRESH_SECRET`. Mismo flujo visual que el de Nexo.

## Dedup (sin cambios)

La escalera de `evaluateCandidate` (Wave 7 del gmail-sync) aplica tal cual:
- BBVA es **ARS** y tarjetas argentinas (`last4` 6557 / el de Mastercard). El wallet push y las demás fuentes son **COP**/Colombia. Un monto ARS coincidiendo con un COP es casi imposible, y el `card_last4` distinto descarta el choque en nivel 1 inverso (no matchea).
- Si el usuario usa la tarjeta BBVA en Colombia (consumo en USD/COP), el `card_last4` propio y la ventana ±1 día siguen resolviendo bien.
- No requiere ninguna regla ni código nuevo de dedup.

## Error handling

| Falla | Detección | Resultado |
|---|---|---|
| Token ausente/inválido | `parseToken` falla | `ERROR: Invalid token for 'bbva'` → el handler lo mapea a AUTH_EXPIRED |
| Sesión expirada | BBVA 401/403 | `ERROR: ...expired. Re-login...` → `mcp-client` → `AUTH_EXPIRED` → 401 + CTA pushear token |
| Timeout BBVA | AbortController 15s | `ERROR: BBVA timed out (15s)` → 502 |
| Cuenta inexistente en `accounts` | lookup falla en `processCandidates` | esa tarjeta reporta error, la otra sigue |
| Línea ambigua (¿gasto o pago?) | adapter no decide | `needs_review = true` (under-count), nunca descartar |
| WAF/fingerprint rechaza | 403 sistemático | documentar en discovery; mensaje claro al usuario |

## Testing strategy

Vitest. Lo testeable sin la API real es el **adapter** (función pura) — el provider Edge se valida E2E contra BBVA real porque depende de shapes que solo se conocen post-discovery.

### Unit (adapter, con fixtures del discovery)
- Consumo ARS simple → 1 candidato ARS con `card_last4`.
- Consumo internacional USD → candidato `native_currency: "USD"`, `fx_rate_to_usd: 1`.
- Cuota → monto de la cuota, no el total; info en `description_raw`.
- Línea PAGO/INTERES/IMPUESTO → excluida o marcada (según 4.3).
- Comercio vacío → `merchant: null`.

### Property
- `adaptBbva` total: ∀ input (incluida basura), no lanza; todo candidato tiene `amount_native > 0`, `tx_date` ISO, `native_currency ∈ {ARS, USD}`, `source: "sync_bbva"`.
- ARS nunca emite `fx_rate_to_usd` pre-cargado (deja que el engine lo resuelva); USD siempre lo pre-carga en 1.

### E2E manual (post-discovery)
1. Pushear token BBVA con el bookmarklet → aparece en Vault.
2. `bbva_get_cards` devuelve 2 tarjetas con last4 correctos.
3. Sync del mes → comparar conteo/montos contra el resumen real de cada tarjeta.
4. Verificar FX: un consumo ARS conocido × tasa oficial del día ≈ `amount_usd` guardado.
5. Re-sync → 0 nuevas (idempotencia).
6. Forzar expiración (logout en BBVA) → sync devuelve AUTH_EXPIRED / CTA pushear token.
