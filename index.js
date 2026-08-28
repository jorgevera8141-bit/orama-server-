require('dotenv').config({ quiet: true });
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required (set it in Railway, or in a local .env for dev)');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(__dirname + '/public'));
app.get('/api/debug/ordenes', async (req, res) => {
  const result = await pool.query("SELECT id, mesa_nombre, total, payment_method, amount_cash, amount_card FROM ordenes WHERE status='cerrada' ORDER BY created_at DESC LIMIT 5");
  res.json(result.rows);
});app.get('/api/ordenes/dia', async (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('en-CA');
  const result = await pool.query(
    "SELECT id, mesa_nombre, total, payment_method, amount_cash, amount_card, created_at FROM ordenes WHERE status='cerrada' AND DATE(mx(created_at))=$1 ORDER BY created_at ASC",
    [date]
  );
  res.json(result.rows);
});app.put('/api/staff/:id', async (req, res) => {
  const { nombre, pin, tipo, idioma, activo } = req.body;
  if(pin){
    await pool.query('UPDATE staff SET nombre=$1, pin=$2, tipo=$3, activo=COALESCE($4,activo) WHERE id=$5',
      [nombre, pin, tipo, activo, req.params.id]);
  } else {
    await pool.query('UPDATE staff SET nombre=$1, tipo=$2, activo=COALESCE($3,activo) WHERE id=$4',
      [nombre, tipo, activo, req.params.id]);
  }
  res.json({ success: true });
});

app.put('/api/ordenes/:id/cancelar', async (req, res) => {
  const { motivo } = req.body || {};
  await pool.query(
    "UPDATE ordenes SET status='cancelada', notas=$1 WHERE id=$2",
    [motivo||'', req.params.id]
  );
  res.json({ success: true });
});

