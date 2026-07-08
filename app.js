// app.js
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

// Standard Middlewares
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Root Welcome Endpoint
app.get('/', (req, res) => {
  try {
    res.json({
      name: 'ST HRMS Leave Management API dev',
      version: '1.0.0',
      status: 'Running',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Root Endpoint Error]', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    console.error('[Health Endpoint Error]', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// API Routes
app.use('/api', routes);

// 404 Route handler
app.use((req, res, next) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Global Error Handler (must be last)
app.use(errorHandler);

// Catch unhandled promise rejections in Express
app.use((err, req, res, next) => {
  console.error('[Unhandled Error in Middleware]', err);
  res.status(err.statusCode || 500).json({ 
    error: err.message || 'An error occurred',
    type: err.name 
  });
});

module.exports = app;
