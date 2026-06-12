# Implementation Plan: Multi-User Push Ingest

## Overview

Migración del pipeline de push ingest de single-user (OWNER_USER_ID hardcodeado) a multi-user usando Device API Keys. El Android Forwarder envía un token opaco como Bearer header; el sistema resuelve el user_id y lo propaga por todo el pipeline. Incluye onboarding UI, migración de datos, y periodo de transición con dual-auth. Código en inglés, UI en español. Antes de escribir route handlers, leer las guías de Next 16 en `node_modules/next/dist/docs/`.

## Tasks

- [ ] 1. Fundaciones: tabla y módulo de Device API Keys (Wave 0)
  - [ ] 1.1 Migración `20260201000001_device_api_keys.sql`
    - Crear tabla `device_api_keys` con columnas: id (uuid PK), user_id (FK auth.users ON DELETE CASCADE), device_name (text, max 50), key_hash (text UNIQUE), key_prefix (text), created_at (timestamptz), last_used_at (timestamptz), last_ip (text), revoked_at (timestamptz). Índices: `idx_device_keys_hash` (WHERE revoked_at IS NULL), `idx_device_keys_user` (user_id, created_at). RLS habilitado con policy "Users manage own devices" (auth.uid() = user_id). Comentarios en tabla y columnas clave.
    - _Requirements: 2.2, 8.3_

  - [ ] 1.2 `src/lib/push-ingest/device-keys.ts`
    - Implementar `generateDeviceKey(userId, deviceName)`: genera 32 bytes random con `crypto.randomBytes`, formatea como `mng_` + hex, computa SHA-256 del token completo, inserta en `device_api_keys` via service_role client, retorna `{ token, id, key_prefix }`. Implementar `validateDeviceToken(token)`: computa SHA-256, busca en `device_api_keys` donde `key_hash = hash` y `revoked_at IS NULL`, retorna `{ ok, userId, deviceId }` o error. Implementar `revokeDevice(deviceId, userId)`: UPDATE `revoked_at = now()` WHERE `id = deviceId AND user_id = userId`. Implementar `countActiveDevices(userId)`: count WHERE `user_id = userId AND revoked_at IS NULL`. Usar comparación constant-time del hash con `timingSafeEqual`.
    - _Requirements: 1.1, 2.1, 2.4, 2.5, 8.3_

  - [ ] 1.3 Tests unitarios de `device-keys.ts`
    - Tests con vitest: formato del token generado (regex `/^mng_[a-f0-9]{64}$/`), hash es determinístico para mismo token, validación retorna userId correcto, token revocado retorna error, token inexistente retorna error. Mock de Supabase admin client.
    - _Requirements: 1.1, 2.1, 2.4_

- [ ] 2. Auth dual y pipeline parametrizado (Wave 1 — depende de Wave 0)
  - [ ] 2.1 Modificar `src/lib/push-ingest/auth.ts`
    - Refactorear `validateAuth` para retornar `AuthResult` extendido con `userId`, `deviceId`, y `authMethod`. Lógica: (1) intentar validar como Device API Key via `validateDeviceToken`; (2) si falla, intentar como legacy secret (PUSH_INGEST_SECRET) → si match, retornar `userId = OWNER_USER_ID` con `authMethod: "legacy_secret"` y loggear warning; (3) si ambos fallan → 401. Tipo de retorno: `{ ok: true; userId: string; deviceId: string | null; authMethod: "device_key" | "legacy_secret" } | { ok: false; status: 401; body: { error: "unauthorized" | "device_revoked" } }`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 9.1, 9.3_

  - [ ] 2.2 Modificar `src/lib/push-ingest/dedup.ts`
    - `computeDedupKey(payload, userId)`: agregar userId como primer segmento del input hash → `SHA-256(userId + "|" + packageName + "|" + title + "|" + text + "|" + minuteTruncated)`. Actualizar la firma y todos los call sites.
    - _Requirements: 4.1_

  - [ ] 2.3 Modificar `src/lib/push-ingest/pipeline.ts`
    - Cambiar firma de `executePipeline(payload, mode)` a `executePipeline(payload, userId)` (mode "full_pipeline" es el único usado, eliminar el parámetro). Eliminar la constante `OWNER_USER_ID`. Reemplazar todas las ~15 ocurrencias de `OWNER_USER_ID` por el parámetro `userId`. Actualizar llamada a `computeDedupKey(payload, userId)`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ] 2.4 Modificar `src/app/api/push-ingest/route.ts`
    - Usar el nuevo `validateAuth` que retorna `userId`. Pasar `authResult.userId` a `executePipeline`. Eliminar la constante `OWNER_USER_ID` del route handler. Actualizar `push_raw_log` insert para usar `authResult.userId`. Si `authMethod === "legacy_secret"`, loggear `console.warn("[push-ingest] legacy auth used — migrate to device key")`.
    - _Requirements: 1.2, 5.1, 9.3_

  - [ ] 2.5 Modificar `src/lib/push-ingest/rate-limiter.ts`
    - Agregar rate limiting por device key (además del existente por IP). Interfaz: `checkRateLimit(ip, deviceId?)`. Si `deviceId` está presente, aplicar límite de 60 req/min por dispositivo. El rate limit por IP se mantiene como protección adicional. Usar el mismo patrón de sliding window o token bucket existente.
    - _Requirements: 8.1, 8.2_

  - [ ] 2.6 Tests unitarios de auth dual y dedup modificado
    - Auth: device key válido retorna userId, legacy secret retorna OWNER_USER_ID con warning, ambos ausentes → 401, device revocado → 401 con "device_revoked". Dedup: mismo payload + mismo userId = mismo key, mismo payload + distinto userId ≠ key, device_id no afecta el key. Rate limiter: 60 requests pasan, 61 rechazada, diferente device no afectado.
    - _Requirements: 1.1, 1.3, 1.4, 4.1, 4.2, 4.3, 8.1, 9.1_

