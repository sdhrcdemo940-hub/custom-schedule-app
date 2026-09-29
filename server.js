// Backend Server - Express API
// server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
  parseBatchTag,
  parseWorkstationTag,
  composeDescription
} = require('./lib/description-tags');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const ERPNEXT_URL = process.env.ERPNEXT_URL || 'http://localhost:8080';
const ERPNEXT_API_KEY = process.env.ERPNEXT_API_KEY;
const ERPNEXT_API_SECRET = process.env.ERPNEXT_API_SECRET;
const ERPNEXT_TIMEOUT = 120000;
const WO_METHOD_PATH = 'erpnext.manufacturing.doctype.work_order.work_order';

// Create Axios instance for ERPNext resource API
const erpnextHeaders = {
  Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`,
  'Content-Type': 'application/json'
};

const erpnextAPI = axios.create({
  baseURL: `${ERPNEXT_URL}/api/resource`,
  headers: erpnextHeaders,
  timeout: ERPNEXT_TIMEOUT
});

// Create Axios instance for ERPNext whitelisted server methods
const erpnextMethodAPI = axios.create({
  baseURL: `${ERPNEXT_URL}/api/method`,
  headers: erpnextHeaders,
  timeout: ERPNEXT_TIMEOUT
});

// ==================== GENERIC ERPNEXT HELPERS ====================

// Helper: Fetch all records from ERPNext using pagination (limit_page_length: 500)
const fetchAllRecords = async (doctype, fields, filters = []) => {
  const limit = 500;
  let offset = 0;
  let allRecords = [];
  let fetchMore = true;
  let requestCount = 0;

  while (fetchMore) {
    const params = {
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
      limit_start: offset,
      limit_page_length: limit
    };

    requestCount++;
    const response = await erpnextAPI.get(`/${encodeURIComponent(doctype)}`, { params });
    const records = response.data.data || [];
    allRecords = allRecords.concat(records);

    if (records.length < limit) {
      fetchMore = false;
    } else {
      offset += limit;
    }
  }

  return { records: allRecords, requestCount };
};

// Helper: Fetch a single document, returning null instead of throwing on 404
const fetchDoc = async (doctype, name) => {
  const response = await erpnextAPI.get(`/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  return response.data.data;
};

const fetchDocSafe = async (doctype, name) => {
  try {
    return await fetchDoc(doctype, name);
  } catch (error) {
    if (error.response && error.response.status === 404) return null;
    throw error;
  }
};

// Helper: Call a whitelisted ERPNext server method
const callErpnextMethod = async (method, args = {}) => {
  const response = await erpnextMethodAPI.post(`/${method}`, args);
  return response.data;
};

// Helper: Call a whitelisted document method (e.g. Job Card pause_job)
const runDocMethod = async (doctype, name, method, args = {}) => {
  const result = await callErpnextMethod('frappe.client.run_doc_method', { doctype, name, method, args });
  return result.message;
};

