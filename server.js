// Backend Server - Express API
// server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const ERPNEXT_URL = process.env.ERPNEXT_URL;
//const ERPNEXT_URL = process.env.ERPNEXT_URL || 'http://localhost:8080';
const ERPNEXT_API_KEY = process.env.ERPNEXT_API_KEY;
const ERPNEXT_API_SECRET = process.env.ERPNEXT_API_SECRET;

// Create Axios instances for ERPNext
const erpnextAPI = axios.create({
  baseURL: `${ERPNEXT_URL}/api/resource`,
  headers: {
    Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`,
    'Content-Type': 'application/json'
  }
});

const erpnextMethodAPI = axios.create({
  baseURL: `${ERPNEXT_URL}/api/method`,
  headers: {
    Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`,
    'Content-Type': 'application/json'
  }
});

// In-memory map: { workOrderName -> workstationName }
// Used to persist the intended workstation for draft WOs that have no operations yet.
const woWorkstationMap = {};

// ==================== BATCH GROUP STORAGE ====================
// Migrated to ERPNext Custom DocType (Virtual Work Order)

// ==================== WORK ORDER TIMER STORAGE ====================

const TIMERS_FILE = path.join(__dirname, 'wo-timers.json');

const loadTimers = () => {
  try {
    if (fs.existsSync(TIMERS_FILE)) {
      const raw = fs.readFileSync(TIMERS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('Could not load wo-timers.json:', e.message);
  }
  return {};
};

const saveTimers = (timers) => {
  try {
    fs.writeFileSync(TIMERS_FILE, JSON.stringify(timers, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save wo-timers.json:', e.message);
  }
};

const normalizeJobCardTimes = (jobCard) => {
  const scheduledLogs = Array.isArray(jobCard.scheduled_time_logs) ? jobCard.scheduled_time_logs : [];
  const scheduled = scheduledLogs[0] || {};

  return {
    ...jobCard,
    from_time: scheduled.from_time || jobCard.from_time || jobCard.expected_start_date || jobCard.actual_start_date || null,
    to_time: scheduled.to_time || jobCard.to_time || jobCard.expected_end_date || jobCard.actual_end_date || null
  };
};

// Helper: Parse human-readable error messages from ERPNext / Frappe response
const parseERPNextError = (error) => {
  if (error.response && error.response.data) {
    const data = error.response.data;

    // 1. Try parsing _server_messages (Frappe standard message array)
    if (data._server_messages) {
      try {
        const parsedMsgs = typeof data._server_messages === 'string'
          ? JSON.parse(data._server_messages)
          : data._server_messages;
        if (Array.isArray(parsedMsgs) && parsedMsgs.length > 0) {
          const firstObj = typeof parsedMsgs[0] === 'string' ? JSON.parse(parsedMsgs[0]) : parsedMsgs[0];
          if (firstObj && firstObj.message) {
            return firstObj.message.replace(/<[^>]*>?/gm, '').trim();
          }
        }
      } catch (e) {
        // Ignore JSON parse error
      }
    }

    // 2. Try exception message string (e.g. "frappe.exceptions.ValidationError: Cannot update Work Order...")
    if (typeof data.exception === 'string' && data.exception) {
      const parts = data.exception.split(':');
      if (parts.length > 1) {
        return parts.slice(1).join(':').trim();
      }
      return data.exception;
    }

    // 3. Try data.message or data.error string
    if (typeof data.message === 'string' && data.message) {
      return data.message;
    }
    if (typeof data.error === 'string' && data.error) {
      return data.error;
    }
  }

  return error.message || 'An unexpected error occurred';
};

// ==================== JOB CARD ENDPOINTS ====================

// Get all Job Cards
app.get('/api/job-cards', async (req, res) => {
  try {
    // ERPNext restricts which fields can be requested in a list query.
    // First fetch names, then retrieve each full Job Card document.
    const listResp = await erpnextAPI.get('/Job Card', {
      params: {
        fields: JSON.stringify(['name']),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        limit_page_length: 500
      }
    });

    const names = (listResp.data.data || []).map(r => r.name);
    const details = await Promise.all(names.map(async (n) => {
      try {
        const r = await erpnextAPI.get(`/Job Card/${n}`);
        return normalizeJobCardTimes(r.data.data);
      } catch (e) {
        console.error('Failed to fetch Job Card', n, e.response ? e.response.data : e.message);
        return null;
      }
    }));

    res.json(details.filter(Boolean));
  } catch (error) {
    console.error('Error fetching Job Cards:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});

// Get single Job Card
app.get('/api/job-cards/:id', async (req, res) => {
  try {
    const response = await erpnextAPI.get(`/Job Card/${req.params.id}`);
    res.json(response.data.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const updateJobCardSchedule = async (jobCardId, from_time, to_time) => {
  // Fetch the Job Card so we can update the scheduled_time_logs child row if present.
  const jobCardResponse = await erpnextAPI.get(`/Job Card/${jobCardId}`);
  const jobCard = jobCardResponse.data.data;
  const scheduledLogs = Array.isArray(jobCard.scheduled_time_logs) ? jobCard.scheduled_time_logs : [];

  const payload = {};

  if (scheduledLogs.length > 0) {
    payload.scheduled_time_logs = [
      {
        name: scheduledLogs[0].name,
        from_time,
        to_time
      }
    ];
  } else {
    payload.from_time = from_time;
    payload.to_time = to_time;
  }

  return erpnextAPI.put(`/Job Card/${jobCardId}`, payload);
};

// Update Job Card dates (reschedule)
app.put('/api/job-cards/:id/reschedule', async (req, res) => {
  try {
    const { from_time, to_time } = req.body;

    const response = await updateJobCardSchedule(req.params.id, from_time, to_time);

    res.json({
      success: true,
      message: `Job Card ${req.params.id} rescheduled`,
      data: response.data.data
    });
  } catch (error) {
    console.error('Job Card reschedule error:', error.response ? error.response.data : error.message);
    const erpData = error.response ? error.response.data : null;
    const isCancelledLink = erpData && erpData.exception && erpData.exception.includes('CancelledLinkError');
    const message = isCancelledLink
      ? 'Reschedule failed: the linked Work Order is cancelled. Open the Job Card in ERPNext and fix or remove the cancelled Work Order link before rescheduling.'
      : parseERPNextError(error);

    res.status(error.response?.status || 500).json({
      success: false,
      error: message,
      details: erpData
    });
  }
});

// ==================== WORK ORDER ENDPOINTS ====================

// Get all Work Orders
app.get('/api/work-orders', async (req, res) => {
  try {
    const listResp = await erpnextAPI.get('/Work Order', {
      params: {
        fields: JSON.stringify(['name']),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        limit_page_length: 500
      }
    });

    const names = (listResp.data.data || []).map(r => r.name);
    const details = await Promise.all(names.map(async (n) => {
      try {
        const r = await erpnextAPI.get(`/Work Order/${n}`);
        return r.data.data;
      } catch (e) {
        console.error('Failed to fetch Work Order', n, e.response ? e.response.data : e.message);
        return null;
      }
    }));

    res.json(details.filter(Boolean));
  } catch (error) {
    console.error('Error fetching Work Orders:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});


// Get single Work Order
app.get('/api/work-orders/:id', async (req, res) => {
  try {
    const response = await erpnextAPI.get(`/Work Order/${req.params.id}`);
    res.json(response.data.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get production items (items that have BOMs)
app.get('/api/items', async (req, res) => {
  try {
    const response = await erpnextAPI.get('/Item', {
      params: {
        fields: JSON.stringify(['name', 'item_name', 'item_group', 'stock_uom']),
        filters: JSON.stringify([
          ['is_stock_item', '=', 1],
          ['disabled', '=', 0],
          ['item_group', '=', 'Products']
        ]),
        limit_page_length: 500,
        order_by: 'name asc'
      }
    });
    res.json(response.data.data || []);
  } catch (error) {
    console.error('Error fetching items:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get BOMs for a specific item
app.get('/api/boms', async (req, res) => {
  try {
    const { item } = req.query;
    const filters = [['docstatus', '=', 1], ['is_active', '=', 1]];
    if (item) filters.push(['item', '=', item]);

    const response = await erpnextAPI.get('/BOM', {
      params: {
        fields: JSON.stringify(['name', 'item', 'item_name', 'quantity', 'is_default']),
        filters: JSON.stringify(filters),
        limit_page_length: 100,
        order_by: 'is_default desc, name asc'
      }
    });
    res.json(response.data.data || []);
  } catch (error) {
    console.error('Error fetching BOMs:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// Create a new Work Order
app.post('/api/work-orders', async (req, res) => {
  try {
    const {
      workstation,
      production_item,
      bom_no,
      qty,
      planned_start_date,
      planned_end_date,
      company,
      wip_warehouse,
      fg_warehouse,
      sales_order,
      description
    } = req.body;

    if (!production_item || !bom_no || !qty || !planned_start_date) {
      return res.status(400).json({
        success: false,
        error: 'production_item, bom_no, qty, and planned_start_date are required'
      });
    }

    // Fetch BOM operations so that ERPNext saves the operations table on the Work Order.
    // Without this, the operations table is empty in REST creation, causing ERPNext to create 0 Job Cards upon submission.
    let woOperations = [];
    try {
      // Get valid workstation list to avoid LinkValidationError
      let validStationNames = new Set();
      try {
        const wsListResp = await erpnextAPI.get('/Workstation', {
          params: { fields: JSON.stringify(['name']), limit_page_length: 500 }
        });
        (wsListResp.data.data || []).forEach(w => validStationNames.add(w.name));
      } catch (e) {
        // Ignore fallback
      }

      const bomResp = await erpnextAPI.get(`/BOM/${bom_no}`);
      const bomData = bomResp.data.data;
      if (Array.isArray(bomData.operations) && bomData.operations.length > 0) {
        woOperations = bomData.operations.map(op => {
          let opStation = (workstation && workstation !== 'Unassigned') ? workstation : (op.workstation || '');
          if (opStation && !validStationNames.has(opStation)) {
            // If the BOM workstation does not exist in ERPNext, clear it or use first valid station
            opStation = validStationNames.size > 0 ? Array.from(validStationNames)[0] : '';
          }
          return {
            operation: op.operation,
            workstation: opStation,
            workstation_type: op.workstation_type || '',
            time_in_mins: op.time_in_mins || 0,
            sequence_id: op.sequence_id || 1,
            bom: bom_no,
            description: op.description || op.operation || '',
            hour_rate: op.hour_rate || 0,
            batch_size: op.batch_size || 1
          };
        });
      }
    } catch (bomErr) {
      console.warn(`Could not fetch BOM ${bom_no} operations:`, bomErr.message);
    }

    // Helper to format into 'YYYY-MM-DD HH:mm:ss'
    const formatERPDatetime = (dt, defaultTime = '08:00:00') => {
      if (!dt) return null;
      let s = String(dt).trim().replace('T', ' ');
      if (!s.includes(' ')) {
        s = `${s} ${defaultTime}`;
      } else {
        const parts = s.split(' ');
        let timePart = parts[1];
        if (timePart.length === 5) timePart += ':00';
        s = `${parts[0]} ${timePart}`;
      }
      return s;
    };

    const formattedStart = formatERPDatetime(planned_start_date, '08:00:00');
    const formattedEnd = formatERPDatetime(planned_end_date || planned_start_date, '17:00:00');

    const payload = {
      production_item,
      bom_no,
      qty: Number(qty),
      planned_start_date: formattedStart,
      planned_end_date: formattedEnd,
      company: company || 'SHRDC Demo',
      wip_warehouse: wip_warehouse || 'Work In Progress - SD',
      fg_warehouse: fg_warehouse || 'Finished Goods - SD',
      use_multi_level_bom: 1,
      skip_transfer: 0
    };

    if (woOperations.length > 0) {
      payload.operations = woOperations;
    }
    if (workstation) payload.workstation = workstation;
    if (sales_order) payload.sales_order = sales_order;
    if (description) payload.description = description;

    const response = await erpnextAPI.post('/Work Order', payload);
    const newWO = response.data.data;

    // Auto-submit the Work Order so it doesn't stay as Draft
    try {
      await erpnextAPI.put(`/Work Order/${newWO.name}`, { docstatus: 1 });
      newWO.docstatus = 1;
      newWO.status = 'Not Started';
    } catch (submitErr) {
      console.warn(`Could not auto-submit Work Order ${newWO.name}:`, submitErr.message);
    }

    // Save the intended workstation in the in-memory map so the matrix can
    // place this WO in the correct row
    if (workstation) {
      woWorkstationMap[newWO.name] = workstation;
      console.log(`Saved workstation "${workstation}" for WO ${newWO.name} in memory map`);
    }

    // If a workstation or times are specified, override operation workstations
    // and sync the scheduled times to any created Job Cards.
    try {
      // Step 1: Update operations child table if workstation is specified
      if (workstation && workstation !== 'Unassigned') {
        const woFull = (await erpnextAPI.get(`/Work Order/${newWO.name}`)).data.data;
        const operations = Array.isArray(woFull.operations) ? woFull.operations : [];

        if (operations.length > 0) {
          const updatedOps = operations.map(op => ({
            ...op,
            workstation: workstation
          }));
          await erpnextAPI.put(`/Work Order/${newWO.name}`, { operations: updatedOps });
          console.log(`Overrode workstation to "${workstation}" on ${operations.length} operation(s) of WO ${newWO.name}`);
        }
      }

      // Step 2: Sync workstation & scheduled start/end times on any Job Cards created
      const jcListResp = await erpnextAPI.get('/Job Card', {
        params: {
          fields: JSON.stringify(['name']),
          filters: JSON.stringify([
            ['work_order', '=', newWO.name]
          ]),
          limit_page_length: 500
        }
      });
      const jobCardNames = (jcListResp.data.data || []).map(r => r.name);
      if (jobCardNames.length > 0) {
        await Promise.all(jobCardNames.map(async (jcName) => {
          await updateJobCardSchedule(jcName, formattedStart, formattedEnd);
          if (workstation && workstation !== 'Unassigned') {
            await erpnextAPI.put(`/Job Card/${jcName}`, { workstation });
          }
        }));
        console.log(`Synced schedule (${formattedStart} - ${formattedEnd}) on ${jobCardNames.length} Job Card(s) for WO ${newWO.name}`);
      }
    } catch (postSyncErr) {
      console.warn('Post-creation sync warning for Work Order', newWO.name, postSyncErr.message);
    }

    res.json({
      success: true,
      message: `Work Order ${newWO.name} created successfully`,
      data: newWO
    });
  } catch (error) {
    console.error('Create Work Order error:', error.response ? error.response.data : error.message);
    const erpData = error.response ? error.response.data : null;
    res.status(500).json({
      success: false,
      error: erpData?.message || error.message,
      details: erpData
    });
  }
});

// ==================== WORK ORDER TIMER / EXECUTION ENDPOINTS ====================

// Get all timers state
app.get('/api/work-orders/timers', (req, res) => {
  const timers = loadTimers();
  res.json({ success: true, timers });
});

// Helper: Top-up missing raw material item stock in ERPNext
const autoReplenishStock = async (itemCode, minQty = 100000) => {
  try {
    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const receiptDoc = {
      stock_entry_type: 'Material Receipt',
      purpose: 'Material Receipt',
      company: 'SHRDC Demo',
      posting_date: today,
      items: [
        {
          item_code: itemCode,
          t_warehouse: 'Stores - SD',
          qty: minQty,
          basic_rate: 10,
          allow_zero_valuation_rate: 1
        }
      ]
    };

    const r = await erpnextAPI.post('/Stock Entry', receiptDoc);
    const steName = r.data.data.name;
    await erpnextAPI.put(`/Stock Entry/${steName}`, { docstatus: 1 });
    console.log(`📦 Auto-replenished ${minQty} units of ${itemCode} (Receipt: ${steName})`);
    return steName;
  } catch (err) {
    console.warn(`Could not auto-replenish stock for ${itemCode}:`, err.message);
    return null;
  }
};

// Helper: Clean up or submit existing draft Stock Entries for a Work Order
const cleanDraftStockEntries = async (woId) => {
  try {
    const drafts = await erpnextAPI.get('/Stock Entry', {
      params: {
        fields: JSON.stringify(['name', 'stock_entry_type', 'docstatus']),
        filters: JSON.stringify([['work_order', '=', woId], ['docstatus', '=', 0]])
      }
    });

    for (const ste of (drafts.data.data || [])) {
      try {
        await erpnextAPI.put(`/Stock Entry/${ste.name}`, { docstatus: 1 });
        console.log(`Submitted existing draft Stock Entry ${ste.name} for WO ${woId}`);
      } catch (submitErr) {
        // If cannot submit, delete the blocking draft
        try {
          await erpnextAPI.delete(`/Stock Entry/${ste.name}`);
          console.log(`Deleted un-submittable draft Stock Entry ${ste.name} for WO ${woId}`);
        } catch (delErr) {
          console.warn(`Could not delete draft ${ste.name}:`, delErr.message);
        }
      }
    }
  } catch (e) {
    console.warn(`Draft cleanup warning for WO ${woId}:`, e.message);
  }
};

// Helper: Perform Material Transfer for Manufacture in ERPNext (with self-healing)
const performMaterialTransfer = async (woId, qty) => {
  await cleanDraftStockEntries(woId);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const prep = await erpnextMethodAPI.post('/erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry', {
        work_order_id: woId,
        purpose: 'Material Transfer for Manufacture',
        qty: qty || undefined
      });
      const steDoc = prep.data.message;
      if (!steDoc || !Array.isArray(steDoc.items) || steDoc.items.length === 0) {
        console.log(`No items to transfer for Work Order ${woId} (possibly already transferred)`);
        return 'ALREADY_TRANSFERRED';
      }

      steDoc.items.forEach(item => {
        item.allow_zero_valuation_rate = 1;
        if (!item.basic_rate || item.basic_rate === 0) item.basic_rate = 1;
      });

      const createResp = await erpnextAPI.post('/Stock Entry', steDoc);
      const steName = createResp.data.data.name;

      // Submit the Stock Entry
      await erpnextAPI.put(`/Stock Entry/${steName}`, { docstatus: 1 });
      console.log(`📦 Material Transfer Stock Entry ${steName} submitted for Work Order ${woId}`);
      return steName;
    } catch (err) {
      const errStr = JSON.stringify(err.response ? err.response.data : err.message);
      console.warn(`Attempt ${attempt + 1} Material Transfer error for WO ${woId}:`, errStr.slice(0, 300));

      // Check if insufficient stock for a specific item
      const match = errStr.match(/For the item <strong>(.*?)<\/strong>/i) || errStr.match(/Item (.*?):/i);
      if (match && match[1] && attempt < 2) {
        const missingItem = match[1].trim();
        console.log(`Auto-replenishing shortage item: "${missingItem}"`);
        await autoReplenishStock(missingItem);
        await cleanDraftStockEntries(woId);
        continue;
      }

      // Check if duplicate entry error
      if (errStr.includes('DuplicateEntryForWorkOrderError') && attempt < 2) {
        await cleanDraftStockEntries(woId);
        continue;
      }

      // Check if already transferred
      if (errStr.includes('already transferred') || errStr.includes('No items to transfer')) {
        return 'ALREADY_TRANSFERRED';
      }

      break;
    }
  }
  return null;
};

// Helper: Complete Job Cards and Perform Manufacture Stock Entry in ERPNext (with self-healing)
const performManufactureEntry = async (woId, qty, elapsedSeconds) => {
  await cleanDraftStockEntries(woId);

  // Step 1: Complete any pending Job Cards
  try {
    const jcList = await erpnextAPI.get('/Job Card', {
      params: {
        fields: JSON.stringify(['name', 'for_quantity', 'docstatus']),
        filters: JSON.stringify([['work_order', '=', woId], ['docstatus', '!=', 2]])
      }
    });

    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    const nowStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const durationMins = Math.max(1, Math.ceil((elapsedSeconds || 900) / 60));

    for (const jc of (jcList.data.data || [])) {
      if (jc.docstatus === 0) {
        await erpnextAPI.put(`/Job Card/${jc.name}`, {
          docstatus: 1,
          time_logs: [
            {
              from_time: nowStr,
              to_time: nowStr,
              time_in_mins: durationMins,
              completed_qty: jc.for_quantity || qty || 1
            }
          ]
        });
        console.log(`✓ Completed Job Card ${jc.name} for WO ${woId}`);
      }
    }
  } catch (jcErr) {
    console.warn(`Job card auto-completion warning for WO ${woId}:`, jcErr.message);
  }

  // Step 2: Make and Submit Manufacture Stock Entry
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const prep = await erpnextMethodAPI.post('/erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry', {
        work_order_id: woId,
        purpose: 'Manufacture',
        qty: qty || undefined
      });
      const steDoc = prep.data.message;
      if (!steDoc || !Array.isArray(steDoc.items) || steDoc.items.length === 0) {
        console.log(`No manufacture items generated for Work Order ${woId} (possibly already manufactured)`);
        return 'ALREADY_MANUFACTURED';
      }

      steDoc.items.forEach(item => {
        item.allow_zero_valuation_rate = 1;
        if (!item.basic_rate || item.basic_rate === 0) item.basic_rate = 1;
      });

      const createResp = await erpnextAPI.post('/Stock Entry', steDoc);
      const steName = createResp.data.data.name;

      // Submit the Stock Entry
      await erpnextAPI.put(`/Stock Entry/${steName}`, { docstatus: 1 });
      console.log(`🏭 Manufacture Stock Entry ${steName} submitted for Work Order ${woId}`);
      return steName;
    } catch (err) {
      const errStr = JSON.stringify(err.response ? err.response.data : err.message);
      console.warn(`Attempt ${attempt + 1} Manufacture Stock Entry error for WO ${woId}:`, errStr.slice(0, 300));

      // Check duplicate entry
      if (errStr.includes('DuplicateEntryForWorkOrderError') && attempt < 2) {
        await cleanDraftStockEntries(woId);
        continue;
      }

      // Check if raw materials shortage
      const match = errStr.match(/For the item <strong>(.*?)<\/strong>/i) || errStr.match(/Item (.*?):/i);
      if (match && match[1] && attempt < 2) {
        const missingItem = match[1].trim();
        console.log(`Auto-replenishing shortage item for manufacture: "${missingItem}"`);
        await autoReplenishStock(missingItem);
        await cleanDraftStockEntries(woId);
        continue;
      }

      if (errStr.includes('already manufactured') || errStr.includes('Completed')) {
        return 'ALREADY_MANUFACTURED';
      }

      break;
    }
  }
  return null;
};

// Start Work Order Timer & Transfer RM to WIP
app.post('/api/work-orders/:id/start', async (req, res) => {
  const woId = req.params.id;
  try {
    const now = Date.now();
    const nowIso = new Date().toISOString();
    let woQty = 0;

    // Check if WO is Draft in ERPNext and submit it
    try {
      const woResp = await erpnextAPI.get(`/Work Order/${woId}`);
      const woData = woResp.data.data;
      if (woData) {
        woQty = woData.qty || woData.for_quantity || 0;
        if (woData.docstatus === 0) {
          // Submit the Draft Work Order
          await erpnextAPI.put(`/Work Order/${woId}`, { docstatus: 1 });
          console.log(`Submitted Draft Work Order ${woId} upon timer start`);
        }
        // Update actual start date if not set
        if (!woData.actual_start_date) {
          const pad = n => String(n).padStart(2, '0');
          const d = new Date();
          const startStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          await erpnextAPI.put(`/Work Order/${woId}`, { actual_start_date: startStr });
        }
      }
    } catch (e) {
      console.warn(`Could not update ERPNext for WO ${woId} start:`, e.message);
    }

    // Transfer Raw Materials from Stores to WIP Warehouse in ERPNext
    const transferEntry = await performMaterialTransfer(woId, woQty);

    // Update batch groups status in ERPNext if belongs to batch group
    try {
      const vwoList = await erpnextAPI.get('/Virtual Work Order', {
        params: {
          fields: JSON.stringify(['name']),
          filters: JSON.stringify([['docstatus', '!=', 2]]),
          limit_page_length: 500
        }
      });
      for (const vwo of (vwoList.data.data || [])) {
        const fullVwo = await erpnextAPI.get(`/Virtual Work Order/${vwo.name}`);
        const data = fullVwo.data.data;
        let updatedGroup = false;
        (data.sub_wos || []).forEach(sub => {
          if (sub.sub_wo === woId) {
            sub.status = 'In Process';
            updatedGroup = true;
          }
        });
        if (updatedGroup) {
          await erpnextAPI.put(`/Virtual Work Order/${vwo.name}`, { sub_wos: data.sub_wos });
        }
      }
    } catch (bgErr) {
      console.warn('Batch group status update warning:', bgErr.message);
    }

    const timers = loadTimers();
    const existing = timers[woId] || { elapsedSeconds: 0 };

    timers[woId] = {
      id: woId,
      status: 'running',
      startTime: existing.startTime || nowIso,
      lastIntervalStart: now,
      elapsedSeconds: existing.elapsedSeconds || 0,
      intervals: existing.intervals || [],
      transferStockEntry: transferEntry || existing.transferStockEntry || null
    };

    saveTimers(timers);
    console.log(`⏱ Started timer for Work Order ${woId} (Transfer: ${transferEntry || 'None'})`);

    res.json({
      success: true,
      timer: timers[woId],
      transferStockEntry: transferEntry,
      message: `Work Order ${woId} started. Raw materials transferred to WIP.`
    });
  } catch (error) {
    console.error('Error starting WO timer:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Pause Work Order Timer
app.post('/api/work-orders/:id/pause', (req, res) => {
  const woId = req.params.id;
  try {
    const now = Date.now();
    const timers = loadTimers();
    const timer = timers[woId];

    if (!timer) {
      return res.status(404).json({ success: false, error: `No timer found for Work Order ${woId}` });
    }

    if (timer.status === 'running' && timer.lastIntervalStart) {
      const added = Math.max(0, Math.floor((now - timer.lastIntervalStart) / 1000));
      timer.elapsedSeconds = (timer.elapsedSeconds || 0) + added;
      if (!Array.isArray(timer.intervals)) timer.intervals = [];
      timer.intervals.push({ start: timer.lastIntervalStart, end: now, duration: added });
    }

    timer.status = 'paused';
    timer.lastIntervalStart = null;
    timer.pausedAt = new Date().toISOString();

    saveTimers(timers);
    console.log(`⏸ Paused timer for Work Order ${woId} (Total elapsed: ${timer.elapsedSeconds}s)`);

    res.json({ success: true, timer, message: `Work Order ${woId} paused` });
  } catch (error) {
    console.error('Error pausing WO timer:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resume Work Order Timer
app.post('/api/work-orders/:id/resume', (req, res) => {
  const woId = req.params.id;
  try {
    const now = Date.now();
    const timers = loadTimers();
    const timer = timers[woId];

    if (!timer) {
      return res.status(404).json({ success: false, error: `No timer found for Work Order ${woId}` });
    }

    timer.status = 'running';
    timer.lastIntervalStart = now;
    timer.resumedAt = new Date().toISOString();

    saveTimers(timers);
    console.log(`▶ Resumed timer for Work Order ${woId}`);

    res.json({ success: true, timer, message: `Work Order ${woId} resumed` });
  } catch (error) {
    console.error('Error resuming WO timer:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Finish / Complete Work Order Timer & Manufacture Finished Goods
app.post('/api/work-orders/:id/finish', async (req, res) => {
  const woId = req.params.id;
  try {
    const now = Date.now();
    const nowIso = new Date().toISOString();
    const timers = loadTimers();
    const timer = timers[woId] || { elapsedSeconds: 0 };
    let woQty = 0;

    if (timer.status === 'running' && timer.lastIntervalStart) {
      const added = Math.max(0, Math.floor((now - timer.lastIntervalStart) / 1000));
      timer.elapsedSeconds = (timer.elapsedSeconds || 0) + added;
      if (!Array.isArray(timer.intervals)) timer.intervals = [];
      timer.intervals.push({ start: timer.lastIntervalStart, end: now, duration: added });
    }

    timer.status = 'completed';
    timer.lastIntervalStart = null;
    timer.finishedAt = nowIso;

    // Fetch Work Order qty
    try {
      const woResp = await erpnextAPI.get(`/Work Order/${woId}`);
      if (woResp.data.data) {
        woQty = woResp.data.data.qty || woResp.data.data.for_quantity || 0;
      }
    } catch (e) {
      console.warn(`Could not fetch WO qty for ${woId}:`, e.message);
    }

    // Manufacture in ERPNext: consumes WIP, produces Finished Good into FG Warehouse
    const manufactureEntry = await performManufactureEntry(woId, woQty, timer.elapsedSeconds);
    timer.manufactureStockEntry = manufactureEntry || null;
    saveTimers(timers);

    // Update actual end date and Completed status in ERPNext
    try {
      const pad = n => String(n).padStart(2, '0');
      const d = new Date();
      const endStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      await erpnextAPI.put(`/Work Order/${woId}`, { actual_end_date: endStr, status: 'Completed', produced_qty: woQty || undefined });
      console.log(`Updated Work Order ${woId} as Completed in ERPNext`);
    } catch (erpErr) {
      console.warn(`Could not update ERPNext completion for ${woId}:`, erpErr.message);
    }

    // Update batch groups status in ERPNext if belongs to batch group
    try {
      const vwoList = await erpnextAPI.get('/Virtual Work Order', {
        params: {
          fields: JSON.stringify(['name']),
          filters: JSON.stringify([['docstatus', '!=', 2]]),
          limit_page_length: 500
        }
      });
      for (const vwo of (vwoList.data.data || [])) {
        const fullVwo = await erpnextAPI.get(`/Virtual Work Order/${vwo.name}`);
        const data = fullVwo.data.data;
        let updatedGroup = false;
        (data.sub_wos || []).forEach(sub => {
          if (sub.sub_wo === woId) {
            sub.status = 'Completed';
            updatedGroup = true;
          }
        });
        if (updatedGroup) {
          await erpnextAPI.put(`/Virtual Work Order/${vwo.name}`, { sub_wos: data.sub_wos });
        }
      }
    } catch (bgErr) {
      console.warn('Batch group status update warning:', bgErr.message);
    }

    console.log(`⏹ Finished timer for Work Order ${woId} (Manufacture: ${manufactureEntry || 'None'})`);

    res.json({
      success: true,
      timer,
      manufactureStockEntry: manufactureEntry,
      message: `Work Order ${woId} finished. Finished goods manufactured into inventory.`
    });
  } catch (error) {
    console.error('Error finishing WO timer:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== BATCH WORK ORDER ENDPOINTS ====================

// Create a Batch Work Order Group (1 master + N sub Work Orders)
app.post('/api/batch-work-orders', async (req, res) => {
  try {
    const {
      production_item,
      bom_no,
      qty,
      batch_count,
      planned_start_date,
      planned_end_date,
      planned_start_time,
      planned_end_time,
      workstation,
      company,
      wip_warehouse,
      fg_warehouse,
      sales_order,
      description
    } = req.body;

    if (!production_item || !bom_no || !qty || !batch_count || !planned_start_date) {
      return res.status(400).json({
        success: false,
        error: 'production_item, bom_no, qty, batch_count, and planned_start_date are required'
      });
    }

    const numBatches = parseInt(batch_count, 10);
    if (isNaN(numBatches) || numBatches < 1 || numBatches > 50) {
      return res.status(400).json({
        success: false,
        error: 'batch_count must be between 1 and 50'
      });
    }

    console.log(`\n=== Creating Batch Group: ${numBatches} batches of ${production_item} (${qty} each) ===`);

    // Helper to build start/end datetime strings
    const startTime = planned_start_time || '08:00';
    const endTime = planned_end_time || '17:00';
    const startDateStr = planned_start_date.includes(' ') ? planned_start_date : `${planned_start_date} ${startTime.length === 5 ? startTime + ':00' : startTime}`;
    const endDate = planned_end_date || planned_start_date;
    const endDateStr = endDate.includes(' ') ? endDate : `${endDate} ${endTime.length === 5 ? endTime + ':00' : endTime}`;

    // Helper: create a single WO via internal POST logic
    const createSingleWO = async (descriptionTag, batchLabel) => {
      const fullDesc = [descriptionTag, description].filter(Boolean).join('\n');
      const internalReq = {
        body: {
          production_item,
          bom_no,
          qty: Number(qty),
          planned_start_date: startDateStr,
          planned_end_date: endDateStr,
          company: company || 'SHRDC Demo',
          wip_warehouse: wip_warehouse || 'Work In Progress - SD',
          fg_warehouse: fg_warehouse || 'Finished Goods - SD',
          workstation: workstation,
          sales_order: sales_order,
          description: fullDesc
        }
      };

      // Re-use the existing work order creation logic directly via API call
      const resp = await axios.post(`http://localhost:${PORT}/api/work-orders`, internalReq.body);
      return resp.data;
    };

    // Create N sub Work Orders (Master is virtual holder)
    const subWOs = [];
    const failedBatches = [];
    for (let i = 1; i <= numBatches; i++) {
      const subDesc = `[BATCH-GROUP: Pending | Batch ${i}/${numBatches}]`;
      try {
        const subResult = await createSingleWO(subDesc, `Batch ${i}/${numBatches}`);
        if (subResult.success) {
          subWOs.push({
            name: subResult.data.name,
            batchNumber: i,
            status: subResult.data.status || 'Draft'
          });
          console.log(`  Sub WO ${i}/${numBatches} created: ${subResult.data.name}`);
        } else {
          failedBatches.push({ batchNumber: i, error: subResult.error });
          console.error(`  Sub WO ${i}/${numBatches} FAILED:`, subResult.error);
        }
      } catch (err) {
        failedBatches.push({ batchNumber: i, error: err.response?.data?.error || err.message });
        console.error(`  Sub WO ${i}/${numBatches} FAILED:`, err.message);
      }
    }

// Helper to map Work Order status to Virtual Work Order Sub DocType Select options:
// ('Draft', 'In Process', 'Completed', 'Failed')
const mapStatusToVWO = (st) => {
  if (!st) return 'Draft';
  const lower = String(st).toLowerCase();
  if (['completed', 'closed'].includes(lower)) return 'Completed';
  if (['in process', 'in progress'].includes(lower)) return 'In Process';
  if (['failed', 'cancelled', 'stopped'].includes(lower)) return 'Failed';
  return 'Draft'; // 'Not Started', 'Draft', etc.
};

    // Save batch group to ERPNext Virtual Work Order
    const docPayload = {
      doctype: "Virtual Work Order",
      production_item: production_item,
      bom_no: bom_no,
      planned_date: planned_start_date.split(' ')[0],
      workstation: workstation || '',
      qty_per_batch: Number(qty),
      batch_count: numBatches,
      total_qty: Number(qty) * numBatches,
      is_virtual_master: 1,
      sub_wos: subWOs.map(sub => ({
        sub_wo: sub.name,
        batch_number: sub.batchNumber,
        status: mapStatusToVWO(sub.status)
      }))
    };
    
    let batchGroupId = 'UNKNOWN';
    try {
      const vwoResp = await erpnextAPI.post('/Virtual Work Order', docPayload);
      batchGroupId = vwoResp.data.data.name;
      
      // Auto-submit the Virtual Work Order so it doesn't stay as Draft
      try {
        await erpnextAPI.put(`/Virtual Work Order/${batchGroupId}`, { docstatus: 1 });
      } catch (submitErr) {
        console.warn(`Could not auto-submit Virtual Work Order ${batchGroupId}:`, submitErr.message);
      }
    } catch (vwoErr) {
      console.error('Failed to save Virtual Work Order to ERPNext:', vwoErr.response ? vwoErr.response.data : vwoErr.message);
    }

    console.log(`=== Batch Group ${batchGroupId} complete: ${subWOs.length}/${numBatches} sub-WOs created ===\n`);

    res.json({
      success: true,
      message: `Batch Group ${batchGroupId} created with ${subWOs.length} Sub-Work-Orders`,
      data: {
        batchGroupId,
        masterWO: null,
        isVirtualMaster: true,
        subWOs,
        failedBatches,
        totalCreated: subWOs.length
      }
    });
  } catch (error) {
    console.error('Batch Work Order creation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Reschedule an entire Batch Work Order Group (updates all sub WOs together)
app.put('/api/batch-work-orders/:id/reschedule', async (req, res) => {
  try {
    const { planned_start_date, planned_end_date, workstation } = req.body;
    const groupId = req.params.id;

    let group;
    try {
      const vwoResp = await erpnextAPI.get(`/Virtual Work Order/${groupId}`);
      group = vwoResp.data.data;
    } catch (e) {
      return res.status(404).json({ success: false, error: `Batch group ${groupId} not found in ERPNext` });
    }

    const startDateStr = planned_start_date.includes(' ') ? planned_start_date : `${planned_start_date} 08:00:00`;
    const endDateStr = (planned_end_date || planned_start_date).includes(' ')
      ? (planned_end_date || planned_start_date)
      : `${planned_end_date || planned_start_date} 17:00:00`;

    // Update group storage metadata
    const updatePayload = {
      planned_date: planned_start_date.split(' ')[0]
    };
    if (workstation && workstation !== 'Unassigned') {
      updatePayload.workstation = workstation;
    }
    await erpnextAPI.put(`/Virtual Work Order/${groupId}`, updatePayload);

    // Reschedule master Work Order if it exists
    const updatedWOs = [];
    const errors = [];
    if (group.master_wo) {
      try {
        await syncRescheduleWorkOrder(group.master_wo, startDateStr, endDateStr, workstation);
        updatedWOs.push(group.master_wo);
      } catch (err) {
        console.warn(`Could not reschedule master WO ${group.master_wo} in batch group ${groupId}:`, err.message);
        errors.push({ name: group.master_wo, error: err.message });
      }
    }

    // Reschedule all sub Work Orders linked to this batch group
    for (const sub of group.sub_wos || []) {
      try {
        await syncRescheduleWorkOrder(sub.sub_wo, startDateStr, endDateStr, workstation);
        updatedWOs.push(sub.sub_wo);
      } catch (err) {
        console.warn(`Could not reschedule sub WO ${sub.sub_wo} in batch group ${groupId}:`, err.message);
        errors.push({ name: sub.sub_wo, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Batch Group ${groupId} (${updatedWOs.length}/${(group.sub_wos || []).length} Work Orders) rescheduled to ${updatePayload.planned_date}`,
      data: {
        batchGroupId: groupId,
        updatedWOs,
        errors,
        plannedDate: updatePayload.planned_date,
        workstation: updatePayload.workstation || group.workstation
      }
    });
  } catch (error) {
    console.error('Batch reschedule error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List all Batch Work Order Groups
app.get('/api/batch-work-orders', async (req, res) => {
  try {
    const vwoList = await erpnextAPI.get('/Virtual Work Order', {
      params: {
        fields: JSON.stringify(['name', 'creation']),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        limit_page_length: 500
      }
    });
    
    const groupList = [];
    for (const v of (vwoList.data.data || [])) {
      try {
        const full = await erpnextAPI.get(`/Virtual Work Order/${v.name}`);
        const d = full.data.data;
        groupList.push({
          id: d.name,
          masterWO: d.master_wo,
          isVirtualMaster: d.is_virtual_master === 1,
          productionItem: d.production_item,
          bomNo: d.bom_no,
          batchCount: d.batch_count,
          qtyPerBatch: d.qty_per_batch,
          totalQty: d.total_qty,
          plannedDate: d.planned_date,
          workstation: d.workstation,
          createdAt: d.creation,
          subWOs: (d.sub_wos || []).map(s => ({
            name: s.sub_wo,
            batchNumber: s.batch_number,
            status: s.status
          }))
        });
      } catch (e) {
        // Skip
      }
    }
    groupList.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Enrich with live statuses from ERPNext
    for (const group of groupList) {
      if (group.masterWO) {
        try {
          const masterResp = await erpnextAPI.get(`/Work Order/${group.masterWO}`);
          group.masterStatus = masterResp.data.data.status;
        } catch (e) {
          group.masterStatus = 'Unknown';
        }
      } else {
        group.masterStatus = 'Virtual Holder';
      }

      // Fetch sub WO statuses
      let completedCount = 0;
      let inProcessCount = 0;
      for (const sub of group.subWOs || []) {
        try {
          const subResp = await erpnextAPI.get(`/Work Order/${sub.name}`);
          sub.status = subResp.data.data.status;
          if (sub.status === 'Completed') completedCount++;
          else if (sub.status === 'In Process') inProcessCount++;
        } catch (e) {
          sub.status = 'Unknown';
        }
      }

      group.progress = {
        total: (group.subWOs || []).length,
        completed: completedCount,
        inProcess: inProcessCount,
        percentage: (group.subWOs || []).length > 0
          ? Math.round((completedCount / group.subWOs.length) * 100)
          : 0
      };
    }

    res.json({ success: true, groups: groupList });
  } catch (error) {
    console.error('Error listing batch groups:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get a single Batch Work Order Group
app.get('/api/batch-work-orders/:id', async (req, res) => {
  try {
    let d;
    try {
      const full = await erpnextAPI.get(`/Virtual Work Order/${req.params.id}`);
      d = full.data.data;
    } catch (e) {
      return res.status(404).json({ success: false, error: `Batch group ${req.params.id} not found` });
    }

    const group = {
      id: d.name,
      masterWO: d.master_wo,
      isVirtualMaster: d.is_virtual_master === 1,
      productionItem: d.production_item,
      bomNo: d.bom_no,
      batchCount: d.batch_count,
      qtyPerBatch: d.qty_per_batch,
      totalQty: d.total_qty,
      plannedDate: d.planned_date,
      workstation: d.workstation,
      createdAt: d.creation,
      subWOs: (d.sub_wos || []).map(s => ({
        name: s.sub_wo,
        batchNumber: s.batch_number,
        status: s.status
      }))
    };

    // Enrich with live data
    if (group.masterWO) {
      try {
        const masterResp = await erpnextAPI.get(`/Work Order/${group.masterWO}`);
        group.masterStatus = masterResp.data.data.status;
        group.masterData = masterResp.data.data;
      } catch (e) {
        group.masterStatus = 'Unknown';
      }
    }

    for (const sub of group.subWOs) {
      try {
        const subResp = await erpnextAPI.get(`/Work Order/${sub.name}`);
        sub.status = subResp.data.data.status;
        sub.data = subResp.data.data;
      } catch (e) {
        sub.status = 'Unknown';
      }
    }

    const completedCount = group.subWOs.filter(s => s.status === 'Completed').length;
    group.progress = {
      total: group.subWOs.length,
      completed: completedCount,
      percentage: group.subWOs.length > 0
        ? Math.round((completedCount / group.subWOs.length) * 100)
        : 0
    };

    res.json({ success: true, group });
  } catch (error) {
    console.error('Error fetching batch group:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Helper: Synchronize reschedule for Work Order and its linked Job Cards
const syncRescheduleWorkOrder = async (workOrderId, planned_start_date, planned_end_date, workstation) => {
  // 1. Update the Work Order itself
  const woPayload = {
    planned_start_date: planned_start_date,
    planned_end_date: planned_end_date
  };
  if (workstation && workstation !== 'Unassigned') {
    woPayload.workstation = workstation;
    woWorkstationMap[workOrderId] = workstation;
  }
  const woResp = await erpnextAPI.put(`/Work Order/${workOrderId}`, woPayload);
  const updatedWO = woResp.data.data;

  // If a workstation is specified, update operations child table
  if (workstation && workstation !== 'Unassigned') {
    try {
      const woFull = (await erpnextAPI.get(`/Work Order/${workOrderId}`)).data.data;
      const operations = Array.isArray(woFull.operations) ? woFull.operations : [];
      if (operations.length > 0) {
        const updatedOps = operations.map(op => ({
          ...op,
          workstation: workstation
        }));
        await erpnextAPI.put(`/Work Order/${workOrderId}`, { operations: updatedOps });
      }
    } catch (e) {
      console.warn('Failed to update operations for Work Order', workOrderId, e.message);
    }
  }

  // 2. Fetch all Job Cards linked to this Work Order
  let updatedJobCards = [];
  try {
    const jcListResp = await erpnextAPI.get('/Job Card', {
      params: {
        fields: JSON.stringify(['name', 'from_time', 'to_time', 'docstatus']),
        filters: JSON.stringify([
          ['work_order', '=', workOrderId],
          ['docstatus', '!=', 2]
        ]),
        limit_page_length: 50
      }
    });

    const jobCards = jcListResp.data.data || [];
    if (jobCards.length > 0) {
      const targetStart = new Date(planned_start_date.replace(' ', 'T'));
      const targetEnd = new Date((planned_end_date || planned_start_date).replace(' ', 'T'));

      for (const jc of jobCards) {
        try {
          // Calculate duration of existing job card or default to full day / shift
          let fromTimeStr = `${planned_start_date.split(' ')[0]} 08:00:00`;
          let toTimeStr = `${(planned_end_date || planned_start_date).split(' ')[0]} 17:00:00`;

          if (jc.from_time && jc.to_time) {
            const originalStart = new Date(jc.from_time.replace(' ', 'T'));
            const originalEnd = new Date(jc.to_time.replace(' ', 'T'));
            const durationMs = originalEnd.getTime() - originalStart.getTime();

            const newStart = new Date(targetStart);
            newStart.setHours(originalStart.getHours(), originalStart.getMinutes(), originalStart.getSeconds());
            const newEnd = new Date(newStart.getTime() + Math.max(durationMs, 30 * 60 * 1000));

            const pad = (n) => String(n).padStart(2, '0');
            fromTimeStr = `${newStart.getFullYear()}-${pad(newStart.getMonth() + 1)}-${pad(newStart.getDate())} ${pad(newStart.getHours())}:${pad(newStart.getMinutes())}:${pad(newStart.getSeconds())}`;
            toTimeStr = `${newEnd.getFullYear()}-${pad(newEnd.getMonth() + 1)}-${pad(newEnd.getDate())} ${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}:${pad(newEnd.getSeconds())}`;
          }

          await updateJobCardSchedule(jc.name, fromTimeStr, toTimeStr);
          if (workstation && workstation !== 'Unassigned') {
            await erpnextAPI.put(`/Job Card/${jc.name}`, { workstation });
          }
          updatedJobCards.push(jc.name);
        } catch (jcErr) {
          console.warn(`Could not sync Job Card ${jc.name}:`, jcErr.message);
        }
      }
    }
  } catch (err) {
    console.warn(`Failed to fetch linked Job Cards for Work Order ${workOrderId}:`, err.message);
  }

  return { workOrder: updatedWO, updatedJobCards };
};

// Helper: Synchronize reschedule for Job Card and propagate to parent Work Order
const syncRescheduleJobCard = async (jobCardId, from_time, to_time) => {
  // 1. Update the Job Card itself
  const jcResp = await updateJobCardSchedule(jobCardId, from_time, to_time);
  const updatedJC = jcResp.data.data;
  let updatedWO = null;

  // 2. If Job Card is linked to a Work Order, update the Work Order planned dates
  const workOrderId = updatedJC.work_order;
  if (workOrderId) {
    try {
      const jcListResp = await erpnextAPI.get('/Job Card', {
        params: {
          fields: JSON.stringify(['name', 'from_time', 'to_time', 'docstatus']),
          filters: JSON.stringify([
            ['work_order', '=', workOrderId],
            ['docstatus', '!=', 2]
          ]),
          limit_page_length: 50
        }
      });

      const jobCards = jcListResp.data.data || [];
      const validDates = [];
      jobCards.forEach(j => {
        const f = j.name === jobCardId ? from_time : j.from_time;
        const t = j.name === jobCardId ? to_time : j.to_time;
        if (f) validDates.push(new Date(f.replace(' ', 'T')));
        if (t) validDates.push(new Date(t.replace(' ', 'T')));
      });

      if (validDates.length > 0) {
        const minDate = new Date(Math.min(...validDates.map(d => d.getTime())));
        const maxDate = new Date(Math.max(...validDates.map(d => d.getTime())));
        const pad = (n) => String(n).padStart(2, '0');
        const minDateStr = `${minDate.getFullYear()}-${pad(minDate.getMonth() + 1)}-${pad(minDate.getDate())}`;
        const maxDateStr = `${maxDate.getFullYear()}-${pad(maxDate.getMonth() + 1)}-${pad(maxDate.getDate())}`;

        const woPut = await erpnextAPI.put(`/Work Order/${workOrderId}`, {
          planned_start_date: minDateStr,
          planned_end_date: maxDateStr
        });
        updatedWO = woPut.data.data;
      }
    } catch (woErr) {
      console.warn(`Could not sync parent Work Order ${workOrderId}:`, woErr.message);
    }
  }

  return { jobCard: updatedJC, parentWorkOrder: updatedWO };
};

// Update Work Order dates (reschedule with automatic Job Card sync)
app.put('/api/work-orders/:id/reschedule', async (req, res) => {
  try {
    const { planned_start_date, planned_end_date, sync_job_cards = true } = req.body;

    if (sync_job_cards) {
      const result = await syncRescheduleWorkOrder(req.params.id, planned_start_date, planned_end_date || planned_start_date);
      return res.json({
        success: true,
        message: `Work Order ${req.params.id} & ${result.updatedJobCards.length} linked Job Cards rescheduled`,
        data: result
      });
    }

    const response = await erpnextAPI.put(`/Work Order/${req.params.id}`, {
      planned_start_date: planned_start_date,
      planned_end_date: planned_end_date
    });

    res.json({
      success: true,
      message: `Work Order ${req.params.id} rescheduled`,
      data: response.data.data
    });
  } catch (error) {
    console.error('Work Order reschedule error:', error.response ? error.response.data : error.message);
    const userMessage = parseERPNextError(error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: userMessage
    });
  }
});

// Unified Synchronized Reschedule Endpoint
app.put('/api/schedule/sync-reschedule', async (req, res) => {
  try {
    const { type, docName, start, end, workOrderId, workstation } = req.body;

    if (!type || !docName) {
      return res.status(400).json({ success: false, error: 'type and docName are required' });
    }

    if (type === 'workorder') {
      const result = await syncRescheduleWorkOrder(docName, start, end || start, workstation);
      return res.json({
        success: true,
        message: `Work Order ${docName} and ${result.updatedJobCards.length} linked Job Card(s) updated`,
        data: result
      });
    } else if (type === 'jobcard') {
      const result = await syncRescheduleJobCard(docName, start, end || start);
      return res.json({
        success: true,
        message: `Job Card ${docName} updated${result.parentWorkOrder ? ` & synced with Work Order ${result.parentWorkOrder.name}` : ''}`,
        data: result
      });
    } else {
      return res.status(400).json({ success: false, error: `Unsupported doc type: ${type}` });
    }
  } catch (error) {
    console.error('Sync reschedule error:', error.response ? error.response.data : error.message);
    const userMessage = parseERPNextError(error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: userMessage,
      details: error.response ? error.response.data : null
    });
  }
});

// ==================== WORKSTATION ENDPOINTS ====================

// Get all Workstations
app.get('/api/workstations', async (req, res) => {
  try {
    const wsResp = await erpnextAPI.get('/Workstation', {
      params: {
        fields: JSON.stringify(['name', 'workstation_name', 'workstation_type', 'status']),
        filters: JSON.stringify([['disabled', '=', 0]]),
        limit_page_length: 500
      }
    });
    res.json(wsResp.data.data || []);
  } catch (error) {
    console.error('Error fetching workstations:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});

// ==================== COMBINED SCHEDULE ENDPOINTS ====================

// Get combined schedule (both Job Cards, Work Orders, and Workstations)
app.get('/api/schedule', async (req, res) => {
  try {
    // Fetch Workstations
    let workstations = [];
    try {
      const wsResp = await erpnextAPI.get('/Workstation', {
        params: {
          fields: JSON.stringify(['name', 'workstation_name', 'workstation_type', 'status']),
          filters: JSON.stringify([['disabled', '=', 0]]),
          limit_page_length: 500
        }
      });
      workstations = wsResp.data.data || [];
    } catch (wsErr) {
      console.warn('Could not fetch workstations:', wsErr.message);
    }

    // Fetch Work Order names first, then fetch full documents individually
    const woListResp = await erpnextAPI.get('/Work Order', {
      params: {
        fields: JSON.stringify(['name']),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        limit_page_length: 500
      }
    });
    const woNames = (woListResp.data.data || []).map(r => r.name);
    const workOrdersDetails = await Promise.all(woNames.map(async (n) => {
      try {
        const r = await erpnextAPI.get(`/Work Order/${n}`);
        return r.data.data;
      } catch (e) {
        console.error('Failed to fetch Work Order', n, e.response ? e.response.data : e.message);
        return null;
      }
    }));

    // Fetch Job Card names first, then fetch full documents individually
    const jcListResp = await erpnextAPI.get('/Job Card', {
      params: {
        fields: JSON.stringify(['name']),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        limit_page_length: 500
      }
    });
    const jcNames = (jcListResp.data.data || []).map(r => r.name);
    const jobCardsDetails = await Promise.all(jcNames.map(async (n) => {
      try {
        const r = await erpnextAPI.get(`/Job Card/${n}`);
        return normalizeJobCardTimes(r.data.data);
      } catch (e) {
        console.error('Failed to fetch Job Card', n, e.response ? e.response.data : e.message);
        return null;
      }
    }));

    // Overlay the in-memory workstation map onto WO data so Draft WOs
    // (which have no operations yet) still appear in the correct matrix row.
    const workOrdersWithStation = workOrdersDetails.filter(Boolean).map(wo => {
      const mappedStation = woWorkstationMap[wo.name];
      if (mappedStation && !wo.workstation) {
        return { ...wo, workstation: mappedStation };
      }
      return wo;
    });

    // Enrich Work Orders with batch group metadata from ERPNext
    const woToBatchMap = {};
    const batchGroupsList = [];
    const liveWoMap = {};
    (workOrdersDetails || []).filter(Boolean).forEach(w => {
      liveWoMap[w.name] = w;
    });

    try {
      const vwoList = await erpnextAPI.get('/Virtual Work Order', {
        params: {
          fields: JSON.stringify(['name', 'creation']),
          filters: JSON.stringify([['docstatus', '!=', 2]]),
          limit_page_length: 500
        }
      });
      for (const v of (vwoList.data.data || [])) {
        try {
          const full = await erpnextAPI.get(`/Virtual Work Order/${v.name}`);
          const group = full.data.data;

          const subWOsEnriched = (group.sub_wos || []).map(s => {
            const liveWo = liveWoMap[s.sub_wo];
            const liveStatus = liveWo ? liveWo.status : s.status;
            return {
              name: s.sub_wo,
              batchNumber: s.batch_number,
              status: liveStatus
            };
          });

          const completedCount = subWOsEnriched.filter(s => (s.status || '').toLowerCase() === 'completed').length;
          const inProcessCount = subWOsEnriched.filter(s => (s.status || '').toLowerCase() === 'in process').length;

          batchGroupsList.push({
            id: group.name,
            masterWO: group.master_wo,
            isVirtualMaster: group.is_virtual_master === 1,
            productionItem: group.production_item,
            bomNo: group.bom_no,
            batchCount: group.batch_count,
            qtyPerBatch: group.qty_per_batch,
            totalQty: group.total_qty,
            plannedDate: group.planned_date,
            workstation: group.workstation,
            createdAt: group.creation,
            subWOs: subWOsEnriched,
            progress: {
              total: subWOsEnriched.length,
              completed: completedCount,
              inProcess: inProcessCount,
              percentage: subWOsEnriched.length > 0 ? Math.round((completedCount / subWOsEnriched.length) * 100) : 0
            }
          });

          // Mark master WO
          if (group.master_wo) {
            woToBatchMap[group.master_wo] = {
              batchGroupId: group.name,
              role: 'master',
              batchNumber: 0,
              batchCount: group.batch_count,
              productionItem: group.production_item,
              qtyPerBatch: group.qty_per_batch,
              totalQty: group.total_qty
            };
          }
          // Mark sub WOs and bind workstation
          (group.sub_wos || []).forEach(sub => {
            if (group.workstation && group.workstation !== 'Unassigned') {
              woWorkstationMap[sub.sub_wo] = group.workstation;
            }
            woToBatchMap[sub.sub_wo] = {
              batchGroupId: group.name,
              role: 'sub',
              batchNumber: sub.batch_number,
              batchCount: group.batch_count,
              masterWO: group.master_wo,
              productionItem: group.production_item,
              qtyPerBatch: group.qty_per_batch,
              totalQty: group.total_qty,
              workstation: group.workstation
            };
          });
        } catch (e) { }
      }
    } catch (e) { }

    const enrichedWorkOrders = workOrdersWithStation.map(wo => {
      const batchInfo = woToBatchMap[wo.name];
      const station = wo.workstation || (batchInfo && batchInfo.workstation) || woWorkstationMap[wo.name];
      const enriched = { ...wo };
      if (station) {
        enriched.workstation = station;
        woWorkstationMap[wo.name] = station;
      }
      if (batchInfo) {
        enriched._batchGroup = batchInfo;
      }
      return enriched;
    });

    res.json({
      workstations: workstations,
      jobCards: jobCardsDetails.filter(Boolean),
      workOrders: enrichedWorkOrders,
      batchGroups: batchGroupsList,
      timers: loadTimers()
    });
  } catch (error) {
    console.error('Error fetching schedule:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});

// ==================== SALES FORECAST ENDPOINT ====================

// Helper: aggregate monthly qty per item from all Sales Orders
const buildMonthlyTotals = (salesOrders) => {
  // { itemCode -> { 'YYYY-MM' -> totalQty } }
  const totals = {};

  salesOrders.forEach(so => {
    const date = so.transaction_date; // 'YYYY-MM-DD'
    if (!date) return;
    const yearMonth = date.substring(0, 7); // 'YYYY-MM'
    (so.items || []).forEach(item => {
      const code = item.item_code;
      if (!code) return;
      if (!totals[code]) totals[code] = {};
      totals[code][yearMonth] = (totals[code][yearMonth] || 0) + (parseFloat(item.qty) || 0);
    });
  });

  return totals;
};

// Helper: generate next N year-month strings after the last known month
const nextMonths = (sortedMonths, n) => {
  const last = sortedMonths[sortedMonths.length - 1] || '2026-08';
  const [y, m] = last.split('-').map(Number);
  const results = [];
  for (let i = 1; i <= n; i++) {
    const nm = m + i;
    const ny = y + Math.floor((nm - 1) / 12);
    const mm = ((nm - 1) % 12) + 1;
    results.push(`${ny}-${String(mm).padStart(2, '0')}`);
  }
  return results;
};

// Helper: Simple Moving Average
const sma = (vals) => vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;

// Helper: Weighted Moving Average (most recent = highest weight)
const wma = (vals) => {
  if (vals.length === 0) return 0;
  const n = vals.length;
  const weights = vals.map((_, i) => i + 1); // weight 1, 2, 3...
  const weightSum = weights.reduce((a, b) => a + b, 0);
  return vals.reduce((sum, v, i) => sum + v * weights[i], 0) / weightSum;
};

// Helper: Linear Trend (least squares regression)
const linearTrend = (vals) => {
  const n = vals.length;
  if (n < 2) return vals[0] || 0;
  const xs = vals.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = vals.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((sum, x, i) => sum + (x - meanX) * (vals[i] - meanY), 0) /
    xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  return Math.max(0, slope * n + intercept); // Forecast for next period
};

app.get('/api/sales-forecast', async (req, res) => {
  try {
    // 1. Fetch all non-cancelled Sales Order names
    const listResp = await erpnextAPI.get('/Sales Order', {
      params: {
        fields: JSON.stringify(['name']),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        limit_page_length: 500
      }
    });
    const names = (listResp.data.data || []).map(r => r.name);

    // 2. Fetch full details for all SOs (parallel with concurrency limit)
    const BATCH = 20;
    const allSOs = [];
    for (let i = 0; i < names.length; i += BATCH) {
      const batch = names.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (n) => {
        try {
          const r = await erpnextAPI.get(`/Sales Order/${n}`);
          const d = r.data.data;
          return {
            name: d.name,
            transaction_date: d.transaction_date,
            customer: d.customer,
            status: d.status,
            items: (d.items || []).map(it => ({
              item_code: it.item_code,
              item_name: it.item_name,
              qty: it.qty,
              rate: it.rate,
              amount: it.amount,
              uom: it.uom
            }))
          };
        } catch (e) {
          return null;
        }
      }));
      allSOs.push(...results.filter(Boolean));
    }

    // 3. Aggregate monthly totals per item
    const monthlyTotals = buildMonthlyTotals(allSOs);

    // 4. Build forecast for each item
    const FORECAST_MONTHS = 3;
    const forecastData = {};

    Object.entries(monthlyTotals).forEach(([itemCode, monthMap]) => {
      const sortedMonths = Object.keys(monthMap).sort();
      const historicalValues = sortedMonths.map(m => monthMap[m]);
      const futureMonths = nextMonths(sortedMonths, FORECAST_MONTHS);

      // Build forecasts for each future month using all 3 methods
      const forecasts = futureMonths.map((fMonth, idx) => {
        const windowVals = historicalValues.slice(-6); // Use last 6 months max

        const smaVal = Math.round(sma(windowVals));
        const wmaVal = Math.round(wma(windowVals));

        // For linear trend: project forward idx+1 periods
        const n = historicalValues.length;
        const xs = historicalValues.map((_, i) => i);
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = historicalValues.reduce((a, b) => a + b, 0) / n;
        const denominator = xs.reduce((s, x) => s + (x - meanX) ** 2, 0);
        const slope = denominator !== 0
          ? xs.reduce((s, x, i) => s + (x - meanX) * (historicalValues[i] - meanY), 0) / denominator
          : 0;
        const intercept = meanY - slope * meanX;
        const trendVal = Math.max(0, Math.round(slope * (n + idx) + intercept));

        return {
          month: fMonth,
          sma: smaVal,
          wma: wmaVal,
          trend: trendVal
        };
      });

      // Trend direction based on last two months
      let trendDirection = 'stable';
      if (historicalValues.length >= 2) {
        const last = historicalValues[historicalValues.length - 1];
        const prev = historicalValues[historicalValues.length - 2];
        const change = ((last - prev) / (prev || 1)) * 100;
        trendDirection = change > 5 ? 'growing' : change < -5 ? 'declining' : 'stable';
      }

      forecastData[itemCode] = {
        itemCode,
        historical: sortedMonths.map(m => ({ month: m, qty: monthMap[m] })),
        forecasts,
        trendDirection,
        totalHistoricalQty: historicalValues.reduce((a, b) => a + b, 0),
        avgMonthlyQty: Math.round(sma(historicalValues))
      };
    });

    res.json({
      success: true,
      totalOrders: allSOs.length,
      items: Object.values(forecastData),
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error generating sales forecast:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date() });
});

// ==================== ERROR HANDLING ====================

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================

//const PORT = process.env.PORT || 3000;
const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`Scheduler API running on http://localhost:${PORT}`);
  console.log(`Connected to ERPNext: ${ERPNEXT_URL}`);
});

module.exports = app;
