const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pool = require('../config/database');
const { canAccessTargetUser } = require('../middlewares/auth');
const LWP_TOTAL_DAYS_META_KEY = 'lwp_total_days_taken';

const USER_META_KEYS = {
  joiningDate: 'joining_date',
  bioMaxId: 'bio_max_id',
  birthdayDate: 'birthday_date',
  designation: 'designation',
  profileIcon: 'profile_icon',
};

const calculateDuration = (joiningDate, referenceDate = new Date()) => {
  if (!joiningDate) {
    return {
      years: 0,
      months: 0,
      days: 0,
      label: null,
    };
  }

  const startDate = new Date(joiningDate);
  if (Number.isNaN(startDate.getTime())) {
    return {
      years: 0,
      months: 0,
      days: 0,
      label: null,
    };
  }

  const endDate = new Date(referenceDate);
  if (endDate < startDate) {
    return {
      years: 0,
      months: 0,
      days: 0,
      label: '0 days',
    };
  }

  let years = endDate.getFullYear() - startDate.getFullYear();
  let months = endDate.getMonth() - startDate.getMonth();
  let days = endDate.getDate() - startDate.getDate();

  if (days < 0) {
    months -= 1;
    const previousMonthLastDay = new Date(endDate.getFullYear(), endDate.getMonth(), 0).getDate();
    days += previousMonthLastDay;
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const parts = [];
  if (years > 0) {
    parts.push(`${years} ${years === 1 ? 'year' : 'years'}`);
  }
  if (months > 0) {
    parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
  }
  if (days > 0 && parts.length < 2) {
    parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  }

  return {
    years: Math.max(0, years),
    months: Math.max(0, months),
    days: Math.max(0, days),
    label: parts.length ? parts.join(', ') : '0 days',
  };
};

const buildProfileIconData = async (attachmentId, attachmentLookup = null) => {
  if (!attachmentId) {
    return null;
  }

  const normalizedAttachmentId = parseInt(attachmentId, 10);
  if (Number.isNaN(normalizedAttachmentId)) {
    return {
      attachment_id: null,
      url: null,
    };
  }

  const lookup = attachmentLookup || (async (id) => {
    const [rows] = await pool.query(
      'SELECT guid FROM wp_posts WHERE ID = ? AND post_type = ? LIMIT 1',
      [id, 'attachment']
    );

    return rows;
  });

  const rows = await lookup(normalizedAttachmentId);
  const attachment = Array.isArray(rows) ? rows[0] : rows;

  if (!attachment || !attachment.guid) {
    return {
      attachment_id: normalizedAttachmentId,
      url: null,
    };
  }

  return {
    attachment_id: normalizedAttachmentId,
    url: attachment.guid,
  };
};

const getProfileUploadDir = () => {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), 'profile-icons');
  }
  return path.join(__dirname, '..', 'uploads', 'profile-icons');
};

const ensureProfileUploadDir = async () => {
  const uploadDir = getProfileUploadDir();
  await fs.promises.mkdir(uploadDir, { recursive: true });
  return uploadDir;
};

const parseBase64Image = (base64String) => {
  if (!base64String || typeof base64String !== 'string') {
    return null;
  }

  const trimmed = base64String.trim();
  const dataUrlMatch = trimmed.match(/^data:(image\/(jpeg|png|gif|webp));base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      mimetype: dataUrlMatch[1].toLowerCase(),
      data: dataUrlMatch[3],
    };
  }

  const rawMatch = trimmed.match(/^[A-Za-z0-9+/=]+$/);
  if (rawMatch) {
    return {
      mimetype: 'image/png',
      data: trimmed,
    };
  }

  return null;
};

const saveBase64ImageToFile = async (base64String) => {
  const image = parseBase64Image(base64String);
  if (!image) {
    return null;
  }

  const extensionMap = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };

  const ext = extensionMap[image.mimetype] || '.png';
  const uploadDir = await ensureProfileUploadDir();
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const filePath = path.join(uploadDir, filename);

  const fileBuffer = Buffer.from(image.data, 'base64');
  await fs.promises.writeFile(filePath, fileBuffer);
  await fs.promises.chmod(filePath, 0o644);

  return {
    originalname: filename,
    filename,
    mimetype: image.mimetype,
    path: filePath,
  };
};

