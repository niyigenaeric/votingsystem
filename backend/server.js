require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db/connection');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT COUNT(*) AS students FROM students');
        res.json({
            message: 'Voting system backend is running',
            database: 'connected',
            students: rows[0].students
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Database connection failed' });
    }
});

app.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});