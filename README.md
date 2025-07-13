
# @butler/split-bill-engine

Split bill functionality for Butler POS system.

## Installation

```bash
npm install @butler/split-bill-engine
```

## Usage

### Basic Setup

```javascript
const { splitBill } = require('@butler/split-bill-engine');
const { Pool } = require('pg');

// Initialize database pool
const pool = new Pool({
  user: 'your_username',
  host: 'localhost',
  database: 'your_database',
  password: 'your_password',
  port: 5432,
});

// Express route example
app.post('/api/bill/split', async (req, res) => {
  await splitBill(req, res, pool);
});
```

### Split Types

#### Portion-wise Split

Split bill into equal portions:

```javascript
const requestBody = {
  tableId: "table-1",
  orderId: "order-123",
  splitType: "portion",
  count: 3  // Split into 3 equal parts
};
```

#### Percentage-wise Split

Split bill by custom percentages:

```javascript
const requestBody = {
  tableId: "table-1", 
  orderId: "order-123",
  splitType: "percentage",
  percentages: [40, 35, 25]  // Must sum to 100
};
```

### Response Format

```javascript
{
  "message": "Bill split successful",
  "results": [
    {
      "orderId": "order-123-split-1",
      "items": { /* split items */ },
      "billData": { /* order data */ }
    },
    {
      "orderId": "order-123-split-2", 
      "items": { /* split items */ },
      "billData": { /* order data */ }
    }
  ]
}
```

### Error Handling

The package validates input and returns appropriate error messages:

- Missing required fields
- Invalid split types
- Percentages not summing to 100
- Order not found
- Database errors

## Requirements

- Node.js >= 14.0.0
- PostgreSQL database
- Express.js (peer dependency)

## License

ISC 