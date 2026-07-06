const express = require('express');
const router = express.Router();
const holidayController = require('../controllers/holidayController');

router.get('/all', holidayController.getAllHolidayLists);
router.get('/upcoming', holidayController.getUpcomingHolidays);
router.get('/', holidayController.getHolidayList);

module.exports = router;
