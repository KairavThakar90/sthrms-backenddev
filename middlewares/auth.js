// middlewares/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

/**
 * Extract and validate JWT token from Authorization header.
 * Mirrors the WordPress st_get_user_id_from_token() function in st-auth-functions.php:
 *   - Requires "Bearer <token>" in Authorization header
 *   - Validates JWT structure (3 segments)
 *   - Verifies signature using JWT_SECRET
 *   - Checks expiry (exp claim)
 *   - Extracts user ID from decoded.data.user.id OR decoded.sub
 *   - NO fallback header (X-User-ID is ignored entirely)
 *
 * @param {string} authHeader - The raw Authorization header value
 * @returns {{ status_code: number, message: string, user_id?: number }}
 */
function getUserIdFromToken(authHeader) {
  // 1. Authorization header must be present
  if (!authHeader) {
    return { status_code: 401, message: 'Authorization header not found.' };
  }

  // 2. Strip "Bearer " prefix (case-insensitive), trim whitespace/newlines
  const token = authHeader.replace(/Bearer\s+/i, '').trim().replace(/[\r\n]/g, '');

  // 3. Validate JWT structure — must have exactly 3 segments
  const segments = token.split('.');
  if (segments.length !== 3) {
    return {
      status_code: 401,
      message: `Malformed token: Expected 3 segments, found ${segments.length}.`,
    };
  }

  // 4. Get secret key
  const secretKey = process.env.JWT_SECRET;
  if (!secretKey) {
    return { status_code: 500, message: 'JWT secret key not configured on the server.' };
  }

  // 5. Verify signature AND expiry — map specific error types to clear messages
  let decoded;
  try {
    decoded = jwt.verify(token, secretKey, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return { status_code: 401, message: 'Token has expired. Please refresh your token.' };
    }
    if (err.name === 'JsonWebTokenError' && err.message === 'invalid signature') {
      return { status_code: 401, message: 'Invalid token signature.' };
    }
    if (err.name === 'NotBeforeError') {
      return { status_code: 401, message: 'Token not yet valid.' };
    }
    // Catch-all for any other JWT error
    return { status_code: 401, message: `Invalid token: ${err.message}` };
  }

  if (!decoded) {
    return { status_code: 401, message: 'Invalid token signature or expired.' };
  }

  // 6. Extract user ID — mirrors WordPress: decoded.data.user.id || decoded.sub
  let userId = null;
  if (decoded.data && decoded.data.user && decoded.data.user.id) {
    userId = decoded.data.user.id;
  } else if (decoded.sub) {
    userId = decoded.sub;
  }

  if (!userId) {
    return { status_code: 401, message: 'User ID not found in token payload.' };
  }

  return {
    status_code: 200,
    user_id: parseInt(userId, 10),
    message: 'Token validated successfully.',
  };
}

/**
 * Authentication middleware.
 * Validates JWT, loads user from WordPress DB, and attaches req.user.
 * NO X-User-ID fallback — identity always comes from the token.
 *
 * Role values set on req.user.role match WordPress role slugs exactly:
 *   'administrator' | 'hr' | 'leader' | 'buddy' | 'employee'
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // Step 1: Validate the JWT token
    const tokenResult = getUserIdFromToken(authHeader);

    if (tokenResult.status_code !== 200) {
      console.warn(`[Auth] REJECTED — ${tokenResult.message}`);
      return res.status(tokenResult.status_code).json({ error: tokenResult.message });
    }

    const userId = tokenResult.user_id;
    console.log(`[Auth] Token valid — User ID from token: ${userId}`);

    // Step 2: Verify user exists in the WordPress DB and fetch role
    const query = `
      SELECT u.ID, u.user_email, u.display_name, 
             (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'wp_capabilities' LIMIT 1) AS capabilities,
             (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'st_reports_to' LIMIT 1) AS reports_to
      FROM wp_users u
      WHERE u.ID = ?
    `;

    const [rows] = await pool.query(query, [userId]);

    if (rows.length === 0) {
      console.warn(`[Auth] REJECTED — User ID ${userId} not found in database.`);
      return res.status(401).json({ error: `User with ID ${userId} does not exist.` });
    }

    const user = rows[0];
    const capabilities = user.capabilities || '';

    // Step 3: Map WordPress capabilities to the exact WordPress role slug.
    // Role order matters — administrator is checked first so dual-role users
    // (e.g., someone who is both 'administrator' and 'hr') get the highest role.
    let role = 'employee';
    if (capabilities.includes('"administrator"')) {
      role = 'administrator';
    } else if (capabilities.includes('"hr"')) {
      role = 'hr';
    } else if (capabilities.includes('"leader"')) {
      role = 'leader';
    } else if (capabilities.includes('"buddy"')) {
      role = 'buddy';
    }
    // Anything else (including the default 'subscriber') → 'employee'

    req.user = {
      id: parseInt(user.ID, 10),
      email: user.user_email,
      name: user.display_name,
      role: role,
      reports_to: user.reports_to ? parseInt(user.reports_to, 10) : null,
    };

    console.log(`[Auth] ALLOWED — User: ${user.display_name} (ID: ${req.user.id}, Role: ${role})`);
    next();
  } catch (err) {
    console.error('[Auth] Middleware error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication.' });
  }
};

/**
 * Authorization middleware — checks req.user.role against allowed roles.
 * Roles must use exact WordPress role slugs: 'administrator', 'hr', 'leader', 'buddy', 'employee'
 *
 * @param {string[]} allowedRoles
 */
