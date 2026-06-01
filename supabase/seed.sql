-- =============================================================================
-- Maquinita — sample data seed
-- =============================================================================
-- Loads a realistic demo dataset (one active goal, 7 monthly net-worth
-- snapshots per account, and ~2 months of transactions) for the demo user
-- 'demo@maquinita.app'. Idempotent: it no-ops if the goal already exists.
--
-- Accounts + categories are created automatically on signup (see
-- 0002_rls_and_seed.sql), so this script only adds the time-series data you
-- need to see the charts come alive. Replace it with your real data anytime.
--
-- FX snapshots used (native -> USD):  USD/USDT = 1,  COP = 0.00025,  ARS = 0.00083
-- =============================================================================

do $$
declare
  u uuid;
begin
  select id into u from auth.users where email = 'demo@maquinita.app';
  if u is null then
    raise notice 'demo user not found; skipping sample seed';
    return;
  end if;

  if exists (select 1 from public.goals where user_id = u) then
    raise notice 'sample data already present; skipping';
    return;
  end if;

  -- --- Active savings goal --------------------------------------------------
  insert into public.goals (user_id, name, target_usd, target_date, start_usd, start_date, is_active)
  values (u, '70k Julio 2026', 70000, '2026-07-31', 45600, '2025-11-30', true);

  -- --- Net-worth snapshots: 7 monthly cut-offs per account ------------------
  -- base_native + growth_native * month_index, valued at a fixed FX snapshot.
  with months as (
    select * from (values
      (0, date '2025-11-30'), (1, date '2025-12-31'), (2, date '2026-01-31'),
      (3, date '2026-02-28'), (4, date '2026-03-31'), (5, date '2026-04-30'),
      (6, date '2026-05-31')
    ) as m(idx, snapshot_date)
  ),
  plan as (
    select * from (values
      -- name,                  base_native, growth_native, fx,       currency, note
      ('Nexo',                  18000.0,      700.0,        1.0,       'USDT', '44916 USDT + NEXO tokens'),
      ('IBKR',                  12000.0,      900.0,        1.0,       'USD',  'VWRA + cash'),
      ('Wise PDE IT Services',   4000.0,      150.0,        1.0,       'USD',  null),
      ('Bancolombia CDT',     20000000.0, 1200000.0,        0.00025,   'COP',  'CDT a 90 días'),
      ('Bancolombia Ahorros',  8000000.0,  200000.0,        0.00025,   'COP',  null),
      ('Rappi',                 400000.0,       0.0,        0.00025,   'COP',  'saldo billetera'),
      ('Brubank',              1200000.0,  100000.0,        0.00083,   'ARS',  null),
      ('BBVA',                  600000.0,   50000.0,        0.00083,   'ARS',  null),
      ('DolarApp/Arq',           3000.0,     100.0,        1.0,       'USD',  null)
    ) as p(name, base_native, growth_native, fx, currency, note)
  )
  insert into public.net_worth_snapshots
    (user_id, account_id, snapshot_date, balance_native, native_currency, fx_rate_to_usd, balance_usd, notes)
  select
    u, a.id, m.snapshot_date,
    round((p.base_native + p.growth_native * m.idx)::numeric, 4),
    p.currency, p.fx,
    round(((p.base_native + p.growth_native * m.idx) * p.fx)::numeric, 4),
    case when m.idx = 6 then p.note else null end
  from plan p
  join public.accounts a on a.user_id = u and a.name = p.name
  cross join months m;

  -- --- Transactions: April + May 2026 --------------------------------------
  -- amount_native > 0 = expense; < 0 = payment/refund. amount_usd is stored.
  insert into public.transactions
    (user_id, account_id, tx_date, description_raw, merchant, amount_native,
     native_currency, fx_rate_to_usd, amount_usd, category_id, is_payment,
     is_extraordinary, installments, statement_period)
  select
    u,
    (select id from public.accounts  where user_id = u and name = t.account),
    t.tx_date, t.description_raw, t.merchant, t.amount_native,
    t.currency, t.fx, round((t.amount_native * t.fx)::numeric, 4),
    (select id from public.categories where user_id = u and name = t.category),
    t.is_payment, t.is_extraordinary, t.installments, t.period
  from (values
    -- account,         date,               description_raw,                merchant,       amount_native, currency, fx,       category,                        is_payment, is_extra, installments, period
    ('Rappi',          date '2026-04-03', 'RAPPI*RAPPI COLOMBIA',          'Rappi',         42000.0,  'COP', 0.00025, 'Delivery comida',                false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Rappi',          date '2026-04-07', 'RAPPI*RAPPITURBO MERCADO',      'Rappiturbo',    78000.0,  'COP', 0.00025, 'Mercado/Super',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Rappi',          date '2026-04-12', 'RAPPI*RAPPI COLOMBIA',          'Rappi',         35500.0,  'COP', 0.00025, 'Delivery comida',                false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Rappi',          date '2026-04-19', 'RAPPI*RAPPITURBO MERCADO',      'Rappiturbo',    61200.0,  'COP', 0.00025, 'Mercado/Super',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Rappi',          date '2026-04-25', 'RAPPI*RAPPI COLOMBIA',          'Rappi',         48900.0,  'COP', 0.00025, 'Delivery comida',                false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-02', 'EXITO SUPERMERCADO POBLADO','Éxito',        210000.0, 'COP', 0.00025, 'Mercado/Super',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-09', 'D1 TIENDAS',                'D1',            64300.0,  'COP', 0.00025, 'Mercado/Super',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-05', 'DIDI RIDES',                'DiDi',          18500.0,  'COP', 0.00025, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-11', 'UBER TRIP',                 'Uber',          22300.0,  'COP', 0.00025, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-18', 'DIDI RIDES',                'DiDi',          15800.0,  'COP', 0.00025, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-14', 'PERGAMINO CAFE',            'Pergamino',     19000.0,  'COP', 0.00025, 'Cafés',                          false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-22', 'CAFE VELVET',               'Velvet',        16500.0,  'COP', 0.00025, 'Cafés',                          false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-16', 'EL CIELO RESTAURANTE',      'El Cielo',     185000.0,  'COP', 0.00025, 'Restaurantes/Bares',             false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-27', 'ALAMBIQUE BAR',             'Alambique',     92000.0,  'COP', 0.00025, 'Restaurantes/Bares',             false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-08', 'DROGUERIA CRUZ VERDE',      'Cruz Verde',    34200.0,  'COP', 0.00025, 'Salud/Farmacia',                 false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-20', 'SMARTFIT GYM',              'Smart Fit',     89900.0,  'COP', 0.00025, 'Gym/Salud física',               false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('DolarApp/Arq',   date '2026-04-01', 'NETFLIX.COM',                   'Netflix',          13.99, 'USD', 1.0,     'Suscripciones',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('DolarApp/Arq',   date '2026-04-01', 'SPOTIFY USA',                   'Spotify',          11.99, 'USD', 1.0,     'Suscripciones',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('DolarApp/Arq',   date '2026-04-15', 'OPENAI CHATGPT SUBSCRIPTION',   'OpenAI',           20.00, 'USD', 1.0,     'Suscripciones',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-10', 'CLARO COLOMBIA',           'Claro',          75000.0,  'COP', 0.00025, 'Servicios (internet/telefonía)', false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-24', 'FALABELLA HOGAR',          'Falabella',     120000.0,  'COP', 0.00025, 'Compras/Hogar',                  false, false, '3 de 6', '2026-04-30 a 2026-05-28'),
    ('Bancolombia Ahorros', date '2026-04-30', 'PAGO TOTAL TARJETA APP',   null,          -650000.0,  'COP', 0.00025, 'Varios',                         true,  false, null,     '2026-04-30 a 2026-05-28'),
    ('Brubank',        date '2026-04-06', 'MERCADO LIBRE',                 'Mercado Libre', 45000.0,  'ARS', 0.00083, 'Compras/Hogar',                  false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Brubank',        date '2026-04-13', 'PEDIDOSYA',                     'PedidosYa',     38000.0,  'ARS', 0.00083, 'Delivery comida',                false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    ('Brubank',        date '2026-04-21', 'CABIFY',                        'Cabify',        29000.0,  'ARS', 0.00083, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-04-30 a 2026-05-28'),
    -- May
    ('Rappi',          date '2026-05-02', 'RAPPI*RAPPI COLOMBIA',          'Rappi',         51000.0,  'COP', 0.00025, 'Delivery comida',                false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Rappi',          date '2026-05-06', 'RAPPI*RAPPITURBO MERCADO',      'Rappiturbo',    83400.0,  'COP', 0.00025, 'Mercado/Super',                  false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Rappi',          date '2026-05-11', 'RAPPI*RAPPI COLOMBIA',          'Rappi',         44200.0,  'COP', 0.00025, 'Delivery comida',                false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Rappi',          date '2026-05-17', 'RAPPI*RAPPI COLOMBIA',          'Rappi',         39900.0,  'COP', 0.00025, 'Delivery comida',                false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Rappi',          date '2026-05-23', 'RAPPI*RAPPITURBO MERCADO',      'Rappiturbo',    72100.0,  'COP', 0.00025, 'Mercado/Super',                  false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-03', 'EXITO SUPERMERCADO POBLADO','Éxito',        198000.0, 'COP', 0.00025, 'Mercado/Super',                  false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-08', 'DIDI RIDES',                'DiDi',          21100.0,  'COP', 0.00025, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-12', 'UBER TRIP',                 'Uber',          17600.0,  'COP', 0.00025, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-19', 'DIDI RIDES',                'DiDi',          24800.0,  'COP', 0.00025, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-09', 'PERGAMINO CAFE',            'Pergamino',     21000.0,  'COP', 0.00025, 'Cafés',                          false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-21', 'CAFE VELVET',               'Velvet',        18000.0,  'COP', 0.00025, 'Cafés',                          false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-15', 'OCI.MDE RESTAURANTE',       'Oci.Mde',      164000.0,  'COP', 0.00025, 'Restaurantes/Bares',             false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-25', 'X CAFE BAR',                'X Cafe',        77000.0,  'COP', 0.00025, 'Restaurantes/Bares',             false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-07', 'FARMATODO',                 'Farmatodo',     41800.0,  'COP', 0.00025, 'Salud/Farmacia',                 false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-20', 'SMARTFIT GYM',              'Smart Fit',     89900.0,  'COP', 0.00025, 'Gym/Salud física',               false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('DolarApp/Arq',   date '2026-05-01', 'NETFLIX.COM',                   'Netflix',          13.99, 'USD', 1.0,     'Suscripciones',                  false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('DolarApp/Arq',   date '2026-05-01', 'SPOTIFY USA',                   'Spotify',          11.99, 'USD', 1.0,     'Suscripciones',                  false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('DolarApp/Arq',   date '2026-05-15', 'OPENAI CHATGPT SUBSCRIPTION',   'OpenAI',           20.00, 'USD', 1.0,     'Suscripciones',                  false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('DolarApp/Arq',   date '2026-05-18', 'LATAM AIRLINES MDE-EZE',        'LATAM',           420.00, 'USD', 1.0,     'Viajes/Pasajes',                 false, true,  '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-10', 'CLARO COLOMBIA',           'Claro',          75000.0,  'COP', 0.00025, 'Servicios (internet/telefonía)', false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-24', 'FALABELLA HOGAR',          'Falabella',     120000.0,  'COP', 0.00025, 'Compras/Hogar',                  false, false, '4 de 6', '2026-05-28 a 2026-06-28'),
    ('Bancolombia Ahorros', date '2026-05-13', 'DEVOLUCION COMPRA EXITO',   'Éxito',        -45000.0,  'COP', 0.00025, 'Mercado/Super',                  true,  false, null,     '2026-05-28 a 2026-06-28'),
    ('Brubank',        date '2026-05-05', 'PEDIDOSYA',                     'PedidosYa',     41000.0,  'ARS', 0.00083, 'Delivery comida',                false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Brubank',        date '2026-05-16', 'COTO SUPERMERCADO',             'Coto',          68000.0,  'ARS', 0.00083, 'Mercado/Super',                  false, false, '1 de 1', '2026-05-28 a 2026-06-28'),
    ('Brubank',        date '2026-05-22', 'CABIFY',                        'Cabify',        33500.0,  'ARS', 0.00083, 'Transporte (Uber/Didi)',         false, false, '1 de 1', '2026-05-28 a 2026-06-28')
  ) as t(account, tx_date, description_raw, merchant, amount_native, currency, fx, category, is_payment, is_extraordinary, installments, period);

  raise notice 'sample data seeded for %', u;
end $$;
