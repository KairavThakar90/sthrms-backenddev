const errorHandler = (err, req, res, next) => {
  console.error('[Global Error Handler]', err);

  const statusCode = err.statusCode || 500;
  const message = err.message || 'An internal server error occurred';

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = errorHandler;
