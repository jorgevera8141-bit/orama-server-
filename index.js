const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Use DATABASE_URL env var on Railway, or local SQLite fallback
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:nwFIKcmWxuKUHUXorawzbqmIumCfAEMV@tokaido.proxy.rlwy.net:22840/railway',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static('public'));
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
  `);

  await pool.query(`
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'efectivo';
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS amount_cash NUMERIC DEFAULT 0;
    ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS amount_card NUMERIC DEFAULT 0;
  `).catch(() => {});

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
  const [summary, categorias, orders] = await Promise.all([
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
    `, [from, to])
  ]);
  res.json({
    ...summary.rows[0],
    categorias: categorias.rows,
    orders: orders.rows
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
  const { payment_method, amount_cash, amount_card } = req.body || {};
  const orden = await pool.query('SELECT * FROM ordenes WHERE id=$1', [req.params.id]);
  await pool.query(
    "UPDATE ordenes SET status='cerrada', payment_method=$1, amount_cash=$2, amount_card=$3 WHERE id=$4",
    [payment_method||'efectivo', amount_cash||0, amount_card||0, req.params.id]
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
      COALESCE(SUM(CASE WHEN payment_method='efectivo' THEN amount_cash ELSE 0 END),0) as total_efectivo,
      COALESCE(SUM(CASE WHEN payment_method='tarjeta' THEN amount_card ELSE 0 END),0) as total_tarjeta,
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
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Orama Server running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});