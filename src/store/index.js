// Picks where data is saved:
//   - MySQL when MYSQL_URL (or MYSQL_HOST) is set  -> recommended for the live site
//   - otherwise local files in backend/data          -> fine on your own computer
// On Render's free plan local files are wiped on every restart, so set MYSQL_URL there.

const mysqlStore = require("./mysql");

const store = mysqlStore.isConfigured() ? mysqlStore : require("./local");

module.exports = store;
