// controllers/timeTrackingController.js
const pool = require('../config/database');
const { canAccessTargetUser } = require('../middlewares/auth');

const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

const parseUtcDate = (dateStr) => new Date(`${dateStr}T00:00:00Z`);

const formatDateOnly = (date) => date.toISOString().slice(0, 10);

/**
 * Returns the Monday on/before the given date (same date if it's already Monday).
 */
const getMondayOnOrBefore = (dateStr) => {
  const date = parseUtcDate(dateStr);
  const day = date.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const diffFromMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - diffFromMonday);
  return formatDateOnly(monday);
};

/**
 * Builds an inclusive array of YYYY-MM-DD strings from start to end.
 */
const buildDateRange = (startStr, endStr) => {
  const dates = [];
  const cursor = parseUtcDate(startStr);
  const end = parseUtcDate(endStr);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(formatDateOnly(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
};

/**
 * GET /api/time-tracking/weekly-hours?date=YYYY-MM-DD&employee_id=123
 *
 * Returns total tracked hours from the given date back to its previous Monday
 * (inclusive of both ends), pulled from wp_hubstaff_daily_activity.daily_time_tracking_data.
 */
exports.getWeeklyHoursUpToDate = async (req, res) => {
  try {
    const requester = req.user;
    const dateParam = req.query.date;

    if (!dateParam || !isValidDateString(dateParam)) {
      return res.status(400).json({ error: "A valid 'date' query parameter (YYYY-MM-DD) is required." });
    }

    const requestedEmployeeId = req.query.employee_id || req.query.user_id;
    let targetEmployeeId = requestedEmployeeId ? parseInt(requestedEmployeeId, 10) : requester.id;
    if (Number.isNaN(targetEmployeeId)) {
      targetEmployeeId = requester.id;
    }

    if (targetEmployeeId !== requester.id) {
      const [metaRows] = await pool.query(
        `SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'st_reports_to'`,
        [targetEmployeeId]
      );
      const managerId = metaRows[0] ? parseInt(metaRows[0].meta_value, 10) : null;

      if (!canAccessTargetUser(requester, targetEmployeeId, managerId)) {
        return res.status(403).json({ error: 'Access denied: You can only view your own or your direct reports\' tracked hours.' });
      }
    }

    const weekStart = getMondayOnOrBefore(dateParam);
    const weekEnd = dateParam;
    const dateRange = buildDateRange(weekStart, weekEnd);

    // Group requested dates by (year, month-abbr) since rows are stored per user/year/month
    const periodsMap = new Map(); // key: "2026-jun" -> Set of dates
    for (const d of dateRange) {
      const dateObj = parseUtcDate(d);
      const year = dateObj.getUTCFullYear();
      const month = MONTH_ABBR[dateObj.getUTCMonth()];
      const key = `${year}-${month}`;
      if (!periodsMap.has(key)) {
        periodsMap.set(key, { year, month, dates: new Set() });
      }
      periodsMap.get(key).dates.add(d);
    }

    const periods = Array.from(periodsMap.values());

    let rows = [];
    if (periods.length > 0) {
      const whereClauses = periods.map(() => '(year = ? AND month = ?)').join(' OR ');
      const params = [targetEmployeeId];
      periods.forEach((p) => {
        params.push(p.year, p.month);
      });

      const query = `
        SELECT year, month, daily_time_tracking_data
        FROM wp_hubstaff_daily_activity
        WHERE user_id = ? AND (${whereClauses})
      `;
      [rows] = await pool.query(query, params);
    }

    // Build a date -> day-entry lookup from all fetched rows
    const dayDataByDate = {};
    for (const row of rows) {
      let parsed;
      try {
        parsed = typeof row.daily_time_tracking_data === 'string'
          ? JSON.parse(row.daily_time_tracking_data)
          : row.daily_time_tracking_data;
      } catch (parseErr) {
        console.error(`Failed to parse daily_time_tracking_data for user ${targetEmployeeId}, ${row.year}-${row.month}:`, parseErr);
        continue;
      }
      if (parsed && typeof parsed === 'object') {
        Object.assign(dayDataByDate, parsed);
      }
    }

    let totalHours = 0;
    let totalActiveHours = 0;
    let totalIdleHours = 0;
    let totalDiscussionHours = 0;
    let daysWithDataCount = 0;

    const days = dateRange.map((d) => {
      const entry = dayDataByDate[d];
      if (!entry) {
        return {
          date: d,
          found: false,
          total_hours: 0,
          active_hours: 0,
          idle_hours: 0,
          discussion_hours: 0,
        };
      }

      const dayTotalHours = parseFloat(entry.total_hours) || 0;
      const dayActiveHours = parseFloat(entry.active_hours) || 0;
      const dayIdleHours = parseFloat(entry.idle_hours) || 0;
      const dayDiscussionHours = parseFloat(entry.discussion_hours) || 0;

      totalHours += dayTotalHours;
      totalActiveHours += dayActiveHours;
      totalIdleHours += dayIdleHours;
      totalDiscussionHours += dayDiscussionHours;
      daysWithDataCount += 1;

      return {
        date: d,
        found: true,
        total_hours: dayTotalHours,
        active_hours: dayActiveHours,
        idle_hours: dayIdleHours,
        discussion_hours: dayDiscussionHours,
      };
    });

    const round2 = (n) => Math.round(n * 100) / 100;

    return res.json({
      employee_id: targetEmployeeId,
      requested_date: dateParam,
      week_start: weekStart,
      week_end: weekEnd,
      total_hours: round2(totalHours),
      total_active_hours: round2(totalActiveHours),
      total_idle_hours: round2(totalIdleHours),
      total_discussion_hours: round2(totalDiscussionHours),
      days_with_data: daysWithDataCount,
      //days,
    });
  } catch (err) {
    console.error('getWeeklyHoursUpToDate error:', err);
    return res.status(500).json({ error: 'Failed to retrieve tracked hours.' });
  }
};