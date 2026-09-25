const express = require('express');
const router = express.Router();
const pool = require('../models/db');

router.get('/health', async (req, res) => {
    try {
        // Test database connection
        await pool.query('SELECT 1');
        res.status(200).json({ status: 'ok', database: 'connected' });
    } catch (error) {
        console.error('Database connection error:', error);
        // The database's own message can name hosts and credentials' context: keep it in the log, not the response.
        res.status(503).json({ status: 'error', database: 'disconnected' });
    }
});

module.exports = router;
