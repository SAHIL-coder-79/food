const { query, idParam, paginationQuery } = require('./common');

const listValidators = [
    query('unreadOnly').optional().isIn(['true', 'false']).withMessage('unreadOnly must be "true" or "false"'),
    ...paginationQuery,
];

const idParamValidator = [idParam('notification id')];

module.exports = { listValidators, idParamValidator };
