const axios = require('axios');
require('dotenv').config();

const ERPNEXT_URL = process.env.ERPNEXT_URL || 'http://localhost:8080';
const ERPNEXT_API_KEY = process.env.ERPNEXT_API_KEY;
const ERPNEXT_API_SECRET = process.env.ERPNEXT_API_SECRET;

const erpnextAPI = axios.create({
  baseURL: `${ERPNEXT_URL}/api/resource`,
  headers: {
    Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`,
    'Content-Type': 'application/json'
  }
});

(async () => {
  try {
    const resp = await erpnextAPI.get('/Sales Order', {
      params: {
        fields: JSON.stringify(['name', 'transaction_date', 'customer', 'grand_total', 'status', 'docstatus']),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        limit_page_length: 50
      }
    });
    console.log('Total Sales Orders found:', resp.data.data.length);
    console.log('Sample Sales Orders:', JSON.stringify(resp.data.data.slice(0, 5), null, 2));

    if (resp.data.data.length > 0) {
      const sample = await erpnextAPI.get(`/Sales Order/${resp.data.data[0].name}`);
      console.log('Sample items in SO:', JSON.stringify(sample.data.data.items?.map(i => ({ item_code: i.item_code, qty: i.qty, delivery_date: i.delivery_date, rate: i.rate })), null, 2));
    }
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
  }
})();
