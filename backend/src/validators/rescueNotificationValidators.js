const { idParam } = require('./common');

const notifyValidators = [idParam('surplus listing id', 'listingId')];

module.exports = { notifyValidators };
