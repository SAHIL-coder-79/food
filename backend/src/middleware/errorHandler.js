const AppError = require('../utils/AppError');

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            status: 'error',
            message: err.message,
            details: err.details,
        });
    }

    if (err && err.code === '23505') {
        // Postgres unique_violation
        return res.status(409).json({ status: 'error', message: 'A record with these values already exists' });
    }

    // Request-body problems raised by express.json before any route runs.
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ status: 'error', message: 'Request body is not valid JSON' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ status: 'error', message: 'Request body is too large' });
    }

    // Postgres data exceptions (class 22: out-of-range number, bad date/text, string too long) and a reference to a
    // row that does not exist (23503) mean the caller sent something unusable, not that the server failed. The
    // database's own message is never returned.
    if (err && typeof err.code === 'string' && (err.code.startsWith('22') || err.code === '23503')) {
        return res.status(400).json({ status: 'error', message: 'One or more values are invalid' });
    }

    console.error('Unhandled error:', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong, please try again' });
};
