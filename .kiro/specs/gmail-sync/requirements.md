# Gmail Expense Sync — Requirements

## Contexto

Maquinita ya tiene un sync engine batch (`src/lib/sync/`) con `processCandidates(candidates, userId, month)` que hace dedup (fuzzy merchant matching contra `transactions` y `push_ingest_log`) → FX → clasificación de transferencias → categorización → insert. Las fuentes actuales son APIs bancarias vía `browser-token-mcp` (Bancolombia, Nexo). Este spec agrega **Gmail como fuente de datos**: parsear emails transaccionales reales y emitir `CandidateTransaction[]` hacia ese mismo engine.

### Hallazgos de la exploración del Gmail real (2026-06)

Estos hallazgos **acotan el alcance** y corrigen supuestos del pedido original:

| Fuente | Remitente real | Formato | Hallazgo clave |
|---|---|---|---|
| Bancolombia | `alertasynotificaciones@an.notificacionesbancolombia.com` | 1 email por movimiento, subject fijo "Alertas y Notificaciones", texto transaccional en una sola oración dentro del body | Hay ≥6 variantes de patrón (compra, pago servicio, QR/Bre-b, transferencia, ingreso, no-transaccional). Formato de monto inconsistente: `$7.500,00`, `$359702.00`, `$100000` |
| RappiCard | `noreply@rappicard.co` | 1 email por compra, subject "RappiCard - Resumen de transacción", campos Monto / Método de pago / No. de autorización / Comercio / Fecha en HTML | **El extracto mensual NO trae PDF adjunto** (manda al app). Las notificaciones por transacción cubren cada compra → son la fuente |
| BBVA (Argentina) | `avisos@bbva.com.ar` | Aviso "Ya podes descargar tu resumen de tarjeta Visa/Mastercard BBVA" | **El resumen NO viene adjunto**: solo un link tokenizado a `online.bbva.com.ar/descarga-resumen/...` detrás de login. Parseo automático del PDF vía Gmail **no es posible** → BBVA queda fuera del alcance v1 (ver Req 10) |
| Arriendo | `info@palomma.com` | Subject "Confirmación de Pago", HTML estructurado: Valor total, Fecha, Descripción ("Canon Inmueble…"), N. referencia | El mismo pago genera **además** un email Bancolombia ("Transferiste $1.900.000,00 por Boton Bancolombia a PALOMMA SAS") → dedup cross-fuente obligatorio |

### Principios

- **Under-count**: ante la duda, NO insertar o insertar con `needs_review = true`. Nunca inventar datos.
- **Idempotencia**: re-correr el sync del mismo mes N veces produce 0 inserciones nuevas.
- **Sin tablas nuevas**: idempotencia por email se registra en `push_ingest_log` (PK `dedup_key`), transacciones van a `transactions`.
- **Extensibilidad**: agregar una fuente nueva = un archivo nuevo en `src/lib/sync/gmail/sources/` que exporta query + parser.

---

## Requirement 1 — Conexión OAuth con Gmail

**User story:** Como dueño de Maquinita, quiero conectar mi Gmail una sola vez, para que el sistema lea mis emails transaccionales sin que yo vuelva a autenticarme.

### Acceptance criteria

1.1. WHEN el usuario visita `/api/gmail/auth` autenticado en la app, THEN el sistema SHALL redirigir al consent screen de Google solicitando únicamente el scope `https://www.googleapis.com/auth/gmail.readonly`, con `access_type=offline` y `prompt=consent`.

1.2. WHEN Google redirige a `/api/gmail/callback` con un `code` válido, THEN el sistema SHALL intercambiar el code por tokens, almacenar el **refresh token en Supabase Vault** (nunca en tablas planas ni en el cliente) y redirigir a la app con confirmación visual.

1.3. WHEN cualquier componente server-side necesita un access token, THEN el sistema SHALL refrescarlo automáticamente usando el refresh token de Vault, sin interacción del usuario.

1.4. IF el refresh token fue revocado o es inválido (`invalid_grant`), THEN el sistema SHALL responder con código de error `GMAIL_AUTH_REQUIRED` y la UI SHALL mostrar un botón "Conectar Gmail" que reinicia el flow 1.1.

