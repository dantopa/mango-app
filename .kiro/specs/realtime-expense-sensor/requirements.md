# Requirements Document

## Introduction

Sistema de captura automática de gastos en tiempo real basado en notificaciones push de pagos NFC. Una app Android de terceros (Notification Forwarder) reenvía las notificaciones bancarias a un webhook en Next.js (Route Handler en Vercel), donde se parsean, normalizan a USD, registran en Maquinita y evalúan contra un semáforo de presupuesto mensual.

La arquitectura reemplaza la ingesta por email como fuente primaria. El email pasa a ser un mecanismo de reconciliación/auditoría en una fase posterior.

**Fases del sistema:**
- **Fase 0**: Logging crudo (recolectar payloads reales antes de escribir parsers)
- **Fase 1**: Parser + registro (pipeline completo por paquete Android)
- **Fase 2**: Dedupe cross-source + semáforo + alerta
- **Fase 3**: Reconciliación por email (posterior, fuera de alcance de este documento)

## Glossary

- **Route_Handler**: Endpoint HTTP en `app/api/push-ingest/route.ts` desplegado en Vercel que recibe los POST del forwarder Android.
- **Forwarder**: App Android de terceros (open-source) que captura notificaciones del sistema y las reenvía como POST JSON a una URL configurable.
- **Push_Payload**: Objeto JSON enviado por el Forwarder conteniendo metadata de la notificación (package name, title, text, timestamp, extras).
- **Parser_Registry**: Mapa de package name Android → función parser que extrae monto, moneda, comercio y metadata de un Push_Payload.
- **Dedup_Key**: Hash único derivado de (package + title + text + ventana temporal) que previene registros duplicados del mismo push.
- **Cross_Source_Dedup**: Lógica que detecta cuando dos pushes de DISTINTOS paquetes representan la misma compra (mismo monto dentro de ventana de 2 minutos).
- **Semáforo**: Función pura que calcula el estado del presupuesto mensual (verde/amarillo/rojo) comparando gasto acumulado vs techo configurable T.
- **Maquinita**: El sistema existente de finanzas personales (tabla `transactions` + MCP server).
- **Package_Name**: Identificador único de la app Android que generó la notificación (ej: `com.todo1.mobile` para Bancolombia).
- **FX_Service**: Servicio externo configurable para obtener tasa de cambio COP→USD (TBD).
- **Techo_T**: Monto máximo mensual en USD configurable que define el presupuesto del semáforo (TBD).
- **push_raw_log**: Tabla de logging permanente que almacena cada payload recibido sin procesar.
- **push_ingest_log**: Tabla de control de ingesta con dedup_key como clave primaria, estado de procesamiento y referencia a la transacción creada.

## Requirements

### Requerimiento 1: Recepción y Autenticación del Webhook (Fase 0+)

**User Story:** Como usuario, quiero que el sistema reciba de forma segura las notificaciones reenviadas desde mi teléfono, para que solo mi forwarder autorizado pueda enviar datos.

#### Criterios de Aceptación

1. WHEN el Forwarder envía un POST a `/api/push-ingest`, THE Route_Handler SHALL validar la presencia de un Bearer token en el header `Authorization`.
2. IF el Bearer token es ausente o no coincide con la variable de entorno `PUSH_INGEST_SECRET`, THEN THE Route_Handler SHALL responder con HTTP 401 y un body JSON `{"error": "unauthorized"}`.
3. WHEN el Bearer token es válido, THE Route_Handler SHALL aceptar el request para procesamiento posterior.
4. THE Route_Handler SHALL responder a todo request válido en menos de 3 segundos para evitar timeouts del Forwarder.
5. IF el body del request no es JSON válido, THEN THE Route_Handler SHALL responder con HTTP 400 y un body JSON `{"error": "invalid_json"}`.

---

### Requerimiento 2: Validación del Payload con Zod (Fase 0+)

**User Story:** Como desarrollador, quiero validar estrictamente la forma del payload recibido, para rechazar datos malformados antes de cualquier procesamiento.

#### Criterios de Aceptación

