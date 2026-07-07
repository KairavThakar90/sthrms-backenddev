// controllers/leaveController.js
const pool = require('../config/database');
const emailService = require('../services/emailService');
const { canAccessTargetUser } = require('../middlewares/auth');

const SPECIAL_BALANCE_FREE_LEAVE_TYPES = ['LWP'];
const LWP_TOTAL_DAYS_META_KEY = 'lwp_total_days_taken';
const LEAVE_TYPE_FULL_NAME_MAP = {
  LWP: 'Leave Without Pay',
  HB: 'Birthday Leave',
  EL: 'Early Leave (2 hours)'
};

const normalizeLeaveType = (leaveType) => {
  if (!leaveType) return '';
  const normalized = String(leaveType).trim();
  const upper = normalized.toUpperCase();
  const specialMapping = {
    'LEAVE WITHOUT PAY': 'LWP',
    'LWP': 'LWP',
    'BIRTHDAY LEAVE': 'HB',
    'HB': 'HB',
    'EARLY LEAVE': 'EL',
    'EL': 'EL'
  };
  return specialMapping[upper] || upper;
};

const isWeekendDate = (dateValue) => {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  const day = date.getDay();
  return day === 0 || day === 6;
};

const getUserMetaValue = async (userId, metaKey) => {
  const query = `SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = ? LIMIT 1`;
  const [rows] = await pool.query(query, [userId, metaKey]);
  return rows[0] ? rows[0].meta_value : null;
};

const getNumericUserMetaValue = async (userId, metaKey, defaultValue = 0) => {
  const value = await getUserMetaValue(userId, metaKey);
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }

  const parsedValue = parseFloat(value);
  return Number.isNaN(parsedValue) ? defaultValue : parsedValue;
};

const addToNumericUserMetaValue = async (userId, metaKey, incrementBy = 0, connection = pool) => {
  if (!userId || incrementBy <= 0) {
    return getNumericUserMetaValue(userId, metaKey, 0);
  }

  const [existingRows] = await connection.query(
    'SELECT meta_id, meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = ? LIMIT 1',
    [userId, metaKey]
  );

  const currentValue = existingRows.length > 0 ? parseFloat(existingRows[0].meta_value || 0) : 0;
  const nextValue = (Number.isNaN(currentValue) ? 0 : currentValue) + incrementBy;

  if (existingRows.length > 0) {
    await connection.query('UPDATE wp_usermeta SET meta_value = ? WHERE meta_id = ?', [String(nextValue), existingRows[0].meta_id]);
  } else {
    await connection.query('INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [userId, metaKey, String(nextValue)]);
  }

  return nextValue;
};

const getWordPressUserRole = async (userId) => {
  const query = `SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'wp_capabilities' LIMIT 1`;
  const [rows] = await pool.query(query, [userId]);
  const capabilities = rows[0] ? rows[0].meta_value : '';

  if (capabilities.includes('"administrator"')) return 'administrator';
  if (capabilities.includes('"hr"')) return 'hr';
  if (capabilities.includes('"leader"')) return 'leader';
  if (capabilities.includes('"buddy"')) return 'buddy';
  return 'employee';
};

const shouldRequireAdministratorOnlyApproval = (role) => role === 'hr';
const shouldNotifyAdministratorForLeaderDecision = (decision) => ['approved', 'rejected'].includes(decision);
const shouldNotifyAdministratorForFinalDecision = (decision) => ['approved', 'rejected'].includes(decision);

const fireAndForgetNotifications = async (employee, leaveData, leaderNameForHR, level1Approver, requireAdministratorOnlyApproval, leaderId) => {
  try {
    if (requireAdministratorOnlyApproval) {
      const administratorEmails = await getAdministratorEmails();
      for (const adminEmail of administratorEmails) {
        await emailService.notifyHRForApproval(adminEmail, employee.name, leaderNameForHR, leaveData, true);
      }
      return;
    }

    const hrEmails = await getHrEmails();
    if (employee.role === 'leader') {
      for (const hrEmail of hrEmails) {
        await emailService.notifyHRForApproval(hrEmail, employee.name, leaderNameForHR, leaveData, true);
      }
      return;
    }

    for (const hrEmail of hrEmails) {
      await emailService.notifyHRNewLeaveRequest(hrEmail, employee.name, leaderNameForHR, leaveData);
    }

    if (leaderId && level1Approver) {
      await emailService.notifyLeaderForApproval(level1Approver.user_email, employee.name, leaveData);
      return;
    }

    const administratorEmails = await getAdministratorEmails();
    for (const adminEmail of administratorEmails) {
      await emailService.notifyHRForApproval(adminEmail, employee.name, leaderNameForHR, leaveData);
    }
  } catch (error) {
    console.warn('[Leave Submission] Background notifications failed:', error.message);
  }
};

const getProbationInfo = async (employeeId, referenceDate = new Date()) => {
  const joiningDateValue = await getUserMetaValue(employeeId, 'joining_date');
  if (!joiningDateValue) {
    return {
      canUseCl: false,
      probationCompleteDate: null,
      monthlyClAvailability: 0,
      monthsAfterProbation: 0,
    };
  }

  const joiningDate = new Date(joiningDateValue);
  if (Number.isNaN(joiningDate.getTime())) {
    return {
      canUseCl: false,
      probationCompleteDate: null,
      monthlyClAvailability: 0,
      monthsAfterProbation: 0,
    };
  }

  const probationCompleteDate = new Date(joiningDate);
  probationCompleteDate.setMonth(probationCompleteDate.getMonth() + 3);

  const reference = new Date(referenceDate);
  const isInProbation = reference < probationCompleteDate;
  const monthsAfterProbation = Math.max(0, (reference.getFullYear() - probationCompleteDate.getFullYear()) * 12 + (reference.getMonth() - probationCompleteDate.getMonth()));
  const monthlyClAvailability = isInProbation ? 0 : Math.min(6, monthsAfterProbation + 1);

  return {
    canUseCl: !isInProbation,
    probationCompleteDate,
    monthlyClAvailability,
    monthsAfterProbation,
  };
};

const parseBalanceJson = (value) => {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      console.warn('[Balance] Failed to parse JSON:', err.message);
      return {};
    }
  }
  return value;
};

const getOrCreateLeaveBalanceRow = async (employeeId, year) => {
  const selectQuery = `SELECT id, balance_json FROM wp_hrms_leave_balances WHERE employee_id = ? AND year = ? LIMIT 1`;
  const [rows] = await pool.query(selectQuery, [employeeId, year]);
  if (rows.length > 0) {
    return {
      id: rows[0].id,
      balanceJson: parseBalanceJson(rows[0].balance_json),
    };
  }

  const emptyBalance = {};

  // For this workflow, CL is not carried forward to the next year.
  // Each year starts with a fresh balance and the previous year's unused CL
  // is not reused automatically.

  const insertQuery = `INSERT INTO wp_hrms_leave_balances (employee_id, year, balance_json) VALUES (?, ?, ?)`;
  const [result] = await pool.query(insertQuery, [employeeId, year, JSON.stringify(emptyBalance)]);
  return {
    id: result.insertId,
    balanceJson: emptyBalance,
  };
};

const saveLeaveBalanceRow = async (employeeId, year, balanceJson) => {
  const query = `UPDATE wp_hrms_leave_balances SET balance_json = ? WHERE employee_id = ? AND year = ?`;
  await pool.query(query, [JSON.stringify(balanceJson), employeeId, year]);
};

const CL_TYPE = 'CL';

const getLeavePolicyCap = async (year, leaveType) => {
  try {
    const query = `SELECT leave_policy_json FROM wp_st_leave_policy WHERE year = ?`;
    const [rows] = await pool.query(query, [year]);
    if (rows.length === 0) {
      return null;
    }

    const policies = JSON.parse(rows[0].leave_policy_json || '[]');
    const canonicalType = normalizeLeaveType(leaveType);
    const matchedPolicy = policies.find((policy) =>
      normalizeLeaveType(policy.short_form) === canonicalType ||
      normalizeLeaveType(policy.full_name) === canonicalType
    );

    return matchedPolicy ? parseFloat(matchedPolicy.total_leaves) || null : null;
  } catch (err) {
    console.error('Failed to fetch leave policy cap for', leaveType, 'year', year, err);
    return null;
  }
};

const getLeaveEntryRemaining = (entry, leaveType) => {
  if (!entry) {
    return null;
  }
  if (leaveType === 'LWP') {
    return null;
  }
  return parseFloat(entry.total_allotted || 0) - parseFloat(entry.used || 0);
};

const getYearMonthKey = (year, monthIndex) => `${year}-${String(monthIndex).padStart(2, '0')}`;

const buildInsufficientLeaveBalanceError = (leaveType, requestedDays, remainingDays) => ({
  status: 400,
  error: `Insufficient leave balance for ${leaveType}. Requested: ${requestedDays} days, Remaining: ${remainingDays} days.`
});

const parseYearMonthKey = (yearMonthKey) => {
  if (!yearMonthKey || typeof yearMonthKey !== 'string') {
    return { year: null, month: 0 };
  }

  const parts = yearMonthKey.split('-').map((part) => parseInt(part, 10));
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
    return { year: null, month: 0 };
  }

  return { year: parts[0], month: parts[1] };
};

const getTargetAccrualMonthIndex = (year) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  if (year > currentYear) {
    return 0;
  }
  return year === currentYear ? now.getMonth() + 1 : 12;
};

const isSandwichRuleRange = (startDateStr, endDateStr) => {
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return false;
  }

  const startDay = start.getDay();
  const endDay = end.getDay();

  return startDay === 5 && (endDay === 1 || endDay === 2);
};

