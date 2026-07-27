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

const normalizeUploadMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'double' ? 'double' : 'single';
};

const validateUploadPayload = (req) => {
  const uploadedFiles = req.files ? Object.values(req.files).flat() : [];
  const primaryFile = req.file || uploadedFiles[0];

  if (!primaryFile) {
    return { ok: false, message: 'No file uploaded.' };
  }

  const ext = path.extname(primaryFile.originalname || '').toLowerCase().replace('.', '');
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, message: 'File type not allowed. Allowed: PDF, JPG, PNG, SVG.' };
  }

  if (!ALLOWED_MIME_TYPES.includes(primaryFile.mimetype)) {
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

const getUploadedFiles = (req) => {
  if (req.files) {
    return Object.values(req.files).flat();
  }

  return req.file ? [req.file] : [];
};

exports.uploadDocumentToWordPress = async (req, res) => {
  try {
    const validation = validateUploadPayload(req);
    if (!validation.ok) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    const uploadedFiles = getUploadedFiles(req);
    const requestedUploadMode = normalizeUploadMode(req.body?.upload_mode || req.body?.uploadMode || req.body?.mode);
    const uploadMode = requestedUploadMode === 'double' || uploadedFiles.length > 1 ? 'double' : 'single';

    const uploadResults = [];
    for (const file of uploadedFiles) {
      const uploadResult = await uploadToWordPressViaHttp(req, file);
      if (!uploadResult.ok) {
        return res.status(400).json({ success: false, message: uploadResult.message });
      }

      uploadResults.push({
        fieldname: file.fieldname,
        attachment_id: uploadResult.attachmentId,
        url: uploadResult.url,
        metadata: uploadResult.metadata,
      });
    }

    if (uploadMode === 'double' && uploadResults.length < 2) {
      return res.status(400).json({ success: false, message: 'Both front and back documents are required for double upload mode.' });
    }

    return res.json({
      success: true,
      message: 'Document uploaded to WordPress successfully.',
      data: {
        upload_mode: uploadMode,
        uploads: uploadResults,
      },
    });
  } catch (error) {
    console.error('[Document Upload] Failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload document.' });
  } finally {
    const uploadedFiles = getUploadedFiles(req);
    uploadedFiles.forEach((file) => deleteUploadedTempFile(file?.path));
  }
};

exports.saveDocumentMetadata = async (req, res) => {
  try {
    const requestPayload = {
      user_id: req.body?.user_id,
      document_type: normalizeDocumentType(req.body?.document_type),
      upload_mode: normalizeUploadMode(req.body?.upload_mode || req.body?.uploadMode || req.body?.mode),
      document_id: req.body?.document_id ?? req.body?.attachment_id ?? req.body?.front_document_id ?? req.body?.front_attachment_id,
      document_url: req.body?.document_url ?? req.body?.front_document_url,
      back_document_id: req.body?.back_document_id ?? req.body?.back_attachment_id,
      back_document_url: req.body?.back_document_url,
    };

    if (!requestPayload.user_id || !requestPayload.document_type || !requestPayload.document_id || !requestPayload.document_url) {
      return res.status(400).json({ success: false, message: 'user_id, document_type, document_id, and document_url are required.' });
    }

    if (requestPayload.upload_mode === 'double' && (!requestPayload.back_document_id || !requestPayload.back_document_url)) {
      return res.status(400).json({ success: false, message: 'back_document_id and back_document_url are required for double upload mode.' });
    }

    const [result] = await pool.query(
      'INSERT INTO wp_user_documents (user_id, document_type, upload_mode, document_id, document_url, back_document_id, back_document_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [requestPayload.user_id, requestPayload.document_type, requestPayload.upload_mode, requestPayload.document_id, requestPayload.document_url, requestPayload.back_document_id, requestPayload.back_document_url]
    );

    return res.json({
      success: true,
      message: 'Document metadata saved successfully.',
      data: {
        id: result.insertId,
        user_id: requestPayload.user_id,
        document_type: requestPayload.document_type,
        upload_mode: requestPayload.upload_mode,
        document_id: requestPayload.document_id,
        document_url: requestPayload.document_url,
        back_document_id: requestPayload.back_document_id,
        back_document_url: requestPayload.back_document_url,
      },
    });
  } catch (error) {
    console.error('[Document Save] Failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to save document metadata.' });
  }
};

exports.listUserDocuments = async (req, res) => {
  try {
    const userId = req.params?.user_id || req.query?.user_id || req.body?.user_id;
    const documentType = req.query?.document_type || req.query?.documentType;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'user_id is required.' });
    }

    let query = 'SELECT id, user_id, document_type, upload_mode, document_id, document_url, back_document_id, back_document_url, created_at FROM wp_user_documents WHERE user_id = ?';
    const values = [userId];

    if (documentType) {
      query += ' AND document_type = ?';
      values.push(String(documentType).trim().toUpperCase());
    }

    query += ' ORDER BY created_at DESC, id DESC';

    const [rows] = await pool.query(query, values);

    return res.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        attachment_id: row.document_id,
        back_attachment_id: row.back_document_id,
      })),
    });
  } catch (error) {
    console.error('[Document List] Failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch documents.' });
  }
};
