const app = require('../app');

// Wrap Express app for Vercel serverless environment
module.exports = (req, res) => {
  // Log incoming request for debugging
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  // Add error handler wrapper
  try {
    app(req, res);
  } catch (error) {
    console.error('[API Handler Error]', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
};
