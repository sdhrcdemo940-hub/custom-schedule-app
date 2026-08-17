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
    // Fetch list of Work Order names, then fetch each Work Order document
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

// Update Work Order dates (reschedule)
app.put('/api/work-orders/:id/reschedule', async (req, res) => {
  try {
    const { planned_start_date, planned_end_date } = req.body;
    
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
    res.status(500).json({ 
      success: false,
      error: error.message 
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

    res.json({
      workstations: workstations,
      jobCards: jobCardsDetails.filter(Boolean),
      workOrders: workOrdersDetails.filter(Boolean)
    });
  } catch (error) {
    console.error('Error fetching schedule:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
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
