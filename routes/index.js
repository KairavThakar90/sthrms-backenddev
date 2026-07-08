const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const router = express.Router();

const leaveRoutes = require('./leaveRoutes');
const holidayRoutes = require('./holidayRoutes');
const profileRoutes = require('./profileRoutes');
const feedbackRoutes = require('./feedbackRoutes');
const leaveController = require('../controllers/leaveController');
const documentController = require('../controllers/documentController');

const getUploadTempDir = () => {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), 'uploads', 'temp');
  }

  return path.join(__dirname, '..', 'uploads', 'temp');
};

const uploadTempDir = getUploadTempDir();
fs.mkdirSync(uploadTempDir, { recursive: true });

const upload = multer({
  dest: uploadTempDir,
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/policy-document', leaveController.getCurrentPolicyDocument);
router.post('/documents/upload', upload.single('file'), documentController.uploadDocumentToWordPress);
router.post('/documents/save', documentController.saveDocumentMetadata);
router.use('/feedback', feedbackRoutes);
router.use('/leaves', leaveRoutes);
router.use('/holidays', holidayRoutes);
router.use('/profile', profileRoutes);

module.exports = router;