const authorize = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized: No authenticated user session.' });
    }

    if (allowedRoles.includes(req.user.role)) {
      return next();
    }

    console.warn(`[Auth] FORBIDDEN — Role '${req.user.role}' not in [${allowedRoles.join(', ')}]`);
    return res.status(403).json({
      error: `Forbidden: Your role '${req.user.role}' is not authorized to access this resource.`,
    });
  };
};

const authenticateOrRedirect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const tokenResult = getUserIdFromToken(authHeader);

    if (tokenResult.status_code !== 200) {
      const loginPage = process.env.APP_LOGIN_URL || `${process.env.APP_BASE_URL || process.env.APP_URL || 'http://localhost:3000'}/login`;
      const originalUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const redirectUrl = new URL(loginPage);
      redirectUrl.searchParams.set('redirect', originalUrl);
      console.log(`[Auth] REDIRECT TO LOGIN — ${originalUrl}`);
      return res.redirect(redirectUrl.toString());
    }

    const userId = tokenResult.user_id;
    console.log(`[Auth] Token valid — User ID from token: ${userId}`);

    const query = `
      SELECT u.ID, u.user_email, u.display_name, 
             (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'wp_capabilities' LIMIT 1) AS capabilities,
             (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'st_reports_to' LIMIT 1) AS reports_to
      FROM wp_users u
      WHERE u.ID = ?
    `;

    const [rows] = await pool.query(query, [userId]);
    if (rows.length === 0) {
      console.warn(`[Auth] REJECTED — User ID ${userId} not found in database.`);
      const loginPage = process.env.APP_LOGIN_URL || `${process.env.APP_BASE_URL || process.env.APP_URL || 'http://localhost:3000'}/login`;
      const originalUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const redirectUrl = new URL(loginPage);
      redirectUrl.searchParams.set('redirect', originalUrl);
      return res.redirect(redirectUrl.toString());
    }

    const user = rows[0];
    const capabilities = user.capabilities || '';

    let role = 'employee';
    if (capabilities.includes('"administrator"')) {
      role = 'administrator';
    } else if (capabilities.includes('"hr"')) {
      role = 'hr';
    } else if (capabilities.includes('"leader"')) {
      role = 'leader';
    } else if (capabilities.includes('"buddy"')) {
      role = 'buddy';
    }

    req.user = {
      id: parseInt(user.ID, 10),
      email: user.user_email,
      name: user.display_name,
      role: role,
      reports_to: user.reports_to ? parseInt(user.reports_to, 10) : null,
    };

    console.log(`[Auth] ALLOWED — User: ${user.display_name} (ID: ${req.user.id}, Role: ${role})`);
    next();
  } catch (err) {
    console.error('[Auth] Redirect auth error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication redirect handling.' });
  }
};

module.exports = { authenticate, authorize, authenticateOrRedirect };
