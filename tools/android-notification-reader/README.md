# Maquinita Reader (Android)

Lector de notificaciones propio: reemplaza al forwarder de terceros que se perdió
al cambiar de celular. Lee solo las notificaciones de las apps financieras del
whitelist y las postea a `POST /api/push-ingest`.

## Cómo funciona

1. `NotificationReaderService` (NotificationListenerService) recibe cada
   notificación, descarta todo lo que no esté en el whitelist y encola el payload.
2. `UploadWorker` (WorkManager) drena la cola contra el endpoint, con reintentos
   exponenciales y constraint de red. Si el celu está sin internet, la compra no
   se pierde: queda en la cola.
3. El servidor dedupea por `dedup_key`, así que reenviar la misma notificación no
   duplica el gasto.

El whitelist está duplicado en `NotificationReaderService.kt` a propósito: el
servidor también lo valida, pero filtrar en el celular es lo que evita que texto
de notificaciones ajenas salga del dispositivo. Si agregás un paquete en
`src/lib/push-ingest/package-whitelist.ts`, agregalo acá también.

## Build

Requiere un JDK 17 (el Android SDK ya está instalado en la máquina):

```bash
brew install --cask temurin@17
```

Después, desde esta carpeta:

```bash
gradle wrapper            # una vez, si no usás Android Studio
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

O abrir `tools/android-notification-reader` en Android Studio y correr la app en
el celular conectado. El build de debug se firma con la debug key, que alcanza
para sideload personal.

## Configuración en el celular

1. Abrir **Maquinita Reader**.
2. **URL del endpoint**: `https://<tu-dominio>/api/push-ingest` (tiene que ser
   https: el token viaja en el header).
3. **Token**: el valor de `PUSH_INGEST_SECRET` de Vercel. Queda solo en el
   celular — `allowBackup="false"`, no se sube al backup de Google ni al repo.
4. **Guardar** → **Dar acceso a notificaciones** → activar "Maquinita Reader" en
   la pantalla del sistema.
5. **Enviar prueba**: usa un packageName que el servidor no whitelistea, así
   valida URL y token sin crear ninguna transacción. Si el estado muestra
   `HTTP 200`, está andando. `HTTP 401` = token mal.

El estado de la pantalla (acceso activo, pendientes en cola, último envío) es lo
que hay que mirar si dejan de aparecer gastos. Del lado del servidor, el cron
diario avisa por push si pasan más de 48 h sin notificaciones.
