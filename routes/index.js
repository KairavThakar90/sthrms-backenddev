const express = require('express');
const router = express.Router();

const leaveRoutes = require('./leaveRoutes');
const holidayRoutes = require('./holidayRoutes');
const profileRoutes = require('./profileRoutes');

router.use('/leaves', leaveRoutes);
router.use('/holidays', holidayRoutes);
router.use('/profile', profileRoutes);

module.exports = router;
