#!/usr/bin/env node
require('dotenv').config();
const pool = require('../config/database');

const COLUMN_NAME = 'compensate_date';
const TABLE_NAME = 'wp_hrms_leaves';

async function columnExists() {
  const query = `
    SELECT COUNT(*) AS cnt
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ? AND column_name = ?
  `;
  const dbName = process.env.DB_NAME || process.env.MYSQL_DATABASE || '';
  const [rows] = await pool.query(query, [dbName, TABLE_NAME, COLUMN_NAME]);
  return rows[0] && rows[0].cnt > 0;
}

async function run() {
  try {
    const exists = await columnExists();
    if (exists) {
      console.log(`Column ${COLUMN_NAME} already exists on ${TABLE_NAME}. Nothing to do.`);
      process.exit(0);
    }

    const alter = `ALTER TABLE \`${TABLE_NAME}\` ADD COLUMN \`${COLUMN_NAME}\` DATE DEFAULT NULL`;
    console.log('Running:', alter);
    await pool.query(alter);
    console.log(`Successfully added column ${COLUMN_NAME} to ${TABLE_NAME}.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message || err);
    process.exit(1);
  }
}

run();
