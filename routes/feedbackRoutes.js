const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth');
const { createFeedback } = require('../controllers/feedbackController');

router.post('/', authenticate, createFeedback);

module.exports = router;
