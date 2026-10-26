require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const pool = require('./db/connection');
const { closeExpiredPositions } = require('./db/election');

const app = express();
const frontendDir = path.join(__dirname, '..', 'frontend');
const uploadsDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads', 'candidates'));
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change_this_to_a_long_random_text' || jwtSecret.length < 32
    || /^(replace|change|your|example|placeholder)/i.test(jwtSecret)) {
    throw new Error('JWT_SECRET must be a unique secret of at least 32 characters.');
}
if (process.env.NODE_ENV === 'production' && !process.env.UPLOAD_DIR) {
    throw new Error('Set UPLOAD_DIR to a persistent disk path in production.');
}
if (process.env.NODE_ENV === 'production' && !process.env.SMTP_HOST) {
    throw new Error('Configure SMTP_HOST before running in production.');
}
app.disable('x-powered-by');
app.use((req, res, next) => {
    const nonce = crypto.randomBytes(18).toString('base64');
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
    });
    res.locals.cspNonce = nonce;
    if (process.env.NODE_ENV === 'production') {
        res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || (process.env.NODE_ENV === 'production' ? 1 : 0));
if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
}
if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && !req.secure) {
        return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    }
    next();
});
app.use('/api', require('express-rate-limit')({ windowMs: 60 * 1000, limit: 200 }));
app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    const host = req.get('host');
    if (!origin || !host) return res.status(403).json({ message: 'Request origin could not be verified' });
    try {
        if (new URL(origin).host !== host) return res.status(403).json({ message: 'Cross-origin request denied' });
    } catch {
        return res.status(403).json({ message: 'Request origin is invalid' });
    }
    next();
});
app.use(cors({ origin: false }));
app.use(express.json({ limit: '100kb' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth', require('./routes/activation'));
app.use('/api/admin', require('./routes/adminVoters'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin', require('./routes/candidates'));
app.use('/api/voter', require('./routes/voter'));
app.use('/api/admin/audit', require('./routes/audit'));

app.get('/api/health', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT COUNT(*) AS students FROM students');
        res.json({ message: 'Voting system backend is running', database: 'connected', students: rows[0].students });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Database connection failed' });
    }
});

app.use('/uploads/candidates', express.static(uploadsDir));
async function serveHtml(fileName, req, res, next) {
    const file = path.resolve(frontendDir, path.basename(fileName));
    if (!file.startsWith(frontendDir + path.sep)) return next();
    try {
        const html = await fs.readFile(file, 'utf8');
        const nonce = res.locals.cspNonce;
        res.set('Cache-Control', 'no-store, private');
        const securedHtml = html.replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
        res.type('html').send(securedHtml);
    } catch (error) {
        if (error.code === 'ENOENT') return next();
        next(error);
    }
}

function requirePageRole(...roles) {
    return (req, res, next) => {
        const cookie = (req.headers.cookie || '').split(';')
            .map(value => value.trim())
            .find(value => value.startsWith('voting_session='));
        if (!cookie) return res.redirect(303, '/');
        try {
            const user = jwt.verify(cookie.slice('voting_session='.length), jwtSecret);
            if (!roles.includes(user.role)) return res.redirect(303, '/');
            next();
        } catch {
            res.redirect(303, '/');
        }
    };
}

app.get('/', (req, res, next) => serveHtml('index.html', req, res, next));
app.get('/admin.html', requirePageRole('admin', 'auditor'), (req, res, next) => serveHtml('admin.html', req, res, next));
app.get('/candidate.html', requirePageRole('admin'), (req, res, next) => serveHtml('candidate.html', req, res, next));
app.get('/position.html', requirePageRole('admin', 'auditor'), (req, res, next) => serveHtml('position.html', req, res, next));
app.get('/vote.html', requirePageRole('voter'), (req, res, next) => serveHtml('vote.html', req, res, next));
app.get(['/index.html', '/activate.html'], (req, res, next) => serveHtml(req.path, req, res, next));
app.use(express.static(frontendDir));

const port = Number(process.env.PORT || 5000);
const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
closeExpiredPositions().catch(error => console.error('Startup position close failed:', error.message));
const expiryTimer = setInterval(() => {
    closeExpiredPositions().catch(error => console.error('Scheduled position close failed:', error.message));
}, 15 * 1000);
expiryTimer.unref();
server.on('close', () => clearInterval(expiryTimer));