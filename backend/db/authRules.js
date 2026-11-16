function requiresSecondFactor(role) {
    return role === 'admin' || role === 'auditor';
}

module.exports = { requiresSecondFactor };