1. WHEN el Route_Handler recibe un payload autenticado, THE Route_Handler SHALL validar la estructura contra un schema Zod estricto.
2. THE Route_Handler SHALL requerir como mínimo los campos: `packageName` (string), `title` (string), `text` (string), `timestamp` (number o string ISO).
3. IF el payload no cumple el schema Zod, THEN THE Route_Handler SHALL responder con HTTP 422 y un body JSON conteniendo los errores de validación de Zod.
4. WHEN el payload cumple el schema, THE Route_Handler SHALL pasar el payload validado y tipado al siguiente paso del pipeline.

> **Nota**: El schema exacto de campos opcionales (extras, postTime, key) es TBD pendiente recolección de payloads reales en Fase 0.

---

### Requerimiento 3: Logging Crudo Permanente (Fase 0 — Modo Log-Only)

**User Story:** Como desarrollador, quiero guardar cada payload crudo recibido en una tabla de debug, para poder analizar la estructura real de las notificaciones antes de escribir parsers.

#### Criterios de Aceptación

1. WHEN el Route_Handler recibe un payload válido y autenticado, THE Route_Handler SHALL insertar una fila en `push_raw_log` conteniendo el payload JSON completo, el timestamp de recepción y el package name.
2. THE Route_Handler SHALL usar el cliente Supabase server-side con service role key para el INSERT (bypass de RLS).
3. WHEN el sistema está en modo Fase 0 (variable de entorno `PUSH_INGEST_MODE=log_only`), THE Route_Handler SHALL responder HTTP 200 con `{"status": "logged"}` inmediatamente después del INSERT, sin ejecutar parsing ni registro.
4. THE Route_Handler SHALL preservar las filas de `push_raw_log` indefinidamente como registro de auditoría (sin TTL automático en esta fase).
5. IF el INSERT en `push_raw_log` falla, THEN THE Route_Handler SHALL responder HTTP 500 con `{"error": "log_failed"}` y NO continuar el pipeline.

---

### Requerimiento 4: Rate Limiting del Endpoint

**User Story:** Como usuario, quiero que el endpoint público tenga protección contra abuso, para que un actor malicioso no pueda saturar la base de datos.

#### Criterios de Aceptación

1. THE Route_Handler SHALL limitar requests por IP a un máximo configurable por ventana temporal (ej: 60 requests por minuto — valor final TBD).
2. IF una IP excede el límite configurado, THEN THE Route_Handler SHALL responder con HTTP 429 y un header `Retry-After` indicando segundos de espera.
3. WHEN un request es rechazado por rate limiting, THE Route_Handler SHALL NO insertar nada en `push_raw_log`.

---

### Requerimiento 5: Parser Registry por Package Name (Fase 1)

**User Story:** Como desarrollador, quiero un sistema extensible de parsers indexado por package name Android, para agregar soporte para nuevos bancos sin modificar el pipeline principal.

#### Criterios de Aceptación

1. THE Parser_Registry SHALL mapear cada Package_Name soportado a exactamente una función parser.
2. WHEN el pipeline recibe un payload con un Package_Name registrado, THE Parser_Registry SHALL invocar el parser correspondiente con el payload completo.
3. IF el Package_Name del payload no tiene parser registrado, THEN THE Parser_Registry SHALL marcar el payload como `status: "no_parser"` en `push_ingest_log` y NO intentar registrar una transacción.
4. THE Parser_Registry SHALL soportar al menos los siguientes paquetes como target inicial (nombres exactos TBD pendiente verificación en dispositivo):
   - Bancolombia: `com.todo1.mobile`
   - Rappi/RappiCard: `com.grability.rappi` (verificar)
   - Nexo: `com.nexo.*` (verificar)
   - Google Wallet: `com.google.android.apps.walletnfcrel`
5. WHEN un parser extrae datos exitosamente, THE Parser_Registry SHALL retornar un objeto normalizado con: `amount_native`, `native_currency`, `merchant` (nullable), `tx_date`, `description_raw`, `account_name`.

