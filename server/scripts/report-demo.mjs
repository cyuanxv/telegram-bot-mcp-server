import { composeReport } from '../lib/telegram/report-compose.ts';
import { dailySnapshot } from '../tests/report-compose-fixture.mjs';
// No inputs, environment lookups, source requests, persistence or transport.
console.log(JSON.stringify({ simulated: true, ...composeReport(dailySnapshot()) }, null, 2));
