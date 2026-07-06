const pool = require('../config/database');
const { sendSuccess, sendError } = require('../utils/response');

const parseHolidayJson = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('[Holiday] Failed to parse holiday JSON:', err.message);
      return [];
    }
  }

  return [];
};

const normalizeHolidayRecord = (item) => {
  const date = item.date || item.holiday_date || item.holidayDate || null;
  const day = item.day || item.week_day || item.weekday || null;

  return {
    id: item.id || null,
    name: item.name || item.holiday_name || '',
    date: date ? String(date).slice(0, 10) : null,
    day: day || null,
  };
};

const getHolidayRecordsFromRows = (rows) => {
  return rows.map((row) => ({
    id: row.id,
    holiday_year: row.holiday_year,
    holidays: parseHolidayJson(row.holiday_json)
      .map(normalizeHolidayRecord)
      .filter((item) => item.name || item.date),
  }));
};

const getDateOnly = (value) => {
  if (!value) {
    return '';
  }

  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  return '';
};

const sortByDate = (a, b) => {
  if (!a.date && !b.date) {
    return 0;
  }
  if (!a.date) {
    return 1;
  }
  if (!b.date) {
    return -1;
  }
  return a.date.localeCompare(b.date);
};

exports.getHolidayList = async (req, res) => {
  try {
    const requestedYear = req.query.year || req.query.holiday_year;
    const currentYear = new Date().getFullYear();
    const yearToFetch = requestedYear || currentYear;

    const query = `
      SELECT id, holiday_year, holiday_json
      FROM wp_st_holiday_list
      WHERE holiday_year = ?
      ORDER BY id ASC
    `;

    const [rows] = await pool.query(query, [yearToFetch]);
    const holidayData = getHolidayRecordsFromRows(rows);

    const responseData = {
      year: yearToFetch,
      total: holidayData.length > 0 ? holidayData[0].holidays.length : 0,
      holidays: holidayData.length > 0 ? holidayData[0].holidays : [],
    };

    return sendSuccess(res, 200, responseData, 'Holiday list fetched successfully.');
  } catch (error) {
    console.error('[Holiday] Error fetching holiday list:', error);
    return sendError(res, 500, 'Failed to fetch holiday list.');
  }
};

exports.getAllHolidayLists = async (req, res) => {
  try {
    const query = `
      SELECT id, holiday_year, holiday_json
      FROM wp_st_holiday_list
      ORDER BY holiday_year DESC, id ASC
    `;

    const [rows] = await pool.query(query);
    const holidayData = getHolidayRecordsFromRows(rows);

    return sendSuccess(
      res,
      200,
      {
        totalYears: holidayData.length,
        holidaysByYear: holidayData,
      },
      'All holiday lists fetched successfully.'
    );
  } catch (error) {
    console.error('[Holiday] Error fetching all holiday lists:', error);
    return sendError(res, 500, 'Failed to fetch all holiday lists.');
  }
};

exports.getUpcomingHolidays = async (req, res) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
    const today = getDateOnly(req.query.date || new Date());

    const query = `
      SELECT id, holiday_year, holiday_json
      FROM wp_st_holiday_list
      ORDER BY holiday_year DESC, id ASC
    `;

    const [rows] = await pool.query(query);
    const holidayData = getHolidayRecordsFromRows(rows);

    const upcoming = holidayData
      .flatMap((row) =>
        row.holidays.map((holiday) => ({
          year: row.holiday_year,
          ...holiday,
        }))
      )
      .filter((holiday) => holiday.date && holiday.date >= today)
      .sort(sortByDate)
      .slice(0, limit);

    return sendSuccess(
      res,
      200,
      {
        today,
        limit,
        total: upcoming.length,
        holidays: upcoming,
      },
      'Upcoming holidays fetched successfully.'
    );
  } catch (error) {
    console.error('[Holiday] Error fetching upcoming holidays:', error);
    return sendError(res, 500, 'Failed to fetch upcoming holidays.');
  }
};