> **Nota**: El formato exacto de cada notificación es TBD pendiente la recolección de payloads en Fase 0. Los parsers se escribirán después de analizar ~15-20 payloads reales.

---

### Requerimiento 6: Deduplicación por Transporte (Fase 1)

**User Story:** Como usuario, quiero que el sistema ignore notificaciones duplicadas del mismo evento, para que una compra no se registre dos veces si el forwarder reenvía.

#### Criterios de Aceptación

1. WHEN el parser extrae datos de un payload, THE Route_Handler SHALL calcular un Dedup_Key como hash de (packageName + title + text + timestamp truncado al minuto).
2. BEFORE insertar en `push_ingest_log`, THE Route_Handler SHALL verificar que el Dedup_Key no exista previamente en la tabla.
3. IF el Dedup_Key ya existe en `push_ingest_log`, THEN THE Route_Handler SHALL responder HTTP 200 con `{"status": "duplicate", "dedup_key": "<key>"}` y NO crear una transacción nueva.
4. WHEN el Dedup_Key es nuevo, THE Route_Handler SHALL insertar una fila en `push_ingest_log` con el dedup_key, datos parseados y `status: "processing"`.

---

### Requerimiento 7: Conversión de Moneda (FX) (Fase 1)

**User Story:** Como usuario, quiero que los gastos en COP se conviertan automáticamente a USD al momento de registro, para mantener consistencia con el modelo de datos de Maquinita.

#### Criterios de Aceptación

1. WHEN el parser retorna un gasto en moneda distinta a USD, THE Route_Handler SHALL obtener la tasa de cambio actual del FX_Service configurado.
2. THE Route_Handler SHALL calcular `amount_usd` como `amount_native * fx_rate_to_usd` redondeado a 4 decimales.
3. THE Route_Handler SHALL almacenar tanto `amount_native`, `native_currency`, `fx_rate_to_usd` como `amount_usd` en la transacción (snapshot congelado, consistente con el modelo existente de Maquinita).
4. IF la moneda nativa es USD o USDT, THEN THE Route_Handler SHALL usar `fx_rate_to_usd = 1` sin consultar el FX_Service.
5. IF el FX_Service no responde o falla, THEN THE Route_Handler SHALL marcar la transacción con `status: "fx_pending"` en `push_ingest_log` y reintentar en el próximo ciclo (mecanismo de retry TBD).

> **Nota**: La fuente de FX (API concreta) es TBD — debe ser configurable via variable de entorno.

---

### Requerimiento 8: Registro de Transacción en Maquinita (Fase 1)

**User Story:** Como usuario, quiero que cada gasto detectado se registre automáticamente en la tabla `transactions` de Maquinita, para verlo reflejado en el dashboard sin intervención manual.

#### Criterios de Aceptación

1. WHEN el pipeline completa parsing, dedup y FX exitosamente, THE Route_Handler SHALL insertar una fila en la tabla `transactions` con todos los campos requeridos por el schema existente.
2. THE Route_Handler SHALL usar el cliente Supabase server-side con service role key y stampar `user_id` con el OWNER_USER_ID configurado (mismo patrón que el MCP server existente).
3. THE Route_Handler SHALL mapear `account_name` del parser al `account_id` correspondiente en la tabla `accounts`.
4. WHEN la transacción se inserta exitosamente, THE Route_Handler SHALL actualizar `push_ingest_log` con `status: "registered"` y el `transaction_id` generado.
5. IF el INSERT en `transactions` falla, THEN THE Route_Handler SHALL actualizar `push_ingest_log` con `status: "registration_failed"` y el mensaje de error.

---

### Requerimiento 9: Clasificación de Categoría por Reglas de Merchant (Fase 1)

**User Story:** Como usuario, quiero que el sistema asigne categoría automáticamente basándose en reglas de merchant conocidas, para minimizar la categorización manual posterior.

#### Criterios de Aceptación

