// server.js
const app = require('./app');
const pool = require('./config/database');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

// Verify database connection and start server
const startServer = async () => {
  try {
    // Attempt to connect to the database to ensure configuration is correct
    const connection = await pool.getConnection();
    console.log('[Database] Connection pool established successfully.');
    connection.release();

    app.listen(PORT, () => {
      console.log(`[Server] ST HRMS Leave Management API is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('[Database] Failed to connect to MySQL database on startup:');
    console.error(error.message);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}
