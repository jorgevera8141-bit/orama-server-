const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: 'postgresql://postgres:nwFIKcmWxuKUHUXorawzbqmIumCfAEMV@tokaido.proxy.rlwy.net:22840/railway',
  ssl: false
});

const items = require('./seed_data.json');

async function seed() {
  const check = await pool.query('SELECT COUNT(*) FROM menu_items');
  if (parseInt(check.rows[0].count) > 0) {
    console.log('Menu already seeded with ' + check.rows[0].count + ' items');
    await pool.end();
    return;
  }
  
  for (const item of items) {
    await pool.query(
      'INSERT INTO menu_items (nombre, categoria, precio) VALUES ($1, $2, $3)',
      [item.nombre, item.categoria, item.precio]
    );
  }
  console.log('Imported ' + items.length + ' menu items!');
  await pool.end();
}

seed().catch(console.error);
