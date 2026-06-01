# maquinita-mcp — MCP server propio (Edge Function)

Servidor **MCP de dominio** para que el asistente que parsea extractos escriba a
Supabase con tools claras y seguras, en vez de SQL crudo. Cada tool fuerza el
contrato de datos (stampea el `user_id` del dueño, calcula el USD, respeta el
signo de gasto y hace upsert de snapshots).

## Endpoint

```
https://ixvxunclnbzguugiqelq.supabase.co/functions/v1/maquinita-mcp
```

- Transporte: **MCP Streamable HTTP** (JSON-RPC 2.0 sobre un único POST).
- Deployado con `verify_jwt = false` (auth propia por secret).

## Auth (secret + único dueño)

La función valida un **secret** y escribe siempre para `OWNER_USER_ID`.
Pasá el secret como query param o header:

- Query: `...maquinita-mcp?key=EL_SECRET`
- Header: `x-maquinita-key: EL_SECRET`

Secret por defecto: `mqnt_3f9aK7Qe2hV8sLpZ1xR6yTbN4wD0cJ5`
Para rotarlo, definí el secret de función **`MAQUINITA_MCP_SECRET`** en
*Supabase → Edge Functions → maquinita-mcp → Secrets* y redeployá. Igual para el
dueño: **`MAQUINITA_OWNER_USER_ID`** (hoy apunta al usuario demo).

## Conectarlo a Claude (custom connector)

claude.ai → **Settings → Connectors → Add custom connector**:

- Nombre: `Maquinita`
- URL: `https://ixvxunclnbzguugiqelq.supabase.co/functions/v1/maquinita-mcp?key=mqnt_3f9aK7Qe2hV8sLpZ1xR6yTbN4wD0cJ5`

No usa OAuth: el secret va en la URL, así que conecta como *no-auth connector*.

## Tools

| Tool | Qué hace |
|------|----------|
| `leer_cuentas` | Lista cuentas (id, nombre, tipo, moneda, **país, medio de pago**) → resolver nombre→id. |
| `leer_categorias` | Lista categorías (id, nombre, color) → resolver nombre→id. |
| `registrar_transaccion` | Inserta un consumo. Acepta `account_name`/`category_name` o sus ids + dimensiones `country`/`payment_type`/`expense_type`. Calcula `amount_usd` si no se pasa. |
| `registrar_transacciones_lote` | Inserta muchas de una (`{ items: [...] }`). |
| `upsert_snapshot` | Crea/actualiza saldo de cuenta a una fecha (upsert por `account_id+snapshot_date`). |
| `recategorizar` | Cambia la categoría de una transacción (o la limpia con `category_id: null`). |
| `leer_resumen_gastos` | Total + desglose por categoría de un mes (`YYYY-MM`); excluye pagos. |
| `leer_cierre` | Lee el cierre de un período (default mes actual) con su checklist. |
| `crear_cierre` | Abre el cierre y siembra las 8 fuentes. Idempotente. |
| `actualizar_item_cierre` | Marca una fuente `cargado`/`omitido`/`pendiente` (por `item_id` o `period`+`source`). |
| `cerrar_mes` | Cierra el mes y congela el snapshot (`net_worth_usd`, `total_spend_usd`, `savings_usd`). |

### Reglas que aplica automáticamente

- `amount_native > 0` = gasto, `< 0` = pago/devolución.
- `amount_usd` / `balance_usd` = `*_native * fx_rate_to_usd` si no se pasan (FX default 1 para USD/USDT).
- `native_currency` toma la de la cuenta si se omite.
- `country` / `payment_type` se heredan de la cuenta si no se pasan; `expense_type` default `variable`.
- Todo se escribe con el `user_id` del dueño (no hace falta pasarlo).

### Ejemplo (tools/call)

```jsonc
// registrar_transaccion
{ "name": "registrar_transaccion", "arguments": {
  "account_name": "Rappi", "tx_date": "2026-06-03",
  "description_raw": "RAPPI*RAPPI COLOMBIA", "merchant": "Rappi",
  "amount_native": 42000, "native_currency": "COP", "fx_rate_to_usd": 0.00025,
  "category_name": "Delivery comida"
}}

// upsert_snapshot
{ "name": "upsert_snapshot", "arguments": {
  "account_name": "Nexo", "snapshot_date": "2026-06-30",
  "balance_native": 23000, "native_currency": "USDT", "fx_rate_to_usd": 1
}}
```

## Deploy

```bash
supabase functions deploy maquinita-mcp --no-verify-jwt --project-ref ixvxunclnbzguugiqelq
```

> Rappi puede ser *delivery* o *mercado* (Rappiturbo): que el parser decida caso
> por caso. Cualquier transacción se puede re-categorizar después desde la app o
> con `recategorizar`.