const calculateSandwichLeaveSplit = (startDateStr, endDateStr, holidayDates = []) => {
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return { totalDays: 0, paidDays: 0, lwpDays: 0 };
  }

  const holidaySet = new Set((holidayDates || []).map((dateValue) => formatDateOnly(dateValue)));
  const calendarDays = [];
  let current = new Date(start);

  while (current <= end) {
    const dateKey = formatDateOnly(current);
    const dayOfWeek = current.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = holidaySet.has(dateKey);

    calendarDays.push({ dateKey, isWeekend, isHoliday });
    current.setDate(current.getDate() + 1);
  }

  if (!isSandwichRuleRange(startDateStr, endDateStr)) {
    const totalDays = calendarDays.filter(({ isWeekend, isHoliday }) => !isWeekend && !isHoliday).length;
    return { totalDays, paidDays: totalDays, lwpDays: 0 };
  }

  const paidDays = calendarDays.filter(({ isWeekend, isHoliday }) => !isWeekend && !isHoliday).length;
  const lwpDays = calendarDays.filter(({ isWeekend, isHoliday }) => isWeekend && !isHoliday).length;

  return {
    totalDays: calendarDays.length,
    paidDays,
    lwpDays
  };
};

const countLeaveDaysForRange = (startDateStr, endDateStr, holidayDates = []) => {
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return 0;
  }

  const holidaySet = new Set((holidayDates || []).map((dateValue) => formatDateOnly(dateValue)));
  let count = 0;
  let current = new Date(start);

  while (current <= end) {
    const dateKey = formatDateOnly(current);
    const dayOfWeek = current.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = holidaySet.has(dateKey);

    if (isSandwichRuleRange(startDateStr, endDateStr)) {
      if (isWeekend || !isHoliday) {
        count += 1;
      }
    } else if (!isWeekend && !isHoliday) {
      count += 1;
    }

    current.setDate(current.getDate() + 1);
  }

  return Math.max(0, count);
};

const ensureMonthlyClAccrual = async (balanceRow, employeeId, year, annualCap = null, referenceDate = new Date()) => {
  if (!balanceRow || !balanceRow.balanceJson) {
    return false;
  }

  if (!balanceRow.balanceJson[CL_TYPE]) {
    balanceRow.balanceJson[CL_TYPE] = {
      total_allotted: 0.00,
      used: 0.00,
      monthly_available: 0.00,
      monthly_last_accrual_month: null,
      unused_previous_year_cl: 0.00,
    };
  }

  const entry = balanceRow.balanceJson[CL_TYPE];
  entry.used = parseFloat(entry.used || 0);
  entry.total_allotted = parseFloat(entry.total_allotted || 0);
  entry.unused_previous_year_cl = parseFloat(entry.unused_previous_year_cl || 0);

  if (annualCap !== null) {
    entry.total_allotted = parseFloat(annualCap || 0);
  }

  const probationInfo = await getProbationInfo(employeeId, referenceDate);
  const totalAllowed = Math.max(0, parseFloat(entry.total_allotted || 0));
  const maxAvailable = Math.max(0, totalAllowed - entry.used);
  entry.monthly_available = probationInfo.canUseCl ? Math.min(maxAvailable, probationInfo.monthlyClAvailability) : 0;
  entry.monthly_last_accrual_month = getYearMonthKey(new Date(referenceDate).getFullYear(), new Date(referenceDate).getMonth() + 1);

  await saveLeaveBalanceRow(employeeId, year, balanceRow.balanceJson);
  return true;
};

/**
 * Helper to calculate working days between start and end date (inclusive),
 * excluding weekends (Saturdays & Sundays) and holidays from wp_st_holiday_list.
 */
const calculateWorkingDays = async (startDateStr, endDateStr) => {
  const holidayDates = [];

  try {
    const query = `
      SELECT holiday_date 
      FROM wp_st_holiday_list 
      WHERE holiday_date BETWEEN ? AND ?
    `;
    const [rows] = await pool.query(query, [startDateStr, endDateStr]);
    holidayDates.push(...rows.map((row) => row.holiday_date));
  } catch (err) {
    // If column is 'date' instead of 'holiday_date', try 'date'
    try {
      const query = `
        SELECT date 
        FROM wp_st_holiday_list 
        WHERE date BETWEEN ? AND ?
      `;
      const [rows] = await pool.query(query, [startDateStr, endDateStr]);
      holidayDates.push(...rows.map((row) => row.date));
    } catch (err2) {
      console.warn('[Calculation] Holiday list lookup skipped/failed (using weekends exclusion only):', err2.message);
    }
  }

  return countLeaveDaysForRange(startDateStr, endDateStr, holidayDates);
};

/**
 * Format a Date object (or date string) as 'YYYY-MM-DD' using its
 * local calendar date — avoids UTC shift caused by JSON.stringify
 * converting Date objects via toISOString().
 */
const formatDateOnly = (value) => {
  if (!value) return value;
  if (typeof value === 'string') {
    // Already a plain date string like '2026-07-05' or '2026-07-05 00:00:00'
    return value.slice(0, 10);
  }
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return value;
};

const hasDateRangeOverlap = (startDateA, endDateA, startDateB, endDateB) => {
  const normalizedStartA = formatDateOnly(startDateA);
  const normalizedEndA = formatDateOnly(endDateA);
  const normalizedStartB = formatDateOnly(startDateB);
  const normalizedEndB = formatDateOnly(endDateB);

  if (!normalizedStartA || !normalizedEndA || !normalizedStartB || !normalizedEndB) {
    return false;
  }

  return normalizedStartA <= normalizedEndB && normalizedEndA >= normalizedStartB;
};

const getUpcomingBirthdayDate = (birthdayDate, referenceDate = new Date()) => {
  const parseDateOnly = (value) => {
    if (!value) return null;
    if (value instanceof Date) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }

    const dateString = String(value).trim();
    const match = dateString.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) {
      const [year, month, day] = match[0].split('-').map((part) => parseInt(part, 10));
      return new Date(year, month - 1, day);
    }

    const parsed = new Date(dateString);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  };

  const parsedBirthday = parseDateOnly(birthdayDate);
  const parsedReference = parseDateOnly(referenceDate);

  if (!parsedBirthday || !parsedReference) {
    return null;
  }

  const thisYearBirthday = new Date(
    parsedReference.getFullYear(),
    parsedBirthday.getMonth(),
    parsedBirthday.getDate()
  );

  if (thisYearBirthday < parsedReference) {
    thisYearBirthday.setFullYear(thisYearBirthday.getFullYear() + 1);
  }

  return thisYearBirthday;
};

/**
 * Format a Date object (or datetime string) as 'YYYY-MM-DD HH:mm:ss'
 * using its local time — avoids UTC shift on DATETIME/TIMESTAMP columns.
 */
const formatDateTime = (value) => {
  if (!value) return value;
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    const y = value.getFullYear();
    const mo = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    const h = String(value.getHours()).padStart(2, '0');
    const mi = String(value.getMinutes()).padStart(2, '0');
    const s = String(value.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
  }
  return value;
};

/**
 * Helper to query HR emails to send application notifications.
 */
const getHrEmails = async () => {
  try {
    const query = `
      SELECT u.user_email 
      FROM wp_users u
      JOIN wp_usermeta m ON u.ID = m.user_id
      WHERE m.meta_key = 'wp_capabilities' 
        AND m.meta_value LIKE '%"hr"%'
    `;
    const [rows] = await pool.query(query);
    if (rows.length > 0) {
      return rows.map(r => r.user_email);
    }
  } catch (err) {
    console.error('Error fetching HR emails:', err);
  }
  return [process.env.SMTP_FROM || 'hr@example.com'];
};

const getAdministratorEmails = async () => {
  try {
    const query = `
      SELECT u.user_email
      FROM wp_users u
      JOIN wp_usermeta m ON u.ID = m.user_id
      WHERE m.meta_key = 'wp_capabilities'
        AND m.meta_value LIKE '%"administrator"%'
    `;
    const [rows] = await pool.query(query);
    if (rows.length > 0) {
      return rows.map(r => r.user_email).filter(Boolean);
    }
  } catch (err) {
    console.error('Error fetching administrator emails:', err);
  }
  return [];
};

const getAdministratorUser = async () => {
  try {
    const query = `
      SELECT u.ID, u.user_email, u.display_name
      FROM wp_users u
      JOIN wp_usermeta m ON u.ID = m.user_id
      WHERE m.meta_key = 'wp_capabilities'
        AND m.meta_value LIKE '%"administrator"%'
      LIMIT 1
    `;
    const [rows] = await pool.query(query);
    if (rows.length > 0) {
      return {
        ID: rows[0].ID,
        user_email: rows[0].user_email,
        display_name: rows[0].display_name,
        role: 'administrator'
      };
    }
  } catch (err) {
    console.error('Error fetching administrator user:', err);
  }
  return null;
};

const crypto = require('crypto');

const verifyActionToken = (token) => {
  const secret = process.env.JWT_SECRET || 'secret';
  if (!token || !token.includes('.')) return null;
  const [dataB64, sig] = token.split('.');
  try {
    const expected = crypto.createHmac('sha256', secret).update(dataB64).digest('base64url');
    if (sig !== expected) return null;
    const dataStr = Buffer.from(dataB64, 'base64url').toString('utf8');
    const data = JSON.parse(dataStr);
    if (!data.exp || Math.floor(Date.now() / 1000) > data.exp) return null;
    return data;
  } catch (err) {
    return null;
  }
};

/**
 * Handle one-click action links from email.
 * GET /api/leaves/:id/action?token=...&decision=approved|rejected
 */
exports.hasDateRangeOverlap = hasDateRangeOverlap;
exports.countLeaveDaysForRange = countLeaveDaysForRange;
exports.isSandwichRuleRange = isSandwichRuleRange;
exports.calculateSandwichLeaveSplit = calculateSandwichLeaveSplit;
exports.getUpcomingBirthdayDate = getUpcomingBirthdayDate;
exports.buildInsufficientLeaveBalanceError = buildInsufficientLeaveBalanceError;
exports.shouldRequireAdministratorOnlyApproval = shouldRequireAdministratorOnlyApproval;
exports.shouldNotifyAdministratorForLeaderDecision = shouldNotifyAdministratorForLeaderDecision;
exports.shouldNotifyAdministratorForFinalDecision = shouldNotifyAdministratorForFinalDecision;

