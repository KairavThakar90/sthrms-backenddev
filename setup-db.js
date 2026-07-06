// setup-db.js
const pool = require('./config/database');
const fs = require('fs');
const path = require('path');

const setup = async () => {
  try {
    console.log('[Setup] Connecting to database and applying schema...');
    
    // Read schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Split queries by semicolon and execute them
    const queries = schemaSql
      .split(';')
      .map(q => q.trim())
      .filter(q => q.length > 0);
      
    for (const query of queries) {
      console.log(`[Setup] Executing query...`);
      await pool.query(query);
    }
    
    console.log('[Setup] Leave management tables (wp_hrms_leaves and wp_hrms_leave_balances) created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('[Setup] Failed to initialize database:', error);
    process.exit(1);
  }
};

setup();