1.5. WHEN el callback recibe un `state` que no coincide con el emitido en 1.1, THEN el sistema SHALL rechazar el intercambio (protección CSRF).

1.6. El refresh token SHALL ser accesible únicamente con service role key (RPCs `SECURITY DEFINER` revocadas para `anon` y `authenticated`).

---

## Requirement 2 — Búsqueda de emails por mes y fuente

**User story:** Como usuario, quiero que el sync de un mes encuentre exactamente los emails transaccionales de ese mes, para no procesar promociones ni meses ajenos.

### Acceptance criteria

2.1. WHEN se sincroniza el mes `YYYY-MM` para una fuente, THEN el sistema SHALL construir una Gmail search query con `from:`, (`subject:` si aplica), `after:YYYY/MM/01` y `before:` primer día del mes siguiente.

2.2. La fuente Bancolombia SHALL usar `from:(an.notificacionesbancolombia.com)`; RappiCard SHALL usar `from:(noreply@rappicard.co) subject:("Resumen de transacción")`; Arriendo SHALL usar `from:(info@palomma.com) subject:("Confirmación de Pago")`.

2.3. WHEN la búsqueda devuelve más resultados que una página de la API, THEN el sistema SHALL paginar con `pageToken` hasta agotar resultados del mes.

2.4. WHEN un email matchea la query pero no es transaccional (promos, avisos de factura disponible, alertas de seguridad), THEN el parser SHALL devolver vacío y el email SHALL registrarse como descartado sin insertar nada (under-count).

---

## Requirement 3 — Parser Bancolombia (notificaciones en body)

**User story:** Como usuario, quiero que cada alerta de movimiento de Bancolombia se convierta en una transacción con monto, comercio y fecha correctos.

### Acceptance criteria

3.1. WHEN el body contiene el patrón `Compraste $X en MERCHANT con tu T.Deb/T.Cred *NNNN, el DD/MM/YYYY`, THEN el parser SHALL emitir un candidato con `amount_native`, `merchant`, `tx_date` extraídos y `native_currency: "COP"`.

3.2. WHEN el body contiene `Pagaste $X a BENEFICIARIO desde tu producto NNNN el DD/MM/YYYY`, THEN el parser SHALL emitir un candidato con `merchant` = beneficiario.

3.3. WHEN el body contiene un pago QR / Bre-b (`pagaste $X por codigo QR ... a la llave NNN` o `transferiste $X a la llave @user ... a NOMBRE`), THEN el parser SHALL emitir un candidato con `merchant` = nombre del destinatario si está presente, o `null` si solo hay llave numérica (la clasificación downstream marcará `needs_review`).

3.4. WHEN el body contiene `Transferiste $X ... a CUENTA/DESTINATARIO`, THEN el parser SHALL emitir un candidato y la decisión gasto-vs-transferencia SHALL quedar en manos del classifier existente (`transfer_classification_rules`).

3.5. WHEN el body indica ingreso (`recibiste una transferencia`, `recibiste un pago`), THEN el parser SHALL devolver vacío (no es gasto).

3.6. El parser SHALL soportar los tres formatos de monto observados: `$7.500,00` (CO: punto miles, coma decimal), `$359702.00` (decimal con punto), `$100000` (entero plano), reutilizando la lógica probada de `src/lib/push-ingest/parsers/bancolombia.ts`.

3.7. WHEN no se puede extraer monto o fecha de un email transaccional, THEN el parser SHALL devolver vacío para ese email y el sistema SHALL registrar el descarte con motivo (nunca insertar con datos inventados).

3.8. Los candidatos SHALL llevar `source: "sync_gmail_bancolombia"`, `account_name: "Bancolombia"` y `description_raw` = oración transaccional original.

---

## Requirement 4 — Parser RappiCard (notificaciones por transacción)

**User story:** Como usuario, quiero que cada compra con RappiCard llegue a Maquinita desde el email "Resumen de transacción".

### Acceptance criteria

