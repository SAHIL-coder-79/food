require('./config/env');
const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes');
const forecastRoutes = require('./routes/forecasts');
const financialImpactRoutes = require('./routes/financialImpactRoutes');
const simulationRoutes = require('./routes/simulationRoutes');
const learningRoutes = require('./routes/learningRoutes');
const processingRoutes = require('./routes/processingRoutes');
const rootCauseRoutes = require('./routes/rootCauses');
const preventionRoutes = require('./routes/prevention');
const rescuePriorityRoutes = require('./routes/rescuePriorities');
const foodQualityRoutes = require('./routes/foodQualityRoutes');
const donationLedgerRoutes = require('./routes/donationLedgerRoutes');
const rescueRouteRoutes = require('./routes/rescueRouteRoutes');
const rescueNotificationRoutes = require('./routes/rescueNotificationRoutes');
const messagingRoutes = require('./routes/messagingRoutes');
const errorHandler = require('./middleware/errorHandler');

const path = require('path');
const app = express();

app.disable('x-powered-by'); // do not advertise the framework

// Public routes for Meta App publishing requirements (Privacy, Terms, Data Deletion)
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/privacy.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/terms.html'));
});

app.get('/data-deletion', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/data-deletion.html'));
});

app.use(cors());
// API responses carry per-user data: never let a browser or proxy cache or sniff them.
app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
});
// 100kb comfortably covers every existing endpoint's JSON bodies; food-quality screening (base64 image data,
// see ai/foodQuality/service.js) is the one deliberate exception, needing a somewhat larger - but still small and
// bounded - limit. The service itself enforces a much smaller effective image size (~300 KB decoded); this is
// only the outer transport-level backstop.
// `verify` stashes the exact raw bytes Express received, alongside (not instead of) the normal parsed
// `req.body` - every existing JSON endpoint is completely unaffected. This exists solely so the Meta WhatsApp
// provider (integrations/messaging/metaProvider.js) can HMAC-verify X-Hub-Signature-256 against the ORIGINAL
// bytes Meta signed - re-serializing the parsed body is not guaranteed to be byte-identical (key order,
// whitespace, unicode escaping can all differ), which would make signature verification unreliable.
app.use(
    express.json({
        limit: '600kb',
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    })
);
// Routes
app.use('/api', apiRoutes); // health, auth, organizations, menu-items, daily-logs, surplus-listings, notifications
app.use('/api/forecasts', forecastRoutes);
app.use('/api/financial-impact', financialImpactRoutes);
app.use('/api/simulations', simulationRoutes);
app.use('/api/learning', learningRoutes);
app.use('/api/processing', processingRoutes);
app.use('/api/root-causes', rootCauseRoutes);
app.use('/api/prevention', preventionRoutes);
app.use('/api/rescue-priorities', rescuePriorityRoutes);
app.use('/api/food-quality', foodQualityRoutes);
app.use('/api/donations', donationLedgerRoutes);
app.use('/api/rescue-routes', rescueRouteRoutes);
app.use('/api/communications', rescueNotificationRoutes);
app.use('/api/messaging', messagingRoutes);

app.use((_req, res) => {
    res.status(404).json({ status: 'error', message: 'Not found' });
});

app.use(errorHandler);

module.exports = app;

