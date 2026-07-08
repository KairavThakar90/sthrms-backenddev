const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { authenticate } = require('../middlewares/auth');
const { getProfile, updateProfile, uploadProfileImage } = require('../controllers/profileController');

const router = express.Router();

const getUploadDir = () => {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), 'profile-icons');
  }

  return path.join(__dirname, '..', 'uploads', 'profile-icons');
};

const uploadDir = getUploadDir();
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only image files are allowed for profile icons.'));
  },
});

router.get('/:id', authenticate, getProfile);
router.get('/', authenticate, getProfile);
router.post('/upload-image', authenticate, upload.single('profile_icon_file'), uploadProfileImage);
router.put('/', authenticate, upload.single('profile_icon_file'), updateProfile);

module.exports = router;
