// routes/leaveRoutes.js
const express = require('express');
const router = express.Router();
const leaveController = require('../controllers/leaveController');
const { authenticate, authorize, authenticateOrRedirect } = require('../middlewares/auth');

// Public email action endpoint: asks for login if not authenticated, preserves redirect URL
router.get('/:id/action', authenticateOrRedirect, leaveController.handleActionLink);

// All other leave endpoints require user authentication
router.use(authenticate);

// 1. Get leave balances (everyone can access; restriction checks inside the controller)
router.get('/balances/:employee_id', leaveController.getLeaveBalances);
router.get('/balances', leaveController.getLeaveBalances);

// 2. Configure leave balance (administrator & hr only)
router.post('/balances', authorize(['administrator', 'hr']), leaveController.configureLeaveBalance);

// 3. Apply for leave (everyone can access)
router.post('/', leaveController.applyLeave);

// 4. Get leave dashboard reports (everyone; role-based filtering inside controller)
router.get('/report', leaveController.getLeavesReport);

// 5. Level 1: Leader approval (leader and administrator only)
router.put('/:id/approve-leader', authorize(['leader', 'administrator']), leaveController.approveLeader);

// 6. Level 2: HR approval (hr and administrator only)
router.put('/:id/approve-hr', authorize(['hr', 'administrator']), leaveController.approveHR);

module.exports = router;