exports.getCurrentPolicyDocument = async (req, res) => {
  try {
    const requestedYear = req.query?.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    const year = Number.isNaN(requestedYear) ? new Date().getFullYear() : requestedYear;

    const [rows] = await pool.query(
      'SELECT policy_document FROM wp_st_leave_policy WHERE year = ? LIMIT 1',
      [year]
    );

    const policyDocument = rows[0]?.policy_document || null;

    return res.json({
      success: true,
      data: {
        year,
        policy_document: policyDocument,
      },
    });
  } catch (error) {
    console.error('[Leave Policy] Failed to fetch policy document:', error);
    return res.status(500).json({ error: 'Failed to fetch policy document.' });
  }
};

exports.handleActionLink = async (req, res) => {
  try {
    const leaveId = parseInt(req.params.id, 10);
    const { decision } = req.query;
    const validDecisions = ['approved', 'rejected'];

    if (!validDecisions.includes(decision)) {
      return res.status(400).send('Invalid request');
    }

    if (!req.user) {
      return res.status(401).send('Authentication required');
    }

    const user = req.user;
    const [rows] = await pool.query(
      'SELECT l.*, u.display_name AS employee_name, u.user_email AS employee_email FROM wp_hrms_leaves l JOIN wp_users u ON l.employee_id = u.ID WHERE l.id = ?',
      [leaveId]
    );

    if (rows.length === 0) {
      return res.status(404).send('Leave request not found');
    }

    const leave = rows[0];
    const employeeRole = await getWordPressUserRole(leave.employee_id);
    const requireAdministratorOnlyApproval = shouldRequireAdministratorOnlyApproval(employeeRole);
    const canProcessLeader = (user.role === 'leader' && parseInt(leave.leader_id, 10) === user.id) || user.role === 'administrator';
    const canProcessHR = (user.role === 'hr' && !requireAdministratorOnlyApproval) || user.role === 'administrator';

    if (leave.leader_status === 'pending') {
      if (!canProcessLeader) {
        return res.status(403).send('Action not authorized for this leader');
      }

      if (leave.hr_status !== 'pending') {
        return res.status(400).send('Cannot modify leader decision. HR already processed this request.');
      }

      const overallStatus = decision === 'approved' ? 'partially_approved' : 'rejected';
      await pool.query(
        'UPDATE wp_hrms_leaves SET leader_status = ?, leader_approved_at = NOW(), leader_rejection_reason = ?, status = ? WHERE id = ?',
        [decision, decision === 'rejected' ? null : null, overallStatus, leaveId]
      );

      if (decision === 'approved') {
        const administratorEmails = (await getAdministratorEmails()).filter((email) => email && email.toLowerCase() !== user.email?.toLowerCase());
        for (const adminEmail of administratorEmails) {
          await emailService.notifyHRForApproval(adminEmail, leave.employee_name || '', user.name, leave);
        }
        return res.send('Leader approval recorded. Administrator has been notified.');
      }

      await emailService.notifyEmployeeStatus(leave.employee_email, leave.employee_name || '', { ...leave, rejection_reason: null }, 'rejected');
      return res.send('Leader rejection recorded and employee notified.');
    }

    if (leave.leader_status === 'approved' && leave.hr_status === 'pending') {
      if (!canProcessHR) {
        return res.status(403).send('Action not authorized for this HR user');
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        const [leaveRows] = await connection.query(
          'SELECT l.*, u.display_name AS employee_name, u.user_email AS employee_email FROM wp_hrms_leaves l JOIN wp_users u ON l.employee_id = u.ID WHERE l.id = ? FOR UPDATE',
          [leaveId]
        );

        if (leaveRows.length === 0) {
          await connection.rollback();
          return res.status(404).send('Leave request not found');
        }

        const leaveRec = leaveRows[0];
        const requestedDays = parseFloat(leaveRec.leave_days);
        const leaveYear = new Date(leaveRec.start_date).getFullYear();

        const [balanceRows] = await connection.query(
          'SELECT balance_json FROM wp_hrms_leave_balances WHERE employee_id = ? AND year = ? FOR UPDATE',
          [leaveRec.employee_id, leaveYear]
        );

        if (balanceRows.length === 0) {
          await connection.rollback();
          return res.status(400).send('No leave balance configured for employee in this year');
        }

        const balanceRowJson = parseBalanceJson(balanceRows[0].balance_json);
        let updatedClDaysCharged = parseFloat(leaveRec.cl_days_charged || 0);
        let updatedExtraLwpDays = parseFloat(leaveRec.extra_lwp_days || 0);

        if (decision === 'approved') {
          if (leaveRec.leave_type === CL_TYPE) {
            const entry = balanceRowJson[leaveRec.leave_type];
            if (!entry) {
              await connection.rollback();
              return res.status(400).send('No leave balance entry for this leave type');
            }
            const remaining = getLeaveEntryRemaining(entry, leaveRec.leave_type);
            if (remaining < updatedClDaysCharged) {
              await connection.rollback();
              return res.status(400).send('Insufficient CL balance for final approval');
            }
            entry.used = parseFloat(entry.used || 0) + updatedClDaysCharged;
            entry.monthly_available = Math.max(0, parseFloat(entry.monthly_available || 0) - updatedClDaysCharged);
            balanceRowJson[leaveRec.leave_type] = entry;
          } else if (leaveRec.leave_type !== 'LWP') {
            const entry = balanceRowJson[leaveRec.leave_type];
            if (!entry) {
              await connection.rollback();
              return res.status(400).send('No leave balance entry for this leave type');
            }
            const remaining = getLeaveEntryRemaining(entry, leaveRec.leave_type);
            if (remaining < requestedDays) {
              await connection.rollback();
              return res.status(400).send('Insufficient leave balance for final approval');
            }
            entry.used = parseFloat(entry.used || 0) + requestedDays;
            balanceRowJson[leaveRec.leave_type] = entry;
          }

          await connection.query(
            'UPDATE wp_hrms_leave_balances SET balance_json = ? WHERE employee_id = ? AND year = ?',
            [JSON.stringify(balanceRowJson), leaveRec.employee_id, leaveYear]
          );
        }

        const finalStatus = decision === 'approved' ? 'approved' : 'rejected';
        const [approverUserRows] = await connection.query('SELECT ID FROM wp_users WHERE user_email = ? LIMIT 1', [user.email]);
        const approverUserId = approverUserRows[0] ? parseInt(approverUserRows[0].ID, 10) : null;

        await connection.query(
          'UPDATE wp_hrms_leaves SET hr_status = ?, hr_id = ?, hr_approved_at = NOW(), hr_rejection_reason = ?, status = ? WHERE id = ?',
          [decision, approverUserId, decision === 'rejected' ? null : null, finalStatus, leaveId]
        );

        await connection.commit();

        if (shouldNotifyAdministratorForFinalDecision(decision)) {
          const administratorEmails = await getAdministratorEmails();
          for (const adminEmail of administratorEmails) {
            await emailService.notifyHRForApproval(adminEmail, leaveRec.employee_name, leaveRec.employee_name, { ...leaveRec, extra_lwp_days: updatedExtraLwpDays, cl_days_charged: updatedClDaysCharged, rejection_reason: decision === 'rejected' ? null : null });
          }
        }

        await emailService.notifyEmployeeStatus(leaveRec.employee_email, leaveRec.employee_name, { ...leaveRec, extra_lwp_days: updatedExtraLwpDays, cl_days_charged: updatedClDaysCharged }, finalStatus);
        return res.send('HR decision recorded and employee notified.');
      } catch (err) {
        await connection.rollback();
        console.error('handleActionLink HR error', err);
        return res.status(500).send('Failed to process HR action');
      } finally {
        connection.release();
      }
    }

    return res.status(400).send('Leave request is not in a state that allows this action.');
  } catch (err) {
    console.error('handleActionLink error', err);
    return res.status(500).send('Failed to process action link');
  }
};

/**
 * Walk up the st_reports_to hierarchy to find the FIRST user with the 'leader'
 * (or 'administrator') role.
 *
 * Hierarchy example:  Leader → Buddy → Employee
 * If an employee's direct manager is a Buddy, this function keeps going up
 * until it reaches a Leader. This ensures the correct person gets the
 * approval request regardless of how many intermediary levels exist.
 *
 * @param {number} employeeId - The user ID to start walking UP from
 * @param {number} maxDepth   - Max levels to traverse (prevents infinite loops)
 * @returns {object|null}     Manager row { ID, user_email, display_name, role } or null
 */
const findLeaderInHierarchy = async (employeeId, maxDepth = 10) => {
  let currentUserId = employeeId;

  for (let depth = 0; depth < maxDepth; depth++) {
    // Fetch the direct manager of the current user, including their capabilities
    const query = `
      SELECT u.ID, u.user_email, u.display_name,
             (SELECT meta_value FROM wp_usermeta
              WHERE user_id = u.ID AND meta_key = 'wp_capabilities' LIMIT 1) AS capabilities
      FROM wp_usermeta m
      JOIN wp_users u ON m.meta_value = u.ID
      WHERE m.user_id = ? AND m.meta_key = 'st_reports_to'
      LIMIT 1
    `;
    const [rows] = await pool.query(query, [currentUserId]);

    // No manager found at this level — hierarchy ends without a Leader
    if (rows.length === 0) {
      console.log(`[Hierarchy] No manager found for user ${currentUserId} at depth ${depth}. No Leader in chain.`);
      return null;
    }

    const manager = rows[0];
    const capabilities = manager.capabilities || '';

    // Determine this manager's role from WordPress capabilities
    let managerRole = 'employee';
    if (capabilities.includes('"administrator"'))  managerRole = 'administrator';
    else if (capabilities.includes('"leader"'))    managerRole = 'leader';
    else if (capabilities.includes('"hr"'))        managerRole = 'hr';
    else if (capabilities.includes('"buddy"'))     managerRole = 'buddy';

    console.log(`[Hierarchy] Depth ${depth}: User ${currentUserId} → Manager ID ${manager.ID} (${manager.display_name}, Role: ${managerRole})`);

    // Found a Leader or Administrator — this is the approver
    if (managerRole === 'leader' || managerRole === 'administrator') {
      console.log(`[Hierarchy] Found approver: ${manager.display_name} (ID: ${manager.ID}, Role: ${managerRole})`);
      return { ...manager, role: managerRole };
    }

    // This manager is a buddy or other intermediate role — go up one more level
    currentUserId = parseInt(manager.ID, 10);
  }

  console.warn(`[Hierarchy] Exhausted ${maxDepth} levels without finding a Leader for employee ${employeeId}.`);
  return null;
};

