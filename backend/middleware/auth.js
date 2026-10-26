const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
    const cookieHeader = req.headers.cookie || '';
    const sessionCookie = cookieHeader.split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('voting_session='));
    const token = sessionCookie ? sessionCookie.slice('voting_session='.length) : null;
    if (!token) return res.status(401).json({ message: 'Authentication required' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Access denied' });
        }
        next();
    };
}

module.exports = { verifyToken, requireRole };