4.1. WHEN un email de `noreply@rappicard.co` contiene los campos Monto, Comercio y Fecha de la transacción, THEN el parser SHALL emitir un candidato con `amount_native` (formato CO `$88.443`), `merchant` = valor de Comercio, `tx_date` normalizada a `YYYY-MM-DD`, `native_currency: "COP"`, `source: "sync_gmail_rappicard"`, `account_name: "RappiCard"`.

4.2. WHEN el email es de extracto mensual ("¡Llegó el extracto de tu RappiCard!") u otra comunicación sin los campos de 4.1, THEN el parser SHALL devolver vacío.

4.3. El parser SHALL operar sobre el HTML del email convertido a texto plano (estos emails no traen parte `text/plain`).

4.4. IF en el futuro el monto aparece con decimales (`$88.443,50`), THEN el parser SHALL interpretarlo con la misma lógica de montos CO del Req 3.6.

---

## Requirement 5 — Parser Arriendo (Palomma)

**User story:** Como usuario, quiero que el pago mensual del arriendo se registre automáticamente como gasto fijo al llegar la confirmación de Palomma.

### Acceptance criteria

5.1. WHEN un email de `info@palomma.com` con subject "Confirmación de Pago" contiene Estado "Aprobado", THEN el parser SHALL emitir exactamente un candidato con `amount_native` = "Valor total" (formato `$ 1.900.000`), `tx_date` = campo Fecha (`DD/MM/YYYY`), `merchant: "Arriendo"`, `description_raw` = descripción del pago + N. de referencia, `source: "sync_gmail_arriendo"`, `account_name: "Bancolombia"`.

5.2. WHEN el estado no es "Aprobado", THEN el parser SHALL devolver vacío.

5.3. La transacción de arriendo SHALL insertarse con `expense_type: "fixed"`.

5.4. WHEN el mismo pago llega también como email Bancolombia ("Transferiste … a PALOMMA SAS"), THEN el sistema SHALL evitar el doble conteo: la fuente Arriendo se procesa **antes** que Bancolombia dentro del mismo run, y la variante Bancolombia con mismo monto+fecha SHALL resultar `discard` o `insert_review` según el árbol de dedup existente. Adicionalmente se SHALL seedear una regla `transfer_classification_rules` (allowlist, pattern `PALOMMA`) para que la transferencia Bancolombia se marque `is_payment` y no compute como gasto.

---

## Requirement 6 — Idempotencia por email procesado

**User story:** Como usuario, quiero re-correr el sync del mismo mes cuantas veces quiera sin generar duplicados.

### Acceptance criteria

6.1. WHEN se procesa un email, THEN el sistema SHALL registrar una fila en `push_ingest_log` con `dedup_key = sha256("gmail|" + gmail_message_id)` (truncado a 32 hex, igual que el pipeline push) y `package_name = "gmail." + sourceId`.

6.2. WHEN un `dedup_key` ya existe en `push_ingest_log`, THEN el sistema SHALL saltear ese email sin re-parsearlo ni re-insertarlo, contándolo como duplicado en el resultado.

6.3. Los emails descartados (ingresos, no-transaccionales, parse fallido) SHALL registrarse también en `push_ingest_log` (status `no_parser` con `error_message` indicando el motivo, o `transfer` para ingresos), para que tampoco se reprocesen.

6.4. El sistema SHALL filtrar los message IDs ya procesados con una sola query (`IN` sobre `dedup_key`) antes de descargar los bodies, minimizando llamadas a la Gmail API.

6.5. No se SHALL usar labels de Gmail como mecanismo de tracking (mantiene el scope en `gmail.readonly`).

---

## Requirement 7 — Integración con el sync engine y dedup cross-fuente

**User story:** Como usuario, quiero que los gastos de Gmail pasen por el mismo pipeline (dedup, FX, clasificación, categorización) que el resto de las fuentes.

### Acceptance criteria

7.1. Cada sub-fuente Gmail SHALL emitir `CandidateTransaction[]` y llamar al `processCandidates()` existente sin reimplementar dedup/FX/insert.

