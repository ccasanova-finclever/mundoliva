# Diseño — Sincronización de inventario Repo → Wix (botón manual)

**Fecha:** 2026-07-18
**Autor:** Christian Casanova + Claude
**Estado:** Aprobado el diseño; pendiente escribir plan de implementación.

---

## 1. Contexto

Mundoliva tiene **dos sistemas de stock que hoy andan por caminos separados**:

1. **App de inventario (el "repo")** — `inventario.mundoliva.cl`, un `index.html` alojado en
   **Netlify** (sitio `adorable-fudge-c6f545.netlify.app`), respaldado en **Firebase Firestore**
   (proyecto `mundoliva-6def2`, colección `inventario`, doc id = SKU). Controla stock de aceite
   en **bidones de 5 litros** repartido en **2 bodegas**: Geminis 366 (`g`) y Hamburgo 1620 (`h`).
   Lo usa Nadia.
2. **Tienda Wix** — `mundoliva.cl` (site ID `4403d986-8752-475e-a9f4-f7ed5b460b6f`, Catálogo V1).
   39 productos; cada uno con su propio `quantity` de stock (`trackInventory`).

**Verdad física = la bodega.** Aunque la web lleve su propio contador, el número real de unidades
se sabe en bodega, y ese dato vive en el repo. Por eso el repo es el **maestro**.

## 2. Objetivo

Un **botón manual "Sincronizar con la web"** en la app del repo que, al apretarlo, copie el stock
del repo hacia Wix, para que la tienda deje de mostrar/vender lo que ya no hay (lección de la crisis
de mayo 2026: productos agotados visibles y vendibles).

Este es el **cimiento** de la meta mayor: métricas confiables para gestión. Sin un stock unificado,
cualquier tablero de gestión miente.

## 3. Decisiones tomadas (con el usuario)

| Decisión | Valor | Por qué |
|---|---|---|
| Dirección | **Repo → Wix** (una vía) | La bodega/el repo es la verdad física |
| Qué se sincroniza | **Solo stock** (nunca precio) | Los precios calzan solo en 3 de 10; mezclarlos cambiaría precios sin querer |
| Alcance | **Solo los 10 SKU que existen en ambos** | Los otros 29 productos de Wix no están en el repo |
| Fórmula de stock | `quantity Wix = g + h` | Wix tiene un solo número; el repo tiene 2 bodegas |
| Disparo | **Botón manual** que aprieta Nadia | Simple y seguro para partir; ella controla cuándo |
| Puente | **Función de Netlify** en el mismo sitio | Encaja con el stack actual; la llave de Wix queda oculta en el servidor |

## 4. Los 10 productos en alcance (SKU calza 10/10)

| Producto | SKU | `inventoryItemId` en Wix (fallback) |
|---|---|---|
| Huerto de los Olivos Blend | HDO-AO-BLD-5L | 4614dfbd-8035-4e90-0e9e-29d8c8a182ff |
| Albero Arbequina | ALB-AO-ARB-5L | b2440368-4d1b-e848-1cb7-88ed1deb0230 |
| Albero Blend | ALB-AO-BLD-5L | 485d832a-f991-a059-c45d-49b16e7f8e44 |
| Albero Frantoio | ALB-AO-FRA-5L | c79a10f0-08f4-6999-2cb0-754395e7eb0b |
| Albero Coratina | ALB-AO-COR-5L | 4e5cbf32-65c5-6a3b-0858-b8b3f1f436ee |
| Cepas Patagua Arbequina | CPT-AO-ARB-5L | 8d42c31e-3c2d-5e93-4c15-915b410ffb2d |
| Cepas Patagua Picual | CPT-AO-PIC-5L | 7f589c93-b799-e52e-3106-bd4304ce0f94 |
| Cepas Patagua Frantoio | CPT-AO-FRA-5L | 6ad89db3-867d-2e44-45b1-52f51152faaa |
| Santa Elvira Blend | STE-AO-BLD-5L | 4ab85a9f-83af-bdad-8589-b466e491e580 |
| Deleyda Prime BIB | DEL-AO-BLD-BIB-5L | 3ae960a9-67f0-fd24-f7a9-e74172f9176f |

> La función identificará cada producto **por SKU** (robusto ante cambios); los `inventoryItemId`
> quedan como referencia/fallback.

## 5. Arquitectura

