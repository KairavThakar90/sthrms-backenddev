// server.js
const app = require('./app');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

// Start server
const startServer = async () => {
  try {
    app.listen(PORT, () => {
      console.log(`[Server] ST HRMS Leave Management API is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('[Server] Error starting server:');
    console.error(error.message);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}