const findLeaderNameInHierarchy = async (employeeId, maxDepth = 10) => {
  let currentUserId = employeeId;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const query = `
      SELECT u.ID, u.display_name,
             (SELECT meta_value FROM wp_usermeta
              WHERE user_id = u.ID AND meta_key = 'wp_capabilities' LIMIT 1) AS capabilities
      FROM wp_usermeta m
      JOIN wp_users u ON m.meta_value = u.ID
      WHERE m.user_id = ? AND m.meta_key = 'st_reports_to'
      LIMIT 1
    `;

    const [rows] = await pool.query(query, [currentUserId]);

    if (rows.length === 0) {
      return null;
    }

    const manager = rows[0];
    const capabilities = manager.capabilities || '';

    let managerRole = 'employee';
    if (capabilities.includes('"administrator"')) {
      managerRole = 'administrator';
    } else if (capabilities.includes('"leader"')) {
      managerRole = 'leader';
    } else if (capabilities.includes('"hr"')) {
      managerRole = 'hr';
    } else if (capabilities.includes('"buddy"')) {
      managerRole = 'buddy';
    }

    if (managerRole === 'leader' || managerRole === 'administrator') {
      return manager.display_name || null;
    }

    currentUserId = parseInt(manager.ID, 10);
  }

  return null;
};

const getProfile = async (req, res) => {
  try {
    const requester = req.user;
    const requestedUserId = req.params?.userId || req.params?.id || req.query?.user_id || req.query?.employee_id || req.query?.id;
    const userId = requestedUserId ? parseInt(requestedUserId, 10) : requester?.id;

    if (!requester?.id) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'A valid user ID is required.' });
    }

    if (userId !== requester.id) {
      const reportsToQuery = `SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'st_reports_to'`;
      const [metaRows] = await pool.query(reportsToQuery, [userId]);
      const managerId = metaRows[0] ? parseInt(metaRows[0].meta_value, 10) : null;

      if (!canAccessTargetUser(requester, userId, managerId)) {
        return res.status(403).json({ error: 'Access denied: You can only view your own or your direct reports\' profile.' });
      }
    }

    const query = `
      SELECT
        u.user_email,
        u.display_name,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS joining_date,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS bio_max_id,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS birthday_date,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS designation,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS profile_icon
      FROM wp_users u
      WHERE u.ID = ?
      LIMIT 1
    `;

    const [rows] = await pool.query(query, [
      USER_META_KEYS.joiningDate,
      USER_META_KEYS.bioMaxId,
      USER_META_KEYS.birthdayDate,
      USER_META_KEYS.designation,
      USER_META_KEYS.profileIcon,
      userId,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const profile = rows[0];
    const duration = calculateDuration(profile.joining_date);
    const profileIcon = await buildProfileIconData(profile.profile_icon);
    const leaderName = await findLeaderNameInHierarchy(userId);
    const lwpTotalDaysTaken = await (async () => {
      const [metaRows] = await pool.query('SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = ? LIMIT 1', [userId, LWP_TOTAL_DAYS_META_KEY]);
      const value = metaRows[0] ? metaRows[0].meta_value : null;
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    })();

    return res.json({
      success: true,
      data: {
        user_id: userId,
        email: profile.user_email || req.user?.email || null,
        display_name: profile.display_name || req.user?.name || null,
        joining_date: profile.joining_date || null,
        bio_max_id: profile.bio_max_id || null,
        birthday_date: profile.birthday_date || null,
        designation: profile.designation || null,
        profile_icon: profileIcon,
        leader_name: leaderName,
        lwp_total_days_taken: lwpTotalDaysTaken,
        duration,
      },
    });
  } catch (error) {
    console.error('[Profile] Failed to fetch profile:', error);
    return res.status(500).json({ error: 'Failed to fetch profile.' });
  }
};

