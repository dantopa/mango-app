# Requirements Document

## Introduction

Funcionalidad de sincronización on-demand de gastos para la app Maquinita. Un botón "Sincronizar" en la página `/gastos` permite al usuario reconciliar transacciones de un mes seleccionado consultando fuentes externas (APIs bancarias, herramientas MCP) y cruzando contra las transacciones ya existentes en la base de datos.

El objetivo es **backfill**: recuperar gastos que el sensor push en tiempo real pudo haber perdido (teléfono apagado, app killeada, etc.) y permitir carga de datos históricos.

**Fases:**
- **Fase 1** (alcance de este documento): Sincronización desde Bancolombia API (via `browser-token-mcp`) y Nexo Card (via `nexo_get_card_transactions`).
- **Fase 2** (futura): Upload de CSV, parsing de emails Gmail, parsing de emails RappiCard.

**Relación con otros specs:**
- El spec `realtime-expense-sensor` cubre la captura push en tiempo real. Este spec complementa esa captura con reconciliación batch.
- La lógica de dedup cross-source existente (`push_ingest_log`, ventana de 2 minutos, mismo monto) se reutiliza y extiende con fuzzy merchant matching.

## Glossary

- **Sync_Engine**: Módulo server-side (Route Handlers en Next.js) que orquesta la consulta a fuentes externas, normalización y deduplicación de transacciones para un período dado.
- **Source_Adapter**: Función que consulta una fuente específica (Bancolombia API, Nexo MCP, etc.) y retorna transacciones en formato normalizado.
- **Sync_Dialog**: Componente UI (dialog/panel) que permite al usuario configurar y ejecutar una sincronización.
- **Dedup_Engine**: Módulo que compara transacciones candidatas del sync contra transacciones existentes en la tabla `transactions` para evitar duplicados.
- **Fuzzy_Matcher**: Función que normaliza nombres de comercio (uppercase, remove suffixes SA/SAS/COL, trim espacios) para comparación tolerante.
- **Sync_Run**: Una ejecución completa de sincronización para un mes y conjunto de fuentes seleccionadas. Tiene progreso y resultado.
- **Candidate_Transaction**: Transacción obtenida de una fuente externa durante el sync, antes de ser evaluada por el Dedup_Engine.
- **browser-token-mcp**: Edge Function de Supabase que expone herramientas MCP para consultar APIs bancarias (Bancolombia, Nexo) usando tokens del navegador del usuario.
- **Maquinita**: Sistema de finanzas personales — la app completa incluyendo tabla `transactions`, analytics y UI.
- **transactions**: Tabla principal de Supabase donde se almacenan todos los gastos normalizados (amount_native, native_currency, fx_rate_to_usd, amount_usd, merchant, tx_date, account_name, source, etc.).
- **push_ingest_log**: Tabla de control del sensor push con dedup_key como PK, usada para verificar si una transacción ya fue capturada en tiempo real.
- **needs_review**: Flag booleano en `transactions` que indica que el sistema no pudo determinar con certeza si la transacción es duplicada o nueva.

## Requirements

### Requerimiento 1: Botón de Sincronización en la UI

**User Story:** Como usuario, quiero un botón "Sincronizar" visible en la página de gastos, para poder iniciar manualmente la reconciliación de transacciones cuando lo necesite.

#### Criterios de Aceptación

1. THE Sync_Dialog SHALL ser accesible desde un botón "Sincronizar" ubicado en el header de la página `/gastos`.
2. WHEN el usuario presiona el botón "Sincronizar", THE Sync_Dialog SHALL abrirse mostrando opciones de configuración del sync.
3. THE Sync_Dialog SHALL mostrar un selector de mes con el mes actual como valor por defecto.
4. THE Sync_Dialog SHALL mostrar checkboxes para seleccionar las fuentes a sincronizar (Bancolombia, Nexo Card).
5. THE Sync_Dialog SHALL tener todas las fuentes seleccionadas por defecto al abrirse.
6. WHEN el usuario presiona "Iniciar sincronización" en el Sync_Dialog, THE Sync_Engine SHALL ejecutar el proceso de sync con los parámetros seleccionados.

---

### Requerimiento 2: Arquitectura de Ejecución por Fuente

**User Story:** Como usuario, quiero que la sincronización consulte cada fuente de forma independiente, para que un fallo en una fuente no bloquee las demás y se respeten los límites de timeout de Vercel.

#### Criterios de Aceptación