```
Nadia aprieta "Sincronizar con la web"   (inventario.mundoliva.cl, navegador)
        │  fetch POST /.netlify/functions/sync-wix
        ▼
Función de Netlify  (sync-wix)
   • guarda la LLAVE DE WIX como variable de entorno (oculta, nunca en el navegador)
   • lee los 10 stocks reales desde Firestore REST (colección `inventario`)
        - reglas Firestore son abiertas (allow read: if true) → no requiere credenciales
   • para cada uno de los 10 SKU: calcula total = g + h
   • busca el producto en Wix por SKU y hace SET quantity = total (Inventory API)
   • NO toca precio, nombre, ni los otros 29 productos
        │
        ▼
   devuelve un resumen JSON: { actualizados: [...], sinCambio: [...], errores: [...] }
        │
        ▼
La app muestra a Nadia: "10 productos actualizados ✓"  (o cuáles fallaron y por qué)
```

### Componentes

1. **Botón + UI de resultado** (en `index.html` del repo)
   - Botón en el header, junto a "Exportar CSV".
   - Al apretarlo: estado "Sincronizando…", luego un modal/toast con el resumen
     (cuántos actualizados, cuáles fallaron). Verificación de comportamiento, no técnica.
2. **Función Netlify `sync-wix`** (nueva, `netlify/functions/sync-wix.js`)
   - Lee Firestore REST → calcula `g+h` → escribe en Wix.
   - Única pieza que conoce la llave de Wix.
3. **Config Netlify** (`netlify.toml`) — declarar carpeta de funciones si no existe.
4. **Variable de entorno en Netlify** — `WIX_API_KEY` (y `WIX_SITE_ID`), configuradas por
   Christian en el panel de Netlify (GUI).

### Autenticación a Wix

- La función usa una **API Key de Wix** (generada una vez en `manage.wix.com` → Settings →
  API Keys, con permiso de **Stores/Inventory**), más el header de site ID.
- La API Key **jamás** viaja al navegador; vive solo como env var en Netlify.
- Endpoint de escritura de inventario: **Wix Stores Inventory API** (V1/V2) usando el
  `inventoryItemId` / SKU para hacer *set* de `quantity`. El endpoint exacto se confirma al
  implementar (leyendo la receta de wix-site-manager); mecanismo ya validado: los productos
  tienen `inventoryItemId` y `trackInventory: true`.

## 6. Seguridad

- La llave de Wix queda **solo en Netlify** (env var), nunca en el HTML/JS del navegador.
- La función **lee** Firestore (reglas abiertas de solo el proyecto Mundoliva) — no expone nada nuevo.
- La función es **acotada por diseño**: lista blanca de 10 SKU, solo campo stock. Aunque alguien
  llame al endpoint, lo peor que puede pasar es re-empujar el stock verdadero del repo.
- (Opcional, fase 2) agregar un token compartido simple para que solo la app pueda gatillar la función.

## 7. Manejo de errores y resultado

- Si un producto falla (SKU no encontrado, error de Wix), **se salta y sigue con los demás**;
  nunca deja la sincronización a medias sin avisar.
- La función devuelve la lista de `actualizados`, `sinCambio` y `errores` con motivo.
- La app muestra ese resumen a Nadia de forma legible.

## 8. Riesgo conocido y mitigación

**Ventas web no se descuentan solas en el repo.** Cuando alguien compra en `mundoliva.cl`, Wix
baja su `quantity`. Como este botón re-empuja el número del repo, restauraría el stock previo a esa
venta. **Mitigación (aceptada):** la bodega es la verdad; Nadia mantiene el repo al día. Para partir:
sincronizar con criterio (ej. cada mañana y al recibir mercadería). **Fase 2 futura (fuera de este
alcance):** que las ventas web también descuenten en el repo (sincronización de dos vías).

## 9. Fuera de alcance (para no inflar el proyecto)

- Sincronización de **precios** (se maneja en Wix).
- Los **29 productos** que el repo no controla (botellas chicas, acetos, accesorios).
- Sincronización **automática / en tiempo real** (se eligió botón manual).
- Sincronización **de dos vías** (Wix → repo).
- El **tablero de métricas de gestión** (viene encima de este cimiento, en un ciclo aparte).

## 10. Preguntas abiertas para la implementación

1. Confirmar el endpoint exacto de la Inventory API de Wix para *set* de quantity (receta
   wix-site-manager).
2. Confirmar que Netlify Functions está habilitado / configurable en el sitio `adorable-fudge-c6f545`
   (o habilitarlo vía `netlify.toml`).
3. Christian genera la API Key de Wix (con clics guiados) y la carga como env var en Netlify.