7.2. El tipo `SyncSource` SHALL extenderse con `"sync_gmail_bancolombia" | "sync_gmail_rappicard" | "sync_gmail_arriendo"`.

7.3. WHEN una candidata Gmail coincide en monto+fecha con una transacción existente (cargada por push, MCP o manual) y el merchant matchea (fuzzy), THEN SHALL descartarse; IF el merchant difiere o es ambiguo, THEN SHALL insertarse con `needs_review = true` (árbol de decisión existente en `dedup-sync.ts`).

7.4. WHEN `processCandidates` se invoca, THEN SHALL recibir candidatas de **una sola cuenta** por llamada (limitación existente: resuelve `account_id` desde `candidates[0]`); el orquestador Gmail SHALL agrupar por sub-fuente.

7.5. WHEN la cuenta (`account_name`) no existe en `accounts`, THEN el run de esa sub-fuente SHALL fallar con error reportado, sin afectar las demás sub-fuentes.

### Dedup cross-fuente robusto (vs push Google Wallet / Bancolombia) — pendiente, Wave 7

Contexto: las push notifications (Google Wallet, Bancolombia) insertan en tiempo real; el sync de Gmail corre después sobre el mismo mes. El mismo gasto puede llegar por 2–3 canales con merchant truncado distinto y fecha corrida por timezone. La resolución SHALL ser **determinista** (escalera de claves de identidad), no probabilística.

7.6. WHEN se evalúa una candidata contra `transactions`, THEN la búsqueda SHALL usar una ventana de fecha de **±1 día** (no igualdad exacta): el wallet push deriva `tx_date` del reloj del servidor (UTC en Vercel) y el email trae fecha local Bogotá, por lo que compras nocturnas (~19:00–24:00 local) difieren en un día.

7.7. Los parsers (Gmail y push) SHALL extraer `card_last4` cuando esté presente (email Bancolombia `*5685`, email RappiCard `*3679`, wallet push `••5685`). WHEN candidata y transacción existente coinciden en `card_last4` + monto + fecha ±1 día, THEN SHALL descartarse como duplicado seguro, sin importar el merchant.

7.8. `compareMerchants` SHALL agregar **token containment** al árbol de comparación: si todos los tokens del merchant más corto están contenidos en el más largo (post-normalización), es `match` (ej.: "DIDI" ⊂ "DLO DIDI", "MULTIPLEX" ⊂ "MULTIPLEX VIVA ENVIG").

7.9. El dedup SHALL ser consciente de **multiplicidad**: WHEN el batch contiene N candidatas idénticas en (monto, fecha, merchant-match) y existen M transacciones equivalentes en DB, THEN SHALL descartarse exactamente min(N, M) y procesarse las N−M restantes (caso real: dos compras de $9.500 en PQUE ECOLOGICO el mismo día — la segunda no debe perderse).

7.10. El chequeo contra `push_ingest_log` por monto-solo a lo largo del mes (paso 2 actual de `evaluateCandidate`) SHALL acotarse a `created_at` ±1 día respecto del `tx_date` de la candidata, o eliminarse (las transacciones push ya viven en `transactions`); un gasto del día 20 no debe descartarse porque hubo un push del mismo monto el día 9.

7.11. Toda decisión de descarte SHALL quedar registrada con su motivo (razón del `DedupDecision` → `error_message` del log de idempotencia), de modo que un duplicado mal resuelto sea auditable a posteriori.

7.12. WHEN el wallet push parsea una notificación, THEN `tx_date` SHALL calcularse en zona `America/Bogota` (fix en origen de 7.6, en `google-wallet.ts`; la ventana ±1 día queda como cinturón de seguridad).

---

## Requirement 8 — Route Handler `/api/sync/gmail` + UI

**User story:** Como usuario, quiero disparar el sync de Gmail desde el SyncDialog y ver progreso por sub-fuente.

### Acceptance criteria

8.1. `POST /api/sync/gmail` SHALL aceptar `{ month: "YYYY-MM", sources?: GmailSourceId[] }` (default: todas las sub-fuentes), autenticado con sesión Supabase, y devolver `{ results: SyncSourceResult[] }` — un resultado por sub-fuente.

