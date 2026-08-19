# Maquinita (Android)

La app oficial: un solo APK que es **el dashboard y el sensor de gastos**.

- **Dashboard** — una Trusted Web Activity abre el PWA a pantalla completa. Es
  Chrome renderizando el sitio, así que la sesión, el service worker y el web push
  son los del navegador, y actualizar el sitio actualiza la app: no hay nada que
  reinstalar.
- **Sensor** — `NotificationReaderService` lee las notificaciones de las apps
  financieras del whitelist y las postea a `POST /api/push-ingest`.

## Por qué TWA y no WebView

Un `WebView` **no implementa la Push API**, así que envolver el PWA en uno rompería
las notificaciones, incluida la alerta del cron que avisa cuando el sensor deja de
reportar. La TWA usa el motor del navegador y las conserva.

Y el sensor no puede "pasarle la data al WebView" en vez de hacer el POST: las
notificaciones llegan con la app cerrada, cuando no existe ninguna Activity ni
ningún WebView. El POST es el límite de durabilidad — es lo que hace que una
compra sin señal quede encolada y entre después.

## Cómo funciona el sensor

1. `NotificationReaderService` recibe cada notificación, descarta todo lo que no
   esté en el whitelist y encola el payload.
2. `UploadWorker` (WorkManager) drena la cola contra el endpoint, con reintentos
   exponenciales y constraint de red. Si el celu está sin internet, la compra no
   se pierde: queda en la cola.
3. El servidor dedupea por `dedup_key`, así que reenviar la misma notificación no
   duplica el gasto.

El whitelist está duplicado en `NotificationReaderService.kt` a propósito: el
servidor también lo valida, pero filtrar en el celular es lo que evita que texto
de notificaciones ajenas salga del dispositivo. Si agregás un paquete en
`src/lib/push-ingest/package-whitelist.ts`, agregalo acá también.

## Digital Asset Links

La TWA solo esconde la barra de URL si el sitio y la app se reconocen mutuamente:

- **App** → `@string/asset_statements` en `strings.xml`, declarado como
  `<meta-data android:name="asset_statements">`.
- **Sitio** → `public/.well-known/assetlinks.json`, con el SHA-256 de la key que
  firma el APK. Están los dos fingerprints (release y debug) para que ambos
  builds anden sin barra.

Si cambiás de dominio hay que tocar `twa_url`, `twa_host`, el `site` de
`asset_statements` y el `assetlinks.json` juntos. Si cambiás la key de firma, hay
que actualizar el fingerprint. Verificar el archivo servido:

```bash
curl -s https://mango-app-phi.vercel.app/.well-known/assetlinks.json
```

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
gradle wrapper --gradle-version 8.9   # una vez; AGP 8.7.3 no corre con Gradle 9
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

`local.properties` (con `sdk.dir`) lo genera Android Studio; si compilás a mano,
crealo apuntando al SDK. Está gitignoreado porque es una ruta local.

### Firma

Instalá el APK de **release**, no el de debug: un build debug es `debuggable`, y
eso permite leer el token del ingest desde `adb shell run-as`.

La config de firma se lee de `keystore.properties`, gitignoreado, apuntando a una
keystore en `~/.android/` (fuera del repo, para que no pueda terminar
committeada). Si el archivo no está, el variant de release queda sin firmar en vez
de romper el build. Para regenerarla:

```bash
keytool -genkeypair -v -keystore ~/.android/maquinita-release.keystore \
  -alias maquinita -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Maquinita, O=Maquinita, C=AR"

cat > keystore.properties <<'EOF'
storeFile=/Users/<vos>/.android/maquinita-release.keystore
storePassword=<pw>
keyAlias=maquinita
keyPassword=<pw>
EOF

# El fingerprint nuevo va a assetlinks.json
keytool -list -v -keystore ~/.android/maquinita-release.keystore -alias maquinita | grep SHA256
```

Perder la keystore no es grave: como no se distribuye por Play Store, se genera
otra y se actualiza el fingerprint.

## Configuración en el celular

Al abrir **Maquinita** entrás directo al dashboard. La pantalla del sensor está en
el **long-press del ícono → "Lector de notificaciones"** (no es el launcher, y no
está exportada, así que ninguna otra app puede abrirla).

1. **URL del endpoint**: `https://<tu-dominio>/api/push-ingest` (tiene que ser
   https: el token viaja en el header).
2. **Token**: el valor de `PUSH_INGEST_SECRET` de Vercel. Está marcado como
   `sensitive`, o sea write-only: no se puede leer de vuelta ni por dashboard ni
   por API. Si no lo tenés guardado, hay que rotarlo (ver abajo). Queda solo en
   el celular — `allowBackup="false"`, no se sube al backup de Google ni al repo.
3. **Guardar** → **Dar acceso a notificaciones** → activar "Maquinita" en la
   pantalla del sistema.
4. **Enviar prueba**: usa un packageName que el servidor no whitelistea, así
   valida URL y token sin crear ninguna transacción. Si el estado muestra
   `HTTP 200`, está andando. `HTTP 401` = token mal.

Desde Android 13, el acceso a notificaciones está detrás de "ajustes restringidos"
para apps que no vienen de una store. Si el toggle aparece gris: Info de la app →
menú ⋮ → *Permitir ajustes restringidos*.

El estado de la pantalla (acceso activo, pendientes en cola, último envío) es lo
que hay que mirar si dejan de aparecer gastos: no hay ninguna alerta del lado del
servidor.

## Rotar el token

Nada más consume `PUSH_INGEST_SECRET` (el forwarder de terceros ya no existe),
así que rotarlo solo afecta a esta app. El runtime lee las env vars del snapshot
del deployment, así que hace falta redeployar para que el valor nuevo aplique:

```bash
openssl rand -hex 32            # copialo antes de seguir: no se puede releer
printf '%s' '<el-valor>' | vercel env add PUSH_INGEST_SECRET production --force -y
vercel --prod                   # el valor nuevo no aplica hasta redeployar
```

## Pendiente

`ForegroundService` para persistencia de proceso, que el spec en
`.kiro/specs/android-notification-forwarder/` pide y todavía no está. Sin eso, en
Doze mode o con el optimizador de batería de Samsung/Xiaomi el sistema puede matar
el listener y dejás de recibir notificaciones sin enterarte.
