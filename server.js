// Backend Server - Express API
// server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const ERPNEXT_URL = process.env.ERPNEXT_URL || 'http://localhost:8080';
const ERPNEXT_API_KEY = process.env.ERPNEXT_API_KEY;
const ERPNEXT_API_SECRET = process.env.ERPNEXT_API_SECRET;

// Create Axios instance for ERPNext
const erpnextAPI = axios.create({
  baseURL: `${ERPNEXT_URL}/api/resource`,
  headers: {
    Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`,
    'Content-Type': 'application/json'
  }
});

// In-memory map: { workOrderName -> workstationName }
// Used to persist the intended workstation for draft WOs that have no operations yet.
const woWorkstationMap = {};

const normalizeJobCardTimes = (jobCard) => {
  const scheduledLogs = Array.isArray(jobCard.scheduled_time_logs) ? jobCard.scheduled_time_logs : [];
  const scheduled = scheduledLogs[0] || {};

  return {
    ...jobCard,
    from_time: scheduled.from_time || jobCard.from_time || jobCard.expected_start_date || jobCard.actual_start_date || null,
    to_time: scheduled.to_time || jobCard.to_time || jobCard.expected_end_date || jobCard.actual_end_date || null
  };
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
      : error.message;

    res.status(isCancelledLink ? 400 : 500).json({ 
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
      const bomResp = await erpnextAPI.get(`/BOM/${bom_no}`);
      const bomData = bomResp.data.data;
      if (Array.isArray(bomData.operations) && bomData.operations.length > 0) {
        woOperations = bomData.operations.map(op => ({
          operation: op.operation,
          workstation: (workstation && workstation !== 'Unassigned') ? workstation : (op.workstation || ''),
          workstation_type: op.workstation_type || '',
          time_in_mins: op.time_in_mins || 0,
          sequence_id: op.sequence_id || 1,
          bom: bom_no,
          description: op.description || op.operation || '',
          hour_rate: op.hour_rate || 0,
          batch_size: op.batch_size || 1
        }));
      }
    } catch (bomErr) {
      console.warn(`Could not fetch BOM ${bom_no} operations:`, bomErr.message);
    }

    const payload = {
      production_item,
      bom_no,
      qty: Number(qty),
      planned_start_date,
      planned_end_date: planned_end_date || planned_start_date,
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

    // Save the intended workstation in the in-memory map so the matrix can
    // place this WO in the correct row
    if (workstation) {
      woWorkstationMap[newWO.name] = workstation;
      console.log(`Saved workstation "${workstation}" for WO ${newWO.name} in memory map`);
    }

    // If a workstation is specified, immediately override every operation's workstation
    // on the Work Order's operations child table, AND any already-created Job Cards.
    if (workstation) {
      // Step 1: Fetch the full WO document to get its operations child table
      try {
        const woFull = (await erpnextAPI.get(`/Work Order/${newWO.name}`)).data.data;
        const operations = Array.isArray(woFull.operations) ? woFull.operations : [];

        if (operations.length > 0) {
          // Override every operation's workstation
          const updatedOps = operations.map(op => ({
            ...op,
            workstation: workstation
          }));
          await erpnextAPI.put(`/Work Order/${newWO.name}`, { operations: updatedOps });
          console.log(`Overrode workstation to "${workstation}" on ${operations.length} operation(s) of WO ${newWO.name}`);
        }
      } catch (e) {
        console.warn('Failed to override operations workstation on Work Order', newWO.name, e.message);
      }

      // Step 2: Also update any Job Cards already linked (in case ERPNext created them on insert)
      try {
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
            await erpnextAPI.put(`/Job Card/${jcName}`, { workstation });
          }));
          console.log(`Set workstation to "${workstation}" on ${jobCardNames.length} Job Card(s) for WO ${newWO.name}`);
        }
      } catch (e) {
        console.warn('Failed to set workstation on Job Cards for Work Order', newWO.name, e.message);
      }
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
    res.status(500).json({ 
      success: false,
      error: error.message 
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
    res.status(500).json({
      success: false,
      error: error.message,
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

    res.json({
      workstations: workstations,
      jobCards: jobCardsDetails.filter(Boolean),
      workOrders: workOrdersWithStation
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Scheduler API running on http://localhost:${PORT}`);
  console.log(`Connected to ERPNext: ${ERPNEXT_URL}`);
});

module.exports = app;
