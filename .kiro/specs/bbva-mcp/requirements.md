# BBVA MCP Sync — Requirements

## Introduction

Sumar **BBVA Argentina** como fuente del sync engine, con el **mismo método** que Bancolombia y Nexo: un provider read-only en la Edge Function `browser-token-mcp` que consume la API interna de `online.bbva.com.ar` usando un session token extraído del navegador (bookmarklet → `/refresh` → Vault), y un adapter + route handler del lado app que emite `CandidateTransaction[]` hacia `processCandidates()`.

No se parsea el PDF del resumen (ese camino quedó descartado en el spec `gmail-sync`, Req 10.1: el email no adjunta el PDF, solo un link tokenizado detrás de login). Acá vamos directo a la API que usa la web de BBVA.

### Decisiones del dueño (resueltas)

| Decisión | Resolución |
|---|---|
| **FX ARS→USD** | Dólar **oficial** vía `open.er-api.com` (ya integrado en `fx.ts`). No requiere fuente nueva: la brecha cambiaria se cerró, el oficial refleja el valor real. `resolveRate("ARS")` resuelve solo. |
| **Qué traer** | **Consumos en curso** (período no cerrado), igual que Bancolombia/Nexo (movimientos, no resumen cerrado). |
| **Tarjetas** | **Ambas**: Visa Signature (cuenta `****6557`) y Mastercard Black. Dos `account_name` distintos. |

### Patrón a calcar (verificado en el código)

- Provider Edge: `supabase/functions/browser-token-mcp/providers/bancolombia.ts` — interface `ProviderModule` (`name`, `tools`, `handle`), token JSON en Vault (`provider:bbva:token`), headers de sesión, `bcFetch` con timeout 15s y manejo 401/403→"token expirado".
- Registro: `register(bbvaProvider)` en `index.ts`. El routing (`resolveProvider`) y el `/refresh` ya funcionan para cualquier provider registrado (`isValidProvider`).
- Bookmarklet: variante de `bookmarklet.html` que extrae el token de sesión desde `online.bbva.com.ar` y lo POSTea a `/refresh` con `provider: "bbva"`.
- Lado app: `adapters/nexo.ts` + `api/sync/nexo/route.ts` como molde para `adapters/bbva.ts` + `api/sync/bbva/route.ts`.

### ⚠️ Incógnita central — discovery de endpoints

A diferencia de Bancolombia/Nexo, **no conocemos los endpoints internos de `online.bbva.com.ar`** (URLs, headers de auth, forma del token, shape de respuesta). El primer entregable es **capturarlos del navegador** (DevTools → Network, ya logueado), igual que se hizo con los otros providers. Todo el resto del spec asume que ese discovery produjo: (a) endpoint de listado de tarjetas, (b) endpoint de consumos por tarjeta, (c) qué campos componen el session token, (d) headers requeridos. Hasta tenerlos, el provider no se puede terminar — está marcado como tarea bloqueante (Wave 0).

### Principios (heredados del sync engine)

- **Under-count**: ante la duda, no insertar o marcar `needs_review`. Nunca inventar datos.
- **Read-only**: el provider solo hace GET/POST de consulta. Ninguna operación muta la cuenta.
- **Token nunca expuesto**: vive en Vault, se redacta en errores (`redactToken`), jamás se serializa a respuestas.
- **Idempotencia**: re-correr el mismo mes produce 0 inserciones nuevas (lo garantiza el dedup engine).

---

## Requirement 1 — Discovery de la API de BBVA (bloqueante)

**User story:** Como implementador, necesito los endpoints reales de `online.bbva.com.ar`, para poder escribir el provider sin adivinar.

### Acceptance criteria

1.1. El discovery SHALL capturar, desde una sesión real logueada (DevTools → Network), la request que **lista las tarjetas de crédito** (Visa Signature + Mastercard Black): URL, método, headers de auth, y shape de respuesta (cómo viene el id de tarjeta, el `last4`, la marca).

1.2. El discovery SHALL capturar la request que **lista los consumos/movimientos de una tarjeta** en el período en curso: URL, método, parámetros (card id, rango de fechas o período), y shape de cada movimiento (fecha, comercio, monto ARS, cuotas si aplica).

