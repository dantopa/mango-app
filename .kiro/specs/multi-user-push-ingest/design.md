# Multi-User Push Ingest — Design

## Overview

Eliminar el `OWNER_USER_ID` hardcodeado del pipeline de push ingest y reemplazarlo con un sistema de **Device API Keys**: tokens opacos vinculados a `user_id` en una tabla `device_api_keys`. El Android Forwarder envía el token como Bearer header y el sistema resuelve el usuario automáticamente.

### Decisiones de diseño

| Pregunta | Decisión | Por qué |
|---|---|---|
| ¿Cómo identifica el forwarder al usuario? | Device API Key (Bearer token) | Los tokens no expiran (a diferencia de JWT), son triviales de configurar en Tasker (un header estático), y no requieren flujos OAuth complejos en Android. |
| ¿Formato del token? | `mng_` + 64 hex chars (32 bytes random) | Prefijo permite identificación visual y auditoría de logs sin exponer el secreto. 256 bits de entropía es seguro contra brute force. |
| ¿Cómo se almacena? | SHA-256 del token en DB; token plano mostrado 1 sola vez | Si la DB se filtra, los tokens no son recuperables. Patrón estándar de API keys (GitHub, Stripe, etc.). |
| ¿Rate limiting por qué eje? | Por device key (no solo IP) | Un dispositivo comprometido no debe poder saturar el sistema; dos dispositivos legítimos detrás del mismo NAT no deben bloquearse mutuamente. |
| ¿Dedup key con user_id? | Sí, user_id se incluye en el input del hash | Dos usuarios con cuenta bancaria compartida recibirán la misma notificación; sin aislamiento uno bloquearía al otro. |
| ¿Periodo de transición? | Dual auth: Device Key preferido, secreto legacy acepta vinculado a OWNER_USER_ID | Permite migrar sin downtime. Warning en logs señala dispositivos pendientes. |
| ¿Cambios en el payload del forwarder? | Ninguno; solo agregar header Authorization | Mínimo esfuerzo de migración: un solo campo en la config de Tasker/app. |

## Architecture

### Auth Flow (per-request)

```
Android Forwarder                   /api/push-ingest                   device_api_keys
     │                                     │                                │
     │── POST + Bearer mng_abc123...──────▶│                                │
     │                                     │── SHA-256(token) ─────────────▶│
     │                                     │◀── { user_id, revoked_at } ────│
     │                                     │                                │
     │                                     │── if revoked → 401             │
     │                                     │── else → executePipeline(payload, user_id)
     │◀── 200 { status: "registered" } ───│
```

### Onboarding Flow

```
Usuario (webapp)                /api/devices                     device_api_keys
     │                              │                                │
     │── POST { device_name } ─────▶│                                │
     │   (sesión Supabase auth)     │── count active ≤ 10? ─────────▶│
     │                              │── generate token ──────────────▶│ INSERT (key_hash, user_id...)
     │◀── 200 { token: "mng_..." } ─│                                │
     │                              │                                │
     │   (usuario copia token       │                                │
     │    y configura en Android)   │                                │
```

### Pipeline parametrizado

```
executePipeline(payload, userId):    ← antes: executePipeline(payload, mode)
  1. computeDedupKey(payload, userId)  ← antes: computeDedupKey(payload)
  2. isDuplicate(dedupKey)
  3. parse(payload)
  4. insert push_ingest_log (user_id = userId)
  5. classifyTransaction(parsed, userId)
  6. resolveRate(...)
  7. resolveDuplicate(candidate, userId, ...)
  8. categorize(merchant, userId)
  9. resolve account (userId)
  10. insert transaction (user_id = userId)
  11. semaphore (userId)
  12. web push (userId)
```

## Components and Interfaces

### File Structure

```
src/lib/push-ingest/
  auth.ts                       [MODIFICAR] Dual auth: Device Key + legacy secret
  pipeline.ts                   [MODIFICAR] Eliminar OWNER_USER_ID, recibir userId param
  dedup.ts                      [MODIFICAR] computeDedupKey incluye userId
  device-keys.ts                [NUEVO] Generación, hashing, validación de Device API Keys
  rate-limiter.ts               [MODIFICAR] Rate limit por device key además de IP

src/app/api/push-ingest/
  route.ts                      [MODIFICAR] Resolver userId desde auth, pasar a pipeline

src/app/api/devices/
  route.ts                      [NUEVO] GET (listar), POST (crear device key)
  [id]/route.ts                 [NUEVO] DELETE (revocar device key)

src/app/(app)/dispositivos/
  page.tsx                      [NUEVO] UI de gestión de dispositivos
  loading.tsx                   [NUEVO] Loading state

supabase/migrations/
  20260201000001_device_api_keys.sql  [NUEVO] Tabla + índices + RLS
  20260201000002_migrate_dedup_keys.sql [NUEVO] Re-computar dedup keys existentes
```

### Types and Interfaces