1. WHEN el parser extrae un nombre de merchant, THE Route_Handler SHALL consultar la tabla `merchant_category_rules` buscando una regla que coincida (pattern matching).
2. IF una regla coincide con el merchant, THEN THE Route_Handler SHALL asignar el `category_id` de esa regla a la transacción.
3. IF ninguna regla coincide, THEN THE Route_Handler SHALL insertar la transacción con `category_id = null` y marcar `needs_review = true`.
4. THE Route_Handler SHALL respetar el orden de prioridad de las reglas (regla más específica gana sobre regla genérica).

> **Nota**: La tabla `merchant_category_rules` y su lógica de aprendizaje por recategorización se reusan del spec existente de categorización automática.

---

### Requerimiento 10: Clasificación de Transferencias (Fase 1)

**User Story:** Como usuario, quiero que el sistema identifique automáticamente transferencias entre mis propias cuentas y las excluya del conteo de gastos, para que el semáforo refleje solo gastos reales.

#### Criterios de Aceptación

1. WHEN el parser extrae datos de un push, THE Route_Handler SHALL evaluar si el movimiento es una transferencia usando la tabla `transfer_classification_rules`.
2. IF el movimiento coincide con una regla de transferencia (allowlist), THEN THE Route_Handler SHALL marcar la transacción con `is_payment = true` para excluirla de totales de gasto.
3. IF el movimiento coincide con una regla de la denylist (gastos disfrazados de transferencia), THEN THE Route_Handler SHALL registrarlo como gasto normal.
4. WHEN no hay regla aplicable, THE Route_Handler SHALL aplicar el default del parser (gasto) y marcar `needs_review = true`.

> **Nota**: La tabla `transfer_classification_rules` se reusa del spec existente.

---

### Requerimiento 11: Deduplicación Cross-Source (Fase 2)

**User Story:** Como usuario, quiero que cuando recibo notificación del mismo pago desde dos apps distintas (ej: Google Wallet + Bancolombia), el sistema registre solo una transacción, para evitar doble conteo.

#### Criterios de Aceptación

1. WHEN el pipeline está por registrar una transacción, THE Route_Handler SHALL buscar en `push_ingest_log` transacciones de OTRO Package_Name con el mismo `amount_native` dentro de una ventana de 2 minutos.
2. IF se encuentra una coincidencia cross-source, THEN THE Route_Handler SHALL retener la transacción más informativa (la que tiene merchant name) y marcar la otra como `status: "deduped_cross_source"`.
3. IF ambas transacciones tienen el mismo nivel de información, THEN THE Route_Handler SHALL retener la primera registrada y descartar la segunda.
4. THE Route_Handler SHALL registrar en `push_ingest_log` la referencia al dedup_key de la transacción retenida cuando descarta un duplicado cross-source.
5. WHEN la ventana de 2 minutos pasa sin coincidencia, THE Route_Handler SHALL considerar la transacción como única y proceder normalmente.

---

### Requerimiento 12: Cálculo del Semáforo de Presupuesto (Fase 2)

**User Story:** Como usuario, quiero ver un indicador visual de mi ritmo de gasto mensual comparado con mi techo, para saber si voy bien o necesito frenar.

#### Criterios de Aceptación

1. WHEN se registra una nueva transacción de gasto (no transferencia, no pago), THE Semáforo SHALL recalcular el estado del presupuesto mensual.
2. THE Semáforo SHALL calcular el estado como función pura de: (gasto_acumulado_mes, Techo_T, día_del_mes, días_totales_del_mes).
3. THE Semáforo SHALL retornar estado "verde" WHEN el gasto acumulado es menor al ritmo proporcional esperado (gasto < T × día_actual / días_totales).
4. THE Semáforo SHALL retornar estado "amarillo" WHEN el gasto acumulado supera el ritmo proporcional pero no el techo (T × día_actual / días_totales ≤ gasto < T).
5. THE Semáforo SHALL retornar estado "rojo" WHEN el gasto acumulado iguala o supera el Techo_T.
6. THE Semáforo SHALL exponer el cálculo como función pura exportable para testing (sin side effects).

> **Nota**: El valor de Techo_T en USD es configurable (TBD — se definirá con el usuario).

---

### Requerimiento 13: Componente UI del Semáforo (Fase 2)