1. THE Sync_Engine SHALL exponer un Route Handler separado por cada fuente (ej: `/api/sync/bancolombia`, `/api/sync/nexo`).
2. WHEN el usuario inicia un sync con múltiples fuentes seleccionadas, THE Sync_Dialog SHALL invocar cada Route Handler de forma secuencial desde el cliente.
3. WHEN un Route Handler de fuente completa su ejecución, THE Sync_Dialog SHALL actualizar el progreso antes de invocar la siguiente fuente.
4. IF un Route Handler de fuente falla o excede 25 segundos, THEN THE Sync_Engine SHALL retornar un error parcial y THE Sync_Dialog SHALL continuar con la siguiente fuente.
5. THE Sync_Engine SHALL autenticar cada Route Handler verificando la sesión activa del usuario via Supabase Auth.

---

### Requerimiento 3: Source Adapter — Bancolombia API

**User Story:** Como usuario, quiero que el sync consulte mis movimientos de Bancolombia del mes seleccionado, para recuperar transacciones que el sensor push pudo haber perdido.

#### Criterios de Aceptación

1. WHEN el Sync_Engine recibe un request para sincronizar Bancolombia, THE Source_Adapter SHALL invocar la Edge Function `browser-token-mcp` con la herramienta `bancolombia_get_transactions` pasando el rango de fechas del mes seleccionado.
2. THE Source_Adapter SHALL transformar cada movimiento retornado por la API de Bancolombia al formato normalizado de Candidate_Transaction con los campos: `amount_native` (COP), `native_currency` ("COP"), `merchant`, `tx_date`, `description_raw`, `account_name` ("Bancolombia").
3. THE Source_Adapter SHALL filtrar movimientos de tipo crédito (abonos/transferencias entrantes) y retornar solo débitos (compras/pagos).
4. IF la Edge Function `browser-token-mcp` retorna un error de autenticación (token expirado), THEN THE Source_Adapter SHALL retornar un error descriptivo indicando que el usuario debe renovar la sesión bancaria.
5. THE Source_Adapter SHALL asignar `source: "sync_bancolombia"` a cada Candidate_Transaction generada.

---

### Requerimiento 4: Source Adapter — Nexo Card

**User Story:** Como usuario, quiero que el sync consulte mis transacciones de Nexo Card del mes seleccionado, para tener visibilidad completa de mis gastos con tarjeta crypto.

#### Criterios de Aceptación

1. WHEN el Sync_Engine recibe un request para sincronizar Nexo, THE Source_Adapter SHALL invocar la Edge Function `browser-token-mcp` con la herramienta `nexo_get_card_transactions` pasando el rango de fechas del mes seleccionado.
2. THE Source_Adapter SHALL transformar cada transacción retornada al formato normalizado de Candidate_Transaction con: `amount_native` (USD, ya que Nexo reporta en USD), `native_currency` ("USD"), `fx_rate_to_usd` (1), `amount_usd`, `merchant`, `tx_date`, `description_raw`, `account_name` ("Nexo Card").
3. IF la Edge Function retorna un error, THEN THE Source_Adapter SHALL retornar un error descriptivo con el mensaje original del fallo.
4. THE Source_Adapter SHALL asignar `source: "sync_nexo"` a cada Candidate_Transaction generada.

---

### Requerimiento 5: Deduplicación contra Transacciones Existentes

**User Story:** Como usuario, quiero que el sync detecte transacciones que ya existen en la base (ingresadas por push o por syncs anteriores), para no crear duplicados.

#### Criterios de Aceptación

1. WHEN el Sync_Engine recibe una lista de Candidate_Transactions, THE Dedup_Engine SHALL comparar cada candidata contra las transacciones existentes en la tabla `transactions` del mismo mes y cuenta.
2. THE Dedup_Engine SHALL considerar como duplicado probable a una Candidate_Transaction WHEN existe una transacción con el mismo `amount_native` y la misma `tx_date` en la misma cuenta.
3. WHEN se detecta un duplicado probable, THE Dedup_Engine SHALL aplicar el Fuzzy_Matcher para comparar nombres de comercio antes de descartar la candidata.
4. IF el Fuzzy_Matcher confirma similitud de merchant (después de normalización), THEN THE Dedup_Engine SHALL descartar la candidata como duplicado confirmado.
5. IF el monto y fecha coinciden pero el merchant normalizado difiere significativamente, THEN THE Dedup_Engine SHALL marcar la candidata como `needs_review: true` en lugar de descartarla o insertarla directamente.
6. THE Dedup_Engine SHALL verificar también contra `push_ingest_log` buscando entradas con `status: "registered"` del mismo monto y fecha, como señal adicional de duplicado.
7. WHEN no se encuentra ninguna coincidencia, THE Dedup_Engine SHALL marcar la candidata como nueva transacción lista para insertar.

