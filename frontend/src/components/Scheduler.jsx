import React, { useState, useEffect, useRef, useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import './Scheduler.css';

const ZOOM_LEVELS = [
  { label: 'Compact (Fit)', dayWidth: 58, fontSize: '10px' },
  { label: 'Standard', dayWidth: 90, fontSize: '11px' },
  { label: 'Comfortable', dayWidth: 140, fontSize: '12px' },
  { label: 'Detailed', dayWidth: 200, fontSize: '13px' },
  { label: 'Expanded', dayWidth: 280, fontSize: '13px' }
];

const Scheduler = () => {
  const calendarRef = useRef(null);
  const matrixScrollRef = useRef(null);

  const [events, setEvents] = useState([]);
  const [backendWorkstations, setBackendWorkstations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const [error, setError] = useState(null);

  // Active view: 'matrix' (Monthly Production Schedule) or 'calendar' (FullCalendar)
  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem('scheduler_active_tab');
    return (saved === 'calendar' || saved === 'matrix') ? saved : 'matrix';
  });
  const [viewFilter, setViewFilter] = useState(() => {
    const saved = localStorage.getItem('scheduler_view_filter');
    return (saved === 'jobcard' || saved === 'workorder' || saved === 'all') ? saved : 'all';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(() => {
    const saved = localStorage.getItem('scheduler_status_filter');
    return saved || 'all';
  });
  const [hideOffStations, setHideOffStations] = useState(false);

  // Matrix navigation state: active month (defaults to current date, e.g. August 2026)
  const [activeDate, setActiveDate] = useState(() => {
    const d = new Date();
    if (d.getFullYear() < 2026) {
      return new Date(2026, 7, 1); // August 2026
    }
    return d;
  });

  const [zoomIndex, setZoomIndex] = useState(() => {
    const saved = localStorage.getItem('scheduler_zoom_index');
    const parsed = parseInt(saved, 10);
    return !isNaN(parsed) && parsed >= 0 && parsed < ZOOM_LEVELS.length ? parsed : 1;
  });
  const [draggedEvent, setDraggedEvent] = useState(null);
  const [dragOverCell, setDragOverCell] = useState(null);

  // ── Create Work Order Modal State ──
  const [createWOModal, setCreateWOModal] = useState(null); // null | { date, workstation }
  const [woItems, setWoItems] = useState([]);
  const [woBoms, setWoBoms] = useState([]);
  const [woSubmitting, setWoSubmitting] = useState(false);
  const [woForm, setWoForm] = useState({
    production_item: '',
    bom_no: '',
    qty: '',
    planned_start_date: '',
    planned_start_time: '08:00',
    planned_end_date: '',
    planned_end_time: '17:00',
    description: ''
  });

  // ── Batch Mode State ──
  const [batchMode, setBatchMode] = useState(false);
  const [batchCount, setBatchCount] = useState(2);

  // ── Batch Group Tracking State ──
  const [batchGroups, setBatchGroups] = useState([]);
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  const [batchPanelLoading, setBatchPanelLoading] = useState(false);
  const [expandedBatchGroup, setExpandedBatchGroup] = useState(null);

  // ── Edit Time / Reschedule Modal State ──
  const [editTimeModal, setEditTimeModal] = useState(null);

  // ── Work Order Live Timer Execution State ──
  const [woTimers, setWoTimers] = useState({});
  const [timerTick, setTimerTick] = useState(0);

  // Tick interval for live updating stopwatch timers every second
  useEffect(() => {
    const interval = setInterval(() => {
      setTimerTick(t => (t + 1) % 1000000);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const API_URL = process.env.REACT_APP_API_URL;
  //const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3500/api';
  useEffect(() => {
    try {
      localStorage.setItem('scheduler_active_tab', activeTab);
    } catch (e) {
      console.error('Failed to save activeTab to localStorage', e);
    }
  }, [activeTab]);

  useEffect(() => {
    try {
      localStorage.setItem('scheduler_view_filter', viewFilter);
    } catch (e) {
      console.error('Failed to save viewFilter to localStorage', e);
    }
  }, [viewFilter]);

  useEffect(() => {
    try {
      localStorage.setItem('scheduler_status_filter', statusFilter);
    } catch (e) {
      console.error('Failed to save statusFilter to localStorage', e);
    }
  }, [statusFilter]);

  useEffect(() => {
    try {
      localStorage.setItem('scheduler_zoom_index', zoomIndex);
    } catch (e) {
      console.error('Failed to save zoomIndex to localStorage', e);
    }
  }, [zoomIndex]);

  useEffect(() => {
    fetchSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = (msg, isError = false) => {
    setToastMessage({ text: msg, isError });
    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  };

  // ── Create Work Order helpers ──
  const openCreateWOModal = async (date, workstation) => {
    const pad = v => String(v).padStart(2, '0');
    const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    setWoForm({
      production_item: '',
      bom_no: '',
      qty: '',
      planned_start_date: dateStr,
      planned_start_time: '08:00',
      planned_end_date: dateStr,
      planned_end_time: '17:00',
      description: ''
    });
    setWoBoms([]);
    setBatchMode(false);
    setBatchCount(2);
    setCreateWOModal({ date, workstation });
    // Fetch items if not already loaded
    if (woItems.length === 0) {
      try {
        const r = await fetch(`${API_URL}/items`);
        const data = await r.json();
        setWoItems(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error('Failed to load items', e);
      }
    }
  };

  const handleWOItemChange = async (itemCode) => {
    setWoForm(f => ({ ...f, production_item: itemCode, bom_no: '' }));
    setWoBoms([]);
    if (!itemCode) return;
    try {
      const r = await fetch(`${API_URL}/boms?item=${encodeURIComponent(itemCode)}`);
      const data = await r.json();
      const boms = Array.isArray(data) ? data : [];
      setWoBoms(boms);
      // Auto-select default BOM
      const defaultBom = boms.find(b => b.is_default) || boms[0];
      if (defaultBom) setWoForm(f => ({ ...f, bom_no: defaultBom.name }));
    } catch (e) {
      console.error('Failed to load BOMs', e);
    }
  };

  const handleWOFormChange = (field, value) => {
    setWoForm(f => ({ ...f, [field]: value }));
  };

  const handleCreateWOSubmit = async (e) => {
    e.preventDefault();
    if (!woForm.production_item || !woForm.bom_no || !woForm.qty || !woForm.planned_start_date) {
      showToast('Please fill all required fields', true);
      return;
    }
    setWoSubmitting(true);
    try {
      const startTime = woForm.planned_start_time || '08:00';
      const endTime = woForm.planned_end_time || '17:00';
      const startDateTime = `${woForm.planned_start_date} ${startTime.length === 5 ? startTime + ':00' : startTime}`;
      const endDate = woForm.planned_end_date || woForm.planned_start_date;
      const endDateTime = `${endDate} ${endTime.length === 5 ? endTime + ':00' : endTime}`;

      if (batchMode && batchCount > 1) {
        // Batch creation mode
        const payload = {
          production_item: woForm.production_item,
          bom_no: woForm.bom_no,
          qty: woForm.qty,
          batch_count: batchCount,
          planned_start_date: woForm.planned_start_date,
          planned_end_date: woForm.planned_end_date || woForm.planned_start_date,
          planned_start_time: startTime,
          planned_end_time: endTime,
          description: woForm.description
        };
        if (createWOModal.workstation && createWOModal.workstation !== 'Unassigned') {
          payload.workstation = createWOModal.workstation;
        }

        const resp = await fetch(`${API_URL}/batch-work-orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (!resp.ok || !result.success) throw new Error(result.error || 'Failed to create batch Work Orders');
        showToast(`✓ ${result.message}`);
      } else {
        // Single WO creation (existing logic)
        const payload = {
          ...woForm,
          planned_start_date: startDateTime,
          planned_end_date: endDateTime
        };
        if (createWOModal.workstation && createWOModal.workstation !== 'Unassigned') {
          payload.workstation = createWOModal.workstation;
        }

        const resp = await fetch(`${API_URL}/work-orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (!resp.ok || !result.success) throw new Error(result.error || 'Failed to create Work Order');
        showToast(`✓ ${result.message}`);
      }

      setCreateWOModal(null);
      await fetchSchedule();
    } catch (err) {
      showToast(`✗ ${err.message}`, true);
    } finally {
      setWoSubmitting(false);
    }
  };

  const openEditTimeModal = (ev) => {
    const ext = ev.extendedProps || {};
    const s = ev.start instanceof Date ? ev.start : new Date(ev.start);
    const e = ev.end ? (ev.end instanceof Date ? ev.end : new Date(ev.end)) : s;
    const pad = n => String(n).padStart(2, '0');

    const sDate = !isNaN(s.getTime()) ? `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}` : '';
    const sTime = !isNaN(s.getTime()) ? `${pad(s.getHours())}:${pad(s.getMinutes())}` : '08:00';

    const eDate = !isNaN(e.getTime()) ? `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}` : sDate;
    const eTime = !isNaN(e.getTime()) ? `${pad(e.getHours())}:${pad(e.getMinutes())}` : '17:00';

    setEditTimeModal({
      eventObj: ev,
      docType: ext.type,
      docName: ext.docName,
      itemCode: ext.itemCode || ext.docName,
      status: ext.status,
      startDate: sDate,
      startTime: sTime,
      endDate: eDate,
      endTime: eTime,
      workstation: ext.workstation || 'Unassigned'
    });
  };

  const handleEditTimeSubmit = async (e) => {
    e.preventDefault();
    if (!editTimeModal) return;
    const { eventObj, startDate, startTime, endDate, endTime, workstation } = editTimeModal;

    const startDateTime = new Date(`${startDate}T${startTime.length === 5 ? startTime + ':00' : startTime}`);
    const endDateTime = new Date(`${endDate || startDate}T${endTime.length === 5 ? endTime + ':00' : endTime}`);

    try {
      await rescheduleEvent(eventObj, startDateTime, endDateTime, workstation);
      setEditTimeModal(null);
    } catch (err) {
      // Toast handles error display
    }
  };

  const parseDateTime = (value) => {
    if (!value) return null;
    if (value instanceof Date) return value;
    const normalized = String(value).replace(' ', 'T');
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d;
  };

  const formatTimeRange = (start, end) => {
    if (!start) return '';
    const s = start instanceof Date ? start : new Date(start);
    if (isNaN(s.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    const sTime = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
    if (end) {
      const e = end instanceof Date ? end : new Date(end);
      if (!isNaN(e.getTime())) {
        const eTime = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
        return `${sTime} – ${eTime}`;
      }
    }
    return sTime;
  };

  const fetchSchedule = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/schedule`);
      if (!response.ok) throw new Error(`Failed to fetch schedule (${response.statusText})`);

      const data = await response.json();

      if (Array.isArray(data.workstations)) {
        setBackendWorkstations(data.workstations);
      }

      const rawJobCards = Array.isArray(data.jobCards) ? data.jobCards : [];
      const rawWorkOrders = Array.isArray(data.workOrders) ? data.workOrders : [];

      // Transform Work Orders (Include all linked Job Cards as text list inside this single box)
      const workOrderEvents = rawWorkOrders.map(wo => {
        const itemCode = wo.production_item || wo.item_name || 'Product';
        const qty = wo.qty || '';
        const startTime = parseDateTime(wo.planned_start_date || wo.creation);
        const endTime = parseDateTime(wo.planned_end_date || wo.planned_start_date || wo.creation);

        // Derive workstation: top-level field first, then fallback to first op
        const firstOpWorkstation = Array.isArray(wo.operations) && wo.operations.length > 0
          ? (wo.operations[0].workstation || '').trim()
          : '';
        const station = (wo.workstation || wo.workstation_name || firstOpWorkstation || 'Unassigned').trim();

        // Find all Job Cards linked to this Work Order
        const linkedJobCards = rawJobCards.filter(jc => jc.work_order === wo.name);
        const opCount = Array.isArray(wo.operations) ? wo.operations.length : linkedJobCards.length;
        const opSummary = opCount > 0 ? `${opCount} ops` : '';
        const title = `${itemCode}${qty ? ` (${qty} kg)` : ''} | WO: ${wo.name}${linkedJobCards.length > 0 ? ` (${linkedJobCards.length} JCs)` : ''}`;

        // Batch group metadata (from enriched backend data)
        const batchGroup = wo._batchGroup || null;

        return {
          id: `wo-${wo.name}`,
          title: title,
          start: startTime,
          end: endTime,
          allDay: false,
          backgroundColor: getStatusColorWO(wo.status),
          borderColor: '#334155',
          extendedProps: {
            type: 'workorder',
            docName: wo.name,
            itemCode: itemCode,
            qty: qty,
            operation: opSummary || 'Production',
            status: wo.status,
            workOrder: wo.name,
            workstation: station,
            jobCards: linkedJobCards,
            timeRange: formatTimeRange(startTime, endTime),
            batchGroup: batchGroup,
            raw: wo
          }
        };
      });

      // Include standalone Job Cards (only if they are NOT already linked to a loaded Work Order)
      const orphanedJobCards = rawJobCards.filter(jc => !jc.work_order || !rawWorkOrders.some(wo => wo.name === jc.work_order));
      const jobCardEvents = orphanedJobCards.map(jc => {
        const startTime = parseDateTime(jc.from_time);
        const endTime = parseDateTime(jc.to_time);
        const itemCode = jc.production_item || jc.item_name || 'Product';
        const qty = jc.for_quantity || jc.total_completed_qty || '';
        const operation = jc.operation || '';
        const station = (jc.workstation || jc.workstation_name || jc.workstation_type || 'Unassigned').trim();
        const woName = jc.work_order || '';

        const title = `${itemCode}${qty ? ` (${qty} kg)` : ''}${woName ? ` | WO: ${woName}` : ''}${operation ? ` • ${operation}` : ''}`;

        return {
          id: `jc-${jc.name}`,
          title: title,
          start: startTime,
          end: endTime,
          allDay: false,
          backgroundColor: getStatusColor(jc.status),
          borderColor: '#1e293b',
          extendedProps: {
            type: 'jobcard',
            docName: jc.name,
            itemCode: itemCode,
            qty: qty,
            operation: operation,
            status: jc.status,
            workOrder: woName,
            workstation: station,
            jobCards: [],
            timeRange: formatTimeRange(startTime, endTime),
            raw: jc
          }
        };
      });

      setEvents([...workOrderEvents, ...jobCardEvents]);

      // Capture batch groups from schedule response
      if (Array.isArray(data.batchGroups)) {
        setBatchGroups(data.batchGroups);
      }

      // Capture active timers from schedule response
      if (data.timers) {
        setWoTimers(data.timers);
      }

      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching schedule:', err);
    } finally {
      setLoading(false);
    }
  };

  // ── Work Order Live Timer Action Handlers ──
  const getWOTimerSeconds = (woName) => {
    const t = woTimers[woName];
    if (!t) return 0;
    if (t.status === 'running' && t.lastIntervalStart) {
      const added = Math.max(0, Math.floor((Date.now() - t.lastIntervalStart) / 1000));
      return (t.elapsedSeconds || 0) + added;
    }
    return t.elapsedSeconds || 0;
  };

  const formatTimerDuration = (totalSeconds) => {
    const s = Math.max(0, Number(totalSeconds) || 0);
    const pad = n => String(n).padStart(2, '0');
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hours > 0) return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
    return `${pad(mins)}:${pad(secs)}`;
  };

  const handleStartTimer = async (woName, e) => {
    if (e) e.stopPropagation();
    try {
      const resp = await fetch(`${API_URL}/work-orders/${encodeURIComponent(woName)}/start`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.error || 'Failed to start timer');
      setWoTimers(prev => ({ ...prev, [woName]: data.timer }));
      const steNote = data.transferStockEntry ? ` [Transfer: ${data.transferStockEntry}]` : '';
      showToast(`▶ Started ${woName}${steNote} — Raw materials transferred to WIP`);
      await fetchSchedule();
    } catch (err) {
      showToast(`✗ Failed to start: ${err.message}`, true);
    }
  };

  const handlePauseTimer = async (woName, e) => {
    if (e) e.stopPropagation();
    try {
      const resp = await fetch(`${API_URL}/work-orders/${encodeURIComponent(woName)}/pause`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.error || 'Failed to pause timer');
      setWoTimers(prev => ({ ...prev, [woName]: data.timer }));
      showToast(`⏸ Paused ${woName} (${formatTimerDuration(data.timer?.elapsedSeconds)})`);
    } catch (err) {
      showToast(`✗ Failed to pause: ${err.message}`, true);
    }
  };

  const handleResumeTimer = async (woName, e) => {
    if (e) e.stopPropagation();
    try {
      const resp = await fetch(`${API_URL}/work-orders/${encodeURIComponent(woName)}/resume`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.error || 'Failed to resume timer');
      setWoTimers(prev => ({ ...prev, [woName]: data.timer }));
      showToast(`▶ Resumed ${woName}`);
    } catch (err) {
      showToast(`✗ Failed to resume: ${err.message}`, true);
    }
  };

  const handleFinishTimer = async (woName, e) => {
    if (e) e.stopPropagation();
    try {
      const resp = await fetch(`${API_URL}/work-orders/${encodeURIComponent(woName)}/finish`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.error || 'Failed to finish timer');
      setWoTimers(prev => ({ ...prev, [woName]: data.timer }));
      const steNote = data.manufactureStockEntry ? ` [Manufacture: ${data.manufactureStockEntry}]` : '';
      showToast(`✓ Completed ${woName}${steNote} — Finished goods manufactured! (Total: ${formatTimerDuration(data.timer?.elapsedSeconds)})`);
      await fetchSchedule();
    } catch (err) {
      showToast(`✗ Failed to finish: ${err.message}`, true);
    }
  };

  // Status colors matching production standards
  const getStatusColor = (status) => {
    const colors = {
      'Completed': '#16a34a',
      'In Progress': '#ea580c',
      'Work In Progress': '#ea580c',
      'Open': '#2563eb',
      'Not Started': '#0284c7',
      'On Hold': '#dc2626',
      'Cancelled': '#64748b'
    };
    return colors[status] || '#2563eb';
  };

  const getStatusColorWO = (status) => {
    const colors = {
      'Completed': '#16a34a',
      'In Process': '#ea580c',
      'In Progress': '#ea580c',
      'Submitted': '#7c3aed',
      'Not Started': '#0284c7',
      'Draft': '#64748b',
      'Stopped': '#dc2626',
      'Cancelled': '#475569'
    };
    return colors[status] || '#7c3aed';
  };

  // Check if a Work Order is locked from drag & drop (already started or completed)
  const isWODragLocked = (event) => {
    const ext = event?.extendedProps || event;
    if (ext?.type !== 'workorder') return false;
    const status = (ext?.status || '').trim();
    return status === 'In Process' || status === 'Completed';
  };

  const formatDateTimeLocal = (date) => {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const formatDateLocal = (date) => {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // Helper: Apply optimistic state updates locally to React state for instant 0ms visual feedback
  const applyOptimisticReschedule = (currentEvents, eventObj, newStart, newEnd, newWorkstation) => {
    const type = eventObj.extendedProps?.type;
    const docName = eventObj.extendedProps?.docName;
    const targetWs = (newWorkstation || eventObj.extendedProps?.workstation || 'Unassigned').trim();

    return currentEvents.map(ev => {
      const ext = ev.extendedProps || {};
      const isTarget = ext.type === type && ext.docName === docName;

      if (isTarget) {
        return {
          ...ev,
          start: newStart,
          end: newEnd,
          extendedProps: {
            ...ext,
            workstation: targetWs,
            timeRange: formatTimeRange(newStart, newEnd)
          }
        };
      }

      // If updating a Work Order, also update linked Job Cards in the same Work Order
      if (type === 'workorder' && ext.type === 'jobcard' && ext.workOrder === docName) {
        const origWOStart = eventObj.start instanceof Date ? eventObj.start : new Date(eventObj.start);
        const origJCStart = ev.start instanceof Date ? ev.start : new Date(ev.start);
        const origJCEnd = ev.end instanceof Date ? ev.end : new Date(ev.end);
        const duration = Math.max(0, origJCEnd.getTime() - origJCStart.getTime());

        const offsetMs = !isNaN(origWOStart.getTime()) && !isNaN(origJCStart.getTime())
          ? origJCStart.getTime() - origWOStart.getTime()
          : 0;

        const updatedJCStart = new Date(newStart.getTime() + offsetMs);
        const updatedJCEnd = new Date(updatedJCStart.getTime() + duration);

        return {
          ...ev,
          start: updatedJCStart,
          end: updatedJCEnd,
          extendedProps: {
            ...ext,
            workstation: targetWs !== 'Unassigned' ? targetWs : ext.workstation,
            timeRange: formatTimeRange(updatedJCStart, updatedJCEnd)
          }
        };
      }

      return ev;
    });
  };

  // Synchronized Reschedule API caller (coordinates Work Orders and child Job Cards together with Optimistic UI)
  const rescheduleEvent = async (eventObj, newStart, newEnd, newWorkstation) => {
    const type = eventObj.extendedProps?.type;
    const docName = eventObj.extendedProps?.docName;
    const itemCode = eventObj.extendedProps?.itemCode || 'Product';
    const workOrder = eventObj.extendedProps?.workOrder;
    if (!type || !docName) throw new Error('Invalid event data');

    // Store previous events state for rollback if backend request fails
    const previousEvents = events;

    // 1. Optimistic Update (Immediate 0ms visual feedback on UI!)
    const optimisticEvents = applyOptimisticReschedule(previousEvents, eventObj, newStart, newEnd, newWorkstation);
    setEvents(optimisticEvents);

    setSyncing(true);
    try {
      const formattedStart = formatDateTimeLocal(newStart);
      const formattedEnd = formatDateTimeLocal(newEnd);

      const response = await fetch(`${API_URL}/schedule/sync-reschedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: type,
          docName: docName,
          start: formattedStart,
          end: formattedEnd,
          workOrderId: workOrder,
          workstation: newWorkstation
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || errData.message || 'Failed to reschedule');
      }

      const resData = await response.json();
      const newDateStr = newStart.toLocaleDateString();

      if (type === 'workorder') {
        const jcCount = resData.data?.updatedJobCards?.length || 0;
        showToast(`✓ Product '${itemCode}' (WO: ${docName} & ${jcCount} linked Job Cards) rescheduled to ${newDateStr}`);
      } else {
        const hasParentWO = resData.data?.parentWorkOrder;
        showToast(`✓ Product '${itemCode}' [JC: ${docName}]${hasParentWO ? ` & parent WO: ${hasParentWO.name}` : ''} rescheduled to ${newDateStr}`);
      }
    } catch (err) {
      console.error('Reschedule error:', err);
      // Revert card position back to original location on failure
      setEvents(previousEvents);
      showToast(`✗ Reschedule failed: ${err.message}`, true);
    } finally {
      setSyncing(false);
    }
  };

  // FullCalendar Custom Event Card Renderer
  const renderEventContent = (eventInfo) => {
    const ext = eventInfo.event.extendedProps || {};
    const isJobCard = ext.type === 'jobcard';
    const itemCode = ext.itemCode || ext.raw?.production_item || ext.docName;
    const woName = ext.workOrder || (ext.type === 'workorder' ? ext.docName : null);
    const qty = ext.qty || ext.raw?.for_quantity || ext.raw?.qty;
    const operation = ext.operation;
    const station = ext.workstation;
    const status = ext.status;
    const jobCards = Array.isArray(ext.jobCards) ? ext.jobCards : [];

    return (
      <div
        className={`fc-custom-event-node ${isJobCard ? 'fc-node-jc' : 'fc-node-wo'}`}
        title={`[${ext.type ? ext.type.toUpperCase() : 'EVENT'}] ${itemCode}\nWork Order: ${woName || 'N/A'}\nDoc: ${ext.docName}\nQty: ${qty || 'N/A'}\nStatus: ${status || 'N/A'}\nWorkstation: ${station || 'N/A'}${jobCards.length > 0 ? `\n\nJob Cards:\n` + jobCards.map(j => `• ${j.name}: ${j.operation || ''} (${j.status || ''})`).join('\n') : ''}`}
      >
        <div className="fc-event-header-row">
          <span className="fc-event-item-name">{itemCode}</span>
          {qty !== undefined && qty !== null && qty !== '' && (
            <span className="fc-event-qty-pill">{qty}</span>
          )}
        </div>

        <div className="fc-event-meta-row">
          {woName && (
            <span className="fc-event-wo-pill">WO: {woName}</span>
          )}
          {isJobCard && (
            <span className="fc-event-jc-pill">JC: {ext.docName}</span>
          )}
        </div>

        {/* Dropdown list view of all Job Cards inside this single Work Order box */}
        {!isJobCard && jobCards.length > 0 ? (
          <details className="fc-event-jc-dropdown" onClick={(e) => e.stopPropagation()}>
            <summary className="fc-event-jc-summary">
              <span>📋 JCs ({jobCards.length})</span>
              <span className="fc-jc-caret">▾</span>
            </summary>
            <div className="fc-event-jc-dropdown-menu">
              {jobCards.map(jc => (
                <div
                  key={jc.name}
                  className="fc-event-jc-dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDoc('jobcard', jc.name);
                  }}
                  title={`Click to open Job Card ${jc.name} in ERPNext\nOperation: ${jc.operation || 'N/A'}\nWorkstation: ${jc.workstation || 'N/A'}\nStatus: ${jc.status || 'N/A'}`}
                >
                  <span className="fc-jc-dot" style={{ backgroundColor: getStatusColor(jc.status) }}>•</span>
                  <span className="fc-jc-name">{jc.name}</span>
                  {jc.operation && <span className="fc-jc-op"> – {jc.operation}</span>}
                </div>
              ))}
            </div>
          </details>
        ) : (
          (operation || (station && station !== 'Unassigned')) && (
            <div className="fc-event-footer-row">
              {station && station !== 'Unassigned' && (
                <span className="fc-event-station-pill">{station}</span>
              )}
              {operation && (
                <span className="fc-event-op-pill">{operation}</span>
              )}
            </div>
          )
        )}
      </div>
    );
  };

  // FullCalendar event drop handler
  const handleFullCalendarDrop = async (info) => {
    const { event } = info;
    // Block drop for locked Work Orders
    if (isWODragLocked({ extendedProps: event.extendedProps })) {
      showToast(`🔒 WO "${event.extendedProps?.docName}" is ${event.extendedProps?.status} and cannot be rescheduled.`, true);
      info.revert();
      return;
    }
    try {
      await rescheduleEvent(
        {
          extendedProps: event.extendedProps
        },
        event.start,
        event.end || event.start,
        event.extendedProps?.workstation
      );
    } catch (err) {
      info.revert();
    }
  };

  // Build a lookup of Off-status workstation names from backend
  const offStationNames = useMemo(() => {
    const set = new Set();
    backendWorkstations.forEach(ws => {
      if ((ws.status || '').toLowerCase() === 'off') {
        const name = (ws.workstation_name || ws.name || '').trim();
        if (name) set.add(name);
      }
    });
    return set;
  }, [backendWorkstations]);

  // List of all distinct workstations (from backend DB + Job Card events only)
  // Work Orders are NOT tied to a single workstation — only Job Cards are.
  const workstationList = useMemo(() => {
    const set = new Set();

    // Add known stations from backend (skip Off-status if toggle is on)
    backendWorkstations.forEach(ws => {
      if (hideOffStations && (ws.status || '').toLowerCase() === 'off') return;
      const name = (ws.workstation_name || ws.name || '').trim();
      if (name) set.add(name);
    });

    const list = Array.from(set).sort();

    // Include Unassigned row only if there are unassigned events
    const hasUnassigned = events.some(e => {
      const w = (e.extendedProps?.workstation || '').trim();
      return !w || w === 'Unassigned';
    });

    if (hasUnassigned) {
      list.push('Unassigned');
    }
    return list;
  }, [backendWorkstations, events, hideOffStations]);

  // Generate all days in the currently selected month
  const monthDays = useMemo(() => {
    const year = activeDate.getFullYear();
    const month = activeDate.getMonth();
    const totalDays = new Date(year, month + 1, 0).getDate();

    const days = [];
    for (let day = 1; day <= totalDays; day++) {
      const d = new Date(year, month, day, 0, 0, 0, 0);
      days.push(d);
    }
    return days;
  }, [activeDate]);

  // Helper to compute ISO Week Number
  const getISOWeekNumber = (d) => {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  };

  // Group month days by Week for the top tier header
  const weekGroups = useMemo(() => {
    const groups = [];
    let currentWeekNum = null;
    let currentDays = [];

    monthDays.forEach(day => {
      const weekNum = getISOWeekNumber(day);
      if (currentWeekNum === null) {
        currentWeekNum = weekNum;
        currentDays = [day];
      } else if (currentWeekNum === weekNum) {
        currentDays.push(day);
      } else {
        groups.push({
          weekNumber: currentWeekNum,
          label: `WEEK ${currentWeekNum}`,
          days: currentDays,
          colSpan: currentDays.length
        });
        currentWeekNum = weekNum;
        currentDays = [day];
      }
    });

    if (currentDays.length > 0) {
      groups.push({
        weekNumber: currentWeekNum,
        label: `WEEK ${currentWeekNum}`,
        days: currentDays,
        colSpan: currentDays.length
      });
    }

    return groups;
  }, [monthDays]);

  // Check if an event falls on a particular date
  const eventIntersectsDay = (ev, day) => {
    if (!ev || !ev.start) return false;
    const s = ev.start instanceof Date ? ev.start : new Date(ev.start);
    let en = ev.end ? (ev.end instanceof Date ? ev.end : new Date(ev.end)) : s;
    if (isNaN(s.getTime())) return false;
    if (isNaN(en.getTime())) en = s;

    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);

    return s <= dayEnd && en >= dayStart;
  };

  // Filtered events — used by the Calendar view (respects all filters including type)
  const filteredEvents = useMemo(() => {
    return events.filter(e => {
      // Type filter (calendar view only)
      if (viewFilter !== 'all' && e.extendedProps?.type !== viewFilter) {
        return false;
      }
      // Status filter
      if (statusFilter !== 'all' && (e.extendedProps?.status || '').toLowerCase() !== statusFilter.toLowerCase()) {
        return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const title = (e.title || '').toLowerCase();
        const item = (e.extendedProps?.itemCode || '').toLowerCase();
        const wo = (e.extendedProps?.workOrder || '').toLowerCase();
        const doc = (e.extendedProps?.docName || '').toLowerCase();
        const op = (e.extendedProps?.operation || '').toLowerCase();
        const ws = (e.extendedProps?.workstation || '').toLowerCase();
        if (!title.includes(query) && !item.includes(query) && !wo.includes(query) && !doc.includes(query) && !op.includes(query) && !ws.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [events, viewFilter, statusFilter, searchQuery]);

  // Matrix events — shows both Job Cards and Work Orders
  const matrixEvents = useMemo(() => {
    return events.filter(e => {
      // Status filter
      if (statusFilter !== 'all' && (e.extendedProps?.status || '').toLowerCase() !== statusFilter.toLowerCase()) {
        return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const title = (e.title || '').toLowerCase();
        const item = (e.extendedProps?.itemCode || '').toLowerCase();
        const wo = (e.extendedProps?.workOrder || '').toLowerCase();
        const doc = (e.extendedProps?.docName || '').toLowerCase();
        const op = (e.extendedProps?.operation || '').toLowerCase();
        const ws = (e.extendedProps?.workstation || '').toLowerCase();
        if (!title.includes(query) && !item.includes(query) && !wo.includes(query) && !doc.includes(query) && !op.includes(query) && !ws.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [events, statusFilter, searchQuery]);

  // Zoom handlers
  const handleZoomIn = () => setZoomIndex(i => Math.min(ZOOM_LEVELS.length - 1, i + 1));
  const handleZoomOut = () => setZoomIndex(i => Math.max(0, i - 1));

  const currentZoom = ZOOM_LEVELS[zoomIndex];

  // Month navigation
  const prevMonth = () => {
    setActiveDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  };
  const nextMonth = () => {
    setActiveDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  };
  const goToToday = () => {
    setActiveDate(new Date());
  };

  // Drag and Drop handlers for Matrix
  const handleDragStart = (e, ev) => {
    // Block drag for locked Work Orders
    if (isWODragLocked(ev)) {
      e.preventDefault();
      showToast(`🔒 WO "${ev.extendedProps?.docName}" is ${ev.extendedProps?.status} and cannot be rescheduled.`, true);
      return;
    }
    setDraggedEvent(ev);
    try {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: ev.id }));
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) {
      // ignore
    }
  };

  // Batch Group Drag Handler
  const handleBatchGroupDragStart = (e, groupId, eventsInGroup) => {
    const lockedWO = eventsInGroup.find(ev => isWODragLocked(ev));
    if (lockedWO) {
      e.preventDefault();
      showToast(`🔒 Batch Group "${groupId}" has locked Work Orders (${lockedWO.extendedProps?.docName}) and cannot be rescheduled.`, true);
      return;
    }

    setDraggedEvent({
      isBatchGroup: true,
      groupId: groupId,
      events: eventsInGroup
    });
    try {
      e.dataTransfer.setData('text/plain', JSON.stringify({ isBatchGroup: true, groupId }));
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) {
      // ignore
    }
  };

  const rescheduleBatchGroup = async (groupId, eventsInGroup, targetDate, targetWorkstation) => {
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}`;
    const previousEvents = events;

    const targetWs = (targetWorkstation || 'Unassigned').trim();
    const optimistic = events.map(ev => {
      if (ev.extendedProps?.batchGroup?.batchGroupId === groupId) {
        const newStart = new Date(targetDate);
        newStart.setHours(8, 0, 0);
        const newEnd = new Date(targetDate);
        newEnd.setHours(17, 0, 0);
        return {
          ...ev,
          start: newStart,
          end: newEnd,
          extendedProps: {
            ...ev.extendedProps,
            workstation: targetWs
          }
        };
      }
      return ev;
    });

    setEvents(optimistic);
    setSyncing(true);

    try {
      const resp = await fetch(`${API_URL}/batch-work-orders/${groupId}/reschedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planned_start_date: dateStr,
          workstation: targetWs
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.error || 'Failed to reschedule batch group');

      showToast(`✓ Batch Group ${groupId} (${data.data?.updatedWOs?.length || eventsInGroup.length} Sub-Work-Orders) rescheduled to ${dateStr}`);
      await fetchSchedule();
    } catch (err) {
      console.error('Batch group reschedule error:', err);
      setEvents(previousEvents);
      showToast(`✗ Reschedule failed: ${err.message}`, true);
    } finally {
      setSyncing(false);
    }
  };

  const handleDragEnd = () => {
    setDraggedEvent(null);
    setDragOverCell(null);
  };

  const handleCellDragOver = (e, cellKey, cellStationName) => {
    e.preventDefault();
    if (!draggedEvent) return;

    if (!draggedEvent.isBatchGroup) {
      const isJobCard = draggedEvent.extendedProps?.type === 'jobcard';
      const originalWs = (draggedEvent.extendedProps?.workstation || 'Unassigned').trim();

      // If it is a Job Card, do NOT allow drag over other workstation rows
      if (isJobCard && originalWs !== cellStationName.trim()) {
        e.dataTransfer.dropEffect = 'none';
        if (dragOverCell === cellKey) {
          setDragOverCell(null);
        }
        return;
      }
    }

    e.dataTransfer.dropEffect = 'move';
    if (dragOverCell !== cellKey) {
      setDragOverCell(cellKey);
    }
  };

  const handleCellDragLeave = (e, cellKey) => {
    if (dragOverCell === cellKey) {
      setDragOverCell(null);
    }
  };

  const handleCellDrop = async (e, targetDate, targetWorkstation) => {
    e.preventDefault();
    setDragOverCell(null);
    const ev = draggedEvent;
    if (!ev) return;

    if (ev.isBatchGroup) {
      await rescheduleBatchGroup(ev.groupId, ev.events, targetDate, targetWorkstation);
      setDraggedEvent(null);
      return;
    }

    // Block drop for locked Work Orders
    if (isWODragLocked(ev)) {
      showToast(`🔒 WO "${ev.extendedProps?.docName}" is ${ev.extendedProps?.status} and cannot be rescheduled.`, true);
      setDraggedEvent(null);
      return;
    }

    const isJobCard = ev.extendedProps?.type === 'jobcard';
    const originalWs = (ev.extendedProps?.workstation || 'Unassigned').trim();

    // Prevent dropping Job Cards onto a different workstation
    if (isJobCard && originalWs !== targetWorkstation.trim()) {
      showToast(`⚠️ Job Cards cannot change workstation. Please drop onto a date within the '${originalWs}' row.`, true);
      setDraggedEvent(null);
      return;
    }

    const isAllDay = !!ev.allDay;
    const origStart = ev.start instanceof Date ? ev.start : new Date(ev.start);
    const origEnd = ev.end ? (ev.end instanceof Date ? ev.end : new Date(ev.end)) : origStart;
    const durationMs = Math.max(0, origEnd.getTime() - origStart.getTime());

    let newStart, newEnd;
    if (isAllDay) {
      newStart = new Date(targetDate);
      newStart.setHours(0, 0, 0, 0);
      newEnd = new Date(newStart.getTime() + (durationMs || 86400000));
    } else {
      newStart = new Date(targetDate);
      newStart.setHours(origStart.getHours(), origStart.getMinutes(), origStart.getSeconds(), 0);
      newEnd = new Date(newStart.getTime() + durationMs);
    }

    // Job Cards strictly retain their assigned workstation, Work Orders can change workstation
    const targetWs = isJobCard ? originalWs : targetWorkstation.trim();
    await rescheduleEvent(ev, newStart, newEnd, targetWs);
    setDraggedEvent(null);
  };

  const openDoc = (type, docName) => {
    if (!docName || docName === 'Unassigned') return;
    let docType;
    if (type === 'jobcard') docType = 'job-card';
    else if (type === 'workorder') docType = 'work-order';
    else if (type === 'workstation') docType = 'workstation';
    else docType = type;
    //window.open(`http://localhost:8080/app/${docType}/${encodeURIComponent(docName)}`, '_blank');
    window.open(`${process.env.REACT_APP_ERPNEXT_URL}/app/${docType}/${encodeURIComponent(docName)}`, '_blank');
  };

  // Fetch live batch group details for the tracking panel
  const fetchBatchGroupDetails = async () => {
    setBatchPanelLoading(true);
    try {
      const resp = await fetch(`${API_URL}/batch-work-orders`);
      const data = await resp.json();
      if (data.success && Array.isArray(data.groups)) {
        setBatchGroups(data.groups);
      }
    } catch (e) {
      console.error('Failed to load batch groups:', e);
    } finally {
      setBatchPanelLoading(false);
    }
  };

  // Batch group color generator (consistent color per group ID)
  const getBatchGroupColor = (groupId) => {
    const colors = [
      '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
      '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#06b6d4'
    ];
    let hash = 0;
    for (let i = 0; i < groupId.length; i++) {
      hash = groupId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const monthTitle = activeDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  return (
    <div className="scheduler-app-root">
      {/* Top Application Bar */}
      <header className="production-header">
        <div className="header-left">
          <div className="header-brand-badge">
            <svg className="header-brand-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
          </div>
          <div>
            <div className="header-title-wrapper">
              <h1 className="header-title">MONTHLY PRODUCTION SCHEDULE</h1>
              <span className="header-version-tag">v16 Engine</span>
            </div>
            <div className="header-subtitle">ERPNext v16 Interactive Work Order & Job Card Dispatch Board</div>
          </div>
        </div>

        {/* View Tabs */}
        <div className="tab-buttons">
          <button
            className={`tab-btn ${activeTab === 'matrix' ? 'active' : ''}`}
            onClick={() => setActiveTab('matrix')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="tab-icon-svg">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
            <span>Workstation Matrix</span>
          </button>
          <button
            className={`tab-btn ${activeTab === 'calendar' ? 'active' : ''}`}
            onClick={() => setActiveTab('calendar')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="tab-icon-svg">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <span>Calendar View</span>
          </button>
        </div>

        <div className="header-right">
          <button
            onClick={() => {
              setShowBatchPanel(v => !v);
              if (!showBatchPanel) fetchBatchGroupDetails();
            }}
            className={`btn-action btn-batch-panel ${showBatchPanel ? 'active' : ''}`}
            title="Toggle Batch Work Order Tracking Panel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="3" y1="9" x2="21" y2="9"></line>
              <line x1="3" y1="15" x2="21" y2="15"></line>
              <line x1="9" y1="3" x2="9" y2="21"></line>
            </svg>
            <span>Batch Groups{batchGroups.length > 0 ? ` (${batchGroups.length})` : ''}</span>
          </button>
          <button onClick={fetchSchedule} className="btn-action btn-refresh" disabled={loading || syncing} title="Refresh data from ERPNext">
            <svg className={`btn-icon-svg ${loading || syncing ? 'spin' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            <span>{loading ? 'Loading...' : syncing ? 'Saving...' : 'Sync ERPNext'}</span>
          </button>
        </div>
      </header>

      {/* Toast Notification */}
      {toastMessage && (
        <div className={`scheduler-toast ${toastMessage.isError ? 'error' : 'success'}`}>
          {toastMessage.text}
        </div>
      )}

      {error && <div className="scheduler-error-banner">⚠️ Connection Error: {error}</div>}

      {/* Control & Toolbar Bar */}
      <div className="scheduler-toolbar">
        {/* Month Navigation (For Matrix View) */}
        {activeTab === 'matrix' && (
          <div className="month-nav-group">
            <button className="btn-nav" onClick={prevMonth} title="Previous Month">◀</button>
            <button className="btn-nav btn-today" onClick={goToToday}>Today</button>
            <button className="btn-nav" onClick={nextMonth} title="Next Month">▶</button>
            <div className="current-month-display">{monthTitle}</div>
          </div>
        )}

        {/* Search & Filters */}
        <div className="filters-group">
          <div className="search-box">
            <svg className="search-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              placeholder="Search Item, WO, Station, Operation..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="clear-search" onClick={() => setSearchQuery('')}>×</button>
            )}
          </div>

          {activeTab === 'calendar' && (
            <select
              className="select-filter"
              value={viewFilter}
              onChange={(e) => setViewFilter(e.target.value)}
            >
              <option value="all">All Documents</option>
              <option value="jobcard">Job Cards Only</option>
              <option value="workorder">Work Orders Only</option>
            </select>
          )}

          <select
            className="select-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="not started">Not Started / Open</option>
            <option value="in progress">In Progress</option>
            <option value="completed">Completed</option>
          </select>

          {/* // Turning off the hide off-status toggle.  */}

          {/* Hide Off-Status Workstations Toggle (Matrix View only)
          {activeTab === 'matrix' && (
            <label className="hide-off-stations-toggle" title="Hide workstations marked as Off in ERPNext">
              <input
                type="checkbox"
                checked={hideOffStations}
                onChange={() => setHideOffStations(v => !v)}
              />
              <span>Hide Off Stations{offStationNames.size > 0 ? ` (${offStationNames.size})` : ''}</span>
            </label>
          )} */}
        </div>

        {/* Zoom Controls (For Matrix View) */}
        {activeTab === 'matrix' && (
          <div className="zoom-controls">
            <span className="zoom-label">Zoom:</span>
            <button
              className="btn-zoom"
              onClick={handleZoomOut}
              disabled={zoomIndex === 0}
              title="Zoom Out (Fit more days)"
            >
              −
            </button>
            <span className="zoom-level-badge">{currentZoom.label} ({currentZoom.dayWidth}px)</span>
            <button
              className="btn-zoom"
              onClick={handleZoomIn}
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              title="Zoom In (More details)"
            >
              +
            </button>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <main className="scheduler-main-view">
        {/* ================= WORKSTATION MONTH MATRIX VIEW ================= */}
        {activeTab === 'matrix' && (
          <div className="matrix-viewport" ref={matrixScrollRef}>
            <div className="matrix-table-container">
              <table className="matrix-table">
                <thead>
                  {/* Top Tier: Title and Week Numbers */}
                  <tr className="header-row-weeks">
                    <th className="th-station-sticky">
                      <div className="station-header-box">
                        <div className="station-th-title-group">
                          <span className="station-th-icon">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
                              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                            </svg>
                          </span>
                          <span className="station-th-title">WORKSTATION / LINE</span>
                        </div>
                        <span className="station-count-badge">{workstationList.length} Stations</span>
                      </div>
                    </th>
                    {weekGroups.map((group, idx) => (
                      <th
                        key={`week-${group.weekNumber}-${idx}`}
                        colSpan={group.colSpan}
                        className="th-week-group"
                      >
                        <div className="week-label-wrapper">
                          <span className="week-label-text">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="week-label-svg">
                              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                              <line x1="16" y1="2" x2="16" y2="6"></line>
                              <line x1="8" y1="2" x2="8" y2="6"></line>
                              <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                            {group.label}
                          </span>
                        </div>
                      </th>
                    ))}
                  </tr>

                  {/* Bottom Tier: Individual Days of Month */}
                  <tr className="header-row-days">
                    <th className="th-station-sticky-sub">
                      <div className="station-sub-label">Station Name / Machine</div>
                    </th>
                    {monthDays.map(day => {
                      const dayOfWeek = day.getDay(); // 0 is Sunday, 6 is Saturday
                      const isSunday = dayOfWeek === 0;
                      const isSaturday = dayOfWeek === 6;
                      const dayNum = day.getDate();
                      const monthShort = day.toLocaleDateString('en-US', { month: 'short' });
                      const weekdayShort = day.toLocaleDateString('en-US', { weekday: 'short' });
                      const isToday = new Date().toDateString() === day.toDateString();

                      return (
                        <th
                          key={day.toISOString()}
                          style={{ width: `${currentZoom.dayWidth}px`, minWidth: `${currentZoom.dayWidth}px` }}
                          className={`th-day-cell ${isSunday ? 'col-sunday' : ''} ${isSaturday ? 'col-saturday' : ''} ${isToday ? 'col-today' : ''}`}
                        >
                          <div className="day-header-content">
                            <span className="day-date-str">
                              <span className="day-num-bold">{dayNum}</span> {monthShort}
                            </span>
                            <span className={`day-weekday-str ${isSunday ? 'weekday-sun' : ''} ${isToday ? 'weekday-today' : ''}`}>
                              {isSunday ? 'SUN' : weekdayShort}
                            </span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                {/* Table Body: Station Rows */}
                <tbody>
                  {workstationList.map((stationName) => {
                    // Count total events for this station in this month
                    const stationMonthEvents = matrixEvents.filter(e => {
                      const ws = (e.extendedProps?.workstation || 'Unassigned').trim();
                      if (ws !== stationName) return false;
                      const isWO = e.extendedProps?.type === 'workorder';
                      if (isWO) {
                        const s = e.start instanceof Date ? e.start : new Date(e.start);
                        if (isNaN(s.getTime())) return false;
                        return monthDays.some(d => s.getFullYear() === d.getFullYear() && s.getMonth() === d.getMonth() && s.getDate() === d.getDate());
                      }
                      return monthDays.some(d => eventIntersectsDay(e, d));
                    });

                    const isDraggingThisStation = draggedEvent && draggedEvent.extendedProps?.type === 'jobcard' && (draggedEvent.extendedProps?.workstation || '').trim() === stationName.trim();
                    const isDraggingOtherStation = draggedEvent && draggedEvent.extendedProps?.type === 'jobcard' && (draggedEvent.extendedProps?.workstation || '').trim() !== stationName.trim();
                    const isUnassigned = stationName === 'Unassigned';

                    return (
                      <tr key={stationName} className={`matrix-row ${isDraggingThisStation ? 'row-active-drag' : ''} ${isDraggingOtherStation ? 'row-inactive-drag' : ''} ${isUnassigned ? 'row-unassigned' : ''}`}>
                        {/* Left Fixed Station Header */}
                        <td
                          className={`td-station-sticky ${!isUnassigned ? 'clickable-station' : 'unassigned-station'}`}
                          onClick={() => !isUnassigned && openDoc('workstation', stationName)}
                          title={!isUnassigned ? `Click to open Workstation "${stationName}" in ERPNext` : 'Unassigned Work Orders'}
                        >
                          <div className="station-cell-content">
                            <div className="station-name-text">
                              <span className={`station-row-icon ${isUnassigned ? 'unassigned' : ''}`} title={isUnassigned ? 'Unassigned Queue' : 'Workstation'}>
                                {isUnassigned ? (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                                    <line x1="12" y1="22.08" x2="12" y2="12"></line>
                                  </svg>
                                ) : (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="3"></circle>
                                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                                  </svg>
                                )}
                              </span>
                              <span className="station-row-title">{stationName}</span>
                              {!isUnassigned && (
                                <svg className="external-link-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" title="Open in ERPNext">
                                  <line x1="7" y1="17" x2="17" y2="7"></line>
                                  <polyline points="7 7 17 7 17 17"></polyline>
                                </svg>
                              )}
                            </div>
                            {stationMonthEvents.length > 0 && (
                              <span className="station-event-count" title={`${stationMonthEvents.length} scheduled order(s) this month`}>
                                {stationMonthEvents.length}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Month Day Cells */}
                        {monthDays.map(day => {
                          const dayOfWeek = day.getDay();
                          const isSunday = dayOfWeek === 0;
                          const isSaturday = dayOfWeek === 6;
                          const cellKey = `${stationName}::${day.toISOString()}`;
                          const isDragOver = dragOverCell === cellKey;

                          // Find events for this station on this day.
                          // Job Cards: show on any day they intersect.
                          // Work Orders: show ONLY on their start date to avoid
                          //   duplicate cards when a WO spans multiple days.
                          const cellEvents = matrixEvents.filter(e => {
                            const ws = (e.extendedProps?.workstation || 'Unassigned').trim();
                            if (ws !== stationName) return false;
                            const isWO = e.extendedProps?.type === 'workorder';
                            if (isWO) {
                              // Pin WO card to its start date only
                              const s = e.start instanceof Date ? e.start : new Date(e.start);
                              if (isNaN(s.getTime())) return false;
                              return s.getFullYear() === day.getFullYear() &&
                                s.getMonth() === day.getMonth() &&
                                s.getDate() === day.getDate();
                            }
                            return eventIntersectsDay(e, day);

                          });

                          return (
                            <td
                              key={day.toISOString()}
                              style={{ width: `${currentZoom.dayWidth}px`, minWidth: `${currentZoom.dayWidth}px` }}
                              className={`matrix-day-cell ${isSunday ? 'col-sunday-cell' : ''} ${isSaturday ? 'col-saturday-cell' : ''} ${isDragOver ? 'cell-drag-over' : ''}`}
                              onDragOver={(e) => handleCellDragOver(e, cellKey, stationName)}
                              onDragLeave={(e) => handleCellDragLeave(e, cellKey)}
                              onDrop={(e) => handleCellDrop(e, day, stationName)}
                              onClick={(e) => {
                                // Only open modal if the click was on the empty cell (not on a card)
                                if (e.target.closest('.prod-card') || e.target.closest('.matrix-batch-card')) return;
                                openCreateWOModal(day, stationName);
                              }}
                              title={`Click to create a Work Order on ${day.toLocaleDateString()}`}
                            >
                              <div className="cell-events-container">
                                {/* Group events in cell: Batch Groups vs Standalone */}
                                {(() => {
                                  const batchGroupsInCell = {};
                                  const standaloneEvents = [];

                                  cellEvents.forEach(ev => {
                                    const bGroup = ev.extendedProps?.batchGroup;
                                    if (bGroup?.batchGroupId) {
                                      const gid = bGroup.batchGroupId;
                                      if (!batchGroupsInCell[gid]) batchGroupsInCell[gid] = [];
                                      batchGroupsInCell[gid].push(ev);
                                    } else {
                                      standaloneEvents.push(ev);
                                    }
                                  });

                                  return (
                                    <>
                                      {/* 1. Render Batch Group Cards in Workstation Matrix Cell */}
                                      {Object.keys(batchGroupsInCell).map(groupId => {
                                        const eventsInGroup = batchGroupsInCell[groupId];
                                        const masterEv = eventsInGroup.find(e => e.extendedProps?.batchGroup?.role === 'master');
                                        const subEvs = eventsInGroup.filter(e => e.extendedProps?.batchGroup?.role === 'sub');

                                        // Lookup full group info from batchGroups state or build from events
                                        const stateGroup = batchGroups.find(g => g.id === groupId);
                                        const itemCode = eventsInGroup[0]?.extendedProps?.itemCode || 'Product';
                                        const batchCountVal = stateGroup?.batchCount || eventsInGroup[0]?.extendedProps?.batchGroup?.batchCount || subEvs.length;
                                        const qtyPerBatchVal = stateGroup?.qtyPerBatch || eventsInGroup[0]?.extendedProps?.batchGroup?.qtyPerBatch || eventsInGroup[0]?.extendedProps?.qty || 0;
                                        const totalQtyVal = stateGroup?.totalQty || (qtyPerBatchVal * batchCountVal);
                                        const masterWOName = stateGroup?.masterWO || masterEv?.extendedProps?.docName || (eventsInGroup[0]?.extendedProps?.batchGroup?.masterWO);
                                        const masterStatus = stateGroup?.masterStatus || masterEv?.extendedProps?.status || 'Draft';

                                        const groupColor = getBatchGroupColor(groupId);

                                        // Compute progress
                                        const subWOsList = stateGroup?.subWOs && stateGroup.subWOs.length > 0
                                          ? stateGroup.subWOs
                                          : subEvs.map(e => ({
                                              name: e.extendedProps?.docName,
                                              batchNumber: e.extendedProps?.batchGroup?.batchNumber,
                                              status: e.extendedProps?.status || 'Draft'
                                            }));

                                        const completedCount = subWOsList.filter(s => (s.status || '').toLowerCase() === 'completed').length;
                                        const pct = subWOsList.length > 0 ? Math.round((completedCount / subWOsList.length) * 100) : 0;

                                        const isGroupLocked = ['in process', 'completed'].includes((masterStatus || '').toLowerCase()) ||
                                          subWOsList.some(s => ['in process', 'completed'].includes((s.status || '').toLowerCase()));

                                        const targetEditEv = masterEv || eventsInGroup[0];

                                        return (
                                          <div
                                            key={groupId}
                                            draggable={!isGroupLocked}
                                            onDragStart={(e) => !isGroupLocked && handleBatchGroupDragStart(e, groupId, eventsInGroup)}
                                            onDragEnd={handleDragEnd}
                                            className={`matrix-batch-card ${isGroupLocked ? 'card-locked' : ''}`}
                                            style={{ borderLeftColor: groupColor, cursor: isGroupLocked ? 'default' : 'grab' }}
                                            title={`📦 Batch Group: ${groupId}\nItem: ${itemCode}\nBatches: ${batchCountVal} (${qtyPerBatchVal} kg each)\nTotal: ${totalQtyVal} kg\nStatus: ${masterStatus}\n\n👉 Click time to edit schedule\n👉 Click ▾ to view sub-orders\n👉 Drag & drop to reschedule entire group`}
                                          >
                                            <div className="matrix-batch-header">
                                              <div className="matrix-batch-top">
                                                <span className="batch-pill-badge" style={{ backgroundColor: groupColor }}>{groupId}</span>
                                                <span className="matrix-batch-item-name">{itemCode}</span>
                                                <span className="matrix-batch-qty-tag">{totalQtyVal} kg</span>
                                                <span className="matrix-batch-date">{day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                                              </div>
                                              {(() => {
                                                const starts = eventsInGroup.map(e => new Date(e.start)).filter(d => !isNaN(d));
                                                const ends = eventsInGroup.map(e => new Date(e.end)).filter(d => !isNaN(d));
                                                const earliest = starts.length > 0 ? new Date(Math.min(...starts)) : null;
                                                const latest = ends.length > 0 ? new Date(Math.max(...ends)) : null;
                                                if (earliest && latest) {
                                                  const fmt = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                                                  return (
                                                    <div
                                                      className="matrix-batch-time clickable-time-badge"
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (!isGroupLocked && targetEditEv) {
                                                          openEditTimeModal(targetEditEv);
                                                        }
                                                      }}
                                                      title={isGroupLocked ? 'Locked from rescheduling (In Process / Completed)' : 'Click to edit date & time'}
                                                      style={{ cursor: isGroupLocked ? 'not-allowed' : 'pointer' }}
                                                    >
                                                      🕐 {fmt(earliest)} – {fmt(latest)} {!isGroupLocked && <span style={{ fontSize: '9px', opacity: 0.7 }}>✏️</span>}
                                                    </div>
                                                  );
                                                }
                                                return null;
                                              })()}
                                              <div className="batch-progress-container">
                                                <div className="batch-progress-bar">
                                                  <div className="batch-progress-fill" style={{ width: `${pct}%`, backgroundColor: groupColor }}></div>
                                                </div>
                                                <span className="batch-progress-label">{completedCount}/{subWOsList.length} · {pct}%</span>
                                              </div>
                                            </div>

                                            {/* Sub Work Orders Dropdown */}
                                            <details className="matrix-batch-details" onClick={(e) => e.stopPropagation()}>
                                              <summary className="matrix-batch-summary">
                                                <span>📋 {subWOsList.length} Orders</span>
                                                <span className="matrix-batch-caret">▾</span>
                                              </summary>
                                              <div className="matrix-batch-sub-list">
                                                {subWOsList.map(sub => {
                                                  const t = woTimers[sub.name];
                                                  const timerStatus = t?.status || 'idle';
                                                  const totalSecs = getWOTimerSeconds(sub.name);
                                                  const isCompleted = sub.status === 'Completed' || timerStatus === 'completed';

                                                  return (
                                                    <div
                                                      key={sub.name}
                                                      className="matrix-batch-sub-item"
                                                      onClick={(e) => { e.stopPropagation(); openDoc('workorder', sub.name); }}
                                                      title={`Click to open ${sub.name} in ERPNext`}
                                                    >
                                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                        <span className="matrix-sub-badge">#{sub.batchNumber}</span>
                                                        <span className="matrix-sub-wo">{sub.name}</span>
                                                      </div>

                                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                        {/* Sub-item Timer Action Controls */}
                                                        <div className="matrix-sub-timer-actions" onClick={(e) => e.stopPropagation()}>
                                                          {isCompleted ? (
                                                            <span className="sub-timer-done" title={`Total production time: ${formatTimerDuration(totalSecs)}`}>
                                                              ✓ {formatTimerDuration(totalSecs)}
                                                            </span>
                                                          ) : timerStatus === 'running' ? (
                                                            <div className="sub-timer-live">
                                                              <span className="timer-pulse-dot-sm"></span>
                                                              <span className="timer-digits-sm">{formatTimerDuration(totalSecs)}</span>
                                                              <button className="sub-timer-btn" onClick={(e) => handlePauseTimer(sub.name, e)} title="Pause Timer">⏸</button>
                                                              <button className="sub-timer-btn finish" onClick={(e) => handleFinishTimer(sub.name, e)} title="Finish Work Order">⏹</button>
                                                            </div>
                                                          ) : timerStatus === 'paused' ? (
                                                            <div className="sub-timer-live paused">
                                                              <span className="timer-paused-dot-sm"></span>
                                                              <span className="timer-digits-sm">{formatTimerDuration(totalSecs)}</span>
                                                              <button className="sub-timer-btn resume" onClick={(e) => handleResumeTimer(sub.name, e)} title="Resume Timer">▶</button>
                                                              <button className="sub-timer-btn finish" onClick={(e) => handleFinishTimer(sub.name, e)} title="Finish Work Order">⏹</button>
                                                            </div>
                                                          ) : (
                                                            <button className="sub-timer-btn start" onClick={(e) => handleStartTimer(sub.name, e)} title="Start Production">
                                                              ▶ Start
                                                            </button>
                                                          )}
                                                        </div>

                                                        <span className="matrix-sub-status" style={{ backgroundColor: getStatusColorWO(sub.status) }}>
                                                          {sub.status || 'Draft'}
                                                        </span>
                                                      </div>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            </details>
                                          </div>
                                        );
                                      })}

                                      {/* 2. Render Standalone Events (Job Cards & non-batch Work Orders) */}
                                      {standaloneEvents.map(ev => {
                                        const ext = ev.extendedProps || {};
                                        const itemCode = ext.itemCode || ext.raw?.production_item || ext.docName;
                                        const qty = ext.qty || ext.raw?.for_quantity || ext.raw?.qty;
                                        const isJobCard = ext.type === 'jobcard';
                                        const jobCards = Array.isArray(ext.jobCards) ? ext.jobCards : [];
                                        const rawOps = Array.isArray(ext.raw?.operations) ? ext.raw.operations : [];

                                        const dragLocked = isWODragLocked(ev);

                                        return (
                                          <div
                                            key={ev.id}
                                            draggable={!dragLocked}
                                            onDragStart={(e) => handleDragStart(e, ev)}
                                            onDragEnd={handleDragEnd}
                                            onClick={() => openDoc(ext.type, ext.docName)}
                                            className={`prod-card ${isJobCard ? 'card-jobcard' : 'card-workorder'}${dragLocked ? ' card-locked' : ''}`}
                                            style={{ borderLeftColor: ev.backgroundColor || '#2563eb', cursor: dragLocked ? 'not-allowed' : undefined }}
                                            title={dragLocked ? `🔒 [${ext.type.toUpperCase()}] ${ext.docName} — ${ext.status} (locked from rescheduling)\nItem: ${itemCode}\nQty: ${qty}\n\n👉 Click to open in ERPNext` : `[${ext.type.toUpperCase()}] ${ext.docName}\nItem: ${itemCode}\nQty: ${qty}\nStatus: ${ext.status}\nWorkstation: ${ext.workstation || 'N/A'}${jobCards.length > 0 ? `\n\nJob Cards:\n` + jobCards.map(j => `• ${j.name}: ${j.operation || ''} (${j.status})`).join('\n') : ''}\n\n👉 Click to open in ERPNext\n👉 Drag to reschedule`}
                                          >
                                            {/* Lock indicator for started/completed WOs */}
                                            {dragLocked && (
                                              <span className="prod-lock-badge" title={`${ext.status} — cannot be rescheduled`}>🔒</span>
                                            )}
                                            {/* Primary Row: Item Code & Quantity */}
                                            <div className="prod-card-main" style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '3px' }}>
                                              <span className="prod-item-code">{itemCode}</span>
                                              {qty !== undefined && qty !== null && qty !== '' && (
                                                <span className="prod-qty-badge"> : {qty}</span>
                                              )}
                                            </div>

                                            {/* Work Order Header Details */}
                                            <div className="prod-card-sub" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                              {isJobCard ? (
                                                <>
                                                  {ext.workOrder && <span className="prod-parent-wo-tag" style={{ fontSize: '11px', color: '#475569' }}>WO: {ext.workOrder}</span>}
                                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                                    <span className="prod-doc-id-badge badge-jc">JC: {ext.docName}</span>
                                                    {ext.timeRange && (
                                                      <span className="prod-time-range-badge" style={{ fontSize: '10px', color: '#1e3a8a', backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', padding: '1px 5px', borderRadius: '4px', fontWeight: '600' }}>
                                                        🕒 {ext.timeRange}
                                                      </span>
                                                    )}
                                                  </div>
                                                  {ext.operation && <span className="prod-op-tag" style={{ alignSelf: 'flex-start', marginTop: '2px' }}>{ext.operation}</span>}
                                                </>
                                              ) : (
                                                <>
                                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
                                                    <span className="prod-doc-id-badge badge-wo" style={{ alignSelf: 'flex-start' }}>WO: {ext.docName}</span>
                                                    <span className="prod-status-tag-sm" style={{ fontSize: '9px', color: '#64748b', fontWeight: '700' }}>{ext.status}</span>
                                                  </div>

                                                  {ext.timeRange && (
                                                    <span
                                                      className="prod-time-range-badge clickable-time-badge"
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (!dragLocked) openEditTimeModal(ev);
                                                      }}
                                                      title={dragLocked ? 'Locked from rescheduling' : 'Click to edit date & time'}
                                                      style={{ fontSize: '10px', color: '#1e3a8a', backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', padding: '1px 5px', borderRadius: '4px', alignSelf: 'flex-start', fontWeight: '600', display: 'inline-flex', alignItems: 'center', gap: '3px', cursor: dragLocked ? 'not-allowed' : 'pointer' }}
                                                    >
                                                      🕒 {ext.timeRange} {!dragLocked && <span style={{ fontSize: '9px', opacity: 0.7 }}>✏️</span>}
                                                    </span>
                                                  )}

                                                  {/* Interactive Live Production Timer Execution Bar */}
                                                  {(() => {
                                                    const t = woTimers[ext.docName];
                                                    const timerStatus = t?.status || 'idle';
                                                    const totalSecs = getWOTimerSeconds(ext.docName);
                                                    const isCompleted = ext.status === 'Completed' || timerStatus === 'completed';

                                                    return (
                                                      <div className="wo-timer-bar" onClick={(e) => e.stopPropagation()}>
                                                        {isCompleted ? (
                                                          <div className="wo-timer-completed">
                                                            <span className="timer-done-icon">✓</span>
                                                            <span>Completed ({formatTimerDuration(totalSecs)})</span>
                                                          </div>
                                                        ) : timerStatus === 'running' ? (
                                                          <div className="wo-timer-running">
                                                            <div className="timer-clock">
                                                              <span className="timer-pulse-dot"></span>
                                                              <span className="timer-digits">{formatTimerDuration(totalSecs)}</span>
                                                            </div>
                                                            <div className="timer-btn-group">
                                                              <button className="timer-btn btn-pause" onClick={(e) => handlePauseTimer(ext.docName, e)} title="Pause Timer">⏸ Pause</button>
                                                              <button className="timer-btn btn-finish" onClick={(e) => handleFinishTimer(ext.docName, e)} title="Finish Work Order">⏹ Finish</button>
                                                            </div>
                                                          </div>
                                                        ) : timerStatus === 'paused' ? (
                                                          <div className="wo-timer-paused">
                                                            <div className="timer-clock paused">
                                                              <span className="timer-paused-dot"></span>
                                                              <span className="timer-digits">{formatTimerDuration(totalSecs)}</span>
                                                            </div>
                                                            <div className="timer-btn-group">
                                                              <button className="timer-btn btn-resume" onClick={(e) => handleResumeTimer(ext.docName, e)} title="Resume Timer">▶ Resume</button>
                                                              <button className="timer-btn btn-finish" onClick={(e) => handleFinishTimer(ext.docName, e)} title="Finish Work Order">⏹ Finish</button>
                                                            </div>
                                                          </div>
                                                        ) : (
                                                          <div className="wo-timer-idle">
                                                            <button className="timer-btn btn-start" onClick={(e) => handleStartTimer(ext.docName, e)} title="Start Production Timer">
                                                              ▶ Start Production
                                                            </button>
                                                          </div>
                                                        )}
                                                      </div>
                                                    );
                                                  })()}

                                                  {/* Dropdown list view of all Job Cards inside this single Work Order box */}
                                                  {jobCards.length > 0 ? (
                                                    <details className="prod-card-jc-dropdown" onClick={(e) => e.stopPropagation()}>
                                                      <summary className="prod-card-jc-summary">
                                                        <span className="jc-summary-label">📋 Job Cards ({jobCards.length})</span>
                                                        <span className="jc-summary-caret">▾</span>
                                                      </summary>
                                                      <div className="prod-card-jc-dropdown-menu">
                                                        {jobCards.map(jc => (
                                                          <div
                                                            key={jc.name}
                                                            className="prod-card-jc-dropdown-item"
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              openDoc('jobcard', jc.name);
                                                            }}
                                                            title={`Click to open Job Card ${jc.name} in ERPNext\nOperation: ${jc.operation || 'N/A'}\nWorkstation: ${jc.workstation || 'N/A'}\nStatus: ${jc.status || 'N/A'}`}
                                                          >
                                                            <div className="jc-item-info">
                                                              <div className="jc-item-name-row">
                                                                <span className="jc-item-name">{jc.name}</span>
                                                                {jc.status && (
                                                                  <span className="jc-item-status-pill">
                                                                    <span className="jc-item-status-dot" style={{ backgroundColor: getStatusColor(jc.status) }}></span>
                                                                    {jc.status}
                                                                  </span>
                                                                )}
                                                              </div>
                                                              {jc.operation && (
                                                                <span className="jc-item-op">
                                                                  {jc.operation} {jc.workstation ? `· ${jc.workstation}` : ''}
                                                                </span>
                                                              )}
                                                            </div>
                                                          </div>
                                                        ))}
                                                      </div>
                                                    </details>
                                                  ) : rawOps.length > 0 ? (
                                                    <details className="prod-card-jc-dropdown" onClick={(e) => e.stopPropagation()}>
                                                      <summary className="prod-card-jc-summary">
                                                        <span className="jc-summary-label">⚙️ Ops ({rawOps.length}) · Draft</span>
                                                        <span className="jc-summary-caret">▾</span>
                                                      </summary>
                                                      <div className="prod-card-jc-dropdown-menu">
                                                        {rawOps.map((op, idx) => (
                                                          <div key={idx} className="prod-card-jc-dropdown-item op-preview">
                                                            <div className="jc-item-info">
                                                              <div className="jc-item-name-row">
                                                                <span className="jc-item-name">{op.operation}</span>
                                                                {op.time_in_mins ? (
                                                                  <span className="jc-item-status-pill">
                                                                    <span className="jc-item-status-dot" style={{ backgroundColor: '#94a3b8' }}></span>
                                                                    {op.time_in_mins}m
                                                                  </span>
                                                                ) : null}
                                                              </div>
                                                              {op.workstation && <span className="jc-item-op">{op.workstation}</span>}
                                                            </div>
                                                          </div>
                                                        ))}
                                                      </div>
                                                    </details>
                                                  ) : (
                                                    ext.operation && (
                                                      <span className="prod-op-tag" style={{ alignSelf: 'flex-start', marginTop: '2px' }}>{ext.operation}</span>
                                                    )
                                                  )}
                                                </>
                                              )}
                                            </div>

                                            {/* Status dot */}
                                            <span
                                              className="prod-status-dot"
                                              style={{ backgroundColor: ev.backgroundColor }}
                                            />
                                          </div>
                                        );
                                      })}
                                    </>
                                  );
                                })()}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ================= CALENDAR VIEW (FULLCALENDAR) ================= */}
        {activeTab === 'calendar' && (
          <div className="fullcalendar-wrapper">
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={{
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay'
              }}
              events={filteredEvents}
              editable={true}
              eventContent={renderEventContent}
              eventDrop={handleFullCalendarDrop}
              eventResize={handleFullCalendarDrop}
              eventAllow={(dropInfo, draggedEvent) => {
                // Prevent dragging locked Work Orders in calendar view
                return !isWODragLocked({ extendedProps: draggedEvent.extendedProps });
              }}
              eventDisplay="block"
              height="auto"
              dateClick={(info) => {
                const calendarApi = calendarRef.current.getApi();
                calendarApi.changeView('timeGridDay', info.date);
              }}
              eventClick={(info) => {
                const ext = info.event.extendedProps;
                openDoc(ext.type, ext.docName);
              }}
            />
          </div>
        )}
      </main>

      {/* Legend & Instructions Footer */}
      <footer className="scheduler-footer">
        <div className="footer-left">
          <span className="footer-legend-title">Legend:</span>
          <div className="legend-items">
            <span className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: getStatusColor('Not Started') }}></span>
              Not Started / Open
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: getStatusColor('In Progress') }}></span>
              In Progress
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: getStatusColor('Completed') }}></span>
              Completed
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: getStatusColorWO('Submitted') }}></span>
              Work Order Submitted
            </span>
            <span className="legend-item">
              <span className="legend-box-sun"></span>
              Sunday / Weekend Divider
            </span>
          </div>
        </div>

        <div className="footer-right">
          💡 <strong>Tip:</strong> Drag and drop any card to reschedule production dates. Job Cards strictly maintain their fixed machine/workstation assignments.
        </div>
      </footer>

      {/* ================= CREATE WORK ORDER MODAL ================= */}
      {createWOModal && (
        <div className="wo-modal-overlay" onClick={(e) => { if (e.target.classList.contains('wo-modal-overlay')) setCreateWOModal(null); }}>
          <div className="wo-modal">
            <div className="wo-modal-header">
              <div className="wo-modal-title">
                <span className="wo-modal-icon">🏭</span>
                <div>
                  <h2>Create Work Order</h2>
                  <p className="wo-modal-subtitle">
                    {createWOModal.workstation !== 'Unassigned' ? `📍 ${createWOModal.workstation} · ` : ''}
                    📅 {createWOModal.date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
              </div>
              <button className="wo-modal-close" onClick={() => setCreateWOModal(null)} title="Close">✕</button>
            </div>

            <form className="wo-modal-form" onSubmit={handleCreateWOSubmit}>
              {/* Item */}
              <div className="wo-form-group">
                <label className="wo-form-label">Production Item <span className="req">*</span></label>
                <select
                  className="wo-form-select"
                  value={woForm.production_item}
                  onChange={e => handleWOItemChange(e.target.value)}
                  required
                >
                  <option value="">— Select Item —</option>
                  {woItems.map(item => (
                    <option key={item.name} value={item.name}>
                      {item.name}{item.item_name && item.item_name !== item.name ? ` – ${item.item_name}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* BOM */}
              <div className="wo-form-group">
                <label className="wo-form-label">Bill of Materials (BOM) <span className="req">*</span></label>
                <select
                  className="wo-form-select"
                  value={woForm.bom_no}
                  onChange={e => handleWOFormChange('bom_no', e.target.value)}
                  required
                  disabled={!woForm.production_item || woBoms.length === 0}
                >
                  <option value="">{woForm.production_item ? (woBoms.length === 0 ? 'No active BOMs found' : '— Select BOM —') : '— Select an Item first —'}</option>
                  {woBoms.map(bom => (
                    <option key={bom.name} value={bom.name}>
                      {bom.name}{bom.is_default ? ' ★ Default' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Batch Creation Mode Toggle */}
              <div className="wo-form-group wo-batch-toggle-group">
                <div className="wo-batch-toggle-header">
                  <label className="wo-form-label" style={{ marginBottom: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={batchMode}
                      onChange={e => setBatchMode(e.target.checked)}
                      style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: '#2563eb' }}
                    />
                    <span>📦 Batch Creation Mode (Master + Sub Orders)</span>
                  </label>
                </div>
                {batchMode && (
                  <div className="wo-batch-options" style={{ marginTop: '10px', padding: '12px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                    <div className="wo-form-group" style={{ marginBottom: 0 }}>
                      <label className="wo-form-label">Number of Batches (Sub-Work-Orders) <span className="req">*</span></label>
                      <input
                        className="wo-form-input"
                        type="number"
                        min="2"
                        max="50"
                        value={batchCount}
                        onChange={e => setBatchCount(parseInt(e.target.value, 10) || 2)}
                        required={batchMode}
                      />
                      <small style={{ color: '#64748b', fontSize: '11px', display: 'block', marginTop: '4px' }}>
                        Will create 1 Master WO + {batchCount} Sub-Work-Orders ({woForm.qty || 0} units per batch, total { (Number(woForm.qty) || 0) * batchCount } units) on {woForm.planned_start_date}.
                      </small>
                    </div>
                  </div>
                )}
              </div>

              {/* Quantity */}
              <div className="wo-form-group">
                <label className="wo-form-label">{batchMode ? 'Quantity per Batch' : 'Quantity to Manufacture'} <span className="req">*</span></label>
                <input
                  className="wo-form-input"
                  type="number"
                  min="1"
                  step="any"
                  placeholder="e.g. 100"
                  value={woForm.qty}
                  onChange={e => handleWOFormChange('qty', e.target.value)}
                  required
                />
              </div>

              {/* Start Schedule: Date & Time */}
              <div className="wo-form-row">
                <div className="wo-form-group" style={{ flex: 3 }}>
                  <label className="wo-form-label">Planned Start Date <span className="req">*</span></label>
                  <input
                    className="wo-form-input"
                    type="date"
                    value={woForm.planned_start_date}
                    onChange={e => handleWOFormChange('planned_start_date', e.target.value)}
                    required
                  />
                </div>
                <div className="wo-form-group" style={{ flex: 2 }}>
                  <label className="wo-form-label">Start Time</label>
                  <input
                    className="wo-form-input"
                    type="time"
                    value={woForm.planned_start_time}
                    onChange={e => handleWOFormChange('planned_start_time', e.target.value)}
                  />
                </div>
              </div>

              {/* End Schedule: Date & Time */}
              <div className="wo-form-row">
                <div className="wo-form-group" style={{ flex: 3 }}>
                  <label className="wo-form-label">Planned End Date</label>
                  <input
                    className="wo-form-input"
                    type="date"
                    value={woForm.planned_end_date}
                    min={woForm.planned_start_date}
                    onChange={e => handleWOFormChange('planned_end_date', e.target.value)}
                  />
                </div>
                <div className="wo-form-group" style={{ flex: 2 }}>
                  <label className="wo-form-label">End Time</label>
                  <input
                    className="wo-form-input"
                    type="time"
                    value={woForm.planned_end_time}
                    onChange={e => handleWOFormChange('planned_end_time', e.target.value)}
                  />
                </div>
              </div>

              {/* Description (optional) */}
              <div className="wo-form-group">
                <label className="wo-form-label">Description <span className="optional">(optional)</span></label>
                <textarea
                  className="wo-form-input wo-form-textarea"
                  rows="2"
                  placeholder="Additional notes..."
                  value={woForm.description}
                  onChange={e => handleWOFormChange('description', e.target.value)}
                />
              </div>

              {/* Actions */}
              <div className="wo-modal-actions">
                <button type="button" className="wo-btn-cancel" onClick={() => setCreateWOModal(null)} disabled={woSubmitting}>
                  Cancel
                </button>
                <button type="submit" className="wo-btn-submit" disabled={woSubmitting}>
                  {woSubmitting ? <span className="spin">⏳</span> : (batchMode ? '📦' : '🏭')} {woSubmitting ? 'Creating...' : (batchMode ? `Create Batch Group (${batchCount} Batches)` : 'Create Work Order')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= BATCH WORK ORDER TRACKING PANEL ================= */}
      {showBatchPanel && (
        <div className="batch-panel-drawer">
          <div className="batch-panel-header">
            <div className="batch-panel-title">
              <span className="batch-panel-icon">📦</span>
              <div>
                <h3>Batch Work Order Tracking</h3>
                <p>Track Master and Sub-Work-Order Groups</p>
              </div>
            </div>
            <button className="batch-panel-close" onClick={() => setShowBatchPanel(false)}>✕</button>
          </div>

          <div className="batch-panel-body">
            {batchPanelLoading ? (
              <div className="batch-panel-empty">Loading batch groups...</div>
            ) : batchGroups.length === 0 ? (
              <div className="batch-panel-empty">
                <p>No batch work orders found.</p>
                <small>Create work orders with "Batch Creation Mode" enabled to track master and sub-orders here.</small>
              </div>
            ) : (
              <div className="batch-groups-list">
                {batchGroups.map(group => {
                  const groupColor = getBatchGroupColor(group.id);
                  const isExpanded = expandedBatchGroup === group.id;

                  return (
                    <div key={group.id} className="batch-group-card" style={{ borderLeftColor: groupColor }}>
                      <div className="batch-group-summary" onClick={() => setExpandedBatchGroup(isExpanded ? null : group.id)}>
                        <div className="batch-group-top">
                          <span className="batch-group-id" style={{ color: groupColor }}>{group.id}</span>
                          <span className="batch-group-date">📅 {group.plannedDate}</span>
                        </div>
                        <div className="batch-group-item">
                          <strong>{group.productionItem}</strong> · {group.batchCount} batches ({group.qtyPerBatch} kg/batch = total {group.totalQty} kg)
                        </div>
                        <div className="batch-group-master">
                          Master WO: <span className="clickable-link" onClick={(e) => { e.stopPropagation(); openDoc('workorder', group.masterWO); }}>{group.masterWO}</span> ({group.masterStatus || 'Draft'})
                        </div>

                        {/* Progress Bar */}
                        <div className="batch-progress-container">
                          <div className="batch-progress-bar">
                            <div className="batch-progress-fill" style={{ width: `${group.progress?.percentage || 0}%`, backgroundColor: groupColor }}></div>
                          </div>
                          <span className="batch-progress-text">{group.progress?.completed || 0}/{group.progress?.total || group.batchCount} Completed ({group.progress?.percentage || 0}%)</span>
                        </div>

                        <div className="batch-group-expand-hint">
                          {isExpanded ? '▲ Hide Sub-Work-Orders' : `▼ View ${group.subWOs?.length || 0} Sub-Work-Orders`}
                        </div>
                      </div>

                      {/* Sub Work Orders List */}
                      {isExpanded && (
                        <div className="batch-sub-list">
                          {(group.subWOs || []).map(sub => (
                            <div key={sub.name} className="batch-sub-item" onClick={() => openDoc('workorder', sub.name)}>
                              <div className="batch-sub-name-row">
                                <span className="batch-sub-badge">Batch {sub.batchNumber}/{group.batchCount}</span>
                                <span className="batch-sub-wo">{sub.name}</span>
                              </div>
                              <span className="batch-sub-status" style={{ backgroundColor: getStatusColorWO(sub.status) }}>
                                {sub.status || 'Draft'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Edit Time / Reschedule Modal ── */}
      {editTimeModal && (
        <div className="wo-modal-overlay" onClick={(e) => { if (e.target.classList.contains('wo-modal-overlay')) setEditTimeModal(null); }}>
          <div className="wo-modal wo-edit-time-modal">
            <div className="wo-modal-header">
              <div>
                <h3 className="wo-modal-title">🕒 Edit Schedule & Time</h3>
                <div className="wo-modal-subtitle">
                  {editTimeModal.docType === 'workorder' ? 'Work Order' : 'Job Card'}: <strong>{editTimeModal.docName}</strong> ({editTimeModal.itemCode})
                </div>
              </div>
              <button className="wo-modal-close" onClick={() => setEditTimeModal(null)} title="Close">✕</button>
            </div>

            <form onSubmit={handleEditTimeSubmit} className="wo-modal-form">
              {/* Start Date & Time */}
              <div className="wo-form-row">
                <div className="wo-form-group">
                  <label className="wo-form-label">Start Date *</label>
                  <input
                    type="date"
                    className="wo-form-input"
                    value={editTimeModal.startDate}
                    onChange={e => setEditTimeModal(m => ({ ...m, startDate: e.target.value }))}
                    required
                  />
                </div>
                <div className="wo-form-group">
                  <label className="wo-form-label">Start Time *</label>
                  <input
                    type="time"
                    className="wo-form-input"
                    value={editTimeModal.startTime}
                    onChange={e => setEditTimeModal(m => ({ ...m, startTime: e.target.value }))}
                    required
                  />
                </div>
              </div>

              {/* End Date & Time */}
              <div className="wo-form-row">
                <div className="wo-form-group">
                  <label className="wo-form-label">End Date *</label>
                  <input
                    type="date"
                    className="wo-form-input"
                    value={editTimeModal.endDate}
                    onChange={e => setEditTimeModal(m => ({ ...m, endDate: e.target.value }))}
                    required
                  />
                </div>
                <div className="wo-form-group">
                  <label className="wo-form-label">End Time *</label>
                  <input
                    type="time"
                    className="wo-form-input"
                    value={editTimeModal.endTime}
                    onChange={e => setEditTimeModal(m => ({ ...m, endTime: e.target.value }))}
                    required
                  />
                </div>
              </div>

              {/* Workstation */}
              <div className="wo-form-group">
                <label className="wo-form-label">Workstation / Line</label>
                <select
                  className="wo-form-select"
                  value={editTimeModal.workstation}
                  onChange={e => setEditTimeModal(m => ({ ...m, workstation: e.target.value }))}
                >
                  <option value="Unassigned">Unassigned</option>
                  {backendWorkstations.map(ws => {
                    const name = (ws.workstation_name || ws.name || '').trim();
                    return name ? <option key={name} value={name}>{name}</option> : null;
                  })}
                </select>
              </div>

              {/* Actions */}
              <div className="wo-modal-actions">
                <button type="button" className="wo-btn-cancel" onClick={() => setEditTimeModal(null)}>
                  Cancel
                </button>
                <button type="submit" className="wo-btn-submit">
                  💾 Save Schedule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Scheduler;