1.3. El discovery SHALL identificar **qué compone el session token** (bearer JWT, cookies, headers tipo `tsec`/`device-id` que BBVA suele usar) y en qué se diferencia del de Bancolombia.

1.4. WHEN el shape real difiera de los supuestos de este spec, THEN el spec (design.md) SHALL actualizarse en el mismo PR del discovery antes de implementar el provider.

1.5. El resultado del discovery SHALL documentarse en `design.md` (sección "API real de BBVA") con ejemplos de request/response sanitizados (sin tokens ni datos personales).

---

## Requirement 2 — Captura y almacenamiento del token (bookmarklet + refresh + Vault)

**User story:** Como dueño, quiero pushear mi sesión de BBVA con un bookmarklet, igual que con Nexo.

### Acceptance criteria

2.1. SHALL existir una variante del bookmarklet (en `bookmarklet.html` o un archivo análogo) que, ejecutada en `online.bbva.com.ar` logueado, extraiga los campos del token identificados en 1.3 y los POSTee a `/refresh` con `provider: "bbva"` y `Authorization: Bearer <BROWSER_MCP_REFRESH_SECRET>`.

2.2. El endpoint `/refresh` existente SHALL aceptar `provider: "bbva"` una vez registrado el provider (no requiere cambios en `refresh.ts`; `isValidProvider` lo valida contra el registry).

2.3. El token SHALL guardarse en Vault bajo la key `provider:bbva:token` como JSON string (mismo mecanismo que `writeToken`).

2.4. WHEN el bookmarklet no encuentra los campos del token (sesión expirada o no logueado), THEN SHALL alertar al usuario en español sin enviar nada.

2.5. El token SHALL respetar el límite de 8192 chars del `/refresh`; si el token de BBVA fuera mayor, el discovery SHALL determinar qué subconjunto mínimo de campos basta.

---

## Requirement 3 — Provider BBVA en la Edge Function

**User story:** Como sync engine, quiero dos tools MCP (`bbva_get_cards`, `bbva_get_card_transactions`) que devuelvan las tarjetas y sus consumos.

### Acceptance criteria

3.1. SHALL existir `supabase/functions/browser-token-mcp/providers/bbva.ts` exportando un `ProviderModule` con `name: "bbva"`, registrado vía `register(bbvaProvider)` en `index.ts`.

3.2. La tool `bbva_get_cards` SHALL devolver la lista de tarjetas de crédito con `{ id, brand, last4, name }` (input vacío), donde `name` permite mapear a `account_name` ("BBVA Visa", "BBVA Mastercard").

3.3. La tool `bbva_get_card_transactions` SHALL aceptar `{ card_id (required), date_from?, date_to? }` y devolver los consumos del período en curso con `{ date (YYYY-MM-DD), merchant, amount (ARS), installments?, type }`.

3.4. El `handle` SHALL parsear el token de Vault y, si faltan campos requeridos, devolver `ERROR: Invalid token for 'bbva'...` (mismo patrón que bancolombia/nexo).

3.5. WHEN BBVA responde 401/403, THEN el provider SHALL devolver `ERROR: Session token for 'bbva' expired. Re-login and push a new token.` (lo mapea `mcp-client.ts` a `AUTH_EXPIRED`).

3.6. Todas las requests SHALL usar timeout de 15s (AbortController) y devolver error claro en timeout/red, redactando el token en cualquier eco de error.

3.7. El provider SHALL ser **read-only**: solo endpoints de consulta, ninguna operación transaccional.

3.8. Los montos SHALL devolverse como número en ARS (sin convertir); la conversión a USD es responsabilidad del sync engine.

---

## Requirement 4 — Adapter y normalización a CandidateTransaction

**User story:** Como sync engine, quiero los consumos de BBVA normalizados al formato que ya proceso.

### Acceptance criteria

4.1. SHALL existir `src/lib/sync/adapters/bbva.ts` con `adaptBbva(rawTxs, accountName)` → `CandidateTransaction[]`.

4.2. Cada candidato SHALL tener `amount_native` = monto ARS, `native_currency: "ARS"`, `merchant` = comercio (o `null` si vacío), `tx_date` (YYYY-MM-DD), `description_raw`, `account_name` ("BBVA Visa" | "BBVA Mastercard"), `source: "sync_bbva"`, y `card_last4` extraído (para el dedup de la Wave 7).