---

### Requerimiento 6: Normalización de Nombres de Comercio (Fuzzy Matcher)

**User Story:** Como usuario, quiero que el sistema reconozca que "PERGAMINO VIVA ENVIGAD" y "PERGAMINO VIVA ENVIGADO SA" son el mismo comercio, para que la deduplicación funcione correctamente a pesar de las diferencias de formato entre fuentes.

#### Criterios de Aceptación

1. THE Fuzzy_Matcher SHALL normalizar nombres de comercio aplicando las siguientes transformaciones en orden: convertir a mayúsculas, eliminar sufijos corporativos (SA, SAS, S.A., S.A.S., LTDA, COL, S.L.), eliminar caracteres especiales no alfanuméricos, colapsar espacios múltiples a uno, trim de espacios.
2. WHEN dos merchants normalizados son idénticos, THE Fuzzy_Matcher SHALL retornar coincidencia confirmada.
3. WHEN un merchant normalizado es prefijo del otro (diferencia solo por truncamiento), THE Fuzzy_Matcher SHALL retornar coincidencia confirmada.
4. WHEN dos merchants normalizados difieren en más de 3 caracteres y no tienen relación de prefijo, THE Fuzzy_Matcher SHALL retornar no coincidencia.
5. THE Fuzzy_Matcher SHALL ser una función pura sin side effects, exportable para testing unitario.

---

### Requerimiento 7: Conversión de Moneda durante Sync

**User Story:** Como usuario, quiero que las transacciones sincronizadas en COP se conviertan a USD automáticamente, para mantener consistencia con el modelo de datos de Maquinita.

#### Criterios de Aceptación

1. WHEN una Candidate_Transaction tiene `native_currency` distinto a USD, THE Sync_Engine SHALL obtener la tasa de cambio usando el mismo FX_Service configurado para el pipeline push.
2. THE Sync_Engine SHALL calcular `amount_usd` como `amount_native * fx_rate_to_usd` redondeado a 4 decimales.
3. THE Sync_Engine SHALL almacenar `amount_native`, `native_currency`, `fx_rate_to_usd` y `amount_usd` en la transacción insertada.
4. IF la Candidate_Transaction tiene `native_currency` igual a USD, THEN THE Sync_Engine SHALL asignar `fx_rate_to_usd = 1` sin consultar el FX_Service.
5. IF el FX_Service falla, THEN THE Sync_Engine SHALL omitir la Candidate_Transaction del batch actual y reportarla como error en el resultado del sync.

---

### Requerimiento 8: Inserción de Transacciones Nuevas

**User Story:** Como usuario, quiero que las transacciones nuevas detectadas por el sync se inserten automáticamente en la tabla `transactions`, para que aparezcan en mis reportes sin intervención manual.

#### Criterios de Aceptación

1. WHEN el Dedup_Engine marca una Candidate_Transaction como nueva, THE Sync_Engine SHALL insertar una fila en la tabla `transactions` con todos los campos requeridos por el schema existente.
2. THE Sync_Engine SHALL usar el cliente Supabase server-side con service role key para el INSERT.
3. THE Sync_Engine SHALL resolver `account_id` a partir del `account_name` de la Candidate_Transaction consultando la tabla `accounts`.
4. THE Sync_Engine SHALL intentar auto-categorizar usando la tabla `merchant_category_rules` (misma lógica que el pipeline push).
5. IF no se encuentra regla de categorización, THEN THE Sync_Engine SHALL insertar con `category_id = null` y `needs_review = true`.
6. THE Sync_Engine SHALL asignar el campo `source` con el valor específico del Source_Adapter que originó la candidata (ej: "sync_bancolombia", "sync_nexo").

---

### Requerimiento 9: Progreso y Resultado del Sync

**User Story:** Como usuario, quiero ver el progreso de la sincronización mientras se ejecuta y un resumen al finalizar, para saber qué se encontró y qué acción tomó el sistema.

#### Criterios de Aceptación

1. WHILE el Sync_Engine está procesando una fuente, THE Sync_Dialog SHALL mostrar un indicador de progreso con el nombre de la fuente actual.
2. WHEN una fuente completa su procesamiento, THE Sync_Dialog SHALL mostrar un resumen parcial con: transacciones encontradas, duplicados descartados, nuevas insertadas, marcadas para revisión.
3. WHEN todas las fuentes completan su procesamiento, THE Sync_Dialog SHALL mostrar un resumen consolidado final.
4. THE Sync_Dialog SHALL mostrar el resumen final con los totales: fuentes consultadas, transacciones nuevas insertadas, duplicados descartados, transacciones marcadas `needs_review`.
5. WHEN el sync inserta transacciones nuevas, THE Sync_Dialog SHALL invalidar la query de transacciones de TanStack Query para refrescar la tabla de gastos.

