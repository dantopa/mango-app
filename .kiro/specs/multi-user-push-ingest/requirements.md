# Requirements Document

## Introduction

Escalar el pipeline de push ingest para soportar múltiples usuarios. Actualmente, el endpoint `/api/push-ingest` usa un `OWNER_USER_ID` hardcodeado y un secreto compartido (`PUSH_INGEST_SECRET`) para autenticar todas las requests. El Android Forwarder (Tasker/app custom) envía notificaciones sin identificar al usuario.

Esta feature introduce un mecanismo de autenticación per-device que vincula cada dispositivo Android a un usuario de Supabase Auth, eliminando el `OWNER_USER_ID` hardcodeado y permitiendo que N usuarios conecten sus teléfonos para ingestar transacciones a sus respectivas cuentas.

**Enfoque recomendado:** Device API Keys — cada dispositivo genera un token único vinculado a un `user_id` en una tabla `device_api_keys`. El forwarder envía este token como Bearer token. Es el enfoque más simple, seguro y compatible con Tasker/apps custom sin requerir flujos OAuth complejos en el dispositivo.

**Alternativas descartadas:**
- **JWT de Supabase directo**: Los tokens expiran (1h default), requiriendo refresh en el forwarder — demasiado complejo para Tasker.
- **OAuth Device Flow**: Over-engineering para un app personal multi-user; requiere polling y UI de consentimiento.
- **HMAC per-request**: Complejidad innecesaria; requiere sincronización de reloj y manejo de nonce.

## Glossary

- **Push_Ingest_API**: El endpoint Next.js Route Handler en `/api/push-ingest` que recibe notificaciones push de dispositivos Android.
- **Android_Forwarder**: Aplicación Android (Tasker + AutoNotification, o app custom) que intercepta notificaciones push bancarias y las envía via HTTPS POST al Push_Ingest_API.
- **Device_API_Key**: Token opaco (formato `mng_` + 32 bytes random hex) generado por el sistema y vinculado a un user_id + device_name. Se usa como Bearer token para autenticar requests del Android_Forwarder.
- **Device_Registry**: Tabla `device_api_keys` que almacena los tokens hasheados, vincula dispositivos a usuarios, y permite revocación.
- **Onboarding_Flow**: Flujo en la webapp donde un usuario autenticado genera un Device_API_Key para configurar su Android_Forwarder.
- **Pipeline**: El proceso completo de ingesta: auth → raw log → parse → dedup → classify → FX → categorize → insert transaction.
- **Dedup_Key**: Hash SHA-256 de (packageName + title + text + minute-truncated timestamp). Actualmente global; debe incluir user_id para aislar por usuario.
- **Service_Role_Client**: Cliente Supabase con `service_role` key que bypasea RLS para operaciones administrativas del Pipeline.

## Requirements

### Requirement 1: Autenticación por Device API Key

**User Story:** Como usuario, quiero vincular mi teléfono Android a mi cuenta para que las notificaciones push que reenvíe se asocien automáticamente a mi usuario.

#### Acceptance Criteria

1. WHEN el Android_Forwarder envía un POST a `/api/push-ingest` con un header `Authorization: Bearer <Device_API_Key>`, THE Push_Ingest_API SHALL validar el token contra el Device_Registry usando comparación constant-time del hash SHA-256.
2. WHEN el token es válido y el dispositivo no está revocado, THE Push_Ingest_API SHALL extraer el `user_id` asociado y usarlo para toda la ejecución del Pipeline.
3. IF el header Authorization está ausente o el token no coincide con ningún registro activo en el Device_Registry, THEN THE Push_Ingest_API SHALL responder con HTTP 401 y body `{"error": "unauthorized"}`.
4. IF el dispositivo asociado al token tiene `revoked_at` no nulo, THEN THE Push_Ingest_API SHALL responder con HTTP 401 y body `{"error": "device_revoked"}`.
5. THE Push_Ingest_API SHALL registrar el `last_used_at` y la IP de origen en el Device_Registry tras cada request exitosa.

