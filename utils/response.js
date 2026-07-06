const sendSuccess = (res, statusCode = 200, data = null, message = null) => {
  const response = { success: true };

  if (message) {
    response.message = message;
  }

  if (data !== null) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
};

const sendError = (res, statusCode = 500, message = 'Something went wrong') => {
  return res.status(statusCode).json({
    success: false,
    error: message,
  });
};

module.exports = {
  sendSuccess,
  sendError,
};