const resolveLevel1Approver = async (employee, deps = {}) => {
  if (!employee) {
    return null;
  }

  const getAdministratorUserFn = deps.getAdministratorUserFn || getAdministratorUser;
  const findLeaderInHierarchyFn = deps.findLeaderInHierarchyFn || findLeaderInHierarchy;

  if (employee.role === 'leader') {
    return getAdministratorUserFn();
  }

  return findLeaderInHierarchyFn(employee.id);
};

exports.resolveLevel1Approver = resolveLevel1Approver;

/**
 * 1. Fetch Leave Balances for an Employee
 * GET /api/leaves/balances
 */
exports.getLeaveBalances = async (req, res) => {
  try {
    const requester = req.user;
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    const requestedEmployeeId = req.params?.employee_id || req.query?.employee_id || req.query?.user_id || req.params?.id;
    let targetEmployeeId = requestedEmployeeId ? parseInt(requestedEmployeeId, 10) : requester.id;

    if (Number.isNaN(targetEmployeeId)) {
      targetEmployeeId = requester.id;
    }

    if (targetEmployeeId !== requester.id) {
      const reportsToQuery = `SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'st_reports_to'`;
      const [metaRows] = await pool.query(reportsToQuery, [targetEmployeeId]);
      const managerId = metaRows[0] ? parseInt(metaRows[0].meta_value, 10) : null;

      if (!canAccessTargetUser(requester, targetEmployeeId, managerId)) {
        return res.status(403).json({ error: 'Access denied: You can only view your own or your direct reports\' balances.' });
      }
    }

    // 1. Fetch leave policy configuration for the year to auto-initialize missing balances
    const policyQuery = `SELECT leave_policy_json FROM wp_st_leave_policy WHERE year = ?`;
    const [policyRows] = await pool.query(policyQuery, [year]);

    const balanceRow = await getOrCreateLeaveBalanceRow(targetEmployeeId, year);
    let balanceJson = balanceRow.balanceJson;
    let needsSave = false;

    if (policyRows.length > 0) {
      try {
        const policies = JSON.parse(policyRows[0].leave_policy_json);
        for (const policy of policies) {
          const key = policy.short_form;
          if (!balanceJson[key]) {
            balanceJson[key] = {
              total_allotted: parseFloat(policy.total_leaves) || 0.00,
              used: 0.00,
            };
            needsSave = true;
          }
        }
      } catch (parseErr) {
        console.error('Failed to auto-populate leave balances from policy:', parseErr);
      }
    }

    if (!balanceJson.LWP) {
      balanceJson.LWP = {
        total_allotted: 0.00,
        used: 0.00,
      };
      needsSave = true;
    }

    if (needsSave) {
      await saveLeaveBalanceRow(targetEmployeeId, year, balanceJson);
    }

    let policyPolicies = [];
    if (policyRows.length > 0) {
      try {
        policyPolicies = JSON.parse(policyRows[0].leave_policy_json || '[]');
      } catch (parseErr) {
        console.error('Failed to parse leave policy JSON for balance accrual:', parseErr);
      }
    }

    const clPolicy = policyPolicies.find((policy) =>
      normalizeLeaveType(policy.short_form) === CL_TYPE ||
      normalizeLeaveType(policy.full_name) === CL_TYPE
    );

    if (clPolicy) {
      await ensureMonthlyClAccrual({ balanceJson }, targetEmployeeId, year, parseFloat(clPolicy.total_leaves) || null, new Date());
      balanceJson = (await getOrCreateLeaveBalanceRow(targetEmployeeId, year)).balanceJson;
    }

    const lwpTotalDaysTaken = await getNumericUserMetaValue(targetEmployeeId, LWP_TOTAL_DAYS_META_KEY, 0);

    const balances = Object.keys(balanceJson).map((leaveType) => {
      const entry = balanceJson[leaveType];
      const balanceRow = {
        leave_type: leaveType,
        total_allotted: parseFloat(entry.total_allotted || 0),
        used: parseFloat(entry.used || 0),
        remaining: getLeaveEntryRemaining(entry, leaveType),
      };
      if (leaveType === CL_TYPE) {
        balanceRow.monthly_available = parseFloat(entry.monthly_available || 0);
        balanceRow.unused_previous_year_cl = parseFloat(entry.unused_previous_year_cl || 0);
        balanceRow.effective_available = Math.min(balanceRow.monthly_available, balanceRow.remaining);
      }
      return balanceRow;
    });

    res.json({
      employee_id: targetEmployeeId,
      year: year,
      lwp_total_days_taken: lwpTotalDaysTaken,
      balances: balances
    });
  } catch (err) {
    console.error('getLeaveBalances error:', err);
    res.status(500).json({ error: 'Failed to retrieve leave balances' });
  }
};

/**
 * 2. Configure / Initialize Leave Balance (Admin/HR only)
 * POST /api/leaves/balances
 */
exports.configureLeaveBalance = async (req, res) => {
  try {
    const { employee_id, leave_type, year, total_allotted } = req.body;

    if (!employee_id || !leave_type || !year || total_allotted === undefined) {
      return res.status(400).json({ error: 'employee_id, leave_type, year, and total_allotted are required.' });
    }

    const canonicalLeaveType = normalizeLeaveType(leave_type);
    if (!canonicalLeaveType) {
      return res.status(400).json({ error: 'Invalid leave_type.' });
    }

    const balanceRow = await getOrCreateLeaveBalanceRow(employee_id, year);
    const entry = balanceRow.balanceJson[canonicalLeaveType] || { total_allotted: 0.00, used: 0.00 };
    balanceRow.balanceJson[canonicalLeaveType] = {
      total_allotted: parseFloat(total_allotted) || 0.00,
      used: parseFloat(entry.used || 0) || 0.00,
    };

    await saveLeaveBalanceRow(employee_id, year, balanceRow.balanceJson);

    res.json({ 
      message: 'Leave balance configured successfully.',
      employee_id,
      leave_type: canonicalLeaveType,
      year,
      total_allotted: parseFloat(total_allotted) || 0.00
    });
  } catch (err) {
    console.error('configureLeaveBalance error:', err);
    res.status(500).json({ error: 'Failed to configure leave balance' });
  }
};

/**
 * 3a. Update an existing leave request
 * PUT /api/leaves/:id
 */