- [ ] 3. API de gestión de dispositivos (Wave 2 — depende de Wave 0)
  - [ ] 3.1 `src/app/api/devices/route.ts`
    - GET: requiere sesión Supabase Auth (usar `createClient` del server). Retorna dispositivos del usuario: `SELECT id, device_name, key_prefix, created_at, last_used_at, revoked_at FROM device_api_keys WHERE user_id = session.user.id ORDER BY created_at DESC`. POST: validar body con Zod (`{ device_name: string, max 50 chars }`), verificar `countActiveDevices ≤ 10`, llamar `generateDeviceKey`, retornar 201 con token + instrucciones (URL endpoint, header format, payload example).
    - _Requirements: 2.1, 2.3, 2.5, 2.6, 3.2, 3.3_

  - [ ] 3.2 `src/app/api/devices/[id]/route.ts`
    - DELETE: requiere sesión Supabase Auth. Validar que el device pertenece al usuario (RLS lo hace automáticamente con client auth). Llamar `revokeDevice(id, userId)`. Retornar 200 con `{ revoked: true }`. Si no existe o no pertenece al user → 404.
    - _Requirements: 2.4, 3.4_

  - [ ] 3.3 Tests de los endpoints de dispositivos
    - POST: genera token con formato correcto, segundo dispositivo funciona, 11vo dispositivo → 409. GET: lista dispositivos sin mostrar token/hash. DELETE: revoca correctamente, segundo DELETE del mismo → 404. Autenticación: requests sin sesión → 401.
    - _Requirements: 2.1, 2.3, 2.5, 2.6_

- [ ] 4. UI de gestión de dispositivos (Wave 3 — depende de Wave 2)
  - [ ] 4.1 `src/app/(app)/dispositivos/page.tsx`
    - Página con lista de dispositivos (tabla: nombre, prefijo, último uso, estado activo/revocado). Botón "Agregar dispositivo" que abre dialog para ingresar nombre. Al crear exitosamente: muestra token UNA VEZ con botón copiar y advertencia "Este token no se volverá a mostrar". Sección de instrucciones con URL, header, y payload de ejemplo. Botón revocar por dispositivo con diálogo de confirmación. Textos en español.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 4.2 `src/app/(app)/dispositivos/loading.tsx`
    - Skeleton loader consistente con los demás loading.tsx del proyecto.
    - _Requirements: 3.1_

  - [ ] 4.3 Agregar link en navegación
    - Agregar entrada "Dispositivos" en el layout/nav del app. Ícono de smartphone. Posición: después de las pantallas principales (gastos, patrimonio, objetivos).
    - _Requirements: 3.1_

- [ ] 5. Migración de datos y transición (Wave 4 — depende de Wave 1)
  - [ ] 5.1 Script de migración: generar Device API Key para OWNER_USER_ID
    - Crear migración SQL `20260201000002_seed_owner_device_key.sql` que inserta un device_api_key para el OWNER_USER_ID con device_name "Android Principal (migrado)". El token se genera en un script Node separado (`scripts/migrate-owner-device.ts`) que imprime el token por stdout (para configurar en el forwarder) e inserta el hash en DB. Incluir instrucciones en el script sobre cómo actualizar el forwarder.
    - _Requirements: 7.1, 7.2_

  - [ ] 5.2 Verificación: dedup keys existentes son compatibles
    - Agregar test que verifica: (1) los dedup_keys existentes (sin user_id prefix) no colisionan con los nuevos (con user_id prefix) — esto es inherente al hash SHA-256 con input distinto; (2) el pipeline con el nuevo userId del OWNER_USER_ID funciona para notificaciones nuevas; (3) una notificación ya procesada bajo el esquema legacy NO se detecta como duplicado con el nuevo esquema (aceptable — cross-source dedup lo catchea).
    - _Requirements: 7.2, 7.3_

  - [ ] 5.3 Documentar procedimiento de migración
    - README section: pasos para migrar (1) deploy del código, (2) ejecutar script de generación de token, (3) configurar token en Android Forwarder, (4) verificar que requests llegan con el nuevo auth, (5) opcionalmente remover PUSH_INGEST_SECRET.
    - _Requirements: 7.1, 9.2_