8.2. WHEN el procesamiento de un mes excede el presupuesto de tiempo (~20s sobre el límite de ~25s de Vercel), THEN el handler SHALL devolver resultados parciales con un cursor (`next: { source, pageToken } | null`) y el cliente SHALL reanudar con ese cursor hasta `next: null`.

8.3. El SyncDialog SHALL mostrar "Gmail" como fuente seleccionable junto a Bancolombia/Nexo, y durante el run SHALL mostrar progreso por sub-fuente ("Gmail · Bancolombia", "Gmail · RappiCard", "Gmail · Arriendo") reutilizando el patrón visual de `SourceResult`.

8.4. WHEN Gmail no está conectado (Req 1.4), THEN el dialog SHALL mostrar el CTA "Conectar Gmail" en lugar del checkbox.

8.5. Los errores SHALL mapearse a mensajes en español vía `ERROR_MESSAGES`, agregando `GMAIL_AUTH_REQUIRED` y `GMAIL_API_ERROR`.

---

## Requirement 9 — Cierre mensual y cron

**User story:** Como usuario, quiero que el cierre de mes marque solo los ítems Gmail efectivamente cargados, y que el cron nocturno incluya Gmail.

### Acceptance criteria

9.1. WHEN un run de Gmail para el mes M termina una sub-fuente **sin errores**, THEN el sistema SHALL marcar el `monthly_close_items` correspondiente (`item_type = 'gmail_auto'`, match por `source`: "Bancolombia" ↔ sync_gmail_bancolombia, "Arriendo" ↔ sync_gmail_arriendo) como `status = 'cargado'` con `loaded_at = now()`, vía Supabase admin client.

9.2. IF no existe `monthly_close` o el ítem para ese mes, THEN el sistema SHALL continuar sin error (el cierre es opcional).

9.3. `GET /api/sync/cron` SHALL incluir las sub-fuentes Gmail del mes corriente después de Bancolombia/Nexo, con la misma auth `Bearer SYNC_CRON_SECRET`, y un fallo en Gmail SHALL reportarse en `errors` sin abortar las otras fuentes.

9.4. WHEN el cron corre los primeros 5 días del mes, THEN SHALL sincronizar también el mes anterior (los emails de fin de mes pueden llegar tarde y el cierre del mes anterior sigue abierto).

---

## Requirement 10 — Fuera de alcance v1 (documentado)

10.1. **BBVA (extractos Visa/Mastercard)**: el email no adjunta el PDF (solo link detrás de login) → no es parseable desde Gmail. El ítem de cierre mensual `extracto_pdf` de BBVA SHALL permanecer manual. El diseño SHALL dejar el slot de fuente `sync_gmail_bbva` documentado para una v2 (alternativas: aviso "TRANSFERENCIA INMEDIATA DEBITADA" de `avisos@bbva.com.ar` como señal parcial, o upload manual del PDF).

10.2. **Parseo de PDFs**: ninguna fuente v1 lo necesita. IF una fuente futura adjunta PDFs, THEN se SHALL evaluar `unpdf` (extracción de texto serverless-friendly) con presupuesto < 10s por PDF antes de considerar background processing.

10.3. **Ingresos**: se detectan para descartar, no se registran (la tabla `transactions` modela gastos).

10.4. **LLM como juez de duplicados**: descartado para el camino crítico — un veredicto probabilístico equivocado descarta gastos en silencio (rompe under-count auditable), agrega latencia dentro del límite de ~25s y no es reproducible entre corridas. El `ai-categorizer` ya implementado está bien ubicado: categorizar es bajo riesgo (un error es visible y corregible, no pierde plata) y converge a determinista vía reglas auto-creadas. IF tras un mes de uso el volumen de `insert_review` resulta alto, THEN se SHALL evaluar en v2 un asistente LLM que opere únicamente sobre transacciones ya insertadas con `needs_review = true`, sugiriendo resolución con razonamiento logueado, sin capacidad de descarte autónomo (puede reusar el cliente del ai-categorizer).
