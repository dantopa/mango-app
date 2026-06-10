# Maquinita 🪙

App web personal de finanzas para trackear **patrimonio neto**, **gastos** y
**objetivos de ahorro**, consolidando múltiples cuentas y monedas en USD.

La app es un **visor y motor de análisis**: los datos (transacciones y saldos)
se cargan a Supabase **por fuera de la app** —un asistente externo parsea
extractos en PDF/imagen y escribe directo en la base—. Acá los leés, los
analizás y los re-categorizás.

![stack](https://img.shields.io/badge/Next.js-16-black) ![ts](https://img.shields.io/badge/TypeScript-strict-blue) ![supabase](https://img.shields.io/badge/Supabase-Postgres-green)

## Stack

- **Next.js (App Router) + TypeScript**
- **Tailwind CSS v4** + componentes estilo **shadcn/ui** (hechos a mano)
- **Recharts** para los gráficos
- **Supabase** (Postgres + Auth + RLS)
- **TanStack Query** para fetching/cache
- **Zod** para validación de formularios
- Deploy en **Vercel**

## Pantallas

| Ruta          | Qué muestra |
|---------------|-------------|
| `/`           | Dashboard: patrimonio neto actual + variación, evolución mensual, composición por cuenta, tracking del objetivo activo (ritmo requerido vs real). |
| `/gastos`     | Selector de período + **filtros faceteados combinables** (tipo de gasto, categoría, cuenta, país, medio de pago, búsqueda), **costo de vida mensual** (fijo + promedio variable), torta/barras por categoría, splits fijo/variable/extraordinario, por país y por cuenta, comparación mes vs mes y tabla editable (incl. dimensiones por transacción). |
| `/patrimonio` | Saldos por cuenta (nativo + USD), sparkline histórico por cuenta y total consolidado. |
| `/objetivos`  | CRUD de objetivos + proyección de cuándo llegás al ritmo actual. |
| `/cierre`     | **Cierre mensual**: checklist guiado de las fuentes a cargar (extractos PDF, saldos, gmail-auto) con barra de progreso, botón "Cerrar mes" que congela el snapshot, e histórico de cierres. |

## Modelo de datos

Siete tablas, todas con `id uuid`, `created_at timestamptz` y `user_id` (RLS por
dueño). **Toda la plata se guarda en moneda nativa Y con su valor en USD
congelado al momento de la carga** (`fx_rate_to_usd` + `*_usd`), nunca se
convierte on-the-fly.

- `accounts` — catálogo de cuentas/billeteras. `type`: `crypto | broker | bank | wallet | cash`. Dimensiones por defecto: `country` (`AR | CO | US | global`) y `payment_type` (`credito | debito | transferencia | pse_qr | efectivo | inversion | wallet`).
- `categories` — categorías de gasto (con `parent_id`, `color`, `monthly_budget_usd`).
- `net_worth_snapshots` — una fila por cuenta por fecha de corte (alimenta los gráficos de patrimonio). Único por `(account_id, snapshot_date)`.
- `transactions` — cada consumo. `amount_native > 0` = gasto, `< 0` = pago/devolución. Flags `is_payment` (no cuenta como gasto) e `is_extraordinary` (legacy). **Dimensiones v2** (filtrables): `country` (dónde se gastó, default `CO`), `payment_type` (heredado de la cuenta, editable), `expense_type` (`fijo | variable | extraordinario`, default `variable` — reemplaza a `is_extraordinary`).
- `goals` — metas de ahorro.
- `monthly_close` — un cierre por mes (`period` `YYYY-MM`, único por usuario). `status`: `pendiente | en_progreso | cerrado`. Al cerrar congela `net_worth_usd`, `total_spend_usd`, `savings_usd` y `closed_at`.
- `monthly_close_items` — checklist de fuentes de un cierre (`close_id`). `item_type`: `extracto_pdf | saldo | gmail_auto`. `status`: `pendiente | cargado | omitido` + `loaded_at`. **El asistente externo marca `status='cargado'` y `loaded_at` a medida que ingiere cada fuente.**

El SQL está documentado con `COMMENT ON` en cada tabla/columna relevante para que
el proceso externo (asistente con MCP) sepa exactamente qué escribir. Ver
`supabase/migrations/`.

> **Nota de categorización:** los pedidos de Rappi pueden ser *delivery* o
> *mercado* (Rappiturbo). El parser decide caso por caso y la app permite
> **re-categorizar** cualquier transacción desde la tabla de Gastos.

### Cómo escribe el proceso externo

El asistente externo usa la **service role key** (bypassa RLS) y **debe setear
`user_id`** al id del usuario dueño en cada fila. Ejemplo de upsert de snapshot:

```sql
insert into net_worth_snapshots
  (user_id, account_id, snapshot_date, balance_native, native_currency,
   fx_rate_to_usd, balance_usd)
values ('<user_uuid>', '<account_uuid>', '2026-06-30', 25000, 'USDT', 1.0, 25000)
on conflict (account_id, snapshot_date) do update
  set balance_native = excluded.balance_native,
      balance_usd    = excluded.balance_usd,
      fx_rate_to_usd = excluded.fx_rate_to_usd;
```

Al insertar transacciones, además de los campos clásicos conviene setear las
dimensiones v2 (si se omiten, `country` y `expense_type` toman sus defaults
`CO`/`variable`, y `payment_type` queda `null` → la app lo trata como heredable):

```sql
insert into transactions
  (user_id, account_id, tx_date, description_raw, merchant, amount_native,
   native_currency, fx_rate_to_usd, amount_usd, category_id,
   country, payment_type, expense_type)
values ('<user_uuid>', '<account_uuid>', '2026-06-15', 'RAPPI*BURGER', 'Rappi',
        57900, 'COP', 0.00027, 15.74, '<category_uuid>',
        'CO', 'credito', 'variable');
```

Para el **cierre mensual**, el asistente actualiza el estado de cada fuente del
checklist a medida que la carga:

```sql
update monthly_close_items
  set status = 'cargado', loaded_at = now()
where close_id = '<close_uuid>' and source = 'RappiCard';
```

## Levantar local

```bash
npm install
cp .env.example .env.local   # completá con tus credenciales de Supabase
npm run dev                  # http://localhost:3000
```

Variables en `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable-o-anon-key>
```

## Migraciones y seed

Las migraciones viven en `supabase/migrations/` (idempotentes, en orden):

1. `0001_initial_schema.sql` — extensiones, enums, tablas, índices.
2. `0002_rls_and_seed.sql` — RLS por dueño + (histórico) trigger de seed en
   signup. **El auto-seed fue removido en `0005`** (ver abajo).
3. `0003_expense_dimensions.sql` — **aditiva**: agrega `country` / `payment_type`
   a `accounts`, y `country` / `payment_type` / `expense_type` a `transactions`,
   con backfill no destructivo de los datos existentes + índices de filtrado.
4. `0004_monthly_close.sql` — **aditiva**: tablas `monthly_close` y
   `monthly_close_items` con RLS por dueño.
5. `0005_remove_auto_seed.sql` — dropea el trigger de seed en signup (ya no se
   crean cuentas/categorías por defecto; los datos se cargan vía MCP).

Aplicalas con la **Supabase CLI**:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

…o pegá el SQL en el **SQL Editor** del dashboard.

**Datos de ejemplo** (opcional, para ver los gráficos con data): `supabase/seed.sql`
carga un objetivo, 7 meses de snapshots y ~50 transacciones para el usuario
`demo@maquinita.app`. Ejecutalo en el SQL Editor una vez que ese usuario exista.

### Regenerar los tipos de TypeScript

Los tipos están en `src/lib/supabase/database.types.ts`. Para regenerarlos desde
el schema:

```bash
supabase gen types typescript --project-id <project-ref> > src/lib/supabase/database.types.ts
```

## Auth

Auth de Supabase con **email/password** y **magic link** (botón en `/login`).
RLS activado en todas las tablas: cada usuario sólo ve/escribe sus filas. El
`proxy.ts` (proxy de Next 16, ex-middleware) refresca la sesión y redirige a
`/login` a quien no esté logueado.

## Deploy a Vercel

1. Push del repo a GitHub.
2. En Vercel: **New Project** → importá el repo.
3. Cargá las env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SYNC_CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REDIRECT_URI`).
4. En Supabase → **Authentication → URL Configuration**, agregá tu dominio de
   Vercel a *Site URL* y *Redirect URLs* (`https://tu-app.vercel.app/auth/callback`)
   para que el magic link funcione.
5. Deploy. Build command y output son los de Next.js por defecto.

### Cron Job

`vercel.json` configura un cron diario a las 09:00 UTC (04:00 Bogotá) que ejecuta
`GET /api/sync/cron`. El endpoint sincroniza Bancolombia, Nexo y Gmail para el
mes corriente (y el anterior si estamos dentro de los primeros 5 días).

La autenticación es vía header `Authorization: Bearer <SYNC_CRON_SECRET>`.
Generá un token seguro (e.g. `openssl rand -hex 32`) y guardalo en Vercel como
env var `SYNC_CRON_SECRET`.

## Gmail Sync

El sistema sincroniza automáticamente emails transaccionales de Gmail y los
convierte en gastos. Las fuentes actuales son Bancolombia (alertas), RappiCard
(resúmenes de transacción) y Arriendo (confirmaciones de Palomma).

### Setup de Google Cloud

1. Crear un proyecto en [Google Cloud Console](https://console.cloud.google.com/).
2. Habilitar la **Gmail API** desde *APIs & Services → Library*.
3. Crear un **OAuth client** tipo *Web application* en *Credentials*.
4. Agregar las redirect URIs autorizadas:
   - `http://localhost:3000/api/gmail/callback` (desarrollo local)
   - `https://<tu-dominio>.vercel.app/api/gmail/callback` (producción)
5. Configurar las variables de entorno (ver sección siguiente).
6. El proyecto puede quedarse en modo **"Testing"** (sin verificación de Google)
   — alcanza con agregar el email del owner como test user en la pantalla de
   consentimiento OAuth.

### Variables de entorno (Gmail)

Agregar en `.env.local` (desarrollo) y en Vercel (producción):

| Variable | Descripción |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID del OAuth client creado en Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Client secret del mismo |
| `GOOGLE_OAUTH_REDIRECT_URI` | URI de callback completa, e.g. `https://<app>.vercel.app/api/gmail/callback` |

### Cómo agregar una nueva fuente Gmail

Cada fuente de email es un archivo independiente en `src/lib/sync/gmail/sources/`
que exporta un `GmailSourceDef`. Para agregar una nueva:

1. **Crear el archivo** en `src/lib/sync/gmail/sources/<nombre>.ts` exportando un
   objeto que implemente `GmailSourceDef`:

   ```ts
   import type { GmailSourceDef } from "../types";

   export const miFuenteDef: GmailSourceDef = {
     id: "mi-fuente",           // identificador único
     syncSource: "sync_gmail_mi_fuente",
     accountName: "MiCuenta",   // debe existir en la tabla accounts
     closeItemSource: null,     // o el nombre para monthly_close_items
     buildQuery(month) {
       const [y, m] = month.split("-");
       const after = `${y}/${m}/01`;
       // calcular el primer día del mes siguiente...
       return `from:(remitente@ejemplo.com) after:${after} before:${before}`;
     },
     parse(email) {
       // Extraer datos del email y devolver CandidateTransaction[]
       // Devolver [] si no es transaccional (under-count: ante la duda, no insertar)
       return [];
     },
   };
   ```

2. **Definir `buildQuery(month)`** con el remitente (`from:`) y el rango de
   fechas (`after:/before:`) para limitar la búsqueda al mes indicado.

3. **Implementar `parse(email)`** devolviendo `CandidateTransaction[]` con los
   campos `amount_native`, `merchant`, `tx_date`, `native_currency`,
   `description_raw`. Devolver `[]` para emails no transaccionales o si no se
   puede extraer la data con confianza.

4. **Registrar la fuente** en `src/lib/sync/gmail/sources/index.ts` agregándola
   al array `GMAIL_SOURCES`. El **orden importa**: las fuentes que corren primero
   tienen prioridad en dedup cross-fuente (ej: Arriendo corre antes que
   Bancolombia para evitar doble conteo del pago de alquiler).

5. **Agregar fixtures y tests** en `src/lib/sync/gmail/__fixtures__/` con bodies
   de ejemplo sanitizados, y tests unitarios que cubran las variantes del parser.

### BBVA (fuera de alcance v1)

El slot `sync_gmail_bbva` está reservado para una futura implementación. Estado
actual:

- BBVA **no adjunta el PDF del extracto** en el email — solo envía un link
  tokenizado a `online.bbva.com.ar` que requiere sesión activa, por lo que no
  es parseable automáticamente desde Gmail.
- **Posible v2**: parsear los avisos "TRANSFERENCIA INMEDIATA DEBITADA" de
  `avisos@bbva.com.ar` como señal parcial de gastos en ARS.
- **Alternativa**: upload manual del PDF del extracto (fuera de Gmail sync).

## Estructura

```
src/
  app/
    (app)/             # rutas protegidas (dashboard, gastos, patrimonio, objetivos)
    auth/              # callback de magic link + signout
    login/             # pantalla de login
  components/
    ui/                # primitivas estilo shadcn (button, card, table, …)
    charts/            # gráficos Recharts
  hooks/use-finance.ts # queries + mutations de TanStack Query
  lib/
    analytics.ts       # cálculos puros (patrimonio, gastos, proyección de objetivos)
    supabase/          # clients (browser/server), middleware, tipos generados
    sync/gmail/        # fuentes Gmail (parsers, orquestador, OAuth)
    format.ts schemas.ts colors.ts utils.ts
supabase/
  migrations/          # schema + RLS
  seed.sql             # datos de ejemplo
```