### Requirement 2: Registro y gestión de dispositivos (Device Registry)

**User Story:** Como usuario autenticado en la webapp, quiero generar tokens para mis dispositivos Android para poder configurar el forwarder sin compartir mis credenciales.

#### Acceptance Criteria

1. WHEN un usuario autenticado solicita registrar un nuevo dispositivo, THE Device_Registry SHALL generar un Device_API_Key con formato `mng_<64 hex chars>` (32 bytes random) y almacenar únicamente el hash SHA-256 del token.
2. THE Device_Registry SHALL almacenar por cada dispositivo: `id` (uuid PK), `user_id` (FK a auth.users), `device_name` (texto libre), `key_hash` (SHA-256 hex), `key_prefix` (primeros 8 chars del token para identificación visual), `created_at`, `last_used_at`, `last_ip`, `revoked_at`.
3. THE Push_Ingest_API SHALL mostrar el token completo al usuario una única vez al momento de creación; después solo se muestra el `key_prefix`.
4. WHEN un usuario solicita revocar un dispositivo, THE Device_Registry SHALL establecer `revoked_at` al timestamp actual sin eliminar el registro.
5. THE Device_Registry SHALL permitir un máximo de 10 dispositivos activos (no revocados) por usuario.
6. WHEN un usuario intenta registrar un dispositivo excediendo el límite de 10 activos, THE Device_Registry SHALL rechazar la operación con un mensaje descriptivo.

### Requirement 3: Flujo de onboarding en la webapp

**User Story:** Como usuario nuevo, quiero un flujo guiado para conectar mi teléfono Android a la app para empezar a recibir transacciones automáticamente.

#### Acceptance Criteria

1. WHEN un usuario autenticado navega a la sección de dispositivos, THE Webapp SHALL mostrar la lista de dispositivos registrados con `device_name`, `key_prefix`, `last_used_at`, y estado (activo/revocado).
2. WHEN el usuario hace clic en "Agregar dispositivo", THE Webapp SHALL solicitar un nombre descriptivo y generar el Device_API_Key mostrándolo una sola vez con opción de copiar al clipboard.
3. THE Webapp SHALL mostrar instrucciones de configuración para el Android_Forwarder incluyendo: URL del endpoint, el token generado, y el formato JSON esperado del body.
4. WHEN el usuario revoca un dispositivo, THE Webapp SHALL solicitar confirmación y mostrar que las notificaciones de ese dispositivo dejarán de procesarse.

### Requirement 4: Aislamiento de dedup por usuario

**User Story:** Como usuario, quiero que la deduplicación de notificaciones sea independiente por usuario para que dos usuarios que reciban la misma notificación bancaria (e.g., cuenta compartida) no se interfieran.

#### Acceptance Criteria

1. THE Pipeline SHALL computar el Dedup_Key incluyendo el `user_id` en el input del hash: SHA-256(`user_id` + `|` + `packageName` + `|` + `title` + `|` + `text` + `|` + `minute-truncated timestamp`).
2. WHEN dos usuarios diferentes envían una notificación push con el mismo contenido, THE Pipeline SHALL procesarlas como eventos independientes (ambos generan transacciones separadas).
3. WHEN el mismo usuario envía la misma notificación desde dos dispositivos diferentes, THE Pipeline SHALL detectarla como duplicado usando el Dedup_Key (que no incluye device_id).

### Requirement 5: Pipeline parametrizado por user_id

**User Story:** Como desarrollador, quiero que el pipeline use el user_id del dispositivo autenticado en todas las operaciones para eliminar el hardcoding del OWNER_USER_ID.

#### Acceptance Criteria

1. THE Pipeline SHALL recibir el `user_id` como parámetro de entrada (resuelto en la capa de auth) y usarlo en: inserción en `push_raw_log`, inserción en `push_ingest_log`, consulta de `merchant_category_rules`, consulta de `transfer_classification_rules`, resolución de cuentas, inserción de transacciones, consulta de `user_settings`, y envío de web push.
2. THE Pipeline SHALL eliminar toda referencia a la constante `OWNER_USER_ID` hardcodeada.
3. WHEN el Pipeline consulta reglas de categorización o clasificación, THE Pipeline SHALL filtrar exclusivamente por el `user_id` del dispositivo autenticado.
4. WHEN el Pipeline evalúa el semáforo de presupuesto, THE Pipeline SHALL sumar gastos únicamente del `user_id` autenticado.

