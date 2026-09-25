const { body, idParam, textField, number } = require('./common');

const COST_MESSAGE = 'must be a non-negative number';

const createValidators = [
    textField(body('name'), 'Name', 255),
    textField(body('unit'), 'Unit', 50),
    number(body('costPerUnit').optional(), 'costPerUnit', { message: `costPerUnit ${COST_MESSAGE}` }),
    number(body('preparationCostPerUnit').optional(), 'preparationCostPerUnit', { message: `preparationCostPerUnit ${COST_MESSAGE}` }),
];

const updateValidators = [
    idParam('menu item id'),
    textField(body('name').optional(), 'Name', 255),
    textField(body('unit').optional(), 'Unit', 50),
    number(body('costPerUnit').optional(), 'costPerUnit', { message: `costPerUnit ${COST_MESSAGE}` }),
    number(body('preparationCostPerUnit').optional(), 'preparationCostPerUnit', { message: `preparationCostPerUnit ${COST_MESSAGE}` }),
];

const idParamValidator = [idParam('menu item id')];

module.exports = { createValidators, updateValidators, idParamValidator };
