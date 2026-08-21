const formatValue = (value) => {
  if (value === null || value === undefined || value === '') {
    return 'Not set';
  }

  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return String(value);
};

const buildLeaveUpdateChangeSummary = (previousLeave = {}, updatedLeave = {}) => {
  const fields = [
    { key: 'leave_type', label: 'Leave type' },
    { key: 'start_date', label: 'Date range' },
    { key: 'end_date', label: 'Date range' },
    { key: 'reason', label: 'Reason' },
    { key: 'day_type', label: 'Day type' },
    { key: 'half_day_period', label: 'Half day period' },
    { key: 'compensate_date', label: 'Compensate date' },
  ];

  const changes = [];

  const previousStart = formatValue(previousLeave.start_date);
  const previousEnd = formatValue(previousLeave.end_date);
  const updatedStart = formatValue(updatedLeave.start_date);
  const updatedEnd = formatValue(updatedLeave.end_date);

  const previousLeaveType = formatValue(previousLeave.leave_type);
  const updatedLeaveType = formatValue(updatedLeave.leave_type);
  if (previousLeaveType !== updatedLeaveType) {
    changes.push(`Leave type: ${previousLeaveType} → ${updatedLeaveType}`);
  }

  if (previousStart !== updatedStart || previousEnd !== updatedEnd) {
    changes.push(`Date range: ${previousStart} to ${previousEnd} → ${updatedStart} to ${updatedEnd}`);
  }

  for (const field of fields) {
    if (field.key === 'leave_type' || field.key === 'start_date' || field.key === 'end_date') {
      continue;
    }
    if (field.key === 'start_date' || field.key === 'end_date') {
      continue;
    }

    const previousValue = formatValue(previousLeave[field.key]);
    const updatedValue = formatValue(updatedLeave[field.key]);

    if (previousValue !== updatedValue) {
      changes.push(`${field.label}: ${previousValue} → ${updatedValue}`);
    }
  }

  return changes;
};

module.exports = {
  buildLeaveUpdateChangeSummary,
};