const createWordPressMediaAttachment = async (file, userId) => {
  if (!file) {
    return null;
  }

  const uploadDate = new Date();
  const postDate = uploadDate.toISOString().slice(0, 19).replace('T', ' ');
  const title = path.parse(file.originalname || 'profile-icon').name || 'Profile icon';
  const fileName = file.filename;
  const storedPath = path.join('uploads', 'profile-icons', fileName).replace(/\\/g, '/');
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL || 'http://localhost:3000';
  const guid = `${baseUrl.replace(/\/+$/, '')}/${storedPath}`;

  const [result] = await pool.query(
    `INSERT INTO wp_posts (
      post_author, post_date, post_date_gmt, post_content, post_title, post_status,
      comment_status, ping_status, post_name, post_modified, post_modified_gmt,
      post_parent, guid, post_type, post_mime_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      postDate,
      postDate,
      '',
      title,
      'inherit',
      'open',
      'closed',
      fileName,
      postDate,
      postDate,
      0,
      guid,
      'attachment',
      file.mimetype || 'image/jpeg',
    ]
  );

  const attachmentId = result.insertId;
  const resolvedFilePath = file.path || path.join(process.cwd(), 'uploads', 'profile-icons', fileName);
  const relativeFilePath = path.posix.join('uploads', 'profile-icons', fileName);

  await pool.query('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [attachmentId, '_wp_attached_file', relativeFilePath]);
  await pool.query('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [attachmentId, '_wp_attachment_metadata', JSON.stringify({ file: relativeFilePath, width: 0, height: 0, mime_type: file.mimetype || 'image/jpeg' })]);

  if (fs.existsSync(resolvedFilePath)) {
    await fs.promises.chmod(resolvedFilePath, 0o644);
  }

  return attachmentId;
};

const updateProfile = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const { email, display_name, joining_date, birthday_date, bio_max_id, designation, profile_icon, profile_icon_base64, profile_icon_url } = req.body || {};
    const updates = [];
    let resolvedProfileIconValue = profile_icon;

    const incomingBase64 = profile_icon_base64 || profile_icon || profile_icon_url;
    const isBase64Image = typeof incomingBase64 === 'string' && /(data:image\/(jpeg|png|gif|webp);base64,|^[A-Za-z0-9+/=]+$)/i.test(incomingBase64.trim());

    if (!req.file && profile_icon_base64) {
      if (!isBase64Image) {
        return res.status(400).json({ error: 'Invalid base64 image string provided in profile_icon_base64.' });
      }
      const base64File = await saveBase64ImageToFile(incomingBase64);
      if (!base64File) {
        return res.status(400).json({ error: 'Unable to parse profile_icon_base64. Ensure it is a valid data URI or base64 string.' });
      }
      const attachmentId = await createWordPressMediaAttachment(base64File, userId);
      if (!attachmentId) {
        return res.status(500).json({ error: 'Failed to save profile icon image.' });
      }
      resolvedProfileIconValue = attachmentId;
    }

    if (req.file) {
      const attachmentId = await createWordPressMediaAttachment(req.file, userId);
      if (attachmentId) {
        resolvedProfileIconValue = attachmentId;
      }
    }

    if (email !== undefined && email !== null && email !== '') {
      const normalizedEmail = String(email).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }
      updates.push({ type: 'user', query: 'UPDATE wp_users SET user_email = ? WHERE ID = ?', params: [normalizedEmail, userId] });
    }

    if (display_name !== undefined && display_name !== null) {
      updates.push({ type: 'user', query: 'UPDATE wp_users SET display_name = ? WHERE ID = ?', params: [String(display_name).trim(), userId] });
    }

    const metaFieldMap = [
      { key: USER_META_KEYS.joiningDate, value: joining_date },
      { key: USER_META_KEYS.birthdayDate, value: birthday_date },
      { key: USER_META_KEYS.bioMaxId, value: bio_max_id },
      { key: USER_META_KEYS.designation, value: designation },
      { key: USER_META_KEYS.profileIcon, value: resolvedProfileIconValue },
    ];

    for (const field of metaFieldMap) {
      if (field.value === undefined) {
        continue;
      }

      const normalizedValue = field.value === null || field.value === '' ? null : String(field.value);
      const [existingRows] = await pool.query(
        'SELECT meta_id FROM wp_usermeta WHERE user_id = ? AND meta_key = ? LIMIT 1',
        [userId, field.key]
      );

      if (existingRows.length > 0) {
        await pool.query('UPDATE wp_usermeta SET meta_value = ? WHERE meta_id = ?', [normalizedValue, existingRows[0].meta_id]);
      } else if (normalizedValue !== null) {
        await pool.query('INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [userId, field.key, normalizedValue]);
      }
    }

    for (const update of updates) {
      await pool.query(update.query, update.params);
    }

    const [profileRows] = await pool.query(
      `SELECT
        u.user_email,
        u.display_name,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS joining_date,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS bio_max_id,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS birthday_date,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS designation,
        (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = ? LIMIT 1) AS profile_icon
      FROM wp_users u
      WHERE u.ID = ?
      LIMIT 1`,
      [
        USER_META_KEYS.joiningDate,
        USER_META_KEYS.bioMaxId,
        USER_META_KEYS.birthdayDate,
        USER_META_KEYS.designation,
        USER_META_KEYS.profileIcon,
        userId,
      ]
    );

    if (profileRows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const profile = profileRows[0];
    const duration = calculateDuration(profile.joining_date);
    const profileIcon = await buildProfileIconData(profile.profile_icon);

    return res.json({
      success: true,
      message: 'Profile updated successfully.',
      data: {
        email: profile.user_email || req.user?.email || null,
        display_name: profile.display_name || req.user?.name || null,
        joining_date: profile.joining_date || null,
        bio_max_id: profile.bio_max_id || null,
        birthday_date: profile.birthday_date || null,
        designation: profile.designation || null,
        profile_icon: profileIcon,
        duration,
      },
    });
  } catch (error) {
    console.error('[Profile] Failed to update profile:', error);
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
};

module.exports = {
  calculateDuration,
  buildProfileIconData,
  createWordPressMediaAttachment,
  getProfile,
  updateProfile,
  USER_META_KEYS,
};
