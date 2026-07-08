const app = require('../app');

// Vercel serverless function handler
module.exports = (req, res) => {
  app(req, res);
};
