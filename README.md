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
| `/gastos`     | Selector de período, torta/barras por categoría, toggle para excluir extraordinarios, comparación mes vs mes, detección de patrones y tabla editable. |
| `/patrimonio` | Saldos por cuenta (nativo + USD), sparkline histórico por cuenta y total consolidado. |
| `/objetivos`  | CRUD de objetivos + proyección de cuándo llegás al ritmo actual. |

## Modelo de datos

Cinco tablas, todas con `id uuid`, `created_at timestamptz` y `user_id` (RLS por
dueño). **Toda la plata se guarda en moneda nativa Y con su valor en USD
congelado al momento de la carga** (`fx_rate_to_usd` + `*_usd`), nunca se
convierte on-the-fly.

- `accounts` — catálogo de cuentas/billeteras. `type`: `crypto | broker | bank | wallet | cash`.
- `categories` — categorías de gasto (con `parent_id`, `color`, `monthly_budget_usd`).
- `net_worth_snapshots` — una fila por cuenta por fecha de corte (alimenta los gráficos de patrimonio). Único por `(account_id, snapshot_date)`.
- `transactions` — cada consumo. `amount_native > 0` = gasto, `< 0` = pago/devolución. Flags `is_payment` (no cuenta como gasto) e `is_extraordinary` (one-off).
- `goals` — metas de ahorro.

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
2. `0002_rls_and_seed.sql` — RLS por dueño + trigger que siembra las cuentas y
   categorías por defecto cuando un usuario se registra.

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
3. Cargá las env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
4. En Supabase → **Authentication → URL Configuration**, agregá tu dominio de
   Vercel a *Site URL* y *Redirect URLs* (`https://tu-app.vercel.app/auth/callback`)
   para que el magic link funcione.
5. Deploy. Build command y output son los de Next.js por defecto.

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
    format.ts schemas.ts colors.ts utils.ts
supabase/
  migrations/          # schema + RLS
  seed.sql             # datos de ejemplo
```
