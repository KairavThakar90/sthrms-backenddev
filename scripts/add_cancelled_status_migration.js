#!/usr/bin/env node
require('dotenv').config();
const pool = require('../config/database');

const TABLE_NAME = 'wp_hrms_leaves';
const COLUMN_NAME = 'status';

async function columnTypeIncludesCancelled() {
  const dbName = process.env.DB_NAME || process.env.MYSQL_DATABASE || '';
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE AS columnType
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [dbName, TABLE_NAME, COLUMN_NAME]
  );

  const columnType = rows[0] && rows[0].columnType ? rows[0].columnType : '';
  return columnType.includes('cancelled');
}

async function run() {
  try {
    const alreadyHasCancelled = await columnTypeIncludesCancelled();
    if (alreadyHasCancelled) {
      console.log(`Column ${COLUMN_NAME} on ${TABLE_NAME} already includes cancelled. Nothing to do.`);
      process.exit(0);
    }

    const alter = `ALTER TABLE \`${TABLE_NAME}\` MODIFY COLUMN \`${COLUMN_NAME}\` ENUM('pending','approved','rejected','partially_approved','cancelled') DEFAULT 'pending'`;
    console.log('Running:', alter);
    await pool.query(alter);
    console.log(`Successfully updated ${TABLE_NAME}.${COLUMN_NAME} to support cancelled status.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message || err);
    process.exit(1);
  }
}

run();
