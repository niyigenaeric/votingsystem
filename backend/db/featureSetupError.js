function featureSetupMessage(error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
        return 'Database setup is incomplete. Back up your database, run npm run db:migrate from the backend folder, then restart the server.';
    }
    if (['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(error.code)) {
        return 'The application database account is missing table permissions. Ask your database administrator to apply the required grants from the README, then restart the server.';
    }
    return null;
}

module.exports = { featureSetupMessage };
