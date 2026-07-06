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
  res.json({
    name: 'ST HRMS Leave Management API dev',
    version: '1.0.0',
    status: 'Running'
  });
});

// API Routes
app.use('/api', routes);

// 404 Route handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler
app.use(errorHandler);

module.exports = app;
