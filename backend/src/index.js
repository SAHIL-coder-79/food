const env = require('./config/env');
const app = require('./app');

app.listen(env.port, '0.0.0.0', () => {
    console.log(`Server is running on port ${env.port}`);
});
