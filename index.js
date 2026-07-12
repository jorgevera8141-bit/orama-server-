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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orden_items (
      id SERIAL PRIMARY KEY,
      orden_id INTEGER,
      item_nombre TEXT,
      precio NUMERIC,
      cantidad INTEGER DEFAULT 1
    );
  `);
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

// MENU
app.get('/api/menu', async (req, res) => {
  const result = await pool.query('SELECT * FROM menu_items WHERE activo=1 ORDER BY categoria, nombre');
  res.json(result.rows);
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
  await pool.query("UPDATE ordenes SET status='cerrada' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// SUMMARY
app.get('/api/resumen', async (req, res) => {
  const result = await pool.query(
    "SELECT COUNT(*) as ordenes, COALESCE(SUM(total),0) as total FROM ordenes WHERE status='cerrada' AND DATE(created_at)=CURRENT_DATE"
  );
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

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Orama Server running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});