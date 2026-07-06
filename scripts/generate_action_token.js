#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v === undefined ? true : v;
    }
  }
  return args;
}

const argv = parseArgs();
const leaveId = argv.leaveId || argv.leaveid || argv.id;
const actor = argv.actor || 'leader';
const approverEmail = argv.approverEmail || argv.approveremail || argv.email || '';
const expires = parseInt(argv.expires || argv.exp || '1440', 10); // minutes, default 24h
const secret = process.env.JWT_SECRET || 'secret';
const DEFAULT_APP_BASE_URL = process.env.APP_BASE_URL || process.env.APP_URL || 'http://localhost:3000';

async function getFrontendBaseUrl() {
  try {
    const pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'wordpress_db'
    });
    const [rows] = await pool.query('SELECT option_value FROM wp_options WHERE option_name = ? LIMIT 1', ['st_frontend_url_hrml']);
    await pool.end();
    const configuredUrl = rows[0] && typeof rows[0].option_value === 'string' ? rows[0].option_value.trim() : '';
    return configuredUrl ? configuredUrl.replace(/\/+$/, '') : DEFAULT_APP_BASE_URL.replace(/\/+$/, '');
  } catch (error) {
    console.warn('Failed to read frontend URL option, falling back to default:', error.message);
    return DEFAULT_APP_BASE_URL.replace(/\/+$/, '');
  }
}

if (!leaveId) {
  console.error('Usage: node scripts/generate_action_token.js --leaveId=123 --actor=leader|hr --approverEmail=you@example.com [--expires=60]');
  process.exit(2);
}

async function main() {
  const APP_BASE_URL = await getFrontendBaseUrl();
  const exp = Math.floor(Date.now() / 1000) + expires * 60;
  const payload = { leaveId: String(leaveId), actor, approverEmail, exp };
  const dataStr = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(dataStr).digest('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const token = `${dataStr}.${sig}`;
  const actionLink = `${APP_BASE_URL}/api/leaves/${leaveId}/action?token=${encodeURIComponent(token)}&decision=approved`;

  console.log('Token:');
  console.log(token);
  console.log('\nAction link (Approve):');
  console.log(actionLink);
  console.log('\nAction link (Reject):');
  console.log(`${APP_BASE_URL}/api/leaves/${leaveId}/action?token=${encodeURIComponent(token)}&decision=rejected`);

  console.log('\nExample curl (GET):');
  console.log(`curl -v "${actionLink}"`);

  // Also print decoded payload for verification
  console.log('\nDecoded payload (for verification):');
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error('Failed to generate action link:', error);
  process.exit(1);
});
