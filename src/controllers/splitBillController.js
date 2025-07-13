const { pool } = require('../config/db');
const { completeOrder: completeOrderController } = require('@butler/order-engine/src/controllers/orderController');

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
    
    // Complete the original order using the controller function
    console.log('=== SPLIT BILL: Starting order completion process ===');
    console.log('Original order details:', {
      orderId: originalOrder.id,
      restaurantId: originalOrder.restaurant_id,
      tableId: originalOrder.table_id,
      total: 0,
      paymentMethod: 'split'
    });
    
    const mockReq = {
      params: {
        restaurantId: originalOrder.restaurant_id,
        tableId: originalOrder.table_id
      },
      body: {
        total: 0, // total amount is 0 since it's split
        paymentMethod: 'split' // payment method indicates this order was split
      }
    };
    
    console.log('Mock request object:', JSON.stringify(mockReq, null, 2));
    
    const mockRes = {
      status: (code) => ({
        json: (data) => {
          mockRes.statusCode = code;
          mockRes.responseData = data;
          console.log(`Response status: ${code}, data:`, JSON.stringify(data, null, 2));
        }
      }),
      statusCode: 200,
      responseData: null
    };
    
    try {
      console.log('Calling completeOrderController...');
      await completeOrderController(mockReq, mockRes);
      console.log('completeOrderController completed successfully');
      console.log('Final response status:', mockRes.statusCode);
      console.log('Final response data:', mockRes.responseData);
      
      if (mockRes.statusCode >= 400) {
        console.log('❌ ERROR: Failed to complete original order, but split was successful');
        console.log('Error details:', mockRes.responseData);
      } else {
        console.log('✅ SUCCESS: Original order completed successfully');
      }
    } catch (error) {
      console.log('❌ EXCEPTION: Error calling completeOrderController:', error);
      console.log('Error stack:', error.stack);
    }
    
    // Check if the original order still exists after completion
    try {
      const checkOrderResult = await pool.query(
        'SELECT id, restaurant_id, table_id FROM orders WHERE restaurant_id = $1 AND table_id = $2',
        [originalOrder.restaurant_id, originalOrder.table_id]
      );
      
      console.log('=== POST-COMPLETION ORDER CHECK ===');
      console.log('Orders found for table:', checkOrderResult.rows.length);
      if (checkOrderResult.rows.length > 0) {
        console.log('Remaining orders:', checkOrderResult.rows.map(row => ({
          id: row.id,
          restaurantId: row.restaurant_id,
          tableId: row.table_id
        })));
      } else {
        console.log('✅ No orders found - original order successfully removed');
      }
    } catch (error) {
      console.log('❌ Error checking post-completion orders:', error);
    }
    
    // Check if the order was moved to completed_orders
    try {
      const checkCompletedResult = await pool.query(
        'SELECT id, restaurant_id, table_id, total, completed_at FROM completed_orders WHERE restaurant_id = $1 AND table_id = $2 ORDER BY completed_at DESC LIMIT 1',
        [originalOrder.restaurant_id, originalOrder.table_id]
      );
      
      console.log('=== COMPLETED ORDERS CHECK ===');
      console.log('Completed orders found:', checkCompletedResult.rows.length);
      if (checkCompletedResult.rows.length > 0) {
        console.log('Latest completed order:', {
          id: checkCompletedResult.rows[0].id,
          restaurantId: checkCompletedResult.rows[0].restaurant_id,
          tableId: checkCompletedResult.rows[0].table_id,
          total: checkCompletedResult.rows[0].total,
          completedAt: checkCompletedResult.rows[0].completed_at
        });
      } else {
        console.log('❌ No completed orders found - order may not have been moved');
      }
    } catch (error) {
      console.log('❌ Error checking completed orders:', error);
    }
    
    console.log('=== SPLIT BILL: Order completion process finished ===');
    
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