**User Story:** Como usuario, quiero ver el semáforo de presupuesto en el dashboard de la app, para tener visibilidad instantánea de mi estado financiero del mes.

#### Criterios de Aceptación

1. THE Semáforo_UI SHALL mostrar un indicador visual con tres estados (verde, amarillo, rojo) usando colores accesibles y texto descriptivo.
2. THE Semáforo_UI SHALL mostrar el gasto acumulado del mes, el techo configurado y el porcentaje consumido.
3. THE Semáforo_UI SHALL usar TanStack Query para obtener los datos y invalidar la query automáticamente cuando se registra una nueva transacción.
4. THE Semáforo_UI SHALL renderizarse con Recharts (gauge o barra de progreso) consistente con los gráficos existentes de la app.
5. WHEN el usuario navega al dashboard, THE Semáforo_UI SHALL mostrar datos actualizados sin requerir refresh manual.

---

### Requerimiento 14: Alerta al Cambiar de Estado (Fase 2)

**User Story:** Como usuario, quiero recibir una notificación cuando mi semáforo cambia de color, para enterarme incluso si no estoy mirando la app.

#### Criterios de Aceptación

1. WHEN el Semáforo cambia de estado (verde→amarillo, amarillo→rojo, o cualquier transición), THE Route_Handler SHALL disparar una alerta.
2. THE Route_Handler SHALL soportar al menos un canal de alerta configurable (mecanismo TBD: push de vuelta al teléfono, email, o notificación in-app).
3. THE Route_Handler SHALL incluir en la alerta: estado anterior, estado nuevo, gasto acumulado, techo y porcentaje consumido.
4. THE Route_Handler SHALL NO enviar alertas repetidas para el mismo cambio de estado (idempotencia por período + transición).

> **Nota**: El canal específico de alerta es TBD — se definirá con el usuario.

---

### Requerimiento 15: Schema de Base de Datos — push_raw_log

**User Story:** Como desarrollador, quiero una tabla dedicada para payloads crudos, para tener un registro completo de todo lo recibido independientemente del estado del pipeline.

#### Criterios de Aceptación

1. THE push_raw_log SHALL contener como mínimo: `id` (uuid PK), `user_id` (uuid FK), `package_name` (text), `payload` (jsonb), `received_at` (timestamptz), `created_at` (timestamptz).
2. THE push_raw_log SHALL tener un índice en `(user_id, received_at)` para consultas cronológicas.
3. THE push_raw_log SHALL tener RLS deshabilitado (escritura exclusiva por service role key desde el Route_Handler).
4. THE push_raw_log SHALL aceptar cualquier estructura en el campo `payload` (jsonb sin restricciones de schema).

---

### Requerimiento 16: Schema de Base de Datos — push_ingest_log

**User Story:** Como desarrollador, quiero una tabla de control de ingesta con dedup_key como PK, para tener trazabilidad completa del estado de procesamiento de cada push.

#### Criterios de Aceptación

1. THE push_ingest_log SHALL contener como mínimo: `dedup_key` (text PK), `user_id` (uuid FK), `package_name` (text), `amount_native` (numeric), `native_currency` (text), `amount_usd` (numeric nullable), `merchant` (text nullable), `status` (text), `transaction_id` (uuid FK nullable referenciando transactions), `raw_log_id` (uuid FK referenciando push_raw_log), `created_at` (timestamptz).
2. THE push_ingest_log SHALL usar `dedup_key` como PRIMARY KEY para garantizar unicidad a nivel de constraint (no solo lógica de aplicación).
3. THE push_ingest_log SHALL soportar los siguientes valores de `status`: `processing`, `registered`, `duplicate`, `deduped_cross_source`, `no_parser`, `fx_pending`, `registration_failed`, `transfer`.
4. THE push_ingest_log SHALL tener un índice en `(amount_native, created_at)` para facilitar búsquedas de Cross_Source_Dedup.
5. THE push_ingest_log SHALL tener RLS deshabilitado (escritura exclusiva por service role key).

---

### Requerimiento 17: Modo de Operación Configurable