### Requirement 6: Compatibilidad con Android Forwarder

**User Story:** Como usuario, quiero que la configuración en mi Android Forwarder sea mínima para poder migrar del sistema actual con un solo cambio (el token).

#### Acceptance Criteria

1. THE Android_Forwarder SHALL enviar el Device_API_Key en el header `Authorization: Bearer <token>` en cada POST a `/api/push-ingest`.
2. THE Push_Ingest_API SHALL mantener el mismo formato de payload JSON existente (`packageName`, `title`, `text`, `timestamp`, campos opcionales) sin cambios.
3. THE Push_Ingest_API SHALL mantener el mismo formato de response JSON existente para no romper lógica del forwarder que dependa del status.
4. IF el Android_Forwarder envía un POST sin header Authorization (comportamiento legacy), THEN THE Push_Ingest_API SHALL responder con HTTP 401 indicando que se requiere autenticación.

### Requirement 7: Migración del usuario existente

**User Story:** Como usuario actual (OWNER_USER_ID), quiero que mis datos históricos y configuración se preserven durante la migración al sistema multi-user.

#### Acceptance Criteria

1. WHEN se despliega el sistema multi-user, THE Migration SHALL crear automáticamente un Device_API_Key para el usuario existente (OWNER_USER_ID) y retornar el token para reconfigurar el forwarder.
2. THE Migration SHALL preservar todos los registros históricos en `push_ingest_log` y `push_raw_log` sin modificaciones (ya tienen `user_id` correcto).
3. THE Migration SHALL re-computar los Dedup_Keys existentes para incluir `user_id` en el hash, actualizando la PK de `push_ingest_log` para reflejar el nuevo esquema.
4. IF la migración de Dedup_Keys falla parcialmente, THEN THE Migration SHALL hacer rollback de todos los cambios y reportar los registros afectados.

### Requirement 8: Seguridad y rate limiting por dispositivo

**User Story:** Como operador del sistema, quiero proteger el endpoint contra abuso por dispositivos comprometidos sin afectar a otros usuarios.

#### Acceptance Criteria

1. THE Push_Ingest_API SHALL aplicar rate limiting independiente por Device_API_Key (no solo por IP) con un límite de 60 requests por minuto por dispositivo.
2. IF un dispositivo excede el rate limit, THEN THE Push_Ingest_API SHALL responder con HTTP 429 e incluir header `Retry-After`.
3. THE Device_Registry SHALL almacenar los tokens como hash SHA-256 (nunca en texto plano) para que una filtración de la base de datos no exponga tokens válidos.
4. WHEN un token es revocado, THE Push_Ingest_API SHALL rechazar requests con ese token dentro de un máximo de 60 segundos (tiempo de propagación de caché).

### Requirement 9: Eliminación del secreto compartido legacy

**User Story:** Como desarrollador, quiero eliminar el `PUSH_INGEST_SECRET` compartido una vez que todos los dispositivos migren a Device API Keys.

#### Acceptance Criteria

1. WHILE existan dispositivos que aún usen el secreto legacy (`PUSH_INGEST_SECRET`), THE Push_Ingest_API SHALL aceptar ambos mecanismos de auth: Device_API_Key (preferido) o el secreto legacy vinculado al OWNER_USER_ID.
2. WHEN todos los dispositivos hayan migrado a Device_API_Key, THE Push_Ingest_API SHALL permitir eliminar la variable de entorno `PUSH_INGEST_SECRET` sin afectar la operación.
3. THE Push_Ingest_API SHALL loggear un warning cuando se reciba una request autenticada con el secreto legacy para visibilizar dispositivos pendientes de migración.
