function createHealthHandler(pool) {
    return async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch (error) {
            console.error('Health check database probe failed:', error.message);
            res.status(503).json({ status: 'unavailable' });
        }
    };
}

module.exports = { createHealthHandler };