**User Story:** Como desarrollador, quiero poder cambiar el modo de operación del pipeline sin redesplegar, para progresar entre fases de forma controlada.

#### Criterios de Aceptación

1. THE Route_Handler SHALL leer la variable de entorno `PUSH_INGEST_MODE` para determinar el modo de operación.
2. WHILE `PUSH_INGEST_MODE=log_only`, THE Route_Handler SHALL ejecutar solo: autenticación → validación → logging crudo → responder 200.
3. WHILE `PUSH_INGEST_MODE=full_pipeline`, THE Route_Handler SHALL ejecutar el pipeline completo: autenticación → validación → logging → parsing → dedup → FX → registro → semáforo.
4. IF `PUSH_INGEST_MODE` no está definido o tiene un valor desconocido, THEN THE Route_Handler SHALL operar en modo `log_only` como default seguro.

---

### Requerimiento 18: Respuesta Rápida al Forwarder

**User Story:** Como usuario, quiero que el webhook responda rápido para que el forwarder no acumule reintentos ni pierda notificaciones.

#### Criterios de Aceptación

1. THE Route_Handler SHALL responder al Forwarder dentro del límite de timeout de Vercel (máximo 10 segundos para hobby plan, objetivo < 3 segundos).
2. WHEN la llamada al FX_Service tarda más de 2 segundos, THE Route_Handler SHALL registrar la transacción con `status: "fx_pending"` y responder 200, delegando la resolución de FX a un mecanismo posterior.
3. THE Route_Handler SHALL ejecutar el INSERT en `push_raw_log` de forma síncrona antes de responder (garantía de no pérdida).
4. THE Route_Handler SHALL ejecutar parsing, dedup y registro de forma síncrona dentro del mismo request (aceptable dado que son operaciones de DB locales a Supabase).

---

## Apéndice A: Casos de Test Golden (Pendiente Fase 0)

> Los golden test cases se escribirán después de recolectar ~15-20 payloads reales por fuente durante la Fase 0. Se espera documentar aquí:
>
> - Payload típico de Bancolombia (compra NFC en COP)
> - Payload típico de RappiCard (compra NFC en COP)
> - Payload típico de Google Wallet (compra NFC — moneda varía)
> - Payload típico de Nexo (compra con tarjeta crypto)
> - Caso de duplicado por transporte (mismo push reenviado)
> - Caso de duplicado cross-source (Google Wallet + Bancolombia mismo pago)
> - Caso de transferencia entre cuentas propias
> - Caso de payload malformado / app no soportada

## Apéndice B: Decisiones Arquitectónicas Fijadas

| Decisión | Valor | Justificación |
|----------|-------|---------------|
| Runtime | Next.js Route Handler (Vercel) | Ya es el stack de la app, mismo deploy |
| Componente móvil | App Android terceros (Notification Forwarder) | Zero desarrollo Android |
| DB writes | Supabase service role key (bypass RLS) | Mismo patrón que MCP server existente |
| Validación | Zod | Ya en el stack |
| Parsers | Registry por package name | Extensible, mismo patrón que parsers de email |
| Semáforo | Función pura + Recharts + TanStack Query | Consistente con UI existente |
| FX source | Configurable (TBD) | No comprometer con un proveedor aún |
| Email | Fase 3 reconciliación | No fuente primaria |

## Apéndice C: Preguntas Abiertas (TBD)

1. **FX_Service**: ¿Qué API usar para COP→USD? (debe ser configurable)
2. **Techo_T**: ¿Cuál es el presupuesto mensual en USD? (configurable por env var o tabla)
3. **Canal de alerta**: ¿Push de vuelta al teléfono? ¿In-app? ¿Email? (Req 14)
4. **APK del forwarder**: ¿Cuál app usar? (confirmar con usuario)
5. **Package names exactos**: El usuario debe verificar en el dispositivo los package names reales
6. **Retención de push_raw_log**: ¿Aplicar TTL después de cierto tiempo? (datos sensibles)
7. **Rate limit concreto**: ¿60/min suficiente? ¿Ajustar después de ver patrones reales?
