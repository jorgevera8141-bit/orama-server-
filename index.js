const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 3001;
const db = new Database('orama.db');

app.use(express.json());
app.use(express.static('public'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS mesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    status TEXT DEFAULT 'disponible'
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    categoria TEXT NOT NULL,
    precio REAL NOT NULL,
    activo INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ordenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mesa_id INTEGER,
    mesa_nombre TEXT,
    status TEXT DEFAULT 'abierta',
    total REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orden_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id INTEGER,
    item_nombre TEXT,
    precio REAL,
    cantidad INTEGER DEFAULT 1
  );
`);

// MESAS
app.get('/api/mesas', (req, res) => {
  res.json(db.prepare('SELECT * FROM mesas').all());
});
app.post('/api/mesas', (req, res) => {
  const { nombre } = req.body;
  const result = db.prepare('INSERT INTO mesas (nombre) VALUES (?)').run(nombre);
  res.json({ id: result.lastInsertRowid, nombre });
});

app.post('/api/menu', (req, res) => {
  const { nombre, categoria, precio } = req.body;
  const result = db.prepare('INSERT INTO menu_items (nombre, categoria, precio) VALUES (?,?,?)').run(nombre, categoria, precio);
  res.json({ id: result.lastInsertRowid, nombre, categoria, precio });
});
// MENU
app.get('/api/menu', (req, res) => {
  res.json(db.prepare('SELECT * FROM menu_items WHERE activo=1 ORDER BY categoria, nombre').all());
});

// ORDENES
app.get('/api/ordenes', (req, res) => {
  res.json(db.prepare("SELECT * FROM ordenes WHERE status='abierta' ORDER BY created_at DESC").all());
});

app.post('/api/ordenes', (req, res) => {
  const { mesa_id, mesa_nombre, items } = req.body;
  const total = items.reduce((sum, i) => sum + (i.precio * i.cantidad), 0);
  const orden = db.prepare('INSERT INTO ordenes (mesa_id, mesa_nombre, total) VALUES (?,?,?)').run(mesa_id, mesa_nombre, total);
  const insertItem = db.prepare('INSERT INTO orden_items (orden_id, item_nombre, precio, cantidad) VALUES (?,?,?,?)');
  items.forEach(i => insertItem.run(orden.lastInsertRowid, i.nombre, i.precio, i.cantidad));
  res.json({ id: orden.lastInsertRowid, total });
});

app.put('/api/ordenes/:id/cerrar', (req, res) => {
  db.prepare("UPDATE ordenes SET status='cerrada' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// SUMMARY
app.get('/api/resumen', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const data = db.prepare(`SELECT COUNT(*) as ordenes, SUM(total) as total FROM ordenes WHERE status='cerrada' AND date(created_at)=?`).get(today);
  res.json(data);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Orama Server running at http://localhost:${PORT}`);
});
