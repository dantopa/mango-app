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
las notificaciones (las alertas de presupuesto, por ejemplo). La TWA usa el motor
del navegador y las conserva.

El costo de la TWA es que Chrome no le muestra a la página nada del estado de
Android: si el acceso a notificaciones se apagó, el dashboard no tiene forma de
saberlo. Por eso `LauncherActivity` es una subclase nuestra — chequea antes de
abrir y avisa con un diálogo nativo, que es el único lugar del producto que ve las
dos mitades.

Y el sensor no puede "pasarle la data al WebView" en vez de hacer el POST: las
notificaciones llegan con la app cerrada, cuando no existe ninguna Activity ni
ningún WebView. El POST es el límite de durabilidad — es lo que hace que una
compra sin señal quede encolada y entre después.

## Splash

El arranque tapa la carga entera: `LauncherActivity` dibuja el logo sobre
`theme_background` desde el primer frame, y después le pasa la **misma** imagen a
Chrome, que la sostiene hasta que la página pinta y recién ahí hace un fade de
300 ms. Sin eso se ve una ventana translúcida y después un viewport vacío, que es
justo lo que hace parecer que la app está rota.

El traspaso a Chrome es por qué hay un `FileProvider`: androidbrowserhelper
escribe el PNG en `files/twa_splash/` y le pasa un content URI. El provider no
está exportado y `@xml/filepaths` lo limita a ese directorio.

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

Las apps de SMS tienen además un filtro de contenido, solo en el celular: el
paquete por sí solo no alcanza porque ahí entran los mensajes personales y los
códigos de un solo uso. Un SMS se sube si menciona un banco o una operación
(`FINANCIAL_SIGNAL`) y no parece un código (`ONE_TIME_CODE`). Sin esto, cada SMS
que recibís sale del celu y además se come una llamada al LLM, porque `sms.ts`
escala a la IA todo lo que ningún parser reconoce.

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

No hay nada que escribir. Al abrir **Maquinita** entrás directo al dashboard; si
el sensor no está usable, antes aparece un cartel nativo con **Arreglarlo**, que
lleva a la pantalla del sensor. También llegás a mano con el **long-press del
ícono → "Lector de notificaciones"** (no es el launcher y no está exportada, así
que ninguna otra app puede abrirla).

1. **Vincular este teléfono** → abre el navegador en `/pair`, con tu sesión ya
   iniciada, y queda aprobado. Dos toques.
2. **Dar acceso a notificaciones** → activar "Maquinita" en la pantalla del
   sistema.
3. **Enviar prueba** (opcional): usa un packageName que el servidor no
   whitelistea, así valida el token sin crear ninguna transacción. `HTTP 200` =
   andando; `HTTP 401` = el token no está aprobado.

El endpoint no se configura: sale de `twa_url`, que es el mismo origin que
verifican los Digital Asset Links. Si cambiás de dominio, ya lo estabas tocando.

Desde Android 13, el acceso a notificaciones está detrás de "ajustes restringidos"
para apps que no vienen de una store. Si el toggle aparece gris: Info de la app →
menú ⋮ → *Permitir ajustes restringidos*.

El estado de la pantalla (acceso activo, teléfono vinculado, pendientes en cola,
último envío) es lo que hay que mirar si dejan de aparecer gastos: no hay ninguna
alerta del lado del servidor.

## Cómo funciona el vínculo

El celular genera su propio token de 32 bytes y un código de un solo uso, y
manda **solo los SHA-256** a `POST /api/push-ingest/devices/enroll`, que no pide
sesión: la fila que crea no tiene dueño y no autentica nada. Después abre
`/pair#<código>` en el navegador — el código va en el *fragment*, así que nunca
llega a un log ni a un referer — y esa página, con tu sesión, lo aprueba contra
`POST /api/push-ingest/devices`. Ahí la fila queda atada a tu `user_id` y el
token empieza a valer.

Lo que se gana con ese orden: **el token existe en un solo lugar, el celular**.
El servidor guarda su hash, no se puede recuperar de ninguna parte, y lo que sí
viaja (el código) es de un solo uso y vence a los 10 minutos.

Volver a tocar **Vincular** reusa el mismo token y resetea la fila, así que el
teléfono queda *desvinculado hasta que apruebes de nuevo*. Es a propósito: una
fila por teléfono, sin credenciales viejas dando vueltas.

Un teléfono perdido se corta con `DELETE /api/push-ingest/devices` (`{id}`), que
marca `revoked_at` en vez de borrar: la fila es contra lo que hashea el token, y
tenerla es lo que hace que el rechazo sea deliberado.

## PUSH_INGEST_SECRET

Sigue funcionando como token de ingest — el servidor acepta el secreto compartido
o un token de dispositivo — pero ya no hace falta para configurar la app. Está
marcado `sensitive` en Vercel, o sea write-only: no se puede releer, solo rotar. Y
el runtime lee las env vars del snapshot del deployment, así que hace falta
redeployar para que el valor nuevo aplique:

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