```ts
// src/lib/push-ingest/device-keys.ts

export interface DeviceApiKey {
  id: string;           // uuid
  user_id: string;      // FK auth.users
  device_name: string;  // texto libre del usuario
  key_hash: string;     // SHA-256 hex del token completo
  key_prefix: string;   // primeros 8 chars del token (mng_xxxx)
  created_at: string;
  last_used_at: string | null;
  last_ip: string | null;
  revoked_at: string | null;
}

export interface DeviceAuthResult {
  ok: true;
  userId: string;
  deviceId: string;
}

export interface GeneratedDeviceKey {
  token: string;        // mng_ + 64 hex chars (mostrar 1 vez)
  id: string;           // uuid del registro
  key_prefix: string;   // primeros 8 chars
}

// src/lib/push-ingest/auth.ts (modificación)
export type AuthResult =
  | { ok: true; userId: string; deviceId: string | null; authMethod: "device_key" | "legacy_secret" }
  | { ok: false; status: 401; body: { error: "unauthorized" | "device_revoked" } };
```

### API Endpoints

#### `POST /api/push-ingest` (modificación)

Sin cambios en payload ni response. El cambio es interno: resuelve `userId` desde el auth y lo pasa al pipeline.

```ts
// Antes:
const result = await executePipeline(payload, "full_pipeline");
// Después:
const result = await executePipeline(payload, authResult.userId);
```

#### `GET /api/devices` (nuevo)

Requiere sesión Supabase Auth. Retorna dispositivos del usuario.

```ts
// Response 200
{
  devices: Array<{
    id: string;
    device_name: string;
    key_prefix: string;
    created_at: string;
    last_used_at: string | null;
    is_active: boolean;
  }>
}
```

#### `POST /api/devices` (nuevo)

Requiere sesión Supabase Auth. Crea un nuevo device key.

```ts
// Request
{ device_name: string }  // max 50 chars

// Response 201
{
  token: string;       // mng_... (mostrar 1 sola vez)
  id: string;
  device_name: string;
  key_prefix: string;
  instructions: {
    url: string;       // URL del endpoint
    header: string;    // "Authorization: Bearer mng_..."
    payload_example: object;
  }
}

// Error 409: { error: "max_devices_reached", limit: 10 }
```

#### `DELETE /api/devices/[id]` (nuevo)

Requiere sesión Supabase Auth. Revoca un dispositivo.

```ts
// Response 200
{ revoked: true, device_name: string }

// Error 404: { error: "device_not_found" }
```

## Data Models

### Nueva tabla: `device_api_keys`

```sql
CREATE TABLE IF NOT EXISTS public.device_api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_name text NOT NULL CHECK (char_length(device_name) <= 50),
  key_hash    text NOT NULL UNIQUE,   -- SHA-256 hex del token
  key_prefix  text NOT NULL,          -- primeros 8 chars del token (para UI)
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  last_ip     text,
  revoked_at  timestamptz
);

-- Índice para lookup por hash (auth path caliente)
CREATE INDEX idx_device_keys_hash ON public.device_api_keys(key_hash) WHERE revoked_at IS NULL;

-- Índice para listar dispositivos de un usuario
CREATE INDEX idx_device_keys_user ON public.device_api_keys(user_id, created_at);

-- RLS: usuarios solo ven/gestionan sus propios dispositivos
ALTER TABLE public.device_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own devices"
  ON public.device_api_keys
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role bypasses RLS para validación de token en el pipeline
COMMENT ON TABLE public.device_api_keys IS
  'API keys por dispositivo Android para push ingest. Token almacenado como hash SHA-256.';
```

### Modificación del Dedup Key

El dedup key pasa de:
```
SHA-256(packageName | title | text | minuteTruncated)
```
a:
```
SHA-256(userId | packageName | title | text | minuteTruncated)
```

Esto requiere una migración de datos para re-computar los dedup keys existentes (todos pertenecen a OWNER_USER_ID).

### Migración de dedup keys

```sql
-- Migración transaccional: re-computa todos los dedup_key existentes
-- incluyendo el OWNER_USER_ID como prefijo del hash input.
-- Se ejecuta en una transacción; si falla parcialmente, rollback completo.

-- Nota: esta migración usa una función PL/pgSQL para computar los nuevos hashes
-- usando la misma lógica que el código TypeScript.

CREATE OR REPLACE FUNCTION migrate_dedup_keys_multi_user()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  new_key text;
  owner_id text := 'e99371b1-6163-4216-b624-c79d8ee01520';
BEGIN
  -- Crear tabla temporal con mapping old_key → new_key
  CREATE TEMP TABLE dedup_migration AS
  SELECT
    dedup_key as old_key,
    encode(
      sha256(
        convert_to(
          owner_id || '|' || 
          -- Extraer los componentes originales no es posible desde un hash.
          -- En su lugar, recreamos el key desde push_raw_log.
          -- ALTERNATIVA: marcar los existentes y dejar que el nuevo esquema solo aplique a nuevos.
          dedup_key,  -- placeholder
          'UTF8'
        )
      ),
      'hex'
    ) as new_key
  FROM push_ingest_log
  WHERE FALSE; -- No ejecutar realmente; ver nota abajo

  -- NOTA DE IMPLEMENTACIÓN:
  -- Los dedup_key existentes son hashes — no podemos rehashearlos con user_id.
  -- Estrategia real: agregar columna user_id_scope al constraint check,
  -- y que el nuevo código genere claves con user_id incluido.
  -- Los registros existentes permanecen con su dedup_key original (no colisionan
  -- porque el nuevo formato produce hashes distintos).
  -- La PK sigue siendo dedup_key (texto), el cambio es solo en el cómputo del hash.

  DROP TABLE IF EXISTS dedup_migration;
END $$;
```

