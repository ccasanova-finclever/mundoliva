/* ════════════════════════════════════════════════════════════
   SYNC-WIX — Puente de sincronización de inventario
   Repo (Firebase Firestore) → Tienda Wix (mundoliva.cl)

   Reglas de diseño (ver docs/superpowers/specs/2026-07-18-*.md):
   - Solo toca STOCK (quantity). Nunca precio, nombre ni descripción.
   - Solo productos cuyo SKU existe en AMBOS sistemas.
   - stock Wix = g (Geminis 366) + h (Hamburgo 1620).
   - La llave de Wix vive SOLO aquí (variables de entorno de Netlify),
     nunca en el navegador.
════════════════════════════════════════════════════════════ */

var FIRESTORE_URL =
  "https://firestore.googleapis.com/v1/projects/mundoliva-6def2/databases/(default)/documents/inventario?pageSize=300";
var WIX_API = "https://www.wixapis.com";
var VARIANT_ZERO = "00000000-0000-0000-0000-000000000000";

/* ── Leer inventario del repo (Firestore REST, lectura pública) ── */
async function leerFirestore() {
  var out = {};
  var url = FIRESTORE_URL;
  while (url) {
    var res = await fetch(url);
    if (!res.ok) throw new Error("Firestore respondió " + res.status);
    var data = await res.json();
    (data.documents || []).forEach(function (doc) {
      var sku = doc.name.split("/").pop();
      var f = doc.fields || {};
      function num(k) {
        var v = f[k] || {};
        return parseInt(v.integerValue != null ? v.integerValue : v.doubleValue || 0, 10) || 0;
      }
      out[sku] = {
        name: (f.name && f.name.stringValue) || sku,
        g: num("g"),
        h: num("h")
      };
    });
    url = data.nextPageToken
      ? FIRESTORE_URL + "&pageToken=" + encodeURIComponent(data.nextPageToken)
      : null;
  }
  return out;
}

/* ── Leer catálogo Wix (V1, paginado de a 50 hasta agotar) ── */
async function leerWix(headers) {
  var productos = {};
  var offset = 0;
  var total = Infinity;
  while (offset < total) {
    var res = await fetch(WIX_API + "/stores/v1/products/query", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ query: { paging: { limit: 50, offset: offset } } })
    });
    if (!res.ok) {
      var t = await res.text();
      throw new Error("Wix query respondió " + res.status + ": " + t.slice(0, 200));
    }
    var data = await res.json();
    total = data.totalResults || 0;
    (data.products || []).forEach(function (p) {
      if (p.sku) {
        productos[p.sku] = {
          id: p.id,
          inventoryItemId: p.inventoryItemId,
          name: p.name,
          quantity: p.stock && p.stock.quantity != null ? p.stock.quantity : null,
          trackInventory: !!(p.stock && p.stock.trackInventory)
        };
      }
    });
    offset += 50;
    if (!(data.products || []).length) break; // seguridad anti-loop
  }
  return productos;
}

/* ── Escribir stock de un producto en Wix ── */
async function fijarStockWix(headers, inventoryItemId, cantidad) {
  var res = await fetch(WIX_API + "/stores/v2/inventoryItems/" + inventoryItemId, {
    method: "PATCH",
    headers: headers,
    body: JSON.stringify({
      inventoryItem: {
        trackQuantity: true,
        variants: [{ variantId: VARIANT_ZERO, quantity: cantidad }]
      }
    })
  });
  if (!res.ok) {
    var t = await res.text();
    throw new Error("Wix inventario respondió " + res.status + ": " + t.slice(0, 200));
  }
}

/* ── Handler principal ── */
exports.handler = async function (event) {
  var respond = function (code, body) {
    return {
      statusCode: code,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body)
    };
  };

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Usar POST" });
  }

  var API_KEY = process.env.WIX_API_KEY;
  var SITE_ID = process.env.WIX_SITE_ID;
  if (!API_KEY || !SITE_ID) {
    return respond(500, {
      error: "config",
      mensaje:
        "Falta configurar la llave de Wix en Netlify (variables WIX_API_KEY y WIX_SITE_ID). Avisar a Christian."
    });
  }

  var wixHeaders = {
    "Content-Type": "application/json",
    Authorization: API_KEY,
    "wix-site-id": SITE_ID
  };

  var actualizados = [];
  var sinCambio = [];
  var sinProductoWeb = [];
  var errores = [];

  try {
    var repo = await leerFirestore();
    var wix = await leerWix(wixHeaders);

    var skus = Object.keys(repo);
    for (var i = 0; i < skus.length; i++) {
      var sku = skus[i];
      var item = repo[sku];
      var total = item.g + item.h;
      var prod = wix[sku];

      if (!prod) {
        sinProductoWeb.push({ sku: sku, name: item.name, stock: total });
        continue;
      }
      if (prod.trackInventory && prod.quantity === total) {
        sinCambio.push({ sku: sku, name: prod.name, stock: total });
        continue;
      }
      try {
        await fijarStockWix(wixHeaders, prod.inventoryItemId, total);
        actualizados.push({
          sku: sku,
          name: prod.name,
          antes: prod.quantity,
          ahora: total
        });
      } catch (e) {
        errores.push({ sku: sku, name: prod.name, detalle: String(e.message || e) });
      }
    }
  } catch (e) {
    return respond(502, {
      error: "sync",
      mensaje: "La sincronización no pudo completarse: " + String(e.message || e)
    });
  }

  return respond(200, {
    ok: true,
    fecha: new Date().toISOString(),
    actualizados: actualizados,
    sinCambio: sinCambio,
    sinProductoWeb: sinProductoWeb,
    errores: errores
  });
};
