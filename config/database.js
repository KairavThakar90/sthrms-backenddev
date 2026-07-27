// config/database.js
const mysql = require('mysql2/promise');
require('dotenv').config();

const isRemoteHost = Boolean(process.env.DB_HOST && !['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST));
const useSsl = process.env.DB_SSL === 'true' || process.env.DB_SSL === '1' || (isRemoteHost && process.env.DB_SSL !== 'false');

const pool = mysql.createPool({ 
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'wordpress_db',
  connectTimeout: 10000,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined
});

module.exports = pool;