4.3. El adapter SHALL **excluir** movimientos que no son consumos de compra: pagos del resumen, intereses, impuestos (IVA, percepciones), ajustes — o marcarlos para que el classifier los trate como `is_payment`/transferencia. WHEN haya duda sobre si una línea es gasto real, THEN se SHALL marcar `needs_review` (under-count), nunca descartar plata silenciosamente.

4.4. WHEN un consumo viene en USD (compra internacional con la tarjeta argentina), THEN el adapter SHALL respetar la moneda real del movimiento (`native_currency: "USD"`, `fx_rate_to_usd: 1`) en vez de asumir ARS.

4.5. WHEN un consumo está en cuotas, THEN SHALL registrarse el monto de **la cuota del período** (no el total), con la info de cuota en `description_raw`.

---

## Requirement 5 — Route Handler `/api/sync/bbva`

**User story:** Como usuario, quiero disparar el sync de BBVA desde el SyncDialog.

### Acceptance criteria

5.1. `POST /api/sync/bbva` SHALL aceptar `{ month: "YYYY-MM" }`, validar sesión Supabase y formato de mes, igual que `/api/sync/nexo`.

5.2. El handler SHALL llamar `bbva_get_cards`, y para cada tarjeta llamar `bbva_get_card_transactions` filtrando al mes pedido, adaptar y llamar `processCandidates` **una vez por tarjeta** (el engine resuelve `account_id` desde `candidates[0]`, así que no se puede mezclar cuentas en una llamada).

5.3. El handler SHALL devolver `{ results: SyncSourceResult[] }` (un resultado por tarjeta) y correr `recategorizeMonth` al final, como los otros route handlers.

5.4. WHEN el token está expirado/ausente (`McpError` con `AUTH_EXPIRED`), THEN SHALL responder 401 con mensaje en español; otros errores MCP → 502.

5.5. El `SyncSource` SHALL extenderse con `"sync_bbva"` y `ERROR_MESSAGES` no requiere claves nuevas (reutiliza `AUTH_EXPIRED`/`MCP_ERROR`).

---

## Requirement 6 — Integración con UI y dedup

**User story:** Como usuario, quiero BBVA como fuente en el dialog, sin duplicados contra otras fuentes.

### Acceptance criteria

6.1. El SyncDialog SHALL ofrecer "BBVA" como fuente seleccionable; `use-sync.ts` SHALL mapear `sync_bbva` → `/api/sync/bbva` (POST simple, sin cursor — como Bancolombia/Nexo).

6.2. Los resultados por tarjeta SHALL mostrarse con labels "BBVA Visa" / "BBVA Mastercard".

6.3. El dedup engine existente SHALL aplicar sin cambios: el `card_last4` de BBVA (`6557` y el de Mastercard) y la moneda ARS hacen muy improbable el choque con fuentes colombianas (COP); aun así, la escalera de `evaluateCandidate` cubre cualquier coincidencia de monto+fecha.

6.4. Las cuentas "BBVA Visa" y "BBVA Mastercard" SHALL existir en la tabla `accounts` (tipo `bank`/tarjeta) antes del primer sync; si no existen, el run de esa tarjeta falla con error reportado sin afectar la otra (comportamiento existente de `processCandidates`).

6.5. BBVA NO se incluye en el cron automático (`/api/sync/cron`), por la misma razón que Bancolombia/Nexo: el session token expira rápido y requiere trigger manual con token fresco vía el dialog.

---

## Requirement 7 — Fuera de alcance / futuro

7.1. **Resumen cerrado mensual**: no en v1 (se eligió consumos en curso). Si se quisiera reconciliar el cierre, sería una tool adicional `bbva_get_statement`.

7.2. **Caja de ahorro / cuenta ARS**: este spec cubre tarjetas de crédito. Los avisos "TRANSFERENCIA INMEDIATA" de `avisos@bbva.com.ar` (vistos en Gmail) podrían ser una fuente de la cuenta en v2.

7.3. **Auto-refresh del token**: no aplica — como Bancolombia/Nexo, el token se renueva manualmente con el bookmarklet cuando expira.
