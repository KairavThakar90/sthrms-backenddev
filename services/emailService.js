// services/emailService.js
const nodemailer = require('nodemailer');
const pool = require('../config/database');
const { buildLeaveUpdateChangeSummary } = require('../utils/leaveChangeSummary');
require('dotenv').config();

// Create nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
  port: parseInt(process.env.SMTP_PORT, 10) || 2525,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

// Helper to generate a clean, modern HTML wrapper for email notifications
const getHtmlTemplate = (title, content) => {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
          background-color: #f4f6f9;
          margin: 0;
          padding: 0;
          color: #333333;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          background-color: #ffffff;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
        }
        .header {
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          padding: 30px 20px;
          text-align: center;
          color: #ffffff;
        }
        .header h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
        }
        .content {
          padding: 30px 40px;
          line-height: 1.6;
        }
        .footer {
          background-color: #f9fafb;
          padding: 20px;
          text-align: center;
          font-size: 12px;
          color: #6b7280;
          border-top: 1px solid #f3f4f6;
        }
        .badge {
          display: inline-block;
          padding: 6px 12px;
          border-radius: 9999px;
          font-size: 14px;
          font-weight: 600;
          text-transform: capitalize;
        }
        .badge-pending { background-color: #fef3c7; color: #d97706; }
        .badge-approved { background-color: #d1fae5; color: #065f46; }
        .badge-rejected { background-color: #fee2e2; color: #991b1b; }
        .badge-partially { background-color: #e0e7ff; color: #3730a3; }
        .details-table {
          width: 100%;
          border-collapse: collapse;
          margin: 20px 0;
        }
        .details-table td {
          padding: 10px 12px;
          border-bottom: 1px solid #f3f4f6;
        }
        .details-table td.label {
          font-weight: 600;
          color: #4b5563;
          width: 35%;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${title}</h1>
        </div>
        <div class="content">
          ${content}
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} ST HRMS Leave Management. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;
};

/**
 * Format Date helper.
 */
const formatDate = (dateStr) => {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
};

/**
 * Format Duration helper.
 */
const getDurationText = (leave) => {
  const dateText = leave.start_date === leave.end_date 
    ? formatDate(leave.start_date)
    : `${formatDate(leave.start_date)} to ${formatDate(leave.end_date)}`;
    
  if (leave.day_type === 'half_day') {
    const periodText = leave.half_day_period === 'first_half' ? 'First Half' : 'Second Half';
    return `${dateText} (Half Day - ${periodText})`;
  }
  
  return `${dateText} (${leave.days} Day(s))`;
};

const crypto = require('crypto');
const DEFAULT_APP_BASE_URL = process.env.APP_BASE_URL || (process.env.APP_URL || 'http://localhost:3000');

const buildLeaveNotificationSubject = ({ recipientType, event }) => {
  const subjectMap = {
    employee: {
      submitted: 'Leave Request Submitted Successfully',
      hr_approved: 'Leave Request Approved',
      hr_rejected: 'Leave Request Rejected by HR',
      leader_rejected: 'Leave Request Rejected by Leader',
      updated: 'Leave Request Updated'
    },
    leader: {
      submitted: 'New Leave Request Submitted – Level 1 Approval Required',
      hr_approved: 'Leave Request Approved by HR',
      hr_rejected: 'Leave Request Rejected by HR'
    },
    hr: {
      submitted: 'New Leave Request Submitted',
      leader_approved: 'Leave Request Approved by Leader – Level 2 Approval Required',
      leader_rejected: 'Leave Request Rejected by Leader',
      hr_approved: 'Leave Request Approved by HR',
      hr_rejected: 'Leave Request Rejected by HR'
    },
    cc: {
      submitted: 'New Leave Request Submitted',
      leader_approved: 'Leave Request Approved by Leader',
      leader_rejected: 'Leave Request Rejected by Leader',
      hr_approved: 'Leave Request Approved by HR',
      hr_rejected: 'Leave Request Rejected by HR'
    }
  };

  return subjectMap[recipientType]?.[event] || 'Leave Request Update';
};

const getConfiguredActionBaseUrl = async () => {
  try {
    const [rows] = await pool.query('SELECT option_value FROM wp_options WHERE option_name = ? LIMIT 1', ['st_frontend_url_hrml']);
    const configuredUrl = rows[0] && typeof rows[0].option_value === 'string'
      ? rows[0].option_value.trim()
      : '';

    if (configuredUrl) {
      return configuredUrl.replace(/\/+$/, '');
    }
  } catch (error) {
    console.warn('[Email Service] Failed to read frontend URL option, falling back to default base URL:', error.message);
  }

  return DEFAULT_APP_BASE_URL.replace(/\/+$/, '');
};

const generateActionToken = (payload, expiresMinutes = 60 * 24) => {
  const secret = process.env.JWT_SECRET || 'secret';
  const exp = Math.floor(Date.now() / 1000) + expiresMinutes * 60;
  const data = { ...payload, exp };
  const dataStr = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(dataStr).digest('base64url');
  return `${dataStr}.${sig}`;
};

const getWarningCcEmails = () => {
  const ccList = process.env.EMAIL_CC_ADDRESSES || '';

  if (!ccList) {
    return [];
  }

  return ccList
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
};

const buildActionLink = async (leaveId, decision) => {
  const baseUrl = await getConfiguredActionBaseUrl();
  const url = new URL(`${baseUrl}/leaves/${leaveId}/action`);
  url.searchParams.set('decision', decision);
  return url.toString();
};

/**
 * Send an email using nodemailer.
 */
const sendEmail = async (to, subject, html) => {
  try {
    const warningCcEmails = getWarningCcEmails();
    const cc = warningCcEmails.length > 0 ? warningCcEmails : undefined;

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || 'hrms@example.com',
      to,
      cc,
      subject,
      html
    });
    console.log(`[Email Service] Email sent: ${info.messageId} to ${to}`);
    return true;
  } catch (error) {
    console.error('[Email Service] Error sending email:', error);
    return false;
  }
};

/**
 * Notify Employee that their leave request was received and is pending review.
 */
const notifyEmployeeRequestReceived = async (employeeEmail, employeeName, leave) => {
  const subject = buildLeaveNotificationSubject({ recipientType: 'employee', event: 'submitted' });
  const statusBadge = `<span class="badge badge-pending">Submitted - Pending Review</span>`;

  const content = `
    <p>Hello ${employeeName},</p>
    <p>Your leave request has been submitted successfully and is now pending review.</p>

    <table class="details-table">
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type_full || leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Reason</td>
        <td>${leave.reason}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
    </table>

    <p>You will be notified once your request is approved or rejected.</p>
    <p>Thank you,</p>
    <p><strong>ST HRMS Leave Management System</strong></p>
  `;

  return sendEmail(employeeEmail, subject, getHtmlTemplate('Leave Request Submitted', content));
};

/**
 * Notify Employee that their leave request was updated and is pending review.
 */
const notifyEmployeeLeaveUpdated = async (employeeEmail, employeeName, leave) => {
  const subject = buildLeaveNotificationSubject({ recipientType: 'employee', event: 'updated' });
  const statusBadge = `<span class="badge badge-pending">Updated - Pending Review</span>`;
  const changeSummary = leave.change_summary || [];
  const changeRows = changeSummary.length > 0
    ? changeSummary.map((item) => `<tr><td class="label">Change</td><td>${item}</td></tr>`).join('')
    : '<tr><td class="label">Change</td><td>No detailed changes were provided.</td></tr>';

  const content = `
    <p>Hello ${employeeName},</p>
    <p>Your leave request has been updated successfully and is now pending re-review.</p>

    <table class="details-table">
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type_full || leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Reason</td>
        <td>${leave.reason}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
      ${changeRows}
    </table>

    <p>Your updated request will be reviewed again by the relevant approver.</p>
    <p>Thank you,</p>
    <p><strong>ST HRMS Leave Management System</strong></p>
  `;

  return sendEmail(employeeEmail, subject, getHtmlTemplate('Leave Request Updated', content));
};

/**
 * Notify HR that a new leave request has been submitted and is awaiting review.
 */
const notifyHRNewLeaveRequest = async (hrEmail, employeeName, leaderName, leave) => {
  const subject = buildLeaveNotificationSubject({ recipientType: 'hr', event: 'submitted' });
  const statusBadge = `<span class="badge badge-pending">Pending Leader / HR Review</span>`;

  const content = `
    <p>Hello HR Team,</p>
    <p><strong>${employeeName}</strong> has submitted a new leave request and it is now pending review.</p>

    <table class="details-table">
      <tr>
        <td class="label">Employee</td>
        <td>${employeeName}</td>
      </tr>
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type_full || leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Reason</td>
        <td>${leave.reason}</td>
      </tr>
      <tr>
        <td class="label">Assigned Leader</td>
        <td>${leaderName || 'Not assigned yet'}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
    </table>

    <p>Please review this request in the HRMS dashboard.</p>
  `;

  return sendEmail(hrEmail, subject, getHtmlTemplate('New Leave Request Submitted', content));
};

/**
 * Notify Leader that their direct report updated a leave request (Level 1 Review Required).
 */
const notifyLeaderLeaveUpdated = async (leaderEmail, employeeName, leave) => {
  const subject = `Leave Update Needed: ${employeeName}`;
  const statusBadge = `<span class="badge badge-pending">Updated - Pending Leader Approval</span>`;
  const changeSummary = leave.change_summary || [];
  const changeRows = changeSummary.length > 0
    ? changeSummary.map((item) => `<tr><td class="label">Change</td><td>${item}</td></tr>`).join('')
    : '<tr><td class="label">Change</td><td>No detailed changes were provided.</td></tr>';

  const content = `
    <p>Hello,</p>
    <p><strong>${employeeName}</strong> has updated their leave request and it is awaiting your review.</p>

    <table class="details-table">
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type_full || leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Reason</td>
        <td>${leave.reason}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
      ${changeRows}
    </table>

    <p>Please review the updated request in the HRMS dashboard.</p>
  `;

  return sendEmail(leaderEmail, subject, getHtmlTemplate('Leave Request Updated', content));
};

/**
 * Notify Leader that their direct report applied for leave (Level 1 Review Required).
 */
const notifyLeaderForApproval = async (leaderEmail, employeeName, leave) => {
  const subject = buildLeaveNotificationSubject({ recipientType: 'leader', event: 'submitted' });
  const statusBadge = `<span class="badge badge-pending">Pending Leader Approval</span>`;
  
  const approveLink = await buildActionLink(leave.id, 'approved');
  const rejectLink = await buildActionLink(leave.id, 'rejected');

  const content = `
    <p>Hello,</p>
    <p><strong>${employeeName}</strong> has applied for leave and is awaiting your Level 1 approval.</p>
    
    <table class="details-table">
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Reason</td>
        <td>${leave.reason}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
    </table>
    
    <p>
      <a href="${approveLink}" style="display:inline-block;padding:12px 18px;background:#10b981;color:#fff;border-radius:6px;margin-right:8px;text-decoration:none;">Approve</a>
      <a href="${rejectLink}" style="display:inline-block;padding:12px 18px;background:#ef4444;color:#fff;border-radius:6px;text-decoration:none;">Reject</a>
    </p>
    <p style="margin-top:12px;font-size:13px;color:#6b7280">Or log in to the HRMS Dashboard to review and add a rejection reason if needed.</p>
  `;
  
  return sendEmail(leaderEmail, subject, getHtmlTemplate('Leave Request Pending Approval', content));
};

/**
 * Notify HR that an updated leave request is awaiting review.
 */
const notifyHRLeaveUpdated = async (hrEmail, employeeName, leaderName, leave) => {
  const subject = 'Leave Request Updated';
  const statusBadge = `<span class="badge badge-pending">Updated - Pending Review</span>`;
  const changeSummary = leave.change_summary || [];
  const changeRows = changeSummary.length > 0
    ? changeSummary.map((item) => `<tr><td class="label">Change</td><td>${item}</td></tr>`).join('')
    : '<tr><td class="label">Change</td><td>No detailed changes were provided.</td></tr>';

  const content = `
    <p>Hello HR Team,</p>
    <p><strong>${employeeName}</strong> has updated a leave request and it is now pending review.</p>

    <table class="details-table">
      <tr>
        <td class="label">Employee</td>
        <td>${employeeName}</td>
      </tr>
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type_full || leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Reason</td>
        <td>${leave.reason}</td>
      </tr>
      <tr>
        <td class="label">Assigned Leader</td>
        <td>${leaderName || 'Not assigned yet'}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
      ${changeRows}
    </table>

    <p>Please review the updated request in the HRMS dashboard.</p>
  `;

  return sendEmail(hrEmail, subject, getHtmlTemplate('Leave Request Updated', content));
};

/**
 * Notify HR that a request has been approved by the Leader (Level 2 Review Required).
 */
const notifyHRForApproval = async (hrEmail, employeeName, approvingPartyName, leave, isFinalApproval = false, decision = 'approved') => {
  const subject = decision === 'rejected'
    ? buildLeaveNotificationSubject({ recipientType: 'hr', event: 'leader_rejected' })
    : buildLeaveNotificationSubject({ recipientType: 'hr', event: 'leader_approved' });

  const isRejected = decision === 'rejected';
  const statusBadge = isRejected
    ? `<span class="badge badge-rejected">Rejected</span>`
    : (isFinalApproval
      ? `<span class="badge badge-partially">Pending Final Approval</span>`
      : `<span class="badge badge-partially">Leader Approved (Pending HR)</span>`);
  
  const approveLink = await buildActionLink(leave.id, 'approved');
  const rejectLink = await buildActionLink(leave.id, 'rejected');

  const introText = isRejected
    ? `<p><strong>${employeeName}</strong>'s leave request has been rejected by their Leader (<strong>${approvingPartyName}</strong>).</p>`
    : (isFinalApproval
      ? `<p><strong>${employeeName}</strong>'s leave request is now awaiting your final approval.</p>`
      : `<p><strong>${employeeName}</strong>'s leave request has been approved by their Leader (<strong>${approvingPartyName}</strong>) and is now awaiting your Level 2 final approval.</p>`);

  const approverRowLabel = isRejected ? 'Rejected By' : (isFinalApproval ? 'Submitted By' : 'Approved By');
  const approverRowValue = isRejected ? `${approvingPartyName} (Leader)` : (isFinalApproval ? approvingPartyName : `${approvingPartyName} (Leader)`);
  const emailTitle = isRejected ? 'Leave Request Rejected by Leader' : (isFinalApproval ? 'Leave Request Pending Final Approval' : 'Level 1 Leave Approved');

  const content = `
    <p>Hello HR Team,</p>
    ${introText}
    
    <table class="details-table">
      <tr>
        <td class="label">Employee</td>
        <td>${employeeName}</td>
      </tr>
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">${approverRowLabel}</td>
        <td>${approverRowValue}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
    </table>
    
    ${isRejected ? '' : `<p>
      <a href="${approveLink}" style="display:inline-block;padding:12px 18px;background:#10b981;color:#fff;border-radius:6px;margin-right:8px;text-decoration:none;">Approve</a>
      <a href="${rejectLink}" style="display:inline-block;padding:12px 18px;background:#ef4444;color:#fff;border-radius:6px;text-decoration:none;">Reject</a>
    </p>`}
    <p style="margin-top:12px;font-size:13px;color:#6b7280">Or log in to the HRMS Dashboard to process and add a rejection reason if needed.</p>
  `;
  
  return sendEmail(hrEmail, subject, getHtmlTemplate(emailTitle, content));
};

/**
 * Notify Employee of the final outcome of their leave application (Approved or Rejected).
 */
const notifyLeaderDecisionOutcome = async (leaderEmail, employeeName, leave, finalStatus) => {
  const subject = finalStatus === 'approved'
    ? buildLeaveNotificationSubject({ recipientType: 'leader', event: 'hr_approved' })
    : buildLeaveNotificationSubject({ recipientType: 'leader', event: 'hr_rejected' });

  const statusBadge = finalStatus === 'approved'
    ? `<span class="badge badge-approved">Approved</span>`
    : `<span class="badge badge-rejected">Rejected</span>`;

  const statusText = finalStatus === 'approved'
    ? `HR has approved the leave request for <strong>${employeeName}</strong>.`
    : `HR has rejected the leave request for <strong>${employeeName}</strong>.`;

  const content = `
    <p>Hello,</p>
    <p>${statusText}</p>

    <table class="details-table">
      <tr>
        <td class="label">Employee</td>
        <td>${employeeName}</td>
      </tr>
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
    </table>
  `;

  return sendEmail(leaderEmail, subject, getHtmlTemplate(finalStatus === 'approved' ? 'Leave Request Approved by HR' : 'Leave Request Rejected by HR', content));
};

const notifyEmployeeStatus = async (employeeEmail, employeeName, leave, finalStatus, actorRole = 'hr', actorName = 'HR') => {
  const subject = finalStatus === 'approved'
    ? buildLeaveNotificationSubject({ recipientType: 'employee', event: 'hr_approved' })
    : actorRole === 'leader'
      ? buildLeaveNotificationSubject({ recipientType: 'employee', event: 'leader_rejected' })
      : buildLeaveNotificationSubject({ recipientType: 'employee', event: 'hr_rejected' });
  
  let statusBadge = '';
  let statusText = '';
  if (finalStatus === 'approved') {
    statusBadge = `<span class="badge badge-approved">Approved</span>`;
    statusText = `Congratulations! Your leave request has been fully approved by both your Leader and HR. Your leave balance has been updated accordingly.`;
  } else if (actorRole === 'leader') {
    statusBadge = `<span class="badge badge-rejected">Rejected</span>`;
    statusText = `We regret to inform you that your leave request has been rejected by your Leader.`;
  } else {
    statusBadge = `<span class="badge badge-rejected">Rejected</span>`;
    statusText = `We regret to inform you that your leave request has been rejected by HR.`;
  }
  
  let rejectionReasonRow = '';
  if (finalStatus === 'rejected' && leave.rejection_reason) {
    rejectionReasonRow = `
      <tr>
        <td class="label">Rejection Reason</td>
        <td style="color: #991b1b; font-weight: bold;">${leave.rejection_reason}</td>
      </tr>
    `;
  }
  
  const content = `
    <p>Hello ${employeeName},</p>
    <p>${statusText}</p>
    
    <table class="details-table">
      <tr>
        <td class="label">Leave Type</td>
        <td>${leave.leave_type}</td>
      </tr>
      <tr>
        <td class="label">Duration</td>
        <td>${getDurationText(leave)}</td>
      </tr>
      <tr>
        <td class="label">Reason</td>
        <td>${leave.reason}</td>
      </tr>
      <tr>
        <td class="label">Status</td>
        <td>${statusBadge}</td>
      </tr>
      ${rejectionReasonRow}
    </table>
    
    <p>Thank you,</p>
    <p><strong>ST HRMS Leave Management System</strong></p>
  `;
  
  return sendEmail(employeeEmail, subject, getHtmlTemplate(`Leave Request ${finalStatus.toUpperCase()}`, content));
};

module.exports = {
  buildActionLink,
  buildLeaveNotificationSubject,
  notifyEmployeeRequestReceived,
  notifyEmployeeLeaveUpdated,
  notifyHRNewLeaveRequest,
  notifyLeaderForApproval,
  notifyLeaderLeaveUpdated,
  notifyHRForApproval,
  notifyHRLeaveUpdated,
  notifyLeaderDecisionOutcome,
  notifyEmployeeStatus
};