// Helper: Submit (docstatus 1) or cancel (docstatus 2) an existing document
const setDocStatus = async (doctype, name, docstatus) => {
  const response = await erpnextAPI.put(
    `/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    { docstatus }
  );
  return response.data.data;
};

// Helper: Strip client-side/framework metadata from a document payload so it can be re-created via REST
const ROW_META_KEYS = ['name', 'parent', 'parentfield', 'parenttype', 'doctype', 'owner', 'creation', 'modified', 'modified_by', 'docstatus', 'idx', '__islocal', '__unsaved'];

const stripRowMeta = (row) => {
  const clean = { ...row };
  ROW_META_KEYS.forEach((key) => delete clean[key]);
  return clean;
};

const stripDocMeta = (doc) => {
  const clean = { ...doc };
  ['__islocal', '__unsaved', '__onload', 'doctype', 'name', 'owner', 'creation', 'modified', 'modified_by', 'docstatus', 'idx'].forEach((key) => delete clean[key]);

  Object.keys(clean).forEach((field) => {
    const value = clean[field];
    if (Array.isArray(value) && value.length > 0 && value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      clean[field] = value.map(stripRowMeta);
    }
  });

  return clean;
};

// Helper: Human readable error text from an ERPNext/axios failure
const errorDetail = (error) => {
  if (error.response && error.response.data) {
    const data = error.response.data;
    if (typeof data === 'string') return data;
    return data.exception || data._server_messages || data.message || JSON.stringify(data);
  }
  return error.message;
};

// ==================== DATE HELPERS ====================

const pad2 = (value) => String(value).padStart(2, '0');

const formatDate = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const formatDateTime = (date) =>
  `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

// Accepts "YYYY-MM-DD", "YYYY-MM-DD HH:MM(:SS)" and native Date objects
const parseDateTime = (value) => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(' ', 'T') : raw;
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
};

// Combine a "YYYY-MM-DD" date with a "HH:MM" / "HH:MM:SS" time into an ERPNext datetime string
const combineDateTime = (dateStr, timeStr) => {
  if (!dateStr) return null;
  const time = timeStr ? String(timeStr).trim() : '';
  const normalized = !time || !/^\d{1,2}:\d{2}/.test(time)
    ? '00:00:00'
    : (time.length === 5 ? `${time}:00` : time);
  return `${dateStr} ${normalized}`;
};

// ==================== TIMER STORE (wo-timers.json) ====================

const TIMERS_FILE = path.join(__dirname, 'wo-timers.json');

let timersCache = null;
let timersWriteChain = Promise.resolve();

const readTimersFile = () => {
  try {
    if (fs.existsSync(TIMERS_FILE)) {
      const raw = fs.readFileSync(TIMERS_FILE, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      }
    }
  } catch (error) {
    console.error('[Timers] Failed to read wo-timers.json:', error.message);
  }
  return {};
};

const getTimers = () => {
  if (!timersCache) timersCache = readTimersFile();
  return timersCache;
};

const persistTimers = () => {
  const snapshot = JSON.stringify(timersCache, null, 2);
  timersWriteChain = timersWriteChain
    .then(() => fs.promises.writeFile(TIMERS_FILE, snapshot, 'utf8'))
    .catch((error) => console.error('[Timers] Failed to write wo-timers.json:', error.message));
  return timersWriteChain;
};

const closeOpenInterval = (timer) => {
  if (timer.lastIntervalStart) {
    const start = timer.lastIntervalStart;
    const end = Date.now();
    const duration = Math.max(0, Math.round((end - start) / 1000));
    timer.intervals = Array.isArray(timer.intervals) ? timer.intervals : [];
    timer.intervals.push({ start, end, duration });
    timer.elapsedSeconds = (Number(timer.elapsedSeconds) || 0) + duration;
    timer.lastIntervalStart = null;
  }
};

// Apply a lifecycle action to a Work Order / Job Card timer and persist it
const updateTimer = (id, action, extra = {}) => {
  const timers = getTimers();
  const existing = timers[id];
  const timer = existing && typeof existing === 'object' ? existing : { id };

  timer.intervals = Array.isArray(timer.intervals) ? timer.intervals : [];
  timer.elapsedSeconds = Number(timer.elapsedSeconds) || 0;

  const nowIso = new Date().toISOString();

  if (action === 'start') {
    if (timer.status !== 'running') {
      closeOpenInterval(timer);
      timer.status = 'running';
      timer.startTime = timer.startTime || nowIso;
      timer.lastIntervalStart = Date.now();
      delete timer.pausedAt;
      delete timer.finishedAt;
      delete timer.cancelledAt;
    }
  } else if (action === 'pause') {
    if (timer.status === 'running') {
      closeOpenInterval(timer);
      timer.status = 'paused';
      timer.pausedAt = nowIso;
    }
  } else if (action === 'resume') {
    if (timer.status !== 'running') {
      closeOpenInterval(timer);
      timer.status = 'running';
      timer.lastIntervalStart = Date.now();
      timer.resumedAt = nowIso;
    }
  } else if (action === 'finish') {
    closeOpenInterval(timer);
    timer.status = 'completed';
    timer.finishedAt = nowIso;
  } else if (action === 'cancel') {
    closeOpenInterval(timer);
    timer.status = 'cancelled';
    timer.cancelledAt = nowIso;
  }

  Object.assign(timer, extra);
  timer.id = id;

  timers[id] = timer;
  persistTimers();

  return timer;
};

const getTimer = (id) => {
  const timers = getTimers();
  const timer = timers[id];
  return timer && typeof timer === 'object' ? timer : null;
};

// ==================== BATCH GROUP HELPERS ====================

// Batch membership and the production line are encoded in the Work Order description so
// that ERPNext stays the single source of truth. See lib/description-tags.js for the
// exact formats and for the parsing/building rules shared with the backfill script.

const WO_LIST_FIELDS = [
  'name',
  'production_item',
  'item_name',
  'bom_no',
  'qty',
  'planned_start_date',
  'planned_end_date',
  'status',
  'docstatus',
  'description',
  'company',
  'creation'
];

const JC_LIST_FIELDS = [
  'name',
  'work_order',
  'production_item',
  'item_name',
  'for_quantity',
  'total_completed_qty',
  'operation',
  'workstation',
  'workstation_type',
  'sequence_id',
  'status',
  'docstatus',
  'expected_start_date',
  'expected_end_date'
];

// Build the batch group model consumed by the frontend:
//   [{ id, productionItem, bomNo, plannedDate, workstation, qtyPerBatch,
//      batchCount, totalQty, masterWO, masterStatus, subWOs: [...] }]
const getBatchGroups = async (workOrderRecords) => {
  const workOrders = workOrderRecords
    || (await fetchAllRecords('Work Order', WO_LIST_FIELDS, [['docstatus', '!=', 2]])).records;

  const woByName = new Map();
  workOrders.forEach((wo) => woByName.set(wo.name, wo));

  // Index every Work Order that carries a batch tag by its group id
  const tagged = new Map();
  workOrders.forEach((wo) => {
    const tag = parseBatchTag(wo.description);
    if (!tag) return;
    if (!tagged.has(tag.groupId)) {
      tagged.set(tag.groupId, { groupId: tag.groupId, master: null, masterTag: null, subs: [] });
    }
    const group = tagged.get(tag.groupId);
    if (tag.role === 'master' && !group.master) {
      group.master = wo;
      group.masterTag = tag;
    } else {
      group.subs.push({ wo, tag });
    }
  });

  // Virtual Work Orders are the authoritative group records
  let virtualWorkOrders = [];
  try {
    const list = await fetchAllRecords('Virtual Work Order', ['name'], [['is_virtual_master', '=', 1]]);
    virtualWorkOrders = await Promise.all(
      list.records.map((row) => fetchDocSafe('Virtual Work Order', row.name))
    );
    virtualWorkOrders = virtualWorkOrders.filter(Boolean);
  } catch (error) {
    console.warn('[BatchGroups] Could not load Virtual Work Orders:', errorDetail(error));
  }

  const groups = new Map();

  virtualWorkOrders.forEach((vwo) => {
    const subWOs = (Array.isArray(vwo.sub_wos) ? vwo.sub_wos : [])
      .map((row) => {
        const wo = woByName.get(row.sub_wo) || null;
        return {
          name: row.sub_wo,
          batchNumber: Number(row.batch_number) || 0,
          status: (wo && wo.status) || row.status || 'Draft',
          qty: wo ? Number(wo.qty) || 0 : 0,
          docstatus: wo ? wo.docstatus : null,
          planned_start_date: wo ? wo.planned_start_date : null,
          planned_end_date: wo ? wo.planned_end_date : null
        };
      })
      .filter((sub) => Boolean(sub.name))
      .sort((a, b) => a.batchNumber - b.batchNumber);

    const taggedGroup = tagged.get(vwo.name);
    const masterWO = vwo.master_wo || (taggedGroup && taggedGroup.master ? taggedGroup.master.name : null);
    const masterDoc = masterWO ? woByName.get(masterWO) : null;
    const reference = masterDoc || subWOs.map((sub) => woByName.get(sub.name)).find(Boolean) || null;

    const batchCount = Number(vwo.batch_count) || subWOs.length || 0;
    const qtyPerBatch = Number(vwo.qty_per_batch) || 0;

    groups.set(vwo.name, {
      id: vwo.name,
      productionItem: vwo.production_item || (reference ? reference.production_item : null),
      itemName: reference ? reference.item_name : null,
      bomNo: vwo.bom_no || (reference ? reference.bom_no : null),
      plannedDate: (masterDoc && masterDoc.planned_start_date)
        || (subWOs[0] && subWOs[0].planned_start_date)
        || vwo.planned_date
        || null,
      workstation: vwo.workstation || null,
      qtyPerBatch,
      batchCount,
      totalQty: Number(vwo.total_qty) || qtyPerBatch * batchCount,
      masterWO: masterWO || null,
      masterStatus: masterDoc ? masterDoc.status || 'Draft' : 'Draft',
      subWOs,
      creation: vwo.creation,
      hasVirtualMaster: Boolean(vwo.is_virtual_master)
    });
  });

  // Groups that exist purely as tagged Work Orders (no Virtual Work Order record)
  tagged.forEach((group, groupId) => {
    if (groups.has(groupId)) return;

    const subWOs = group.subs
      .map(({ wo, tag }) => ({
        name: wo.name,
        batchNumber: tag.batchNumber || 0,
        status: wo.status || 'Draft',
        qty: Number(wo.qty) || 0,
        docstatus: wo.docstatus,
        planned_start_date: wo.planned_start_date,
        planned_end_date: wo.planned_end_date
      }))
      .sort((a, b) => a.batchNumber - b.batchNumber);

    const reference = group.master || subWOs.map((sub) => woByName.get(sub.name)).find(Boolean) || null;
    const batchCount = (group.masterTag && group.masterTag.batchTotal) || subWOs.length;
    const qtyPerBatch = subWOs.length ? subWOs[0].qty : 0;

    groups.set(groupId, {
      id: groupId,
      productionItem: reference ? reference.production_item : null,
      itemName: reference ? reference.item_name : null,
      bomNo: reference ? reference.bom_no : null,
      plannedDate: (group.master && group.master.planned_start_date)
        || (subWOs[0] && subWOs[0].planned_start_date)
        || null,
      workstation: null,
      qtyPerBatch,
      batchCount,
      totalQty: qtyPerBatch * batchCount,
      masterWO: group.master ? group.master.name : null,
      masterStatus: group.master ? group.master.status || 'Draft' : 'Draft',
      subWOs,
      creation: reference ? reference.creation : null,
      hasVirtualMaster: false
    });
  });

  return Array.from(groups.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
};

// Attach `_batchGroup` metadata to a Work Order record so the calendar can group cards
const buildWorkOrderBatchMap = (batchGroups) => {
  const map = new Map();
  batchGroups.forEach((group) => {
    if (group.masterWO) {
      map.set(group.masterWO, {
        batchGroupId: group.id,
        role: 'master',
        batchCount: group.batchCount,
        qtyPerBatch: group.qtyPerBatch,
        totalQty: group.totalQty
      });
    }
    group.subWOs.forEach((sub) => {
      if (map.has(sub.name)) return;
      map.set(sub.name, {
        batchGroupId: group.id,
        role: 'sub',
        batchNumber: sub.batchNumber,
        batchCount: group.batchCount,
        qtyPerBatch: group.qtyPerBatch,
        totalQty: group.totalQty
      });
    });
  });
  return map;
};

// ==================== WORK ORDER HELPERS ====================

// ERPNext stores the production line on the Work Order's `operations` child table,
// not on the document header. A brand new Work Order has every operation's
// `workstation` set to null, which is why freshly created orders used to land in the
// "Unassigned" row of the matrix even though a workstation was chosen in the UI.
let fallbackWorkstationCache = { value: null, expiresAt: 0 };

const getFallbackWorkstation = async () => {
  if (fallbackWorkstationCache.value && Date.now() < fallbackWorkstationCache.expiresAt) {
    return fallbackWorkstationCache.value;
  }

  let value = null;
  try {
    const response = await erpnextAPI.get('/Workstation', {
      params: {
        fields: JSON.stringify(['name', 'status']),
        filters: JSON.stringify([['disabled', '=', 0]]),
        limit_page_length: 200,
        order_by: 'name asc'
      }
    });
    const stations = response.data.data || [];
    const production = stations.find((ws) => ws.status === 'Production');
    value = (production || stations[0] || {}).name || null;
  } catch (error) {
    console.warn('[Workstation] Could not resolve a default workstation:', errorDetail(error));
  }

  fallbackWorkstationCache = { value, expiresAt: Date.now() + 60000 };
  return value;
};

// Resolve which workstation a new Work Order should run on.
// Precedence: explicit request -> workstation already on a BOM operation ->
//              DEFAULT_WORKSTATION env var -> first active ERPNext workstation.
const resolveWorkstation = async (requested, doc) => {
  const explicit = requested && requested !== 'Unassigned' ? String(requested).trim() : '';
  if (explicit) {
    return { workstation: explicit, source: 'request' };
  }

  const operations = Array.isArray(doc.operations) ? doc.operations : [];
  const fromOperations = operations.find((op) => op.workstation);
  if (fromOperations) {
    return { workstation: fromOperations.workstation, source: 'bom' };
  }

  const configured = (process.env.DEFAULT_WORKSTATION || '').trim();
  if (configured) {
    return { workstation: configured, source: 'config' };
  }

  const fallback = await getFallbackWorkstation();
  return { workstation: fallback, source: fallback ? 'default' : null };
};

// Stamp the resolved workstation onto the Work Order's operation rows
const applyWorkstationToOperations = (doc, workstation, { overwrite }) => {
  if (!workstation) return;
  const operations = Array.isArray(doc.operations) ? doc.operations : [];

  operations.forEach((op) => {
    if (overwrite || !op.workstation) {
      op.workstation = workstation;
    }
  });

  doc.operations = operations;
};

const createWorkOrder = async ({
  production_item,
  bom_no,
  qty,
  planned_start_date,
  planned_end_date,
  userDescription,
  batch,
  company,
  workstation
}) => {
  const result = await callErpnextMethod(`${WO_METHOD_PATH}.make_work_order`, {
    bom_no,
    item: production_item,
    qty: Number(qty) || 0
  });

  const doc = stripDocMeta(result.message);

  const resolved = await resolveWorkstation(workstation, doc);
  applyWorkstationToOperations(doc, resolved.workstation, { overwrite: resolved.source === 'request' });

  doc.production_item = production_item;
  if (bom_no) doc.bom_no = bom_no;
  doc.qty = Number(qty) || 0;
  if (company) doc.company = company;
  if (planned_start_date) doc.planned_start_date = planned_start_date;
  if (planned_end_date) doc.planned_end_date = planned_end_date;
  doc.description = composeDescription({
    batch: batch || null,
    workstation: resolved.workstation,
    userDescription
  });

  const created = await erpnextAPI.post('/Work Order', doc);
  return { workOrder: created.data.data, workstation: resolved };
};

// Rewrite a Work Order description, preserving the batch tag and replacing the workstation tag
const restampWorkOrderDescription = async (workOrderName, { batch, workstation, userDescription }) => {
  const workOrder = await fetchDocSafe('Work Order', workOrderName);
  const existingBatch = workOrder ? parseBatchTag(workOrder.description) : null;
  const resolvedWorkstation = workstation !== undefined
    ? workstation
    : (workOrder ? parseWorkstationTag(workOrder.description) : null);

  await erpnextAPI.put(`/Work Order/${encodeURIComponent(workOrderName)}`, {
    description: composeDescription({
      batch: batch || existingBatch,
      workstation: resolvedWorkstation,
      userDescription
    })
  });
};

const createVirtualWorkOrder = async ({ master_wo, production_item, bom_no, planned_date, workstation, qty_per_batch, batch_count, total_qty, subWOs }) => {
  const payload = {
    is_virtual_master: 1,
    master_wo: master_wo || null,
    production_item,
    bom_no: bom_no || null,
    planned_date: planned_date || null,
    workstation: workstation || null,
    qty_per_batch: Number(qty_per_batch) || 0,
    batch_count: Number(batch_count) || 0,
    total_qty: Number(total_qty) || 0,
    docstatus: 1,
    sub_wos: (subWOs || []).map((sub) => ({
      sub_wo: sub.name,
      batch_number: sub.batchNumber,
      status: sub.status || 'Draft'
    }))
  };

  const created = await erpnextAPI.post('/Virtual Work Order', payload);
  return created.data.data;
};

// Create + submit a Stock Entry for a Work Order using ERPNext's own builder
const createStockEntryForWorkOrder = async (workOrderName, purpose, qty) => {
  const result = await callErpnextMethod(`${WO_METHOD_PATH}.make_stock_entry`, {
    work_order_id: workOrderName,
    purpose,
    qty
  });

  const stockEntry = stripDocMeta(result.message);
  const created = await erpnextAPI.post('/Stock Entry', stockEntry);
  const name = created.data.data.name;
  await setDocStatus('Stock Entry', name, 1);
  return name;
};

const changeWorkOrderStatus = async (workOrderName, status) => {
  const result = await callErpnextMethod(`${WO_METHOD_PATH}.stop_unstop`, {
    work_order: workOrderName,
    status
  });
  return result.message;
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

// ==================== JOB CARD ENDPOINTS ====================

// Get all Job Cards
app.get('/api/job-cards', async (req, res) => {
  try {
    const jcResult = await fetchAllRecords('Job Card', JC_LIST_FIELDS, [['docstatus', '!=', 2]]);
    res.json(jcResult.records.map(normalizeJobCardTimes));
  } catch (error) {
    console.error('Error fetching Job Cards:', errorDetail(error));
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});

// Get single Job Card
app.get('/api/job-cards/:id', async (req, res) => {
  try {
    res.json(await fetchDoc('Job Card', req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-sync parent Work Order planned start and end dates based on the earliest and latest Job Cards
const syncWorkOrderDatesFromJobCards = async (workOrderId) => {
  if (!workOrderId) return;
  try {
    const jcFields = [
      'name',
      'work_order',
      'expected_start_date',
      'expected_end_date'
    ];
    const listResp = await erpnextAPI.get('/Job Card', {
      params: {
        fields: JSON.stringify(jcFields),
        filters: JSON.stringify([
          ['work_order', '=', workOrderId],
          ['docstatus', '!=', 2]
        ]),
        limit_page_length: 500
      }
    });

    const rawJCs = listResp.data.data || [];
    if (rawJCs.length === 0) return;

    const jobCards = rawJCs.map(normalizeJobCardTimes);
    let minStart = null;
    let maxEnd = null;

    jobCards.forEach(jc => {
      if (jc.from_time) {
        const s = new Date(String(jc.from_time).replace(' ', 'T'));
        if (!isNaN(s.getTime())) {
          if (!minStart || s < minStart) minStart = s;
        }
      }
      if (jc.to_time) {
        const e = new Date(String(jc.to_time).replace(' ', 'T'));
        if (!isNaN(e.getTime())) {
          if (!maxEnd || e > maxEnd) maxEnd = e;
        }
      }
    });

    if (minStart && maxEnd) {
      const planned_start_date = formatDateTime(minStart);
      const planned_end_date = formatDateTime(maxEnd);

      console.log(`[Auto-Sync] Updating parent Work Order ${workOrderId}: planned_start_date=${planned_start_date}, planned_end_date=${planned_end_date}`);

      await erpnextAPI.put(`/Work Order/${encodeURIComponent(workOrderId)}`, {
        planned_start_date,
        planned_end_date
      });
    }
  } catch (err) {
    console.error(`[Auto-Sync Error] Failed to sync parent Work Order ${workOrderId} dates:`, errorDetail(err));
  }
};

const updateJobCardSchedule = async (jobCardId, from_time, to_time, workstation) => {
  // Fetch the Job Card so we can update the scheduled_time_logs child row if present.
  const jobCard = await fetchDoc('Job Card', jobCardId);
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

  if (workstation && workstation !== 'Unassigned') {
    payload.workstation = workstation;
  }

  const response = await erpnextAPI.put(`/Job Card/${encodeURIComponent(jobCardId)}`, payload);

  // Automatically update parent Work Order to span from the earliest Job Card to the latest Job Card
  if (jobCard.work_order) {
    await syncWorkOrderDatesFromJobCards(jobCard.work_order);
  }

  return response;
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
    console.error('Job Card reschedule error:', errorDetail(error));
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
    const woResult = await fetchAllRecords('Work Order', WO_LIST_FIELDS, [['docstatus', '!=', 2]]);
    res.json(woResult.records);
  } catch (error) {
    console.error('Error fetching Work Orders:', errorDetail(error));
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});

// Get single Work Order
app.get('/api/work-orders/:id', async (req, res) => {
  try {
    res.json(await fetchDoc('Work Order', req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a single Work Order
app.post('/api/work-orders', async (req, res) => {
  const { production_item, bom_no, qty, planned_start_date, planned_end_date, description, company, workstation } = req.body || {};

  if (!production_item || !bom_no || !qty) {
    return res.status(400).json({ success: false, error: 'production_item, bom_no and qty are required' });
  }
  if (!(Number(qty) > 0)) {
    return res.status(400).json({ success: false, error: 'qty must be greater than zero' });
  }

  try {
    const { workOrder, workstation: resolvedWorkstation } = await createWorkOrder({
      production_item,
      bom_no,
      qty: Number(qty),
      planned_start_date: planned_start_date || null,
      planned_end_date: planned_end_date || null,
      userDescription: description || '',
      company,
      workstation
    });

    res.json({
      success: true,
      message: `Work Order ${workOrder.name} created for ${production_item}${resolvedWorkstation.workstation ? ` on ${resolvedWorkstation.workstation}` : ''}`,
      data: workOrder,
      workstation: resolvedWorkstation.workstation,
      workstationSource: resolvedWorkstation.source
    });
  } catch (error) {
    console.error('Create Work Order error:', errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// Update Work Order dates (reschedule)
app.put('/api/work-orders/:id/reschedule', async (req, res) => {
  try {
    const { planned_start_date, planned_end_date } = req.body;

    const response = await erpnextAPI.put(`/Work Order/${encodeURIComponent(req.params.id)}`, {
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

// ==================== BATCH WORK ORDER ENDPOINTS ====================

// List every batch group (1 Master WO + N Sub-Work-Orders)
app.get('/api/batch-work-orders', async (req, res) => {
  try {
    const groups = await getBatchGroups();
    res.json({ success: true, count: groups.length, groups });
  } catch (error) {
    console.error('Error fetching batch work orders:', errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// Create 1 Master Work Order + N Sub-Work-Orders and register them as a batch group
app.post('/api/batch-work-orders', async (req, res) => {
  const {
    production_item,
    bom_no,
    qty,
    batch_count,
    planned_start_date,
    planned_end_date,
    planned_start_time,
    planned_end_time,
    description,
    workstation,
    company
  } = req.body || {};

  if (!production_item || !bom_no || !qty) {
    return res.status(400).json({ success: false, error: 'production_item, bom_no and qty are required' });
  }

  const qtyPerBatch = Number(qty);
  const subCount = Math.max(2, parseInt(batch_count, 10) || 2);

  if (!(qtyPerBatch > 0)) {
    return res.status(400).json({ success: false, error: 'qty must be greater than zero' });
  }

  const startDateTime = combineDateTime(planned_start_date, planned_start_time) || combineDateTime(planned_start_date, '08:00');
  const endDateTime = combineDateTime(planned_end_date || planned_start_date, planned_end_time) || combineDateTime(planned_end_date || planned_start_date, '17:00');
  const userDescription = String(description || '').trim();

  const createdWorkOrders = [];

  try {
    // 1. Master Work Order covering the full batch quantity
    const master = await createWorkOrder({
      production_item,
      bom_no,
      qty: qtyPerBatch * subCount,
      planned_start_date: startDateTime,
      planned_end_date: endDateTime,
      batch: { groupId: 'Pending', role: 'master', batchTotal: subCount },
      userDescription,
      company,
      workstation
    });
    const masterWO = master.workOrder;
    const groupWorkstation = master.workstation.workstation;
    createdWorkOrders.push(masterWO.name);

    // 2. Sub Work Orders — one per batch
    const subWOs = [];
    for (let batchNumber = 1; batchNumber <= subCount; batchNumber++) {
      const sub = await createWorkOrder({
        production_item,
        bom_no,
        qty: qtyPerBatch,
        planned_start_date: startDateTime,
        planned_end_date: endDateTime,
        batch: { groupId: 'Pending', role: 'sub', batchNumber, batchTotal: subCount, masterWO: masterWO.name },
        userDescription,
        company,
        // Reuse the workstation resolved for the master so the whole batch stays on one line
        workstation: groupWorkstation
      });
      createdWorkOrders.push(sub.workOrder.name);
      subWOs.push({ name: sub.workOrder.name, batchNumber, status: sub.workOrder.status || 'Draft' });
    }

    // 3. Register the group as a Virtual Work Order
    const group = await createVirtualWorkOrder({
      master_wo: masterWO.name,
      production_item,
      bom_no,
      planned_date: (planned_start_date || startDateTime || '').slice(0, 10) || null,
      workstation: groupWorkstation || null,
      qty_per_batch: qtyPerBatch,
      batch_count: subCount,
      total_qty: qtyPerBatch * subCount,
      subWOs
    });

    // 4. Replace the placeholder "Pending" group id with the real group id
    await restampWorkOrderDescription(masterWO.name, {
      batch: { groupId: group.name, role: 'master', batchTotal: subCount },
      workstation: groupWorkstation,
      userDescription
    });

    for (const sub of subWOs) {
      await restampWorkOrderDescription(sub.name, {
        batch: { groupId: group.name, role: 'sub', batchNumber: sub.batchNumber, batchTotal: subCount, masterWO: masterWO.name },
        workstation: groupWorkstation,
        userDescription
      });
    }

    res.json({
      success: true,
      message: `Created 1 Master WO (${masterWO.name}) + ${subCount} Sub-Work-Orders for batch group ${group.name}${groupWorkstation ? ` on ${groupWorkstation}` : ''}`,
      data: {
        groupId: group.name,
        masterWO: masterWO.name,
        subWOs,
        productionItem: production_item,
        qtyPerBatch,
        batchCount: subCount,
        totalQty: qtyPerBatch * subCount,
        plannedStartDate: startDateTime,
        plannedEndDate: endDateTime
      },
      workstation: groupWorkstation,
      workstationSource: master.workstation.source
    });
  } catch (error) {
    console.error('Create batch Work Orders error:', errorDetail(error));
    res.status(500).json({
      success: false,
      error: errorDetail(error),
      details: { createdWorkOrders }
    });
  }
});

// Shift an entire batch group (Master WO + every Sub-Work-Order) to a new window
app.put('/api/batch-work-orders/:id/reschedule', async (req, res) => {
  const groupId = req.params.id;
  const { planned_start_date, planned_end_date } = req.body || {};

  const newStart = parseDateTime(planned_start_date);
  const newEnd = parseDateTime(planned_end_date);

  if (!newStart) {
    return res.status(400).json({ success: false, error: 'planned_start_date is required' });
  }

  try {
    const groups = await getBatchGroups();
    const group = groups.find((entry) => entry.id === groupId);

    if (!group) {
      return res.status(404).json({ success: false, error: `Batch group ${groupId} not found` });
    }

    const workOrderNames = Array.from(new Set(
      [group.masterWO, ...group.subWOs.map((sub) => sub.name)].filter(Boolean)
    ));

    const workOrders = (await Promise.all(workOrderNames.map((name) => fetchDocSafe('Work Order', name)))).filter(Boolean);

    if (workOrders.length === 0) {
      return res.status(404).json({ success: false, error: `No Work Orders found for batch group ${groupId}` });
    }

    const existingStarts = workOrders
      .map((wo) => parseDateTime(wo.planned_start_date))
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime());

    const base = existingStarts[0] || newStart;
    const deltaMs = newStart.getTime() - base.getTime();

    const updatedWOs = [];
    for (const wo of workOrders) {
      const oldStart = parseDateTime(wo.planned_start_date);
      const oldEnd = parseDateTime(wo.planned_end_date);

      let nextStart = oldStart ? new Date(oldStart.getTime() + deltaMs) : newStart;
      let nextEnd = oldEnd ? new Date(oldEnd.getTime() + deltaMs) : (newEnd || nextStart);

      if (group.masterWO && wo.name === group.masterWO && newEnd) {
        nextStart = newStart;
        nextEnd = newEnd;
      }

      await erpnextAPI.put(`/Work Order/${encodeURIComponent(wo.name)}`, {
        planned_start_date: formatDateTime(nextStart),
        planned_end_date: formatDateTime(nextEnd)
      });

      updatedWOs.push(wo.name);
    }

    // Keep the group's planned date in step with the new window
    if (group.hasVirtualMaster) {
      try {
        await erpnextAPI.put(`/Virtual Work Order/${encodeURIComponent(groupId)}`, {
          planned_date: formatDate(newStart)
        });
      } catch (error) {
        console.warn(`[BatchGroups] Could not update planned_date on ${groupId}:`, errorDetail(error));
      }
    }

    res.json({
      success: true,
      message: `Batch group ${groupId} rescheduled`,
      data: { updatedWOs }
    });
  } catch (error) {
    console.error('Batch group reschedule error:', errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// ==================== ITEM & BOM ENDPOINTS ====================

// Get active stock items (for the Create WO modal dropdown)
app.get('/api/items', async (req, res) => {
  try {
    const response = await erpnextAPI.get('/Item', {
      params: {
        fields: JSON.stringify(['name', 'item_name', 'item_code', 'item_group', 'stock_uom']),
        filters: JSON.stringify([['disabled', '=', 0]]),
        limit_page_length: 500,
        order_by: 'item_name asc'
      }
    });
    res.json(response.data.data || []);
  } catch (error) {
    console.error('Error fetching items:', errorDetail(error));
    res.status(500).json({ error: error.message });
  }
});

// Get active BOMs, optionally filtered by item
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
    console.error('Error fetching BOMs:', errorDetail(error));
    res.status(500).json({ error: error.message });
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
    console.error('Error fetching workstations:', errorDetail(error));
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});

// ==================== SCHEDULE ENDPOINTS ====================

// Synchronized reschedule: moves a Work Order together with its Job Cards,
// or a single Job Card (which then re-syncs its parent Work Order).
app.put('/api/schedule/sync-reschedule', async (req, res) => {
  const { type, docName, start, end, workstation } = req.body || {};

  if (!type || !docName) {
    return res.status(400).json({ success: false, error: 'type and docName are required' });
  }

  const newStart = parseDateTime(start);
  const newEnd = parseDateTime(end);

  if (!newStart) {
    return res.status(400).json({ success: false, error: 'Invalid or missing start date' });
  }

  try {
    if (type === 'workorder') {
      const workOrder = await fetchDoc('Work Order', docName);
      const oldStart = parseDateTime(workOrder.planned_start_date);
      const oldEnd = parseDateTime(workOrder.planned_end_date);

      const deltaMs = oldStart ? newStart.getTime() - oldStart.getTime() : 0;
      const durationMs = oldStart && oldEnd ? oldEnd.getTime() - oldStart.getTime() : null;
      const finalEnd = newEnd || (durationMs !== null ? new Date(newStart.getTime() + durationMs) : newStart);

      const woPayload = {
        planned_start_date: formatDateTime(newStart),
        planned_end_date: formatDateTime(finalEnd)
      };
      await erpnextAPI.put(`/Work Order/${encodeURIComponent(docName)}`, woPayload);

      // Shift every linked Job Card by the same offset, preserving relative ordering
      const jcResult = await fetchAllRecords('Job Card', JC_LIST_FIELDS, [['work_order', '=', docName], ['docstatus', '!=', 2]]);
      const updatedJobCards = [];

      for (const jc of jcResult.records) {
        const jcStart = parseDateTime(jc.from_time || jc.expected_start_date);
        const jcEnd = parseDateTime(jc.to_time || jc.expected_end_date);
        const shiftedStart = jcStart ? new Date(jcStart.getTime() + deltaMs) : newStart;
        const shiftedEnd = jcEnd ? new Date(jcEnd.getTime() + deltaMs) : finalEnd;

        try {
          await updateJobCardSchedule(jc.name, formatDateTime(shiftedStart), formatDateTime(shiftedEnd), workstation);
          updatedJobCards.push(jc.name);
        } catch (error) {
          console.warn(`[Sync-Reschedule] Skipped Job Card ${jc.name}:`, errorDetail(error));
        }
      }

      // updateJobCardSchedule re-syncs the parent WO from its Job Cards — re-apply the requested window
      await erpnextAPI.put(`/Work Order/${encodeURIComponent(docName)}`, woPayload);

      return res.json({
        success: true,
        data: {
          workOrder: { name: docName, planned_start_date: woPayload.planned_start_date, planned_end_date: woPayload.planned_end_date },
          updatedJobCards
        }
      });
    }

    if (type === 'jobcard') {
      await updateJobCardSchedule(docName, formatDateTime(newStart), formatDateTime(newEnd || newStart), workstation);

      let parentWorkOrder = null;
      try {
        const jobCard = await fetchDoc('Job Card', docName);
        if (jobCard.work_order) parentWorkOrder = { name: jobCard.work_order };
      } catch (error) {
        console.warn(`[Sync-Reschedule] Could not resolve parent Work Order for ${docName}:`, errorDetail(error));
      }

      return res.json({
        success: true,
        data: { updatedJobCards: [docName], parentWorkOrder }
      });
    }

    return res.status(400).json({ success: false, error: `Unsupported reschedule type: ${type}` });
  } catch (error) {
    console.error('Sync reschedule error:', errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// Get combined schedule (Job Cards, Work Orders, Workstations, batch groups and timers)
app.get('/api/schedule', async (req, res) => {
  const startTime = Date.now();
  let totalERPNextRequests = 0;

  try {
    // 1. Fetch Workstations
    const t0 = Date.now();
    let workstations = [];
    try {
      totalERPNextRequests++;
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
    const workstationsMs = Date.now() - t0;

    // 2. Fetch Work Orders in Bulk (Paginated)
    const t1 = Date.now();
    const woResult = await fetchAllRecords('Work Order', WO_LIST_FIELDS, [['docstatus', '!=', 2]]);
    totalERPNextRequests += woResult.requestCount;
    const workOrdersMs = Date.now() - t1;

    // 3. Fetch Job Cards in Bulk (Paginated)
    const t2 = Date.now();
    const jcResult = await fetchAllRecords('Job Card', JC_LIST_FIELDS, [['docstatus', '!=', 2]]);
    totalERPNextRequests += jcResult.requestCount;
    const jobCardsMs = Date.now() - t2;

    // Normalize Job Card time properties
    const normalizedJobCards = jcResult.records.map(normalizeJobCardTimes);

    // Resolve each Work Order's production line.
    // Priority: a linked Job Card (ERPNext's own record) -> the [WORKSTATION: x] tag written
    // at creation time. The Work Order operations child table is not readable via the list API.
    const woWorkstationMap = {};
    jcResult.records.forEach(jc => {
      if (jc.work_order && jc.workstation && !woWorkstationMap[jc.work_order]) {
        woWorkstationMap[jc.work_order] = jc.workstation;
      }
    });
    woResult.records.forEach(wo => {
      if (woWorkstationMap[wo.name]) return;
      const tagged = parseWorkstationTag(wo.description);
      if (tagged) woWorkstationMap[wo.name] = tagged;
    });

    // 4. Build batch groups from the Work Orders we already have
    const t3 = Date.now();
    const batchGroups = await getBatchGroups(woResult.records);
    const batchGroupMap = buildWorkOrderBatchMap(batchGroups);
    const batchGroupsMs = Date.now() - t3;

    const workOrders = woResult.records.map(wo => ({
      ...wo,
      workstation: woWorkstationMap[wo.name] || null,
      _batchGroup: batchGroupMap.get(wo.name) || null
    }));

    const totalTimeMs = Date.now() - startTime;

    // Instrumentation Logs
    console.log(`\n[SCHEDULE] Total time: ${totalTimeMs}ms`);
    console.log(`[SCHEDULE] Workstations: ${workstationsMs}ms`);
    console.log(`[SCHEDULE] Work Orders: ${workOrdersMs}ms (${woResult.records.length} items)`);
    console.log(`[SCHEDULE] Job Cards: ${jobCardsMs}ms (${jcResult.records.length} items)`);
    console.log(`[SCHEDULE] Batch Groups: ${batchGroupsMs}ms (${batchGroups.length} groups)`);
    console.log(`[SCHEDULE] ERPNext request count: ${totalERPNextRequests}\n`);

    res.json({
      workstations,
      jobCards: normalizedJobCards,
      workOrders,
      batchGroups,
      timers: getTimers()
    });
  } catch (error) {
    console.error('Error fetching schedule:', errorDetail(error));
    res.status(500).json({ error: error.message, details: error.response ? error.response.data : null });
  }
});

// ==================== WORK ORDER ACTION ENDPOINTS ====================

// Submit a Work Order if it is still a draft, transfer raw material to WIP and start its timer
const startWorkOrderTimer = async (workOrderName) => {
  const workOrder = await fetchDoc('Work Order', workOrderName);

  if (workOrder.docstatus === 0) {
    await setDocStatus('Work Order', workOrderName, 1);
  }

  let transferStockEntry = getTimer(workOrderName)?.transferStockEntry || null;

  if (!transferStockEntry) {
    const transferred = Number(workOrder.material_transferred_for_manufacturing) || 0;
    const qty = Number(workOrder.qty) || 0;
    const remaining = qty - transferred;

    if (qty > 0 && transferred >= qty) {
      transferStockEntry = 'ALREADY_TRANSFERRED';
    } else if (remaining > 0) {
      try {
        transferStockEntry = await createStockEntryForWorkOrder(workOrderName, 'Material Transfer for Manufacture', remaining);
      } catch (error) {
        console.warn(`[WO ${workOrderName}] Material transfer stock entry failed:`, errorDetail(error));
        transferStockEntry = null;
      }
    }
  }

  const timer = updateTimer(workOrderName, 'start', { transferStockEntry });
  return { timer, transferStockEntry };
};

// Start a Work Order
app.post('/api/work-orders/:id/start', async (req, res) => {
  const workOrderName = req.params.id;

  try {
    const { timer, transferStockEntry } = await startWorkOrderTimer(workOrderName);
    res.json({ success: true, message: `Work Order ${workOrderName} started`, timer, transferStockEntry });
  } catch (error) {
    console.error(`Start Work Order ${workOrderName} error:`, errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// Pause a Work Order (stop_unstop -> "Stopped")
app.post('/api/work-orders/:id/pause', async (req, res) => {
  const workOrderName = req.params.id;

  try {
    try {
      await changeWorkOrderStatus(workOrderName, 'Stopped');
    } catch (error) {
      console.warn(`[WO ${workOrderName}] Could not set ERPNext status to Stopped:`, errorDetail(error));
    }

    const timer = updateTimer(workOrderName, 'pause');
    res.json({ success: true, message: `Work Order ${workOrderName} paused`, timer });
  } catch (error) {
    console.error(`Pause Work Order ${workOrderName} error:`, errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// Resume a Work Order (stop_unstop -> "Resumed")
app.post('/api/work-orders/:id/resume', async (req, res) => {
  const workOrderName = req.params.id;

  try {
    try {
      await changeWorkOrderStatus(workOrderName, 'Resumed');
    } catch (error) {
      console.warn(`[WO ${workOrderName}] Could not set ERPNext status to Resumed:`, errorDetail(error));
    }

    const timer = updateTimer(workOrderName, 'resume');
    res.json({ success: true, message: `Work Order ${workOrderName} resumed`, timer });
  } catch (error) {
    console.error(`Resume Work Order ${workOrderName} error:`, errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// Finish a Work Order: manufacture the finished goods, complete the timer
app.post('/api/work-orders/:id/finish', async (req, res) => {
  const workOrderName = req.params.id;

  try {
    const workOrder = await fetchDoc('Work Order', workOrderName);

    if (workOrder.docstatus === 0) {
      await setDocStatus('Work Order', workOrderName, 1);
    }

    const produced = Number(workOrder.produced_qty) || 0;
    const qty = Number(workOrder.qty) || 0;
    const remaining = qty - produced;

    let manufactureStockEntry = getTimer(workOrderName)?.manufactureStockEntry || null;

    if (!manufactureStockEntry) {
      if (qty > 0 && produced >= qty) {
        manufactureStockEntry = 'ALREADY_MANUFACTURED';
      } else if (remaining > 0) {
        try {
          manufactureStockEntry = await createStockEntryForWorkOrder(workOrderName, 'Manufacture', remaining);
        } catch (error) {
          console.warn(`[WO ${workOrderName}] Manufacture stock entry failed:`, errorDetail(error));
          manufactureStockEntry = null;
        }
      }
    }

    const timer = updateTimer(workOrderName, 'finish', { manufactureStockEntry });
    res.json({ success: true, message: `Work Order ${workOrderName} finished`, timer, manufactureStockEntry });
  } catch (error) {
    console.error(`Finish Work Order ${workOrderName} error:`, errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

// Cancel a Work Order in ERPNext
app.post('/api/work-orders/:id/cancel', async (req, res) => {
  const workOrderName = req.params.id;

  try {
    const workOrder = await fetchDoc('Work Order', workOrderName);

    if (workOrder.docstatus !== 2) {
      await setDocStatus('Work Order', workOrderName, 2);
    }

    const timer = updateTimer(workOrderName, 'cancel');
    res.json({ success: true, message: `Work Order ${workOrderName} cancelled`, timer });
  } catch (error) {
    console.error(`Cancel Work Order ${workOrderName} error:`, errorDetail(error));
    res.status(500).json({
      success: false,
      error: `ERPNext refused to cancel ${workOrderName}: ${errorDetail(error)}`
    });
  }
});

// ==================== JOB CARD ACTION ENDPOINTS ====================

// Shared logic: start a Work Order from a Job Card action
const autoStartParentWorkOrder = async (workOrderName) => {
  if (!workOrderName) return { workOrder: null, woTimer: null, woTransferEntry: null, woAutoStarted: false };

  const existing = getTimer(workOrderName);
  if (existing && existing.status === 'running') {
    return { workOrder: workOrderName, woTimer: existing, woTransferEntry: existing.transferStockEntry || null, woAutoStarted: false };
  }

  try {
    const { timer, transferStockEntry } = await startWorkOrderTimer(workOrderName);
    return {
      workOrder: workOrderName,
      woTimer: timer,
      woTransferEntry: transferStockEntry,
      woAutoStarted: Boolean(timer)
    };
  } catch (error) {
    console.warn(`[JC] Could not auto-start parent Work Order ${workOrderName}:`, errorDetail(error));
    return { workOrder: workOrderName, woTimer: null, woTransferEntry: null, woAutoStarted: false };
  }
};

// Start a Job Card (and auto-start its parent Work Order)
app.post('/api/job-cards/:id/start', async (req, res) => {
  const jobCardName = req.params.id;

  try {
    const jobCard = await fetchDoc('Job Card', jobCardName);

    if (jobCard.docstatus === 0) {
      await setDocStatus('Job Card', jobCardName, 1);
    }

    try {
      await runDocMethod('Job Card', jobCardName, 'start_timer', { start_time: new Date().toISOString() });
    } catch (error) {
      console.warn(`[JC ${jobCardName}] start_timer failed:`, errorDetail(error));
    }

    try {
      await erpnextAPI.put(`/Job Card/${encodeURIComponent(jobCardName)}`, { status: 'Work In Progress' });
    } catch (error) {
      console.warn(`[JC ${jobCardName}] Could not set status to Work In Progress:`, errorDetail(error));
    }

    const timer = updateTimer(jobCardName, 'start', { type: 'jobcard' });
    const parent = await autoStartParentWorkOrder(jobCard.work_order);

    res.json({
      success: true,
      message: `Job Card ${jobCardName} started`,
      timer,
      workOrder: parent.workOrder,
      woTimer: parent.woTimer,
      woTransferEntry: parent.woTransferEntry,
      woAutoStarted: parent.woAutoStarted
    });
  } catch (error) {
    console.error(`Start Job Card ${jobCardName} error:`, errorDetail(error));
    res.status(500).json({ success: false, error: errorDetail(error) });
  }
});

const jobCardSimpleAction = (action, label, methodName, methodArgs) => {
  return async (req, res) => {
    const jobCardName = req.params.id;

    try {
      if (methodName) {
        try {
          await runDocMethod('Job Card', jobCardName, methodName, methodArgs ? methodArgs() : {});
        } catch (error) {
          console.warn(`[JC ${jobCardName}] ${methodName} failed:`, errorDetail(error));
        }
      }

      const timer = updateTimer(jobCardName, action, { type: 'jobcard' });
      res.json({ success: true, message: `Job Card ${jobCardName} ${label}`, timer });
    } catch (error) {
      console.error(`${action} Job Card ${jobCardName} error:`, errorDetail(error));
      res.status(500).json({ success: false, error: errorDetail(error) });
    }
  };
};

app.post('/api/job-cards/:id/pause', jobCardSimpleAction('pause', 'paused', 'pause_job', () => ({ end_time: new Date().toISOString() })));
app.post('/api/job-cards/:id/resume', jobCardSimpleAction('resume', 'resumed', 'resume_job', () => ({ start_time: new Date().toISOString() })));
app.post('/api/job-cards/:id/finish', jobCardSimpleAction('finish', 'completed', 'complete_job_card', null));

// Cancel a Job Card in ERPNext
app.post('/api/job-cards/:id/cancel', async (req, res) => {
  const jobCardName = req.params.id;

  try {
    const jobCard = await fetchDoc('Job Card', jobCardName);

    if (jobCard.docstatus !== 2) {
      await setDocStatus('Job Card', jobCardName, 2);
    }

    const timer = updateTimer(jobCardName, 'cancel', { type: 'jobcard' });
    res.json({ success: true, message: `Job Card ${jobCardName} cancelled`, timer });
  } catch (error) {
    console.error(`Cancel Job Card ${jobCardName} error:`, errorDetail(error));
    res.status(500).json({
      success: false,
      error: `ERPNext refused to cancel ${jobCardName}: ${errorDetail(error)}`
    });
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