// Create tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mesas (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      status TEXT DEFAULT 'disponible'
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      categoria TEXT NOT NULL,
      precio NUMERIC NOT NULL,
      activo INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS ordenes (
      id SERIAL PRIMARY KEY,
      mesa_id INTEGER,
      mesa_nombre TEXT,
      status TEXT DEFAULT 'abierta',
      total NUMERIC DEFAULT 0,
      payment_method TEXT DEFAULT 'efectivo',
      amount_cash NUMERIC DEFAULT 0,
      amount_card NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orden_items (
      id SERIAL PRIMARY KEY,
      orden_id INTEGER,
      item_nombre TEXT,
      precio NUMERIC,
      cantidad INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS gastos (
      id SERIAL PRIMARY KEY,
      categoria TEXT NOT NULL,
      descripcion TEXT,
      monto NUMERIC NOT NULL,
      fecha DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      pin TEXT NOT NULL,
      tipo TEXT NOT NULL,
      idioma TEXT DEFAULT 'es',
      activo INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff_sessions (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER,
      screen TEXT,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      logout_time TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orama_facturas (
      id SERIAL PRIMARY KEY,
      orden_id INTEGER REFERENCES ordenes(id),
      folio_fiscal TEXT,
      facturapi_id TEXT,
      rfc_receptor TEXT,
      razon_social TEXT,
      total NUMERIC,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'timbrada',
      pdf_url TEXT,
      xml_url TEXT
    );

    -- ── INVENTORY (Phase 2) ──
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'pieza',
      current_stock NUMERIC NOT NULL DEFAULT 0,
      reorder_threshold NUMERIC NOT NULL DEFAULT 0,
      reorder_quantity NUMERIC NOT NULL DEFAULT 0,
      cost_per_unit NUMERIC NOT NULL DEFAULT 0,
      supplier_name TEXT,
      supplier_contact TEXT,
      last_restocked_at TIMESTAMP,
      last_restocked_by INTEGER REFERENCES staff(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recipe_items (
      id SERIAL PRIMARY KEY,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity_used NUMERIC NOT NULL DEFAULT 0,
      UNIQUE (menu_item_id, inventory_item_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id SERIAL PRIMARY KEY,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      change_amount NUMERIC NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('sale','manual_adjustment','restock','waste')),
      order_id INTEGER,
      staff_id INTEGER REFERENCES staff(id),
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_inv_mov_item ON inventory_movements(inventory_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inv_mov_reason ON inventory_movements(reason);
    CREATE INDEX IF NOT EXISTS idx_inv_mov_order ON inventory_movements(order_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_menu ON recipe_items(menu_item_id);

    -- ── REPORTING (Phase 3) ──
    -- created_at is stored in UTC; mx() returns the wall-clock time in the
    -- café's timezone so DATE()/hour/day-of-week bucket correctly.
    CREATE OR REPLACE FUNCTION mx(ts timestamp) RETURNS timestamp AS $mx$
      SELECT ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'
    $mx$ LANGUAGE sql STABLE;

    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;

    CREATE TABLE IF NOT EXISTS orama_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO orama_settings (key, value) VALUES ('margin_threshold_pct', '70')
      ON CONFLICT (key) DO NOTHING;
  `);

  await pool.query(`
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'efectivo';
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS amount_cash NUMERIC DEFAULT 0;
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS amount_card NUMERIC DEFAULT 0;
  `).catch(() => {});
await pool.query(`
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS notas TEXT;
  `).catch(()=>{});
  await pool.query(`
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS clave TEXT;
  `).catch(() => {});
  await pool.query(`
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS clave_sat TEXT;
  `).catch(() => {});
await pool.query(`
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'efectivo';
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS amount_cash NUMERIC DEFAULT 0;
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS amount_card NUMERIC DEFAULT 0;
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS notas TEXT;
  `).catch(()=>{});
  console.log('Database ready');
}

// MESAS
app.get('/api/mesas', async (req, res) => {
  const result = await pool.query('SELECT * FROM mesas ORDER BY id');
  res.json(result.rows);
});

app.post('/api/mesas', async (req, res) => {
  const { nombre } = req.body;
  const result = await pool.query('INSERT INTO mesas (nombre) VALUES ($1) RETURNING *', [nombre]);
  res.json(result.rows[0]);
});

// GET all menu items including inactive (for admin)
app.get('/api/menu', async (req, res) => {
  const all = req.query.all === '1';
  const result = await pool.query(
    all ? 'SELECT * FROM menu_items ORDER BY categoria, nombre' 
        : 'SELECT * FROM menu_items WHERE activo=1 ORDER BY categoria, nombre'
  );
  res.json(result.rows);
});

// UPDATE menu item active status
app.put('/api/menu/:id', async (req, res) => {
  const { activo } = req.body;
  await pool.query('UPDATE menu_items SET activo=$1 WHERE id=$2', [activo, req.params.id]);
  res.json({ success: true });
});

// REPORTS by date range
app.get('/api/reportes', async (req, res) => {
  const { from, to } = req.query;
  const [summary, categorias, orders, productos, pagos] = await Promise.all([
    pool.query(`
      SELECT 
        COUNT(*) as ordenes,
        COALESCE(SUM(total),0) as total,
        COUNT(DISTINCT DATE(mx(created_at))) as dias
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
    `, [from, to]),
    pool.query(`
      SELECT mi.categoria, COALESCE(SUM(oi.precio * oi.cantidad),0) as total
      FROM orden_items oi
      JOIN ordenes o ON o.id = oi.orden_id
      JOIN menu_items mi ON mi.nombre = oi.item_nombre
      WHERE o.status='cerrada' AND DATE(mx(o.created_at)) BETWEEN $1 AND $2
      GROUP BY mi.categoria
      ORDER BY total DESC
    `, [from, to]),
    pool.query(`
      SELECT * FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
      ORDER BY created_at DESC
      LIMIT 100
    `, [from, to]),
    pool.query(`
      SELECT oi.item_nombre,
        SUM(oi.cantidad) as cantidad,
        SUM(oi.precio * oi.cantidad) as total
      FROM orden_items oi
      JOIN ordenes o ON o.id = oi.orden_id
      WHERE o.status='cerrada' AND DATE(mx(o.created_at)) BETWEEN $1 AND $2
      GROUP BY oi.item_nombre
      ORDER BY cantidad DESC
      LIMIT 20
    `, [from, to]),
    pool.query(`
      SELECT payment_method,
        COUNT(*) as ordenes,
        COALESCE(SUM(total),0) as total
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
      GROUP BY payment_method
      ORDER BY total DESC
    `, [from, to])
  ]);
  res.json({
    ...summary.rows[0],
    categorias: categorias.rows,
    orders: orders.rows,
    productos: productos.rows,
    pagos: pagos.rows
  });
});

// ORDENES
app.get('/api/ordenes', async (req, res) => {
  const result = await pool.query("SELECT * FROM ordenes WHERE status='abierta' ORDER BY created_at DESC");
  res.json(result.rows);
});

app.get('/api/ordenes/:id/items', async (req, res) => {
  const result = await pool.query('SELECT * FROM orden_items WHERE orden_id=$1', [req.params.id]);
  res.json(result.rows);
});

app.post('/api/ordenes', async (req, res) => {
  const { mesa_id, mesa_nombre, items } = req.body;
  const total = items.reduce((sum, i) => sum + (i.precio * i.cantidad), 0);
  const orden = await pool.query(
    'INSERT INTO ordenes (mesa_id, mesa_nombre, total) VALUES ($1, $2, $3) RETURNING *',
    [mesa_id, mesa_nombre, total]
  );
  const ordenId = orden.rows[0].id;
  for (const item of items) {
    await pool.query(
      'INSERT INTO orden_items (orden_id, item_nombre, precio, cantidad) VALUES ($1, $2, $3, $4)',
      [ordenId, item.nombre, item.precio, item.cantidad]
    );
  }
  res.json({ id: ordenId, total });
});

app.put('/api/ordenes/:id/cerrar', async (req, res) => {
  const { payment_method, amount_cash, amount_card, notas } = req.body || {};
  const orden = await pool.query('SELECT * FROM ordenes WHERE id=$1', [req.params.id]);
  const wasOpen = orden.rows[0]?.status === 'abierta';
  await pool.query(
    `UPDATE ordenes SET status='cerrada', payment_method=$1, amount_cash=$2, amount_card=$3, notas=$4,
       closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
     WHERE id=$5`,
    [payment_method||'efectivo', amount_cash||0, amount_card||0, notas||'', req.params.id]
  );

  // Decrement inventory from recipes on the abierta -> cerrada transition (any close counts).
  // Never blocks the order from closing: the sale already happened.
  if (wasOpen) {
    try { await deductInventoryForOrder(req.params.id); }
    catch (e) { console.error('inventory deduction failed for orden', req.params.id, e.message); }
  }

  // Send ntfy notification
  const mesa = orden.rows[0]?.mesa_nombre || 'Mesa';
  try{
    await fetch('https://ntfy.sh/orama-ordenes', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Title': 'Orden lista',
        'Tags': 'bell'
      },
      body: mesa + ' lista para servir!'
    });
  }catch(e){ console.log('ntfy error:', e); }
  
  res.json({ success: true });
});

// SUMMARY
app.get('/api/resumen', async (req, res) => {
  const { from, to, date } = req.query;
  const filterDate = date || new Date().toLocaleDateString('en-CA');
  const result = await pool.query(`
    SELECT 
      COUNT(*) as ordenes,
      COALESCE(SUM(total),0) as total,
      COALESCE(SUM(CASE WHEN payment_method='efectivo' THEN total ELSE 0 END),0) as total_efectivo,
      COALESCE(SUM(CASE WHEN payment_method='tarjeta' THEN total ELSE 0 END),0) as total_tarjeta,
      COALESCE(SUM(CASE WHEN payment_method='mixto' THEN amount_cash ELSE 0 END),0) as mixto_efectivo,
      COALESCE(SUM(CASE WHEN payment_method='mixto' THEN amount_card ELSE 0 END),0) as mixto_tarjeta
    FROM ordenes
    WHERE status='cerrada' AND DATE(mx(created_at))=$1
  `, [filterDate]);
  res.json(result.rows[0]);
});

// SEED mesas if empty
app.post('/api/seed', async (req, res) => {
  const check = await pool.query('SELECT COUNT(*) FROM mesas');
  if (parseInt(check.rows[0].count) > 0) {
    return res.json({ message: 'Already seeded' });
  }
  const mesas = ['Mesa 1','Mesa 2','Mesa 3','Mesa 4','Mesa 5','Mesa 7','Mesa 8','Mesa 9','Mesa 9A','Mesa 10','Mesa 11','Mesa 12','Mesa 14','Barra','Boutique'];
  for (const m of mesas) {
    await pool.query('INSERT INTO mesas (nombre) VALUES ($1)', [m]);
  }
  res.json({ message: 'Mesas seeded', count: mesas.length });
});
// GASTOS
app.get('/api/gastos', async (req, res) => {
  const { from, to } = req.query;
  let query = 'SELECT * FROM gastos';
  let params = [];
  if(from && to){
    query += ' WHERE fecha BETWEEN $1 AND $2';
    params = [from, to];
  }
  query += ' ORDER BY fecha DESC, created_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/gastos', async (req, res) => {
  const { categoria, descripcion, monto, fecha } = req.body;
  const result = await pool.query(
    'INSERT INTO gastos (categoria, descripcion, monto, fecha) VALUES ($1, $2, $3, $4) RETURNING *',
    [categoria, descripcion, monto, fecha || new Date().toLocaleDateString('en-CA')]
  );
  res.json(result.rows[0]);
});

app.delete('/api/gastos/:id', async (req, res) => {
  await pool.query('DELETE FROM gastos WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// FINANZAS P&L
app.get('/api/finanzas', async (req, res) => {
  const { from, to } = req.query;
  const [ingresos, gastos] = await Promise.all([
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', mx(created_at)), 'YYYY-MM') as mes,
        COALESCE(SUM(total), 0) as total
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
      GROUP BY mes ORDER BY mes
    `, [from, to]),
    pool.query(`
      SELECT 
        TO_CHAR(DATE_TRUNC('month', fecha), 'YYYY-MM') as mes,
        COALESCE(SUM(monto), 0) as total
      FROM gastos 
      WHERE fecha BETWEEN $1 AND $2
      GROUP BY mes ORDER BY mes
    `, [from, to])
  ]);
  res.json({ ingresos: ingresos.rows, gastos: gastos.rows });
});

// ─── FACTURACION CFDI ───
const CLAVE_PROD_SERV_DEFAULT = '90101501';
const CFDI_GLOBAL = {
  legal_name: 'PUBLICO EN GENERAL',
  tax_id: 'XAXX010101000',
  tax_system: '616',
  zip: '00000',
  use: 'S01'
};

app.post('/api/factura', async (req, res) => {
  try {
    const { orden_id, tipo, rfc, razon_social, regimen_fiscal, cp, uso_cfdi, forma_pago_tarjeta, email } = req.body;
    if(!orden_id) return res.status(400).json({ success: false, message: 'orden_id requerido' });

    const ordenRes = await pool.query('SELECT * FROM ordenes WHERE id=$1', [orden_id]);
    if(!ordenRes.rows.length) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    const orden = ordenRes.rows[0];

    if(!orden.total || parseFloat(orden.total) <= 0){
      return res.status(400).json({ success: false, message: 'La orden no tiene un total facturable' });
    }
    if(!['efectivo','tarjeta','mixto'].includes(orden.payment_method)){
      return res.status(400).json({ success: false, message: 'Este tipo de orden no se puede facturar' });
    }

    let formaPago;
    if(orden.payment_method === 'efectivo') formaPago = '01';
    else if(orden.payment_method === 'mixto') formaPago = '99';
    else {
      if(!['04','28'].includes(forma_pago_tarjeta)){
        return res.status(400).json({ success: false, message: 'forma_pago_tarjeta debe ser 04 (crédito) o 28 (débito)' });
      }
      formaPago = forma_pago_tarjeta;
    }

    const esGlobal = tipo === 'global';
    const customer = esGlobal ? {
      legal_name: CFDI_GLOBAL.legal_name,
      tax_id: CFDI_GLOBAL.tax_id,
      tax_system: CFDI_GLOBAL.tax_system,
      address: { zip: CFDI_GLOBAL.zip }
    } : {
      legal_name: (razon_social || '').trim(),
      tax_id: (rfc || '').trim().toUpperCase(),
      tax_system: regimen_fiscal,
      address: { zip: cp },
      email: email || undefined
    };
    const usoCfdi = esGlobal ? CFDI_GLOBAL.use : uso_cfdi;

    if(!esGlobal && (!customer.legal_name || !customer.tax_id || !customer.tax_system || !customer.address.zip || !usoCfdi)){
      return res.status(400).json({ success: false, message: 'Faltan datos del receptor (RFC, razón social, régimen fiscal, CP o uso de CFDI)' });
    }

    const itemsRes = await pool.query(
      `SELECT oi.item_nombre, oi.precio, oi.cantidad, mi.clave_sat
       FROM orden_items oi
       LEFT JOIN menu_items mi ON mi.nombre = oi.item_nombre
       WHERE oi.orden_id=$1`,
      [orden_id]
    );
    if(!itemsRes.rows.length) return res.status(400).json({ success: false, message: 'La orden no tiene artículos' });

    const items = itemsRes.rows.map(it => ({
      quantity: it.cantidad,
      product: {
        description: it.item_nombre,
        product_key: it.clave_sat || CLAVE_PROD_SERV_DEFAULT,
        unit_key: 'E48',
        unit_name: 'Servicio',
        price: parseFloat(it.precio),
        tax_included: true,
        taxes: [{ type: 'IVA', rate: 0.16 }]
      }
    }));

    const facturapiRes = await fetch('https://www.facturapi.io/v2/invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.FACTURAPI_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        customer,
        items,
        payment_form: formaPago,
        payment_method: 'PUE',
        use: usoCfdi
      })
    });
    const facturapiData = await facturapiRes.json();

    if(!facturapiRes.ok){
      return res.status(400).json({
        success: false,
        message: facturapiData.message || (facturapiData.error && facturapiData.error.message) || 'Error al timbrar con Facturapi'
      });
    }

    const pdfUrl = '/api/factura/' + facturapiData.id + '/pdf';
    const xmlUrl = '/api/factura/' + facturapiData.id + '/xml';

    await pool.query(
      `INSERT INTO orama_facturas (orden_id, folio_fiscal, facturapi_id, rfc_receptor, razon_social, total, status, pdf_url, xml_url)
       VALUES ($1,$2,$3,$4,$5,$6,'timbrada',$7,$8)`,
      [orden_id, facturapiData.uuid, facturapiData.id, customer.tax_id, customer.legal_name, orden.total, pdfUrl, xmlUrl]
    );

    res.json({
      success: true,
      folio_fiscal: facturapiData.uuid,
      facturapi_id: facturapiData.id,
      pdf_url: pdfUrl,
      xml_url: xmlUrl
    });
  } catch(e) {
    console.error('Error al facturar:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Proxy autenticado — Facturapi requiere el API key, así el link que compartimos sí abre
app.get('/api/factura/:id/pdf', async (req, res) => {
  try {
    const r = await fetch(`https://www.facturapi.io/v2/invoices/${req.params.id}/pdf`, {
      headers: { 'Authorization': 'Bearer ' + process.env.FACTURAPI_KEY }
    });
    if(!r.ok) return res.status(r.status).send('No se pudo obtener el PDF');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e) {
    res.status(500).send('Error al obtener el PDF');
  }
});

app.get('/api/factura/:id/xml', async (req, res) => {
  try {
    const r = await fetch(`https://www.facturapi.io/v2/invoices/${req.params.id}/xml`, {
      headers: { 'Authorization': 'Bearer ' + process.env.FACTURAPI_KEY }
    });
    if(!r.ok) return res.status(r.status).send('No se pudo obtener el XML');
    res.setHeader('Content-Type', 'application/xml');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e) {
    res.status(500).send('Error al obtener el XML');
  }
});

app.post('/api/factura/:id/email', async (req, res) => {
  try {
    const { email } = req.body || {};
    const r = await fetch(`https://www.facturapi.io/v2/invoices/${req.params.id}/email`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.FACTURAPI_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(email ? { email } : {})
    });
    if(!r.ok){
      const errData = await r.json().catch(() => ({}));
      return res.status(400).json({ success: false, message: errData.message || 'No se pudo enviar el correo' });
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
// STAFF
app.get('/api/staff', async (req, res) => {
  const result = await pool.query('SELECT id, nombre, tipo, idioma, activo FROM staff ORDER BY tipo, nombre');
  res.json(result.rows);
});

app.post('/api/staff', async (req, res) => {
  const { nombre, pin, tipo, idioma } = req.body;
  const result = await pool.query(
    'INSERT INTO staff (nombre, pin, tipo, idioma) VALUES ($1, $2, $3, $4) RETURNING id, nombre, tipo',
    [nombre, pin, tipo, idioma||'es']
  );
  res.json(result.rows[0]);
});

app.post('/api/staff/login', async (req, res) => {
  const { pin } = req.body;
  const result = await pool.query(
    'SELECT id, nombre, tipo, idioma FROM staff WHERE pin=$1 AND activo=1',
    [pin]
  );
  if(!result.rows.length) return res.json({ success: false, message: 'PIN incorrecto' });
  const staff = result.rows[0];
  await pool.query('INSERT INTO staff_sessions (staff_id, screen) VALUES ($1, $2)', [staff.id, 'login']);
  res.json({ success: true, staff });
});

app.put('/api/staff/session', async (req, res) => {
  const { staff_id, screen } = req.body;
  await pool.query('INSERT INTO staff_sessions (staff_id, screen) VALUES ($1, $2)', [staff_id, screen]);
  res.json({ success: true });
});

app.get('/api/staff/active', async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT ON (s.id) s.id, s.nombre, s.tipo, ss.screen, ss.login_time
    FROM staff s
    JOIN staff_sessions ss ON ss.staff_id = s.id
    WHERE ss.login_time > NOW() - INTERVAL '12 hours'
    ORDER BY s.id, ss.login_time DESC
  `);
  res.json(result.rows);
});app.get('/api/mesas/status', async (req, res) => {
  const mesas = await pool.query('SELECT * FROM mesas ORDER BY id');
  const openOrders = await pool.query(`
    SELECT mesa_id, mesa_nombre, id, total, created_at 
    FROM ordenes WHERE status='abierta'
  `);
  const result = mesas.rows.map(m => ({
    ...m,
    ocupada: openOrders.rows.some(o => o.mesa_id === m.id),
    orden: openOrders.rows.find(o => o.mesa_id === m.id) || null
  }));
  res.json(result);
});// INVENTARIO
app.put('/api/menu/:id', async (req, res) => {
  const { nombre, categoria, precio, activo, clave } = req.body;
  await pool.query(
    'UPDATE menu_items SET nombre=$1, categoria=$2, precio=$3, activo=$4, clave=$5 WHERE id=$6',
    [nombre, categoria, precio, activo, clave, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/menu/:id', async (req, res) => {
  await pool.query('DELETE FROM menu_items WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/menu/nuevo', async (req, res) => {
  const { nombre, categoria, precio } = req.body;
  // Auto-generate code based on category
  const catCode = nombre.substring(0,2).toUpperCase();
  const count = await pool.query('SELECT COUNT(*) FROM menu_items WHERE clave LIKE $1', [catCode+'%']);
  const nextNum = parseInt(count.rows[0].count) + 1;
  const clave = catCode + String(nextNum).padStart(2,'0');
  const result = await pool.query(
    'INSERT INTO menu_items (nombre, categoria, precio, clave) VALUES ($1, $2, $3, $4) RETURNING *',
    [nombre, categoria, precio, clave]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════
//  INVENTORY (Phase 2)
// ═══════════════════════════════════════════════════════════════

const NTFY_INVENTARIO = 'https://ntfy.sh/orama-inventario';

// Fire-and-forget ntfy to the inventory topic. Body is UTF-8; Title stays ASCII
// (HTTP header values are latin-1, and emoji in the body broke a past build).
async function ntfyInventario(title, body, tags) {
  try {
    await fetch(NTFY_INVENTARIO, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': title,
        'Tags': tags || 'package'
      },
      body
    });
  } catch (e) { console.log('ntfy inventario error:', e.message); }
}

// Decrement stock for every recipe component consumed by an order, log a movement
// row per component, and alert on any item that just crossed its reorder threshold.
// Runs in a transaction; idempotent per order_id.
async function deductInventoryForOrder(ordenId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const already = await client.query(
      "SELECT 1 FROM inventory_movements WHERE order_id=$1 AND reason='sale' LIMIT 1",
      [ordenId]
    );
    if (already.rows.length) { await client.query('ROLLBACK'); return { skipped: 'already_deducted' }; }

    const consumed = (await client.query(`
      SELECT ri.inventory_item_id,
             SUM(ri.quantity_used * oi.cantidad) AS qty
      FROM orden_items oi
      JOIN menu_items mi   ON mi.nombre = oi.item_nombre
      JOIN recipe_items ri ON ri.menu_item_id = mi.id
      WHERE oi.orden_id = $1
      GROUP BY ri.inventory_item_id
    `, [ordenId])).rows;

    const crossed = [];
    for (const row of consumed) {
      const qty = Number(row.qty);
      if (!qty) continue;
      const upd = await client.query(`
        UPDATE inventory_items
        SET current_stock = current_stock - $1
        WHERE id = $2
        RETURNING name, unit, current_stock, reorder_threshold,
                  (current_stock + $1) AS prev_stock
      `, [qty, row.inventory_item_id]);
      await client.query(
        `INSERT INTO inventory_movements (inventory_item_id, change_amount, reason, order_id)
         VALUES ($1, $2, 'sale', $3)`,
        [row.inventory_item_id, -qty, ordenId]
      );
      const it = upd.rows[0];
      if (it &&
          Number(it.prev_stock) > Number(it.reorder_threshold) &&
          Number(it.current_stock) <= Number(it.reorder_threshold)) {
        crossed.push(it);
      }
    }

    await client.query('COMMIT');

    for (const it of crossed) {
      ntfyInventario(
        'Inventario bajo',
        `${it.name}: quedan ${Number(it.current_stock)} ${it.unit} (umbral ${Number(it.reorder_threshold)}). Hora de resurtir.`,
        'package,warning'
      );
    }
    return { deducted: consumed.length, alerts: crossed.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Apply a manual stock change (restock / adjustment / waste) + log the movement.
async function applyStockChange({ itemId, changeAmount, reason, staffId, note, markRestocked }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = markRestocked
      ? await client.query(`
          UPDATE inventory_items
          SET current_stock = current_stock + $1,
              last_restocked_at = CURRENT_TIMESTAMP,
              last_restocked_by = $2
          WHERE id = $3 RETURNING *`, [changeAmount, staffId || null, itemId])
      : await client.query(`
          UPDATE inventory_items
          SET current_stock = current_stock + $1
          WHERE id = $2 RETURNING *`, [changeAmount, itemId]);
    if (!upd.rows.length) { await client.query('ROLLBACK'); return null; }
    await client.query(
      `INSERT INTO inventory_movements (inventory_item_id, change_amount, reason, staff_id, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [itemId, changeAmount, reason, staffId || null, note || null]
    );
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── stock list / CRUD ──
app.get('/api/inventory', async (req, res) => {
  const result = await pool.query(`
    SELECT i.*, s.nombre AS last_restocked_by_name,
      (i.current_stock <= i.reorder_threshold) AS low_stock
    FROM inventory_items i
    LEFT JOIN staff s ON s.id = i.last_restocked_by
    ORDER BY i.name
  `);
  res.json(result.rows);
});

app.get('/api/inventory/low-stock-count', async (req, res) => {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS count FROM inventory_items WHERE current_stock <= reorder_threshold'
  );
  res.json({ count: r.rows[0].count });
});

app.get('/api/inventory/shopping-list', async (req, res) => {
  const r = await pool.query(`
    SELECT id, name, unit, current_stock, reorder_threshold, reorder_quantity,
           cost_per_unit, supplier_name, supplier_contact,
           ROUND(reorder_quantity * cost_per_unit, 2) AS est_cost
    FROM inventory_items
    WHERE current_stock <= reorder_threshold
    ORDER BY supplier_name NULLS LAST, name
  `);
  res.json(r.rows);
});

app.post('/api/inventory', async (req, res) => {
  const { name, unit, current_stock, reorder_threshold, reorder_quantity,
          cost_per_unit, supplier_name, supplier_contact } = req.body || {};
  if (!name) return res.status(400).json({ success: false, message: 'Nombre requerido' });
  const r = await pool.query(`
    INSERT INTO inventory_items
      (name, unit, current_stock, reorder_threshold, reorder_quantity,
       cost_per_unit, supplier_name, supplier_contact)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [name, unit || 'pieza', current_stock || 0, reorder_threshold || 0,
      reorder_quantity || 0, cost_per_unit || 0, supplier_name || null, supplier_contact || null]);
  res.json(r.rows[0]);
});

app.put('/api/inventory/:id', async (req, res) => {
  const { name, unit, reorder_threshold, reorder_quantity,
          cost_per_unit, supplier_name, supplier_contact } = req.body || {};
  const r = await pool.query(`
    UPDATE inventory_items SET
      name = COALESCE($1, name),
      unit = COALESCE($2, unit),
      reorder_threshold = COALESCE($3, reorder_threshold),
      reorder_quantity = COALESCE($4, reorder_quantity),
      cost_per_unit = COALESCE($5, cost_per_unit),
      supplier_name = $6,
      supplier_contact = $7
    WHERE id = $8 RETURNING *
  `, [name, unit, reorder_threshold, reorder_quantity, cost_per_unit,
      supplier_name || null, supplier_contact || null, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ success: false, message: 'No encontrado' });
  res.json(r.rows[0]);
});

app.delete('/api/inventory/:id', async (req, res) => {
  await pool.query('DELETE FROM inventory_items WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── restock / adjust ──
app.post('/api/inventory/:id/restock', async (req, res) => {
  const { quantity, staff_id, note } = req.body || {};
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ success: false, message: 'Cantidad inválida' });
  const item = await applyStockChange({
    itemId: req.params.id, changeAmount: qty, reason: 'restock',
    staffId: staff_id, note, markRestocked: true
  });
  if (!item) return res.status(404).json({ success: false, message: 'No encontrado' });
  res.json({ success: true, item });
});

app.post('/api/inventory/:id/adjust', async (req, res) => {
  const { change_amount, reason, staff_id, note } = req.body || {};
  const delta = Number(change_amount);
  if (!delta) return res.status(400).json({ success: false, message: 'Cantidad inválida (usa + o -)' });
  if (!['manual_adjustment', 'waste'].includes(reason)) {
    return res.status(400).json({ success: false, message: 'Motivo inválido' });
  }
  if (!note || !note.trim()) return res.status(400).json({ success: false, message: 'La nota es obligatoria' });
  const item = await applyStockChange({
    itemId: req.params.id, changeAmount: delta, reason, staffId: staff_id, note: note.trim()
  });
  if (!item) return res.status(404).json({ success: false, message: 'No encontrado' });
  res.json({ success: true, item });
});

// ── movement history for one item ──
app.get('/api/inventory/:id/movements', async (req, res) => {
  const { from, to, reason } = req.query;
  const params = [req.params.id];
  let q = `
    SELECT m.*, s.nombre AS staff_nombre
    FROM inventory_movements m
    LEFT JOIN staff s ON s.id = m.staff_id
    WHERE m.inventory_item_id = $1
  `;
  if (from) { params.push(from); q += ` AND DATE(m.created_at) >= $${params.length}`; }
  if (to)   { params.push(to);   q += ` AND DATE(m.created_at) <= $${params.length}`; }
  if (reason) { params.push(reason); q += ` AND m.reason = $${params.length}`; }
  q += ' ORDER BY m.created_at DESC LIMIT 500';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// ── "Solicitar resurtido" — staff-initiated request, ntfy only, no DB write ──
app.post('/api/inventory/request-restock', async (req, res) => {
  const { item_id, item_name, current_stock, unit, note } = req.body || {};
  let name = item_name, stock = current_stock, u = unit;
  if (item_id && !name) {
    const r = await pool.query('SELECT name, current_stock, unit FROM inventory_items WHERE id=$1', [item_id]);
    if (r.rows.length) { name = r.rows[0].name; stock = r.rows[0].current_stock; u = r.rows[0].unit; }
  }
  const parts = ['Solicitud de resurtido'];
  if (name) parts.push(`: ${name}`);
  if (stock != null && u) parts.push(` (quedan ${Number(stock)} ${u})`);
  if (note && note.trim()) parts.push(` — ${note.trim()}`);
  await ntfyInventario('Solicitud de resurtido', parts.join(''), 'shopping_cart');
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
//  RECIPES (menu item -> inventory it consumes)
// ═══════════════════════════════════════════════════════════════

// map of menu_item_id -> component count, for the editor's "has recipe" badges
app.get('/api/recipes', async (req, res) => {
  const r = await pool.query(
    'SELECT menu_item_id, COUNT(*)::int AS components FROM recipe_items GROUP BY menu_item_id'
  );
  res.json(r.rows);
});

app.get('/api/recipes/:menuItemId', async (req, res) => {
  const r = await pool.query(`
    SELECT ri.id, ri.inventory_item_id, ri.quantity_used,
           ii.name AS inventory_name, ii.unit, ii.cost_per_unit
    FROM recipe_items ri
    JOIN inventory_items ii ON ii.id = ri.inventory_item_id
    WHERE ri.menu_item_id = $1
    ORDER BY ii.name
  `, [req.params.menuItemId]);
  res.json(r.rows);
});

// replace the whole recipe for a menu item in one call
app.put('/api/recipes/:menuItemId', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ success: false, message: 'items[] requerido' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM recipe_items WHERE menu_item_id=$1', [req.params.menuItemId]);
    for (const it of items) {
      const invId = Number(it.inventory_item_id);
      const qty = Number(it.quantity_used);
      if (!invId || !(qty > 0)) continue;
      await client.query(
        `INSERT INTO recipe_items (menu_item_id, inventory_item_id, quantity_used)
         VALUES ($1,$2,$3)
         ON CONFLICT (menu_item_id, inventory_item_id) DO UPDATE SET quantity_used = EXCLUDED.quantity_used`,
        [req.params.menuItemId, invId, qty]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, count: items.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: e.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════
//  REPORTS & ANALYTICS (Phase 3) — all dates in America/Mexico_City via mx()
// ═══════════════════════════════════════════════════════════════

// settings key/value (currently: margin_threshold_pct)
app.get('/api/settings/:key', async (req, res) => {
  const r = await pool.query('SELECT value FROM orama_settings WHERE key=$1', [req.params.key]);
  res.json({ key: req.params.key, value: r.rows[0]?.value ?? null });
});
app.put('/api/settings/:key', async (req, res) => {
  const { value } = req.body || {};
  await pool.query(
    `INSERT INTO orama_settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [req.params.key, String(value)]
  );
  res.json({ success: true });
});

// the equally-long window immediately before [from, to]
function prevRange(from, to) {
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  const span = t - f;
  const pt = new Date(f.getTime() - 86400000);
  const pf = new Date(pt.getTime() - span);
  const iso = d => d.toISOString().slice(0, 10);
  return { from: iso(pf), to: iso(pt) };
}

async function periodKpis(from, to) {
  const [sales, exp] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS ordenes, COALESCE(SUM(total),0)::float AS ingresos
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
    `, [from, to]),
    pool.query(`SELECT COALESCE(SUM(monto),0)::float AS gastos FROM gastos WHERE fecha BETWEEN $1 AND $2`, [from, to])
  ]);
  const ingresos = sales.rows[0].ingresos;
  const ordenes = sales.rows[0].ordenes;
  const gastos = exp.rows[0].gastos;
  return {
    ingresos, gastos, ordenes,
    neto: ingresos - gastos,
    ticket: ordenes ? ingresos / ordenes : 0
  };
}

// main dashboard bundle
app.get('/api/reportes/v2', async (req, res) => {
  const from = req.query.from, to = req.query.to;
  if (!from || !to) return res.status(400).json({ message: 'from y to requeridos' });
  const prev = prevRange(from, to);

  const [kpi, kpi_prev, serie, pagos, categorias, topQty, topIngreso, mesas, lista] = await Promise.all([
    periodKpis(from, to),
    periodKpis(prev.from, prev.to),
    pool.query(`
      SELECT DATE(mx(created_at))::text AS d,
             COUNT(*)::int AS ordenes,
             COALESCE(SUM(total),0)::float AS ingresos
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
      GROUP BY d ORDER BY d
    `, [from, to]),
    pool.query(`
      SELECT payment_method, COUNT(*)::int AS ordenes, COALESCE(SUM(total),0)::float AS total
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
      GROUP BY payment_method ORDER BY total DESC
    `, [from, to]),
    pool.query(`
      SELECT mi.categoria, COALESCE(SUM(oi.precio*oi.cantidad),0)::float AS total,
             COALESCE(SUM(oi.cantidad),0)::int AS cantidad
      FROM orden_items oi
      JOIN ordenes o ON o.id = oi.orden_id
      JOIN menu_items mi ON mi.nombre = oi.item_nombre
      WHERE o.status='cerrada' AND DATE(mx(o.created_at)) BETWEEN $1 AND $2
      GROUP BY mi.categoria ORDER BY total DESC
    `, [from, to]),
    pool.query(`
      SELECT oi.item_nombre, SUM(oi.cantidad)::int AS cantidad,
             SUM(oi.precio*oi.cantidad)::float AS ingreso
      FROM orden_items oi
      JOIN ordenes o ON o.id = oi.orden_id
      WHERE o.status='cerrada' AND DATE(mx(o.created_at)) BETWEEN $1 AND $2
      GROUP BY oi.item_nombre ORDER BY cantidad DESC LIMIT 15
    `, [from, to]),
    pool.query(`
      SELECT oi.item_nombre, SUM(oi.cantidad)::int AS cantidad,
             SUM(oi.precio*oi.cantidad)::float AS ingreso
      FROM orden_items oi
      JOIN ordenes o ON o.id = oi.orden_id
      WHERE o.status='cerrada' AND DATE(mx(o.created_at)) BETWEEN $1 AND $2
      GROUP BY oi.item_nombre ORDER BY ingreso DESC LIMIT 15
    `, [from, to]),
    pool.query(`
      SELECT mesa_nombre,
             COUNT(*)::int AS ordenes,
             COALESCE(SUM(total),0)::float AS ingresos,
             (COALESCE(SUM(total),0) / NULLIF(COUNT(*),0))::float AS ticket,
             (AVG(EXTRACT(EPOCH FROM (closed_at - created_at))/60)
               FILTER (WHERE closed_at IS NOT NULL))::float AS min_prom
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
      GROUP BY mesa_nombre ORDER BY ingresos DESC
    `, [from, to]),
    pool.query(`
      SELECT id, mesa_nombre, total::float, payment_method, notas, created_at
      FROM ordenes
      WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
      ORDER BY created_at DESC LIMIT 100
    `, [from, to])
  ]);

  res.json({
    rango: { from, to }, prev,
    kpi, kpi_prev,
    serie: serie.rows,
    pagos: pagos.rows,
    categorias: categorias.rows,
    top_qty: topQty.rows,
    top_ingreso: topIngreso.rows,
    mesas: mesas.rows,
    ordenes_lista: lista.rows
  });
});

// peak hours: order volume by day-of-week x hour-of-day (MX time)
app.get('/api/reportes/horas', async (req, res) => {
  const from = req.query.from, to = req.query.to;
  if (!from || !to) return res.status(400).json({ message: 'from y to requeridos' });
  const r = await pool.query(`
    SELECT EXTRACT(DOW  FROM mx(created_at))::int  AS dow,
           EXTRACT(HOUR FROM mx(created_at))::int  AS hora,
           COUNT(*)::int AS ordenes,
           COALESCE(SUM(total),0)::float AS ingresos
    FROM ordenes
    WHERE status='cerrada' AND DATE(mx(created_at)) BETWEEN $1 AND $2
    GROUP BY dow, hora ORDER BY dow, hora
  `, [from, to]);
  res.json({ celdas: r.rows });
});

// per-item cost & margin from Phase 2 recipe data
app.get('/api/reportes/margenes', async (req, res) => {
  const thr = await pool.query("SELECT value FROM orama_settings WHERE key='margin_threshold_pct'");
  const threshold_pct = parseFloat(thr.rows[0]?.value ?? '70');

  const [cov, items] = await Promise.all([
    pool.query(`
      SELECT (SELECT COUNT(*) FROM menu_items)::int AS total,
             (SELECT COUNT(DISTINCT menu_item_id) FROM recipe_items)::int AS con_receta,
             (SELECT COUNT(*) FROM inventory_items WHERE cost_per_unit > 0)::int AS insumos_con_costo
    `),
    pool.query(`
      WITH costo AS (
        SELECT ri.menu_item_id,
               SUM(ri.quantity_used * ii.cost_per_unit)::float AS costo
        FROM recipe_items ri
        JOIN inventory_items ii ON ii.id = ri.inventory_item_id
        GROUP BY ri.menu_item_id
      ),
      ventas AS (
        SELECT oi.item_nombre,
               SUM(oi.cantidad)::int AS vendidos,
               SUM(oi.precio*oi.cantidad)::float AS ingreso
        FROM orden_items oi
        JOIN ordenes o ON o.id = oi.orden_id
        WHERE o.status='cerrada' AND mx(o.created_at) >= (now() AT TIME ZONE 'America/Mexico_City') - INTERVAL '30 days'
        GROUP BY oi.item_nombre
      )
      SELECT mi.id AS menu_item_id, mi.nombre, mi.categoria, mi.precio::float AS precio,
             c.costo,
             (mi.precio - c.costo)::float AS margen,
             CASE WHEN mi.precio > 0 THEN ((mi.precio - c.costo)/mi.precio*100)::float ELSE NULL END AS margen_pct,
             COALESCE(v.vendidos,0)::int AS vendidos_30d,
             COALESCE(v.ingreso,0)::float AS ingreso_30d
      FROM costo c
      JOIN menu_items mi ON mi.id = c.menu_item_id
      LEFT JOIN ventas v ON v.item_nombre = mi.nombre
      ORDER BY margen_pct ASC NULLS LAST
    `)
  ]);

  res.json({
    threshold_pct,
    cobertura: cov.rows[0],
    items: items.rows.map(x => ({ ...x, bajo_umbral: x.margen_pct != null && x.margen_pct < threshold_pct }))
  });
});

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Orama Server running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});