exports.updateLeave = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized: valid token required.' });
    }

    const employee = req.user;
    const leaveId = req.params.id;
    const { leave_type, start_date, end_date, reason, day_type = 'full_day', half_day_period = null } = req.body;

    if (!leaveId) {
      return res.status(400).json({ error: 'Leave ID is required.' });
    }

    const [leaveRows] = await pool.query('SELECT * FROM wp_hrms_leaves WHERE id = ? LIMIT 1', [leaveId]);
    if (leaveRows.length === 0) {
      return res.status(404).json({ error: 'Leave request not found.' });
    }

    const existingLeave = leaveRows[0];
    if (parseInt(existingLeave.employee_id, 10) !== parseInt(employee.id, 10)) {
      return res.status(403).json({ error: 'You can only update your own leave request.' });
    }

    if (['approved', 'rejected', 'cancelled'].includes(existingLeave.status)) {
      return res.status(400).json({ error: 'This leave request can no longer be updated.' });
    }

    if (!leave_type || !start_date || !end_date || !reason) {
      return res.status(400).json({ error: 'leave_type, start_date, end_date, and reason are required' });
    }

    const canonicalLeaveType = normalizeLeaveType(leave_type);
    if (canonicalLeaveType === 'EL') {
      if (day_type !== 'full_day') {
        return res.status(400).json({ error: "Early Leave must be requested as a 2-hour leave using day_type 'full_day'." });
      }
      if (half_day_period) {
        return res.status(400).json({ error: "Early Leave does not support half-day periods. Use day_type 'full_day' only." });
      }
      if (start_date !== end_date) {
        return res.status(400).json({ error: 'Early Leave must be requested for a single day only.' });
      }
    } else {
      if (!['full_day', 'half_day'].includes(day_type)) {
        return res.status(400).json({ error: "Invalid day_type. Must be 'full_day' or 'half_day'" });
      }
    }

    let requestedDays = 0;
    let finalHalfDayPeriod = null;
    let requestedPaidDays = 0;
    let requestedLwpDays = 0;

    if (canonicalLeaveType === 'EL') {
      requestedDays = 0.25;
      finalHalfDayPeriod = null;
    } else if (day_type === 'half_day') {
      if (!['first_half', 'second_half'].includes(half_day_period)) {
        return res.status(400).json({ error: "For half-day leaves, half_day_period is required and must be 'first_half' or 'second_half'" });
      }
      if (start_date !== end_date) {
        return res.status(400).json({ error: 'For half-day leaves, start_date and end_date must be the same date' });
      }
      requestedDays = 0.5;
      finalHalfDayPeriod = half_day_period;
    } else {
      if (canonicalLeaveType === 'HB' && start_date !== end_date) {
        return res.status(400).json({ error: 'Birthday leave must be requested for a single day only.' });
      }

      const start = new Date(start_date);
      const end = new Date(end_date);
      if (start > end) {
        return res.status(400).json({ error: 'Start date cannot be after end date' });
      }
      const sandwichSplit = calculateSandwichLeaveSplit(start_date, end_date);
      requestedDays = sandwichSplit.totalDays;
      requestedPaidDays = sandwichSplit.paidDays;
      requestedLwpDays = sandwichSplit.lwpDays;

      if (requestedDays === 0) {
        return res.status(400).json({ error: 'The selected date range contains only weekends/holidays. No leave days required.' });
      }
    }

    const startYear = new Date(start_date).getFullYear();
    let matchedLeaveType = canonicalLeaveType;
    let matchedFullName = LEAVE_TYPE_FULL_NAME_MAP[canonicalLeaveType] || leave_type;
    let totalAllottedFromPolicy = null;
    const leaveRequiresBalance = !SPECIAL_BALANCE_FREE_LEAVE_TYPES.includes(canonicalLeaveType);

    if (canonicalLeaveType === 'EL') {
      const compensate_date = req.body.compensate_date;
      if (!compensate_date) {
        return res.status(400).json({ error: 'Early Leave requires compensate_date. Provide a date within the current week or next week.' });
      }
      if (!isWithinCurrentOrNextWeek(start_date, compensate_date)) {
        return res.status(400).json({ error: 'Compensate date must be within the same week or the following week of the early leave.' });
      }
      requestedDays = 1;
      matchedLeaveType = 'EL';
      matchedFullName = 'Early Leave (2 hours)';
      totalAllottedFromPolicy = 0.00;
    }

    if (canonicalLeaveType === 'HB') {
      const birthdayMeta = await getUserMetaValue(employee.id, 'birthday_date');
      if (!birthdayMeta) {
        return res.status(400).json({ error: 'Birthday date is not configured in your profile. You cannot apply for birthday leave.' });
      }

      const birthday = new Date(birthdayMeta);
      if (Number.isNaN(birthday.getTime())) {
        return res.status(400).json({ error: 'Birthday date stored in profile is invalid. Contact HR to update your profile.' });
      }

      const requestDate = new Date(start_date);
      const upcomingBirthdayDate = getUpcomingBirthdayDate(birthday, requestDate);
      if (!upcomingBirthdayDate) {
        return res.status(400).json({ error: 'Birthday date stored in profile is invalid. Contact HR to update your profile.' });
      }

      const requestDateKey = formatDateOnly(requestDate);
      const upcomingBirthdayKey = formatDateOnly(upcomingBirthdayDate);
      if (requestDateKey !== upcomingBirthdayKey) {
        return res.status(400).json({ error: 'Birthday leave can only be applied on your upcoming birthday date.' });
      }

      if (isWeekendDate(requestDate)) {
        return res.status(400).json({ error: 'Birthday leave is not available when your birthday falls on a weekend.' });
      }
    }

    if (canonicalLeaveType === CL_TYPE) {
      const probationInfo = await getProbationInfo(employee.id, new Date(start_date));
      if (!probationInfo.canUseCl) {
        return res.status(400).json({
          error: `CL leave is not available until probation completes on ${formatDateOnly(probationInfo.probationCompleteDate)}.`
        });
      }
    }

    if (leaveRequiresBalance) {
      if (matchedLeaveType !== 'EL') {
        const policyQuery = `SELECT leave_policy_json FROM wp_st_leave_policy WHERE year = ?`;
        const [policyRows] = await pool.query(policyQuery, [startYear]);
        if (policyRows.length === 0) {
          return res.status(400).json({ error: `No leave policy configured for the year ${startYear}. Contact Admin/HR.` });
        }

        try {
          const policies = JSON.parse(policyRows[0].leave_policy_json);
          const matchedPolicy = policies.find((p) => p.full_name.toLowerCase() === leave_type.toLowerCase() || p.short_form.toLowerCase() === leave_type.toLowerCase());
          if (!matchedPolicy) {
            const allowedTypes = policies.map((p) => `${p.short_form} (${p.full_name})`).join(', ');
            return res.status(400).json({ error: `Invalid leave type '${leave_type}' for year ${startYear}. Allowed types: ${allowedTypes}` });
          }
          matchedLeaveType = matchedPolicy.short_form;
          matchedFullName = matchedPolicy.full_name;
          totalAllottedFromPolicy = parseFloat(matchedPolicy.total_leaves) || 0.00;
        } catch (parseErr) {
          console.error('Failed to parse leave policy JSON:', parseErr);
          return res.status(500).json({ error: 'Failed to validate leave policy.' });
        }
      }
    } else {
      matchedLeaveType = 'LWP';
      matchedFullName = LEAVE_TYPE_FULL_NAME_MAP.LWP;
      totalAllottedFromPolicy = 0.00;
    }

    const existingLeaveQuery = `
      SELECT id, status, start_date, end_date
      FROM wp_hrms_leaves
      WHERE employee_id = ?
        AND id != ?
        AND status != 'rejected'
    `;
    const [existingLeaveRows] = await pool.query(existingLeaveQuery, [employee.id, leaveId]);
    const hasExistingOverlap = existingLeaveRows.some((row) => hasDateRangeOverlap(start_date, end_date, row.start_date, row.end_date));
    if (hasExistingOverlap) {
      return res.status(409).json({ error: 'You already have another leave request for one or more of the selected dates.' });
    }

    let cl_days_charged = 0;
    let extra_lwp_days = 0;
    let effectivePaidDays = requestedPaidDays || requestedDays;
    let effectiveLwpDays = requestedLwpDays || Math.max(0, requestedDays - effectivePaidDays);

    if (matchedLeaveType === CL_TYPE) {
      const balanceRow = await getOrCreateLeaveBalanceRow(employee.id, startYear);
      const balanceEntry = balanceRow.balanceJson[matchedLeaveType];
      const remainingDays = getLeaveEntryRemaining(balanceEntry, matchedLeaveType);
      const monthlyAvailable = parseFloat(balanceEntry?.monthly_available || 0);
      const effectiveClAvailable = Math.min(monthlyAvailable, remainingDays);
      cl_days_charged = Math.min(effectivePaidDays, effectiveClAvailable);
      extra_lwp_days = effectiveLwpDays + Math.max(0, effectivePaidDays - cl_days_charged);
    } else if (matchedLeaveType !== 'LWP') {
      extra_lwp_days = effectiveLwpDays;
    }

    const requireAdministratorOnlyApproval = shouldRequireAdministratorOnlyApproval(employee.role);
    const level1Approver = employee.role === 'leader' || requireAdministratorOnlyApproval ? null : await resolveLevel1Approver(employee);

    let leaderId = null;
    let leaderStatus = 'pending';
    let hrStatus = 'pending';
    let overallStatus = 'pending';

    if (employee.role === 'leader') {
      leaderId = employee.id;
      leaderStatus = 'approved';
      overallStatus = 'partially_approved';
    } else if (requireAdministratorOnlyApproval) {
      leaderStatus = 'approved';
      overallStatus = 'partially_approved';
    } else if (level1Approver) {
      leaderId = parseInt(level1Approver.ID, 10);
    } else {
      leaderStatus = 'pending';
      overallStatus = 'pending';
    }

    const updateQuery = `
      UPDATE wp_hrms_leaves
      SET leave_type = ?, start_date = ?, end_date = ?, leave_days = ?, cl_days_charged = ?, extra_lwp_days = ?, reason = ?, day_type = ?, half_day_period = ?, compensate_date = ?, leader_id = ?, leader_status = ?, hr_status = ?, status = ?
      WHERE id = ? AND employee_id = ?
    `;
    await pool.query(updateQuery, [
      matchedLeaveType,
      start_date,
      end_date,
      requestedDays,
      cl_days_charged,
      extra_lwp_days,
      reason,
      day_type,
      finalHalfDayPeriod,
      canonicalLeaveType === 'EL' ? req.body.compensate_date : null,
      leaderId,
      leaderStatus,
      hrStatus,
      overallStatus,
      leaveId,
      employee.id,
    ]);

    const leaveData = {
      id: leaveId,
      leave_type: matchedLeaveType,
      leave_type_full: matchedFullName,
      start_date,
      end_date,
      reason,
      days: requestedDays,
      day_type,
      half_day_period: finalHalfDayPeriod,
    };

    void emailService.notifyEmployeeLeaveUpdated(employee.email, employee.name, leaveData);

    if (requireAdministratorOnlyApproval) {
      const administratorEmails = await getAdministratorEmails();
      for (const adminEmail of administratorEmails) {
        await emailService.notifyHRLeaveUpdated(adminEmail, employee.name, employee.name, leaveData);
      }
    } else {
      const hrEmails = await getHrEmails();
      for (const hrEmail of hrEmails) {
        await emailService.notifyHRLeaveUpdated(hrEmail, employee.name, employee.name, leaveData);
      }

      if (level1Approver) {
        await emailService.notifyLeaderLeaveUpdated(level1Approver.user_email, employee.name, leaveData);
      }
    }

    return res.json({
      message: 'Leave request updated successfully and sent for re-review.',
      leave_id: leaveId,
      status: overallStatus,
      leader_status: leaderStatus,
      hr_status: hrStatus,
    });
  } catch (err) {
    console.error('updateLeave error:', err);
    return res.status(500).json({ error: 'Failed to update leave request.' });
  }
};

/**
 * 3c. Cancel an existing leave request
 * PUT /api/leaves/:id/cancel
 */
exports.cancelLeave = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized: valid token required.' });
    }

    const employee = req.user;
    const leaveId = req.params.id;

    if (!leaveId) {
      return res.status(400).json({ error: 'Leave ID is required.' });
    }

    const [leaveRows] = await pool.query('SELECT * FROM wp_hrms_leaves WHERE id = ? LIMIT 1', [leaveId]);
    if (leaveRows.length === 0) {
      return res.status(404).json({ error: 'Leave request not found.' });
    }

    const existingLeave = leaveRows[0];
    if (parseInt(existingLeave.employee_id, 10) !== parseInt(employee.id, 10)) {
      return res.status(403).json({ error: 'You can only cancel your own leave request.' });
    }

    if (['approved', 'rejected', 'cancelled'].includes(existingLeave.status)) {
      return res.status(400).json({ error: 'This leave request cannot be cancelled.' });
    }

    if (!['pending', 'partially_approved'].includes(existingLeave.status)) {
      return res.status(400).json({ error: `This leave request is currently ${existingLeave.status} and cannot be cancelled.` });
    }

    const [result] = await pool.query(
      `UPDATE wp_hrms_leaves
       SET status = 'cancelled'
       WHERE id = ? AND employee_id = ? AND status IN ('pending', 'partially_approved')`,
      [leaveId, employee.id]
    );

    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'Leave request could not be cancelled. It may already be processed or no longer editable.' });
    }

    return res.json({
      message: 'Leave request cancelled successfully.',
      leave_id: leaveId,
      status: 'cancelled'
    });
  } catch (err) {
    console.error('cancelLeave error:', err);
    return res.status(500).json({ error: 'Failed to cancel leave request.' });
  }
};

