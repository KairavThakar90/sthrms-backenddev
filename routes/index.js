const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();

try {
  const leaveRoutes = require('./leaveRoutes');
  const holidayRoutes = require('./holidayRoutes');
  const profileRoutes = require('./profileRoutes');
  const leaveController = require('../controllers/leaveController');
  const documentController = require('../controllers/documentController');

  const uploadTempDir = path.join(__dirname, '../uploads/temp');
  fs.mkdirSync(uploadTempDir, { recursive: true });

  const upload = multer({
    dest: uploadTempDir,
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  router.get('/policy-document', leaveController.getCurrentPolicyDocument);
  router.post('/documents/upload', upload.single('file'), documentController.uploadDocumentToWordPress);
  router.post('/documents/save', documentController.saveDocumentMetadata);
  router.use('/leaves', leaveRoutes);
  router.use('/holidays', holidayRoutes);
  router.use('/profile', profileRoutes);
} catch (error) {
  console.error('[Routes Initialization Error]', error);
  // Return error on /api/* routes
  router.use((req, res) => {
    res.status(500).json({ 
      error: 'API initialization failed',
      details: error.message
    });
  });
}

module.exports = router;
