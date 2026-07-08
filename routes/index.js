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

  // Use /tmp for Vercel serverless, fallback to local uploads/temp for local development
  const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
  const uploadTempDir = isServerless 
    ? '/tmp/uploads'
    : path.join(__dirname, '../uploads/temp');

  // Try to create directory, but don't crash if it fails (e.g., in read-only environments)
  try {
    fs.mkdirSync(uploadTempDir, { recursive: true });
    console.log(`[Routes] Upload temp directory created: ${uploadTempDir}`);
  } catch (dirError) {
    console.warn(`[Routes] Could not create upload temp directory: ${dirError.message}`);
    // Continue anyway - multer will handle the error when upload is attempted
  }

  const upload = multer({
    dest: uploadTempDir,
    limits: { fileSize: 5 * 1024 * 1024 },
    onError: (err, next) => {
      console.error('[Multer Error]', err);
      next(err);
    }
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
