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
    "SELECT id, mesa_nombre, total, payment_method, amount_cash, amount_card, created_at FROM ordenes WHERE status='cerrada' AND DATE(created_at)=$1 ORDER BY created_at ASC",
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
        COUNT(DISTINCT DATE(created_at)) as dias
      FROM ordenes 
      WHERE status='cerrada' AND DATE(created_at) BETWEEN $1 AND $2
    `, [from, to]),
    pool.query(`
      SELECT mi.categoria, COALESCE(SUM(oi.precio * oi.cantidad),0) as total
      FROM orden_items oi
      JOIN ordenes o ON o.id = oi.orden_id
      JOIN menu_items mi ON mi.nombre = oi.item_nombre
      WHERE o.status='cerrada' AND DATE(o.created_at) BETWEEN $1 AND $2
      GROUP BY mi.categoria
      ORDER BY total DESC
    `, [from, to]),
    pool.query(`
      SELECT * FROM ordenes 
      WHERE status='cerrada' AND DATE(created_at) BETWEEN $1 AND $2
      ORDER BY created_at DESC
      LIMIT 100
    `, [from, to]),
    pool.query(`
      SELECT oi.item_nombre, 
        SUM(oi.cantidad) as cantidad,
        SUM(oi.precio * oi.cantidad) as total
      FROM orden_items oi
      JOIN ordenes o ON o.id = oi.orden_id
      WHERE o.status='cerrada' AND DATE(o.created_at) BETWEEN $1 AND $2
      GROUP BY oi.item_nombre
      ORDER BY cantidad DESC
      LIMIT 20
    `, [from, to]),
    pool.query(`
      SELECT payment_method,
        COUNT(*) as ordenes,
        COALESCE(SUM(total),0) as total
      FROM ordenes
      WHERE status='cerrada' AND DATE(created_at) BETWEEN $1 AND $2
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
  await pool.query(
    "UPDATE ordenes SET status='cerrada', payment_method=$1, amount_cash=$2, amount_card=$3, notas=$4 WHERE id=$5",
    [payment_method||'efectivo', amount_cash||0, amount_card||0, notas||'', req.params.id]
  );
  
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
    WHERE status='cerrada' AND DATE(created_at)=$1
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
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as mes,
        COALESCE(SUM(total), 0) as total
      FROM ordenes 
      WHERE status='cerrada' AND DATE(created_at) BETWEEN $1 AND $2
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
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Orama Server running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});