**Decisión simplificada**: Los dedup_keys existentes son hashes irreversibles — no se puede recalcularlos. La estrategia es:
1. Los registros existentes mantienen su dedup_key actual (todos son del OWNER_USER_ID)
2. El nuevo código genera dedup_keys con user_id incluido en el input
3. No hay colisión porque el hash es diferente al incluir un prefijo nuevo
4. Efecto: si el OWNER_USER_ID recibe la misma notificación que ya procesó en el sistema legacy, NO se detectará como duplicado. Esto es aceptable porque la ventana de overlap es mínima (deploy único) y el cross-source dedup catch-all lo detectaría de todas formas.

## Correctness Properties

### Property 1: Token format invariant

**Validates: Requirements 2.1**

∀ token generado por `generateDeviceKey()`, el token cumple `/^mng_[a-f0-9]{64}$/` y tiene 256 bits de entropía.

### Property 2: Hash isolation — token no recuperable

**Validates: Requirements 8.3**

∀ token T, `SHA-256(T)` almacenado en DB no permite reconstruir T. (Verificable: `validateToken(hash) ≠ T` para cualquier input directo.)

### Property 3: Auth constant-time

**Validates: Requirements 1.1**

∀ token válido/inválido, el tiempo de `validateDeviceAuth()` no varía significativamente con la posición del primer carácter diferente. (Testeable como property: medir varianza de timing sobre 1000 runs con tokens que difieren en posición 0 vs posición 63.)

### Property 4: Dedup key user isolation

**Validates: Requirements 4.1, 4.2**

∀ payload P y userId A ≠ B: `computeDedupKey(P, A) ≠ computeDedupKey(P, B)`. Misma notificación, usuarios distintos → claves diferentes.

### Property 5: Dedup key device independence

**Validates: Requirements 4.3**

∀ payload P, userId U, y deviceId D1 ≠ D2: `computeDedupKey(P, U) === computeDedupKey(P, U)`. El device_id NO participa en el hash — duplicados del mismo user desde distintos devices se detectan.

### Property 6: Rate limit per-device fairness

**Validates: Requirements 8.1**

∀ deviceKey D: las primeras 60 requests en una ventana de 60s retornan `allowed: true`; la request 61 retorna `allowed: false` con `retryAfter > 0`. Requests de un deviceKey diferente no se ven afectadas.

### Property 7: Backward compatibility — payload unchanged

**Validates: Requirements 6.2, 6.3**

∀ payload válido bajo el schema actual (`pushPayloadSchema`), el endpoint retorna el mismo conjunto de status codes posibles que antes. No se agrega ni remueve ningún campo del response.

### Property 8: Active device limit

**Validates: Requirements 2.5, 2.6**

∀ userId U: si `count(active devices for U) === 10`, el siguiente `createDeviceKey(U, name)` retorna error sin modificar la tabla.

## Error Handling

| Falla | Detección | Comportamiento | HTTP |
|---|---|---|---|
| Token ausente | Header missing | `{ error: "unauthorized" }` | 401 |
| Token inválido | Hash no encontrado en device_api_keys | `{ error: "unauthorized" }` | 401 |
| Token revocado | `revoked_at IS NOT NULL` | `{ error: "device_revoked" }` | 401 |
| Rate limit excedido | Contador por device key > 60/min | `{ error: "rate_limited" }` + Retry-After | 429 |
| Legacy secret usado | Token = PUSH_INGEST_SECRET | Warning log + continúa con OWNER_USER_ID | 200 |
| Max devices reached | count active ≥ 10 | `{ error: "max_devices_reached", limit: 10 }` | 409 |
| DB error en auth | Supabase query falla | `{ error: "internal_server_error" }` | 500 |

## Testing Strategy

### Unit Tests

- `device-keys.ts`: generación de token (formato), hashing (determinístico), validación (happy path + revocado + inexistente)
- `auth.ts`: dual auth (device key preferido, legacy fallback, ambos ausentes)
- `dedup.ts`: nuevo `computeDedupKey` con user_id (isolation + determinism)
- `rate-limiter.ts`: límite por device key (window + reset + independence)

### Property-Based Tests (fast-check)

Properties 1, 4, 5, 6, 8 del listado de Correctness Properties.

### Integration Tests

- Pipeline end-to-end con device key → transacción insertada con user_id correcto
- Dos users misma notificación → ambos procesan independientemente
- Mismo user dos devices misma notif → solo 1 procesa (dedup)
- Revocación inmediata → siguiente request rechazada

### Migration Test

- Script de validación post-migración: verificar que OWNER_USER_ID tiene un device key generado y que los registros históricos son accesibles.
