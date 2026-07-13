// routes/timeTrackingRoutes.js
const express = require('express');
const router = express.Router();
const timeTrackingController = require('../controllers/timeTrackingController');
const { authenticate } = require('../middlewares/auth');

// All time-tracking endpoints require authentication
router.use(authenticate);

// GET /api/time-tracking/weekly-hours?date=YYYY-MM-DD&employee_id=123
// Returns total tracked hours from `date` back to its previous Monday (inclusive)
router.get('/weekly-hours', timeTrackingController.getWeeklyHoursUpToDate);

module.exports = router;