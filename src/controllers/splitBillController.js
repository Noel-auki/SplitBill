const { pool } = require('../config/db');
const { completeOrder } = require('@butler/order-engine/src/utils/order');

/**
 * Validates the split bill request parameters
 */
const validateSplitRequest = (body) => {
  const { tableId, orderId, splitType } = body;

  if (!tableId || !orderId || !splitType) {
    throw new Error('tableId, orderId, and splitType are required');
  }

  if (!['portion', 'percentage'].includes(splitType)) {
    throw new Error('splitType must be either "portion" or "percentage"');
  }

  if (splitType === 'portion') {
    const { count } = body;
    if (!count || count < 1 || !Number.isInteger(count)) {
      throw new Error('For portion split, count must be a positive integer');
    }
  }

  if (splitType === 'percentage') {
    const { percentages } = body;
    if (!Array.isArray(percentages) || percentages.length === 0) {
      throw new Error('For percentage split, percentages must be a non-empty array');
    }

    const sum = percentages.reduce((acc, curr) => acc + curr, 0);
    if (Math.abs(sum - 100) > 0.01) { // Allow small floating point differences
      throw new Error('Percentages must sum to 100');
    }

    if (percentages.some(p => p <= 0)) {
      throw new Error('All percentages must be greater than 0');
    }
  }
};

/**
 * Calculates portion-wise split for items
 */
const calculatePortionSplit = (items, count) => {
  const splits = Array(count).fill().map(() => ({}));
  
  for (const [itemId, itemData] of Object.entries(items)) {
    // Calculate total quantity and price per item
    const totalQty = itemData.customizations.reduce((sum, c) => sum + c.qty, 0);
    const splitQty = totalQty / count; // This can be a decimal now

    // Create split items with exact fractional quantities
    splits.forEach((split) => {
      split[itemId] = {
        ...itemData,
        customizations: itemData.customizations.map(c => {
          const customizationSplitQty = c.qty / count;
          return {
            ...c,
            qty: customizationSplitQty,
            // Store original price for reference
            originalPrice: c.price,
            // Price remains the same per unit
            price: c.price
          };
        })
      };
    });
  }

  return splits;
};

/**
 * Calculates percentage-wise split for items
 */
const calculatePercentageSplit = (items, percentages) => {
  return percentages.map(percentage => {
    const split = {};
    
    for (const [itemId, itemData] of Object.entries(items)) {
      split[itemId] = {
        ...itemData,
        customizations: itemData.customizations.map(c => {
          const splitQty = (c.qty * percentage) / 100;
          return {
            ...c,
            qty: splitQty,
            // Store original price for reference
            originalPrice: c.price,
            // Price remains the same per unit
            price: c.price
          };
        })
      };
    }
    
    return split;
  });
};

/**
 * Creates new split orders in the database
 */
const createSplitOrders = async (originalOrder, splits, tableId, originalOrderId) => {
  const results = [];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Create new split orders
    for (let i = 0; i < splits.length; i++) {
      const newOrderId = `${originalOrderId}-split-${i + 1}`;
      const splitItems = splits[i];

      // Create new order with split items
      const insertResult = await client.query(
        `INSERT INTO orders (
          id, restaurant_id, table_id, json_data, instructions, 
          petpooja_bill_data, ReadyForReview, razorpay_order_id, 
          invoice_number, offer_given, butler_discount_applied,
          butler_discount_value, guest_count, butler_discount_id, isreservation,
          drink_offer_given, dessert_offer_given, offer_availed, additional_discount,
          disable_service_charge, is_payment_thirdparty, offer_partially_availed,
          butler_payment_failed
        )
        SELECT 
          $1, restaurant_id, table_id, $2, instructions,
          petpooja_bill_data, ReadyForReview, razorpay_order_id,
          invoice_number, offer_given, butler_discount_applied,
          butler_discount_value, guest_count, butler_discount_id, isreservation,
          drink_offer_given, dessert_offer_given, offer_availed, additional_discount,
          disable_service_charge, is_payment_thirdparty, offer_partially_availed,
          butler_payment_failed
        FROM orders
        WHERE id = $3
        RETURNING *`,
        [newOrderId, { items: splitItems }, originalOrderId]
      );

      if (!insertResult.rows[0]) {
        throw new Error(`Failed to create split order ${newOrderId}`);
      }

      const newOrder = insertResult.rows[0];
      
      results.push({
        orderId: newOrderId,
        items: splitItems,
        billData: newOrder
      });
    }


    await client.query('COMMIT');
    
    // Complete the original order outside of the transaction to avoid conflicts
    const completionResult = await completeOrder(
      originalOrder.restaurant_id,
      originalOrder.table_id,
      0, // total amount is 0 since it's split
      'split' // payment method indicates this order was split
    );
    
    if (!completionResult) {
      console.log('Warning: Failed to complete original order, but split was successful');
    }
    
    return results;

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Main controller for splitting bills
 * This function expects a database pool to be passed in
 */
const splitBill = async (req, res) => {
  try {
    // 1. Validate request
    validateSplitRequest(req.body);
    const { tableId, orderId, splitType } = req.body;

    // 2. Fetch original order
    const { rows: [order] } = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND table_id = $2',
      [orderId, tableId]
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = order.json_data.items;

    // 3. Calculate splits based on type
    let splits;
    if (splitType === 'portion') {
      splits = calculatePortionSplit(items, req.body.count);
    } else if (splitType === 'percentage') {
      splits = calculatePercentageSplit(items, req.body.percentages);
    }

    // 4. Create split orders in database
    const results = await createSplitOrders(order, splits, tableId, orderId);

    // 5. Return response
    return res.json({
      message: 'Bill split successful',
      results
    });

  } catch (error) {
    console.error('Error splitting bill:', error);
    return res.status(400).json({ error: error.message });
  }
};

module.exports = {
  splitBill
}; 
