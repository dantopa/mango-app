<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# Maquinita 🪙 — Contexto del proyecto

App web personal de finanzas para trackear **patrimonio neto**, **gastos** y **objetivos de ahorro**, consolidando múltiples cuentas y monedas en USD.

La app es un **visor y motor de análisis**: los datos (transacciones y saldos) se cargan a Supabase **por fuera de la app** (un asistente externo parsea extractos y escribe directo en la base). Acá se leen, analizan y re-categorizan.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **React 19**
- **Tailwind CSS v4** + componentes estilo shadcn/ui (hechos a mano)
- **Recharts** para gráficos
- **Supabase** (Postgres + Auth + RLS)
- **TanStack Query** para fetching/cache
- **Zod** para validación
- Deploy en **Vercel**

## Pantallas

| Ruta | Función |
|------|---------|
| `/` | Dashboard: patrimonio neto, variación mensual, composición por cuenta, objetivo activo, gasto del mes, ritmo de ahorro |
| `/gastos` | Gastos por categoría (torta/barras), toggle extraordinarios, comparación mes vs mes, tabla editable |
| `/patrimonio` | Saldos por cuenta (nativo + USD), sparklines históricos |
| `/objetivos` | CRUD de metas de ahorro + proyección |

## Modelo de datos (5 tablas, RLS por user_id)

- `accounts` — cuentas/billeteras. Tipos: crypto, broker, bank, wallet, cash.
- `categories` — categorías de gasto (parent_id, color, monthly_budget_usd).
- `net_worth_snapshots` — saldo por cuenta por fecha de corte. Único por (account_id, snapshot_date).
- `transactions` — consumos. amount > 0 = gasto. Flags: `is_payment`, `is_extraordinary`.
- `goals` — metas de ahorro.

Toda la plata se guarda en moneda nativa + USD congelado al momento de carga (`fx_rate_to_usd`), nunca se convierte on-the-fly.

## Estructura clave

```
src/
  app/(app)/          → rutas protegidas (dashboard, gastos, patrimonio, objetivos)
  app/auth/           → callback magic link + signout
  app/login/          → pantalla de login
  components/ui/      → primitivas shadcn (button, card, table, etc.)
  components/charts/  → gráficos Recharts
  hooks/use-finance.ts → queries + mutations TanStack Query
  lib/analytics.ts    → cálculos puros (patrimonio, gastos, proyección)
  lib/supabase/       → clients, tipos generados
  lib/format.ts       → formateo de moneda/fechas
  lib/schemas.ts      → schemas Zod
supabase/migrations/  → schema + RLS
```

## Convenciones

- Idioma de la UI: **español**.
- Código (variables, funciones, comentarios técnicos): **inglés**.
- Auth: email/password + magic link. Proxy de Next 16 refresca sesión y redirige a `/login`.
- Los tipos de DB se generan con `supabase gen types typescript` → `src/lib/supabase/database.types.ts`.
