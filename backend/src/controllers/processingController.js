const pool = require('../models/db');
const AppError = require('../utils/AppError');
const { parseProductInput, parseBatchInput } = require('../validators/processingValidators');

// Products/batches always belong to the caller's own organization (from the verified JWT). Accounts
// without one (e.g. a system admin) must not create rows, which would be orphaned.
function requireOrganization(req) {
    if (!req.user.organizationId) {
        throw new AppError(403, 'This account is not associated with an organization');
    }
    return req.user.organizationId;
}

// Create a raw material or finished product
exports.createProduct = async (req, res, next) => {
    try {
        const kitchenOrgId = requireOrganization(req);
        const { name, unit, itemType, costPerUnit, preparationCostPerUnit } = parseProductInput(req.body);

        const result = await pool.query(
            `INSERT INTO menu_items (kitchen_org_id, name, unit, item_type, cost_per_unit, preparation_cost_per_unit)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [kitchenOrgId, name, unit, itemType, costPerUnit, preparationCostPerUnit]
        );

        res.status(201).json({
            status: 'success',
            data: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

// Get all products for the processing unit
exports.getProducts = async (req, res, next) => {
    try {
        const kitchenOrgId = req.user.organizationId;
        const result = await pool.query(
            'SELECT * FROM menu_items WHERE kitchen_org_id = $1 ORDER BY name ASC',
            [kitchenOrgId]
        );
        res.json({
            status: 'success',
            data: result.rows
        });
    } catch (error) {
        next(error);
    }
};

// Log a production batch
exports.logBatch = async (req, res, next) => {
    try {
        // Mapped onto daily_logs so forecasting, waste analytics and financial/environmental impact
        // all pick batches up without a parallel data model:
        // quantity_prepared = raw input, output_quantity = finished output,
        // quantity_leftover = rejects (waste), meal_slot = 'BATCH' (allowed by migration 010).
        const kitchenOrgId = requireOrganization(req);
        const { productId, logDate, input, output, rejects, batchNumber } = parseBatchInput(req.body);

        // product_id is client-supplied - verify it actually belongs to the caller's kitchen (and is
        // still active, as for regular daily logs) before writing a daily_logs row against it.
        const productCheck = await pool.query(
            'SELECT id FROM menu_items WHERE id = $1 AND kitchen_org_id = $2 AND is_active = true',
            [productId, kitchenOrgId]
        );
        if (productCheck.rows.length === 0) {
            return next(new AppError(404, 'Product not found'));
        }

        const mealSlot = 'BATCH'; // must match the daily_logs_meal_slot_check constraint

        const result = await pool.query(
            `INSERT INTO daily_logs
             (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, output_quantity, batch_number, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [productId, logDate, mealSlot, input, rejects, output, batchNumber, req.user.id]
        );

        res.status(201).json({
            status: 'success',
            data: result.rows[0]
        });
    } catch (error) {
        // Handle unique constraint violation
        if (error.code === '23505') {
            return next(new AppError(400, 'A batch for this product already exists on this date. Use a different date or product.'));
        }
        next(error);
    }
};

// Get batches (production logs only - regular kitchen meal logs are not batches)
exports.getBatches = async (req, res, next) => {
    try {
        const kitchenOrgId = req.user.organizationId;

        const query = `
            SELECT dl.*, mi.name as product_name, mi.item_type
            FROM daily_logs dl
            JOIN menu_items mi ON dl.menu_item_id = mi.id
            WHERE mi.kitchen_org_id = $1 AND dl.meal_slot = 'BATCH'
            ORDER BY dl.log_date DESC, dl.created_at DESC
        `;

        const result = await pool.query(query, [kitchenOrgId]);

        res.json({
            status: 'success',
            data: result.rows
        });
    } catch (error) {
        next(error);
    }
};
