---
inclusion: auto
---

# Backlog — Realtime Expense Sensor

Ideas y decisiones pendientes capturadas durante sesiones de diseño. Referencia para cualquier agente que trabaje en el proyecto.

## 1. Semáforo dinámico (rolling daily budget)

El semáforo actual es estático (gasto acumulado vs línea ideal del día). El upgrade es:

```
presupuesto_diario_disponible = (techo_mensual - gastado_acumulado) / dias_restantes
```

- Si pasaron 10 días sin gastar → el día 11 tenés un "permitido" más grande
- Se recalcula con cada gasto nuevo
- Mostrar en la UI: "Hoy podés gastar hasta $X USD" (no solo verde/amarillo/rojo)

## 2. Botón "Sync" (reconciliación on-demand)

- Un botón en la UI que sincroniza gastos del mes actual desde TODAS las fuentes disponibles
- Fuentes posibles por banco:
  - Bancolombia: push (ya) + email (Gmail API, specs existentes) + API directa (browser-token-mcp)
  - Rappi: push + email
  - Nexo: push + MCP read-only (nexo_get_card_transactions)
  - BBVA: solo extracto PDF mensual
- Cada fuente puede tener su propio conector, se usa la más conveniente
- Carga todo lo del mes que no esté ya registrado

## 3. Normalización cross-source y deduplicación inteligente

El mismo gasto puede llegar de múltiples fuentes con formatos distintos:
- Push: `"Compraste $7.900 en JERONIMO MARTINS COL"`
- Email: `"Compraste $7.900,00 en JERONIMO MARTINS COL con tu T.Deb *5685, el 31/05/2026"`
- API: `{"description": "JERONIMO MARTINS COL", "amount": 7900, "date": "2026-05-31"}`

Estrategia de dedup:
- Primero: match exacto por (monto + fecha + ventana de minutos) — cubre el 90%
- Si hay ambigüedad (mismo monto, distinto merchant text): considerar LLM chico para resolver "¿es la misma compra?"
- Prioridad: si la compra ya está por push (real-time), el sync no la duplica

## 4. IA para categorización (ya decidido — Opción C)

- Cache determinístico primero (merchant_category_rules, pattern matching, longest wins)
- Si miss → LLM una vez por merchant nuevo → guardar resultado
- Learning automático: recategorizar en UI → crea/actualiza regla

## 5. Transferencias salientes (ya en spec)

- Allowlist/denylist para clasificar transferencias
- Default seguro: needs_review = true, no suma al semáforo hasta clasificar

---

**Prioridad de implementación:**
1. ~~Phase 0: webhook log-only~~ ✅ HECHO
2. Phase 1: parsers reales (esperando payloads bancarios del celu)
3. Phase 2: semáforo dinámico UI + rolling daily budget
4. Phase 3: botón Sync + reconciliación
5. Phase 4: dedup inteligente cross-source (potencialmente con IA)