/**
 * 3. Apply for Leave
 * POST /api/leaves
 */
exports.applyLeave = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized: valid token required.' });
    }

    const employee = req.user;
    const { leave_type, start_date, end_date, reason, day_type = 'full_day', half_day_period = null } = req.body;

    if (!leave_type || !start_date || !end_date || !reason) {
      return res.status(400).json({ error: 'leave_type, start_date, end_date, and reason are required' });
    }

    const canonicalLeaveType = normalizeLeaveType(leave_type);
    if (canonicalLeaveType === 'EL') {
      if (day_type !== 'full_day') {
        return res.status(400).json({ error: "Early Leave must be requested as a 2-hour leave using day_type 'full_day'." });
      }
      if (half_day_period) {
        return res.status(400).json({ error: "Early Leave does not support half-day periods. Use day_type 'full_day' only." });
      }
      if (start_date !== end_date) {
        return res.status(400).json({ error: 'Early Leave must be requested for a single day only.' });
      }
    } else {
      // Validate Day Type for standard leave types
      if (!['full_day', 'half_day'].includes(day_type)) {
        return res.status(400).json({ error: "Invalid day_type. Must be 'full_day' or 'half_day'" });
      }
    }

    let requestedDays = 0;
    let finalHalfDayPeriod = null;
    let requestedPaidDays = 0;
    let requestedLwpDays = 0;

    if (canonicalLeaveType === 'EL') {
      requestedDays = 1;
      finalHalfDayPeriod = null;
    } else if (day_type === 'half_day') {
      if (!['first_half', 'second_half'].includes(half_day_period)) {
        return res.status(400).json({ error: "For half-day leaves, half_day_period is required and must be 'first_half' or 'second_half'" });
      }
      if (start_date !== end_date) {
        return res.status(400).json({ error: 'For half-day leaves, start_date and end_date must be the same date' });
      }
      requestedDays = 0.5;
      finalHalfDayPeriod = half_day_period;
    } else {
      if (canonicalLeaveType === 'HB' && start_date !== end_date) {
        return res.status(400).json({ error: 'Birthday leave must be requested for a single day only.' });
      }

      const start = new Date(start_date);
      const end = new Date(end_date);
      if (start > end) {
        return res.status(400).json({ error: 'Start date cannot be after end date' });
      }
      const sandwichSplit = calculateSandwichLeaveSplit(start_date, end_date);
      requestedDays = sandwichSplit.totalDays;
      requestedPaidDays = sandwichSplit.paidDays;
      requestedLwpDays = sandwichSplit.lwpDays;

      if (requestedDays === 0) {
        return res.status(400).json({ error: 'The selected date range contains only weekends/holidays. No leave days required.' });
      }
    }

    const startYear = new Date(start_date).getFullYear();
    let matchedLeaveType = canonicalLeaveType;
    let matchedFullName = LEAVE_TYPE_FULL_NAME_MAP[canonicalLeaveType] || leave_type;
    let totalAllottedFromPolicy = null;
    const leaveRequiresBalance = !SPECIAL_BALANCE_FREE_LEAVE_TYPES.includes(canonicalLeaveType);

    // Early Leave (EL) special handling: 2 hours (0.25 day) allowed once per MONTH
    // Requires `compensate_date` in request which must fall within the same week
    // or the next week of the start_date.
    if (canonicalLeaveType === 'EL') {
      const compensate_date = req.body.compensate_date;
      if (!compensate_date) {
        return res.status(400).json({ error: 'Early Leave requires compensate_date. Provide a date within the current week or next week.' });
      }

      if (!isWithinCurrentOrNextWeek(start_date, compensate_date)) {
        return res.status(400).json({ error: 'Compensate date must be within the same week or the following week of the early leave.' });
      }

      // Check if user already took early leave in same month
      const startMonth = new Date(start_date).getMonth() + 1;
      const startYearForMonth = new Date(start_date).getFullYear();
      const [existing] = await pool.query(`
        SELECT id FROM wp_hrms_leaves WHERE employee_id = ? AND leave_type = 'EL' AND MONTH(start_date) = ? AND YEAR(start_date) = ? AND status != 'rejected' LIMIT 1
      `, [employee.id, startMonth, startYearForMonth]);
      if (existing.length > 0) {
        return res.status(400).json({ error: 'You have already taken Early Leave in this month. Only one Early Leave per month is allowed.' });
      }

      // EL is treated as a separate leave type and stored as 1 day
      requestedDays = 1;
      // EL is free (no balance deduction) and treated specially
      matchedLeaveType = 'EL';
      matchedFullName = 'Early Leave (2 hours)';
      totalAllottedFromPolicy = 0.00;
    }

    if (canonicalLeaveType === 'HB') {
      const birthdayMeta = await getUserMetaValue(employee.id, 'birthday_date');
      if (!birthdayMeta) {
        return res.status(400).json({ error: 'Birthday date is not configured in your profile. You cannot apply for birthday leave.' });
      }

      const birthday = new Date(birthdayMeta);
      if (Number.isNaN(birthday.getTime())) {
        return res.status(400).json({ error: 'Birthday date stored in profile is invalid. Contact HR to update your profile.' });
      }

      const requestDate = new Date(start_date);
      const upcomingBirthdayDate = getUpcomingBirthdayDate(birthday, requestDate);

      if (!upcomingBirthdayDate) {
        return res.status(400).json({ error: 'Birthday date stored in profile is invalid. Contact HR to update your profile.' });
      }

      const requestDateKey = formatDateOnly(requestDate);
      const upcomingBirthdayKey = formatDateOnly(upcomingBirthdayDate);

      if (requestDateKey !== upcomingBirthdayKey) {
        return res.status(400).json({ error: 'Birthday leave can only be applied on your upcoming birthday date.' });
      }

      if (isWeekendDate(requestDate)) {
        return res.status(400).json({ error: 'Birthday leave is not available when your birthday falls on a weekend.' });
      }
    }

    if (canonicalLeaveType === CL_TYPE) {
      const probationInfo = await getProbationInfo(employee.id, new Date(start_date));
      if (!probationInfo.canUseCl) {
        return res.status(400).json({
          error: `CL leave is not available until probation completes on ${formatDateOnly(probationInfo.probationCompleteDate)}.`
        });
      }
    }

    if (leaveRequiresBalance) {
      if (matchedLeaveType !== 'EL') {
        const policyQuery = `SELECT leave_policy_json FROM wp_st_leave_policy WHERE year = ?`;
        const [policyRows] = await pool.query(policyQuery, [startYear]);
        
        if (policyRows.length === 0) {
          return res.status(400).json({ error: `No leave policy configured for the year ${startYear}. Contact Admin/HR.` });
        }

        try {
          const policies = JSON.parse(policyRows[0].leave_policy_json);
          const matchedPolicy = policies.find(p => 
            p.full_name.toLowerCase() === leave_type.toLowerCase() || 
            p.short_form.toLowerCase() === leave_type.toLowerCase()
          );

          if (!matchedPolicy) {
            const allowedTypes = policies.map(p => `${p.short_form} (${p.full_name})`).join(', ');
            return res.status(400).json({ 
              error: `Invalid leave type '${leave_type}' for year ${startYear}. Allowed types: ${allowedTypes}` 
            });
          }

          matchedLeaveType = matchedPolicy.short_form;
          matchedFullName = matchedPolicy.full_name;
          totalAllottedFromPolicy = parseFloat(matchedPolicy.total_leaves) || 0.00;
        } catch (parseErr) {
          console.error('Failed to parse leave policy JSON:', parseErr);
          return res.status(500).json({ error: 'Failed to validate leave policy.' });
        }
      }
    } else {
      matchedLeaveType = 'LWP';
      matchedFullName = LEAVE_TYPE_FULL_NAME_MAP.LWP;
      totalAllottedFromPolicy = 0.00;
    }

    // Prevent overlapping leave requests on the same dates for the same employee
    const existingLeaveQuery = `
      SELECT id, status, start_date, end_date
      FROM wp_hrms_leaves
      WHERE employee_id = ?
        AND status != 'rejected'
    `;
    const [existingLeaveRows] = await pool.query(existingLeaveQuery, [employee.id]);

    const hasExistingOverlap = existingLeaveRows.some((existingLeave) =>
      hasDateRangeOverlap(start_date, end_date, existingLeave.start_date, existingLeave.end_date)
    );

    if (hasExistingOverlap) {
      return res.status(409).json({
        error: 'You already have a leave request for one or more of the selected dates. Please choose a different date range.'
      });
    }

    let balanceJsonRow = await getOrCreateLeaveBalanceRow(employee.id, startYear);

    if (matchedLeaveType === CL_TYPE) {
      await ensureMonthlyClAccrual(balanceJsonRow, employee.id, startYear, totalAllottedFromPolicy, new Date(start_date));
      balanceJsonRow = await getOrCreateLeaveBalanceRow(employee.id, startYear);
    }

    let balanceEntry = balanceJsonRow.balanceJson[matchedLeaveType];
    let cl_days_charged = 0;
    let extra_lwp_days = 0;
    let effectivePaidDays = requestedPaidDays || requestedDays;
    let effectiveLwpDays = requestedLwpDays || Math.max(0, requestedDays - effectivePaidDays);

    if (leaveRequiresBalance) {
      if (!balanceEntry) {
        balanceEntry = {
          total_allotted: totalAllottedFromPolicy,
          used: 0.00,
          monthly_available: matchedLeaveType === CL_TYPE ? 0.00 : undefined,
          monthly_last_accrual_month: matchedLeaveType === CL_TYPE ? null : undefined,
          unused_previous_year_cl: matchedLeaveType === CL_TYPE ? 0.00 : undefined,
        };
        balanceJsonRow.balanceJson[matchedLeaveType] = balanceEntry;
        await saveLeaveBalanceRow(employee.id, startYear, balanceJsonRow.balanceJson);
      }

      const remainingDays = getLeaveEntryRemaining(balanceEntry, matchedLeaveType);
      // EL is only allowed when the employee has sufficient EL balance.
      // Do not convert EL to LWP automatically; reject the request if EL balance is insufficient.
      if (matchedLeaveType === 'EL' && remainingDays !== null && remainingDays < requestedDays) {
        return res.status(400).json({
          error: `Insufficient EL balance. Requested: ${requestedDays} days, Remaining: ${remainingDays} days.`
        });
      }

      if (matchedLeaveType === CL_TYPE) {
        const monthlyAvailable = parseFloat(balanceEntry.monthly_available || 0);
        const effectiveClAvailable = Math.min(monthlyAvailable, remainingDays);
        cl_days_charged = Math.min(effectivePaidDays, effectiveClAvailable);
        extra_lwp_days = effectiveLwpDays + Math.max(0, effectivePaidDays - cl_days_charged);

        if (cl_days_charged > 0) {
          balanceEntry.used = parseFloat(balanceEntry.used || 0) + cl_days_charged;
          balanceEntry.monthly_available = Math.max(0, parseFloat(balanceEntry.monthly_available || 0) - cl_days_charged);
          balanceJsonRow.balanceJson[matchedLeaveType] = balanceEntry;
        }
      }

      if (matchedLeaveType !== CL_TYPE) {
        const lwpEntry = balanceJsonRow.balanceJson.LWP || {
          total_allotted: 0.00,
          used: 0.00,
        };
        balanceJsonRow.balanceJson.LWP = lwpEntry;
        await saveLeaveBalanceRow(employee.id, startYear, balanceJsonRow.balanceJson);
      }
    } else {
      if (!balanceEntry) {
        balanceJsonRow.balanceJson.LWP = {
          total_allotted: 0.00,
          used: 0.00,
        };
        await saveLeaveBalanceRow(employee.id, startYear, balanceJsonRow.balanceJson);
      }
    }

    // Determine approval flow:
    // - Leader role requests auto-approve Level 1 and move directly to HR.
    // - HR role requests skip leader approval and go directly to administrator for final approval.
    // - Other employees go through the normal hierarchy to their leader.
    const requireAdministratorOnlyApproval = shouldRequireAdministratorOnlyApproval(employee.role);
    const level1Approver = employee.role === 'leader' || requireAdministratorOnlyApproval ? null : await resolveLevel1Approver(employee);

    let leaderId = null;
    let leaderStatus = 'pending';
    let hrStatus = 'pending';
    let overallStatus = 'pending';

    if (employee.role === 'leader') {
      leaderId = employee.id;
      leaderStatus = 'approved';
      overallStatus = 'partially_approved';
      console.log(`[applyLeave] Leader ${employee.id} submitted leave request. Level 1 approval auto-approved; request sent to HR.`);
    } else if (requireAdministratorOnlyApproval) {
      leaderStatus = 'approved';
      overallStatus = 'partially_approved';
      console.log(`[applyLeave] HR ${employee.id} submitted leave request. Leader approval skipped; request sent to administrator for final approval.`);
    } else if (level1Approver) {
      leaderId = parseInt(level1Approver.ID, 10);
    } else {
      // No Level 1 approver found — keep the request pending rather than auto-approving.
      leaderStatus = 'pending';
      overallStatus = 'pending';
      console.log(`[applyLeave] No Level 1 approver found for employee ${employee.id}. Request remains pending.`);
    }

    // Insert leave request
    const insertQuery = `
      INSERT INTO wp_hrms_leaves (employee_id, leave_type, start_date, end_date, leave_days, cl_days_charged, extra_lwp_days, reason, day_type, half_day_period, compensate_date, leader_id, leader_status, hr_status, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const [insertResult] = await pool.query(insertQuery, [
      employee.id,
      matchedLeaveType,
      start_date,
      end_date,
      requestedDays,
      cl_days_charged,
      extra_lwp_days,
      reason,
      day_type,
      finalHalfDayPeriod,
      // compensate_date stored for EL; null otherwise
      canonicalLeaveType === 'EL' ? req.body.compensate_date : null,
      leaderId,
      leaderStatus,
      hrStatus,
      overallStatus
    ]);

    const leaveId = insertResult.insertId;
    const leaveData = { 
      id: leaveId, 
      leave_type: matchedLeaveType,       // short form (e.g. "CL")
      leave_type_full: matchedFullName,    // full name for email readability
      start_date, 
      end_date, 
      reason, 
      days: requestedDays,
      day_type,
      half_day_period: finalHalfDayPeriod
    };

    // Notify employee that the request was received and will be reviewed.
    // Keep this non-blocking so the API response stays fast.
    void emailService.notifyEmployeeRequestReceived(employee.email, employee.name, leaveData);

    const leaderNameForHR = employee.role === 'leader'
      ? `${employee.name} (Self-approved Leader)`
      : requireAdministratorOnlyApproval
        ? `${employee.name} (HR Submission)`
        : (level1Approver?.display_name || 'Assigned Level 1 Approver');
    void fireAndForgetNotifications(employee, leaveData, leaderNameForHR, level1Approver, requireAdministratorOnlyApproval, leaderId);

    res.status(201).json({
      message: 'Leave application submitted successfully. Approval workflow has been initiated.',
      leave_id: leaveId,
      leave_type: matchedLeaveType,
      leave_type_full: matchedFullName,
      days_requested: requestedDays,
      day_type,
      half_day_period: finalHalfDayPeriod,
      level1_status: leaderStatus,
      hr_status: hrStatus,
      status: overallStatus
    });
  } catch (err) {
    console.error('applyLeave error:', err);
    const errorMessage = err && err.message ? err.message : 'Failed to submit leave application';
    res.status(500).json({ error: errorMessage });
  }
};

/**
 * 4. Dashboard Report (Role-based filtering)
 * GET /api/leaves/report
 */
exports.getLeavesReport = async (req, res) => {
  try {
    const user = req.user;
    const { status, start_date, end_date, employee_id } = req.query;

    let queryParams = [];
    
    // Base query selecting leave request details and names
    let sql = `
      SELECT l.*, 
             u.display_name AS employee_name, u.user_email AS employee_email,
             mgr.display_name AS leader_name, mgr.user_email AS leader_email,
             hr.display_name AS hr_name, hr.user_email AS hr_email
      FROM wp_hrms_leaves l
      JOIN wp_users u ON l.employee_id = u.ID
      LEFT JOIN wp_users mgr ON l.leader_id = mgr.ID
      LEFT JOIN wp_users hr ON l.hr_id = hr.ID
      WHERE 1=1
    `;

    // Access Control & Filtering based on user roles
    if (user.role === 'administrator' || user.role === 'hr') {
      // administrator and hr can view everything.
      if (employee_id) {
        sql += ` AND l.employee_id = ?`;
        queryParams.push(employee_id);
      }
    } else if (user.role === 'leader') {
      // leader sees: own leaves + any leave where they are the assigned leader_id
      // + leaves of all employees who directly report to them
      sql += ` AND (l.employee_id = ? OR l.leader_id = ? OR l.employee_id IN (
        SELECT user_id FROM wp_usermeta WHERE meta_key = 'st_reports_to' AND meta_value = ?
      ))`;
      queryParams.push(user.id, user.id, user.id);
      if (employee_id) {
        sql += ` AND l.employee_id = ?`;
        queryParams.push(employee_id);
      }
    } else if (user.role === 'buddy') {
      // buddy sees: own leaves + leaves of employees who directly report to them
      sql += ` AND (l.employee_id = ? OR l.employee_id IN (
        SELECT user_id FROM wp_usermeta WHERE meta_key = 'st_reports_to' AND meta_value = ?
      ))`;
      queryParams.push(user.id, user.id);
      if (employee_id) {
        sql += ` AND l.employee_id = ?`;
        queryParams.push(employee_id);
      }
    } else {
      // employee and any other role can ONLY view their own leaves
      sql += ` AND l.employee_id = ?`;
      queryParams.push(user.id);
    }

    // Apply additional filters
    if (status) {
      sql += ` AND l.status = ?`;
      queryParams.push(status);
    }
    if (start_date) {
      sql += ` AND l.start_date >= ?`;
      queryParams.push(start_date);
    }
    if (end_date) {
      sql += ` AND l.end_date <= ?`;
      queryParams.push(end_date);
    }

    // Sort by creation date descending
    sql += ` ORDER BY l.created_at DESC`;

    const [rows] = await pool.query(sql, queryParams);
    
    // Map data to append duration days dynamically and normalize date fields
    // so they are returned exactly as stored, without UTC shift.
    const report = rows.map(row => ({
      ...row,
      start_date: formatDateOnly(row.start_date),
      end_date: formatDateOnly(row.end_date),
      leader_approved_at: formatDateTime(row.leader_approved_at),
      hr_approved_at: formatDateTime(row.hr_approved_at),
      created_at: formatDateTime(row.created_at),
      updated_at: formatDateTime(row.updated_at),
      days: parseFloat(row.leave_days)
    }));

    res.json({
      count: report.length,
      report: report
    });
  } catch (err) {
    console.error('getLeavesReport error:', err);
    res.status(500).json({ error: 'Failed to retrieve leaves report' });
  }
};

/**
 * 5. Level 1: Leader Approval
 * PUT /api/leaves/:id/approve-leader
 */
exports.approveLeader = async (req, res) => {
  try {
    const leader = req.user;
    const leaveId = req.params.id;
    const { status, reason } = req.body; // 'approved' or 'rejected', optional 'reason'

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "Invalid status. Must be 'approved' or 'rejected'" });
    }

    // Fetch the leave request
    const selectQuery = `
      SELECT l.*, u.display_name AS employee_name, u.user_email AS employee_email 
      FROM wp_hrms_leaves l
      JOIN wp_users u ON l.employee_id = u.ID
      WHERE l.id = ?
    `;
    const [rows] = await pool.query(selectQuery, [leaveId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Leave request not found' });
    }

    const leave = rows[0];

    // Ensure user is authorized to perform Level 1 approval
    // leader_id in the leave record holds the resolved Leader's ID from hierarchy traversal
    if (parseInt(leave.leader_id, 10) !== parseInt(leader.id, 10) && leader.role !== 'administrator') {
      return res.status(403).json({ error: 'Access denied: You are not the assigned leader for this leave request.' });
    }

    if (leave.hr_status !== 'pending') {
      return res.status(400).json({ 
        error: `Cannot modify leader decision. HR has already processed this request (Current HR status: ${leave.hr_status})` 
      });
    }

    const requestedDays = parseFloat(leave.leave_days);
    const leaveData = { ...leave, days: requestedDays, rejection_reason: reason };

    // Update Leader Status
    let overallStatus = 'pending';
    if (status === 'approved') {
      overallStatus = 'partially_approved';
    } else {
      overallStatus = 'rejected';
    }

    const updateQuery = `
      UPDATE wp_hrms_leaves 
      SET leader_status = ?, leader_approved_at = NOW(), leader_rejection_reason = ?, status = ?
      WHERE id = ?
    `;
    await pool.query(updateQuery, [status, status === 'rejected' ? (reason || null) : null, overallStatus, leaveId]);

    // Send notifications
    if (status === 'approved') {
      const administratorEmails = await getAdministratorEmails();
      for (const adminEmail of administratorEmails) {
        await emailService.notifyHRForApproval(adminEmail, leave.employee_name, leader.name, leaveData);
      }

      const hrEmails = (await getHrEmails())
        .filter(email => email && email.toLowerCase() !== leader.email?.toLowerCase());
      for (const hrEmail of hrEmails) {
        await emailService.notifyHRForApproval(hrEmail, leave.employee_name, leader.name, leaveData);
      }
    } else {
      const administratorEmails = await getAdministratorEmails();
      for (const adminEmail of administratorEmails) {
        await emailService.notifyHRForApproval(adminEmail, leave.employee_name, leader.name, { ...leaveData, rejection_reason: reason });
      }
      await emailService.notifyEmployeeStatus(leave.employee_email, leave.employee_name, leaveData, 'rejected');
    }

    res.json({
      message: `Leader ${status} leave request successfully.`,
      leave_id: leaveId,
      leader_status: status,
      leader_rejection_reason: status === 'rejected' ? (reason || null) : null,
      status: overallStatus
    });
  } catch (err) {
    console.error('approveLeader error:', err);
    res.status(500).json({ error: 'Failed to process Leader approval' });
  }
};

/**
 * 6. Level 2: HR Approval
 * PUT /api/leaves/:id/approve-hr
 */
exports.approveHR = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const hr = req.user;
    const leaveId = req.params.id;
    const { status, reason } = req.body; // 'approved' or 'rejected', optional 'reason'

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "Invalid status. Must be 'approved' or 'rejected'" });
    }

    // Fetch the leave request
    const selectQuery = `
      SELECT l.*, u.display_name AS employee_name, u.user_email AS employee_email 
      FROM wp_hrms_leaves l
      JOIN wp_users u ON l.employee_id = u.ID
      WHERE l.id = ?
    `;
    const [rows] = await connection.query(selectQuery, [leaveId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Leave request not found' });
    }

    const leave = rows[0];
    const employeeRole = await getWordPressUserRole(leave.employee_id);
    const requireAdministratorOnlyApproval = shouldRequireAdministratorOnlyApproval(employeeRole);

    if (requireAdministratorOnlyApproval && hr.role !== 'administrator') {
      return res.status(403).json({ error: 'Only administrator users can approve leave requests submitted by HR.' });
    }

    // Verify Level 1 was approved (or skipped)
    if (leave.leader_status !== 'approved') {
      return res.status(400).json({ 
        error: `Cannot process HR approval. Level 1 Leader status must be approved (Current: ${leave.leader_status})` 
      });
    }

    if (leave.hr_status !== 'pending') {
      return res.status(400).json({ error: `HR status is already processed: ${leave.hr_status}` });
    }

    const requestedDays = parseFloat(leave.leave_days);
    const leaveYear = new Date(leave.start_date).getFullYear();
    const leaveData = { ...leave, days: requestedDays, rejection_reason: reason };

    // Begin Transaction to guarantee balance integrity
    await connection.beginTransaction();

    let updatedClDaysCharged = parseFloat(leave.cl_days_charged || 0);
    let updatedExtraLwpDays = parseFloat(leave.extra_lwp_days || 0);

    if (status === 'approved') {
      // 1. Deduct leave balance
      // Double check current balance inside transaction
      const balanceQuery = `
        SELECT balance_json FROM wp_hrms_leave_balances 
        WHERE employee_id = ? AND year = ?
        FOR UPDATE
      `;
      const [balanceRows] = await connection.query(balanceQuery, [leave.employee_id, leaveYear]);
      
      if (balanceRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({ 
          error: `No leave balance configured for employee ${leave.employee_id} in year ${leaveYear}.` 
        });
      }

      const balanceRowJson = parseBalanceJson(balanceRows[0].balance_json);
      const entry = balanceRowJson[leave.leave_type];
      if (!entry) {
        await connection.rollback();
        return res.status(400).json({ 
          error: `No leave balance configured for leave type '${leave.leave_type}' in year ${leaveYear}.` 
        });
      }

      if (leave.leave_type === CL_TYPE) {
        const clDaysCharged = parseFloat(leave.cl_days_charged || 0);
        if (clDaysCharged > 0) {
          const remaining = getLeaveEntryRemaining(entry, leave.leave_type);
          const clToUse = Math.min(remaining, clDaysCharged);
          const lwpFromCl = clDaysCharged - clToUse;

          if (clToUse > 0) {
            entry.used = parseFloat(entry.used || 0) + clToUse;
            entry.monthly_available = Math.max(0, parseFloat(entry.monthly_available || 0) - clToUse);
          }

          updatedClDaysCharged = clToUse;
          updatedExtraLwpDays = parseFloat(updatedExtraLwpDays || 0) + lwpFromCl;
          balanceRowJson[leave.leave_type] = entry;
        }
      } else if (leave.leave_type !== 'LWP') {
        const remaining = getLeaveEntryRemaining(entry, leave.leave_type);
        const paidDays = Math.min(remaining, requestedDays);
        const lwpDays = requestedDays - paidDays;

        if (paidDays > 0) {
          entry.used = parseFloat(entry.used || 0) + paidDays;
          balanceRowJson[leave.leave_type] = entry;
        }

        updatedExtraLwpDays = parseFloat(updatedExtraLwpDays || 0) + lwpDays;
      }

      const updateBalanceQuery = `
        UPDATE wp_hrms_leave_balances 
        SET balance_json = ? 
        WHERE employee_id = ? AND year = ?
      `;
      await connection.query(updateBalanceQuery, [JSON.stringify(balanceRowJson), leave.employee_id, leaveYear]);
    }

    // 2. Update leave request approval fields
    const updateLeaveQuery = `
      UPDATE wp_hrms_leaves 
      SET hr_status = ?, hr_id = ?, hr_approved_at = NOW(), hr_rejection_reason = ?, status = ?, extra_lwp_days = ?, cl_days_charged = ?
      WHERE id = ?
    `;
    const finalStatus = status === 'approved' ? 'approved' : 'rejected';
    await connection.query(updateLeaveQuery, [
      status,
      hr.id,
      status === 'rejected' ? (reason || null) : null,
      finalStatus,
      updatedExtraLwpDays,
      updatedClDaysCharged,
      leaveId
    ]);

    let lwpDaysToRecord = 0;
    if (status === 'approved') {
      if (leave.leave_type === 'LWP') {
        lwpDaysToRecord = parseFloat(leave.leave_days || 0);
      } else if (updatedExtraLwpDays > 0) {
        lwpDaysToRecord = updatedExtraLwpDays;
      }

      if (lwpDaysToRecord > 0) {
        await addToNumericUserMetaValue(leave.employee_id, LWP_TOTAL_DAYS_META_KEY, lwpDaysToRecord, connection);
      }
    }

    // Commit changes
    await connection.commit();

    // 3. Notify administrator of the final HR decision for all leave request types
    if (shouldNotifyAdministratorForFinalDecision(status)) {
      const administratorEmails = await getAdministratorEmails();
      for (const adminEmail of administratorEmails) {
        await emailService.notifyHRForApproval(adminEmail, leave.employee_name, leave.employee_name, { ...leaveData, rejection_reason: reason });
      }
    }

    // 4. Send final confirmation/rejection email to Employee
    leaveData.extra_lwp_days = updatedExtraLwpDays;
    leaveData.cl_days_charged = updatedClDaysCharged;
    await emailService.notifyEmployeeStatus(leave.employee_email, leave.employee_name, leaveData, finalStatus);

    res.json({
      message: `HR ${status} leave request successfully.`,
      leave_id: leaveId,
      hr_status: status,
      hr_rejection_reason: status === 'rejected' ? (reason || null) : null,
      status: finalStatus
    });
  } catch (err) {
    await connection.rollback();
    console.error('approveHR error:', err);
    res.status(500).json({ error: 'Failed to process HR approval' });
  } finally {
    connection.release();
  }
};

// Check if compDate falls within the week of startDate or the next week
const isWithinCurrentOrNextWeek = (startDateStr, compDateStr) => {
  const start = new Date(startDateStr);
  const comp = new Date(compDateStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(comp.getTime())) return false;

  // Normalize to local dates
  const day = start.getDay(); // 0 (Sun) .. 6 (Sat)
  // Calculate Monday of current week
  const mondayOffset = (day === 0) ? -6 : 1 - day;
  const weekStart = new Date(start);
  weekStart.setDate(start.getDate() + mondayOffset);
  weekStart.setHours(0,0,0,0);

  const nextWeekEnd = new Date(weekStart);
  nextWeekEnd.setDate(weekStart.getDate() + 13); // two weeks inclusive (current + next week)
  nextWeekEnd.setHours(23,59,59,999);

  return comp >= weekStart && comp <= nextWeekEnd;
};