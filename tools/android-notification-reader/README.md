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

Toolchain, tal como quedó instalada. Los *casks* de JDK corren un installer con
`sudo` y piden password interactivo, así que se usa el formula `openjdk@17`, que
instala en `/opt/homebrew` sin root:

```bash
brew install openjdk@17 gradle
brew install --cask android-commandlinetools   # trae sdkmanager

export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME="$HOME/Library/Android/sdk"

# El SDK local tenía hasta android-34; compileSdk es 35.
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platforms;android-35" "build-tools;35.0.0"
```

Después, desde esta carpeta:

```bash
gradle wrapper --gradle-version 8.7   # una vez; AGP 8.5.2 no corre con Gradle 9
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` (con `sdk.dir`) lo genera Android Studio; si compilás a mano,
crealo apuntando al SDK. Está gitignoreado porque es una ruta local.

O abrir `tools/android-notification-reader` en Android Studio y correr la app en
el celular conectado. El build de debug se firma con la debug key, que alcanza
para sideload personal.

## Configuración en el celular

1. Abrir **Maquinita Reader**.
2. **URL del endpoint**: `https://<tu-dominio>/api/push-ingest` (tiene que ser
   https: el token viaja en el header).
3. **Token**: el valor de `PUSH_INGEST_SECRET` de Vercel. Está marcado como
   `sensitive`, o sea write-only: no se puede leer de vuelta ni por dashboard ni
   por API. Si no lo tenés guardado, hay que rotarlo (ver abajo). Queda solo en
   el celular — `allowBackup="false"`, no se sube al backup de Google ni al repo.
4. **Guardar** → **Dar acceso a notificaciones** → activar "Maquinita Reader" en
   la pantalla del sistema.
5. **Enviar prueba**: usa un packageName que el servidor no whitelistea, así
   valida URL y token sin crear ninguna transacción. Si el estado muestra
   `HTTP 200`, está andando. `HTTP 401` = token mal.

El estado de la pantalla (acceso activo, pendientes en cola, último envío) es lo
que hay que mirar si dejan de aparecer gastos. Del lado del servidor, el cron
diario avisa por push si pasan más de 48 h sin notificaciones.

## Rotar el token

Nada más consume `PUSH_INGEST_SECRET` (el forwarder de terceros ya no existe),
así que rotarlo solo afecta a esta app. El runtime lee las env vars del snapshot
del deployment, así que hace falta redeployar para que el valor nuevo aplique:

```bash
openssl rand -hex 32            # copialo antes de seguir: no se puede releer
printf '%s' '<el-valor>' | vercel env add PUSH_INGEST_SECRET production --force -y
vercel --prod                   # el valor nuevo no aplica hasta redeployar
```
