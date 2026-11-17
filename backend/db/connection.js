require('dotenv').config();
const mysql = require('mysql2/promise');

const sslEnabled = ['1', 'true', 'yes'].includes(String(process.env.DB_SSL || '').toLowerCase());
const connectionConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z'
};

if (sslEnabled) {
    connectionConfig.ssl = {
        rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false'
    };
    if (process.env.DB_CA_CERT) {
        connectionConfig.ssl.ca = process.env.DB_CA_CERT;
    }
}

const pool = mysql.createPool(connectionConfig);

module.exports = pool;