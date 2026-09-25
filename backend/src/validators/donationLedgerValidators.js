const { idParam } = require('./common');

const listingIdParamValidator = [idParam('surplus listing id', 'listingId')];

module.exports = { listingIdParamValidator };