- [ ] 6. Property-based tests (Wave 5 — depende de Wave 1)
  - [ ] 6.1 Property: token format invariant
    - fast-check: ∀ userId (uuid) y deviceName (string max 50), `generateDeviceKey` retorna token que cumple `/^mng_[a-f0-9]{64}$/` y key_prefix = token.slice(0, 8).
    - _Requirements: 2.1_

  - [ ] 6.2 Property: dedup key user isolation
    - fast-check: ∀ payload P (packageName, title, text, timestamp arbitrarios) y userId A ≠ B, `computeDedupKey(P, A) ≠ computeDedupKey(P, B)`.
    - _Requirements: 4.1, 4.2_

  - [ ] 6.3 Property: dedup key device independence
    - fast-check: el dedup key depende solo de (payload, userId), NO de deviceId. Verificar que para mismo payload y userId, el resultado es idéntico independientemente de contexto.
    - _Requirements: 4.3_

  - [ ] 6.4 Property: rate limit per-device fairness
    - fast-check: ∀ deviceId D, las primeras 60 calls con D retornan allowed=true, la 61 retorna allowed=false. Calls con deviceId E (≠D) no se ven afectadas.
    - _Requirements: 8.1_

  - [ ] 6.5 Property: active device limit
    - fast-check: ∀ userId, tras crear 10 dispositivos activos, el intento 11 falla. Tras revocar 1, el intento 11 tiene éxito.
    - _Requirements: 2.5, 2.6_

- [ ] 7. Hardening y verificación final (Wave 6)
  - [ ] 7.1 Suite completa: `npm test` + `npm run lint` + `npm run build`
    - Verificar que todos los tests existentes (push-ingest, dedup, gmail-sync) siguen verdes tras los cambios. Los tests de pipeline que usaban OWNER_USER_ID deben actualizarse para pasar un userId como parámetro.
    - _Requirements: 5.2, 6.2, 6.3_

  - [ ] 7.2 Test de integración end-to-end
    - Test que simula: (1) crear device key para user A, (2) POST a /api/push-ingest con Bearer token de A → transacción insertada con user_id=A, (3) misma notificación con token de user B → segunda transacción insertada con user_id=B, (4) repetir con token de A → dedup detecta duplicado. Mock de Supabase.
    - _Requirements: 4.2, 4.3, 5.1_

  - [ ] 7.3 Verificar eliminación completa de OWNER_USER_ID
    - Grep del codebase: `OWNER_USER_ID` no debe aparecer en ningún archivo .ts excepto en el script de migración y en tests que lo referencian como fixture. El único lugar donde el UUID hardcodeado aparece es en la migración SQL.
    - _Requirements: 5.2_

  - [ ] 7.4 Documentación final
    - Actualizar AGENTS.md si es necesario (mención del sistema multi-user). Sección en README: cómo agregar un nuevo usuario (crear cuenta Supabase Auth → generar device key → configurar forwarder). Notas sobre el periodo de transición.
    - _Requirements: 9.1, 9.2_

## Notes

- El payload del Android Forwarder NO cambia — solo se agrega el header Authorization
- Los dedup keys existentes no se re-computan (irreversible desde un hash); el nuevo formato simplemente no colisiona
- El periodo de transición dual-auth permite migrar sin downtime
- Wave 2 y Wave 1 pueden ejecutarse en paralelo (Wave 2 solo depende de Wave 0)
- Wave 5 (property tests) es paralelizable con Wave 3 y Wave 4
- El update de `last_used_at` se hace async (no bloquea la response) para no agregar latencia al hot path

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"], "description": "Fundaciones" },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6"], "description": "Auth dual + pipeline" },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3"], "description": "API dispositivos", "parallel_with": [1] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3"], "description": "UI dispositivos" },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3"], "description": "Migración" },
    { "id": 5, "tasks": ["6.1", "6.2", "6.3", "6.4", "6.5"], "description": "Property tests", "parallel_with": [3, 4] },
    { "id": 6, "tasks": ["7.1", "7.2", "7.3", "7.4"], "description": "Hardening" }
  ]
}
```
