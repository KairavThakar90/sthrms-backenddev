const pool = require('../config/database');

const VALID_FEEDBACK_TYPES = ['like', 'dislike', 'newteal'];

const createFeedback = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { feedback_type, reason } = req.body || {};

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (!feedback_type || typeof feedback_type !== 'string') {
      return res.status(400).json({ error: 'feedback_type is required.' });
    }

    const normalizedType = String(feedback_type).trim().toLowerCase();
    if (!VALID_FEEDBACK_TYPES.includes(normalizedType)) {
      return res.status(400).json({
        error: `Invalid feedback_type. Allowed values: ${VALID_FEEDBACK_TYPES.join(', ')}`,
      });
    }

    const trimmedReason = reason === undefined || reason === null ? null : String(reason).trim();

    const query = `
      INSERT INTO wp_hrms_feedback (user_id, feedback_type, reason, created_at)
      VALUES (?, ?, ?, NOW())
    `;

    const [result] = await pool.query(query, [userId, normalizedType, trimmedReason]);

    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        user_id: userId,
        feedback_type: normalizedType,
        reason: trimmedReason,
      },
    });
  } catch (error) {
    console.error('[Feedback] Failed to create feedback:', error);
    return res.status(500).json({ error: 'Failed to save feedback.' });
  }
};

module.exports = {
  createFeedback,
};
