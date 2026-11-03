'use strict';
// Starts the site. If storage sync is configured, the saved database is restored first.
require('dotenv').config();
const persist = require('./persist'); persist.cleanEnv();
persist.restore().then(msg => { if (msg !== 'off') console.log('Database: ' + msg); require('./server'); })
  .catch(e => { console.error('STOPPED: ' + e.message + '\nThe site did not start so that your saved data is not overwritten. Fix the setting named above in the Render Environment tab, then deploy again.'); process.exit(1); });
