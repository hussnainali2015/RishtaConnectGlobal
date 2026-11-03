'use strict';
// Starts the site. If storage sync is configured, the saved database is restored first.
require('dotenv').config();
require('./persist').restore().then(msg => { if (msg !== 'off') console.log('Database: ' + msg); require('./server'); })
  .catch(e => { console.error('STOPPED: ' + e.message + '\nThe site did not start so that your saved data is not overwritten. Check PERSIST_SUPABASE_URL / PERSIST_SUPABASE_KEY and try again.'); process.exit(1); });
