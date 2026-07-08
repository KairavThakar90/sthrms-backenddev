const pool = require('../config/database');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/svg+xml'];
const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'svg'];
const WORDPRESS_UPLOAD_URL = process.env.WORDPRESS_UPLOAD_URL || 'https://nothing.peakworkos.com';

const normalizeDocumentType = (value) => {
  if (!value) return '';
  return String(value).trim().toUpperCase();
};

const validateUploadPayload = (req) => {
  if (!req.file) {
    return { ok: false, message: 'No file uploaded.' };
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase().replace('.', '');
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, message: 'File type not allowed. Allowed: PDF, JPG, PNG, SVG.' };
  }

  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return { ok: false, message: 'File type not allowed. Allowed: PDF, JPG, PNG, SVG.' };
  }

  return { ok: true };
};

const uploadToWordPressViaHttp = async (req, file) => {
  const boundary = `----STHRMS${Date.now()}`;
  const fileBuffer = fs.readFileSync(file.path);
  const fileName = path.basename(file.originalname || 'document');
  const mimeType = file.mimetype || 'application/octet-stream';
  const safeFileName = fileName.replace(/"/g, '\\"');

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n`),
    Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const wordpressUrl = new URL('/wp-json/custom/v1/upload-document', WORDPRESS_UPLOAD_URL);
  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
  };

  if (req.headers.authorization) {
    headers.Authorization = req.headers.authorization;
  }

  return new Promise((resolve) => {
    const client = wordpressUrl.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        protocol: wordpressUrl.protocol,
        hostname: wordpressUrl.hostname,
        port: wordpressUrl.port || (wordpressUrl.protocol === 'https:' ? 443 : 80),
        path: `${wordpressUrl.pathname}${wordpressUrl.search}`,
        method: 'POST',
        headers,
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
          responseBody += chunk.toString();
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody);
            if (response.statusCode >= 400 || !parsed?.success) {
              resolve({ ok: false, message: parsed?.message || 'WordPress upload failed.', statusCode: response.statusCode });
              return;
            }

            resolve({
              ok: true,
              attachmentId: parsed?.data?.attachment_id,
              url: parsed?.data?.url,
              metadata: parsed?.data,
            });
          } catch (error) {
            resolve({ ok: false, message: 'Invalid WordPress response.', statusCode: response.statusCode });
          }
        });
      }
    );

    request.on('error', () => {
      resolve({ ok: false, message: 'Unable to reach WordPress upload endpoint.' });
    });

    request.write(body);
    request.end();
  });
};

const deleteUploadedTempFile = (filePath) => {
  if (!filePath) return;
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

exports.uploadDocumentToWordPress = async (req, res) => {
  try {
    const validation = validateUploadPayload(req);
    if (!validation.ok) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    const uploadResult = await uploadToWordPressViaHttp(req, req.file);
    if (!uploadResult.ok) {
      return res.status(400).json({ success: false, message: uploadResult.message });
    }

    return res.json({
      success: true,
      message: 'Document uploaded to WordPress successfully.',
      data: {
        attachment_id: uploadResult.attachmentId,
        url: uploadResult.url,
        metadata: uploadResult.metadata,
      },
    });
  } catch (error) {
    console.error('[Document Upload] Failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload document.' });
  } finally {
    deleteUploadedTempFile(req.file?.path);
  }
};

exports.saveDocumentMetadata = async (req, res) => {
  try {
    const { user_id, document_type, attachment_id, document_url } = req.body;

    if (!user_id || !document_type || !attachment_id || !document_url) {
      return res.status(400).json({ success: false, message: 'user_id, document_type, attachment_id, and document_url are required.' });
    }

    const normalizedType = normalizeDocumentType(document_type);
    if (!normalizedType) {
      return res.status(400).json({ success: false, message: 'Invalid document type.' });
    }

    const [result] = await pool.query(
      'INSERT INTO wp_user_documents (user_id, document_type, document_id, document_url) VALUES (?, ?, ?, ?)',
      [user_id, normalizedType, attachment_id, document_url]
    );

    return res.json({
      success: true,
      message: 'Document metadata saved successfully.',
      data: {
        id: result.insertId,
        user_id,
        document_type: normalizedType,
        attachment_id,
        document_url,
      },
    });
  } catch (error) {
    console.error('[Document Save] Failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to save document metadata.' });
  }
};