---

### Requerimiento 10: Clasificación de Transferencias durante Sync

**User Story:** Como usuario, quiero que el sync identifique transferencias entre mis cuentas y las excluya del conteo de gastos, para que el semáforo refleje solo gastos reales.

#### Criterios de Aceptación

1. WHEN el Sync_Engine procesa una Candidate_Transaction, THE Sync_Engine SHALL evaluar si es una transferencia usando la tabla `transfer_classification_rules`.
2. IF la candidata coincide con una regla de transferencia (allowlist), THEN THE Sync_Engine SHALL insertar la transacción con `is_payment = true`.
3. IF la candidata coincide con una regla de la denylist, THEN THE Sync_Engine SHALL registrarla como gasto normal.
4. WHEN no hay regla aplicable y la descripción sugiere transferencia entre cuentas propias, THE Sync_Engine SHALL marcar `needs_review = true`.

---

### Requerimiento 11: Invocación Programática (Cron)

**User Story:** Como usuario, quiero que la sincronización pueda ejecutarse automáticamente de forma periódica, para mantener mis datos actualizados sin depender de que abra la app manualmente.

#### Criterios de Aceptación

1. THE Sync_Engine SHALL exponer un Route Handler `/api/sync/cron` que ejecuta un sync completo de todas las fuentes para el mes actual.
2. THE Route Handler de cron SHALL autenticarse mediante un Bearer token en el header `Authorization` comparado contra la variable de entorno `SYNC_CRON_SECRET`.
3. IF el Bearer token no coincide con `SYNC_CRON_SECRET`, THEN THE Route Handler SHALL responder con HTTP 401.
4. WHEN se invoca el endpoint de cron, THE Sync_Engine SHALL ejecutar el sync con todas las fuentes habilitadas para el mes actual y retornar un JSON con el resumen de resultados.
5. THE Route Handler de cron SHALL ser compatible con Vercel Cron Jobs (responder HTTP 200 en éxito, completar dentro del timeout).

---

### Requerimiento 12: Manejo de Errores y Resiliencia

**User Story:** Como usuario, quiero que si una fuente falla durante el sync las demás sigan funcionando y yo pueda ver claramente qué falló, para no perder el trabajo parcial.

#### Criterios de Aceptación

1. IF un Source_Adapter falla durante la ejecución, THEN THE Sync_Engine SHALL registrar el error y continuar con las fuentes restantes.
2. THE Sync_Engine SHALL retornar en la respuesta tanto los resultados exitosos como los errores por fuente.
3. IF todas las fuentes fallan, THEN THE Sync_Engine SHALL retornar HTTP 207 (Multi-Status) con el detalle de cada error.
4. THE Sync_Engine SHALL NO insertar transacciones parcialmente procesadas (si la dedup o FX falla para una candidata, esa candidata se omite sin afectar las demás).
5. IF la conexión a Supabase falla durante el INSERT batch, THEN THE Sync_Engine SHALL reportar las transacciones que no se pudieron insertar en el resumen de errores.

---

### Requerimiento 13: Estrategia Segura de Deduplicación (Under-count)

**User Story:** Como usuario, prefiero que el sync NO cree una transacción cuando hay duda, para evitar duplicados que inflen mi gasto reportado.

#### Criterios de Aceptación

1. WHEN el Dedup_Engine encuentra una coincidencia de monto y fecha pero no puede confirmar ni descartar duplicado, THE Dedup_Engine SHALL marcar la candidata con `needs_review = true` en lugar de insertarla como nueva.
2. THE Dedup_Engine SHALL aplicar el criterio: mismo `amount_native` + misma `tx_date` + misma cuenta → duplicado confirmado (descartar).
3. THE Dedup_Engine SHALL aplicar el criterio: mismo `amount_native` + misma `tx_date` + distinta cuenta → evaluar merchant con Fuzzy_Matcher.
4. WHEN existen dos transacciones del mismo monto en la misma fecha en la base (no es inusual), THE Dedup_Engine SHALL comparar contra cada una individualmente y solo descartar si hay match de merchant.
5. THE Dedup_Engine SHALL NO crear una transacción nueva cuando la cantidad de coincidencias ambiguas supera 1 para el mismo monto+fecha.

