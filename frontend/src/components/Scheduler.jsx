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
    planned_end_date: '',
    description: ''
  });

  const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3500/api';

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
      planned_end_date: dateStr,
      description: ''
    });
    setWoBoms([]);
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
      const payload = { ...woForm };
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
      setCreateWOModal(null);
      await fetchSchedule();
    } catch (err) {
      showToast(`✗ ${err.message}`, true);
    } finally {
      setWoSubmitting(false);
    }
  };

  const parseDateTime = (value) => {
    if (!value) return null;
    if (value instanceof Date) return value;
    const normalized = String(value).replace(' ', 'T');
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d;
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

        return {
          id: `wo-${wo.name}`,
          title: title,
          start: startTime,
          end: endTime,
          allDay: true,
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
            raw: jc
          }
        };
      });

      setEvents([...workOrderEvents, ...jobCardEvents]);
      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching schedule:', err);
    } finally {
      setLoading(false);
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

  // Synchronized Reschedule API caller (coordinates Work Orders and child Job Cards together)
  const rescheduleEvent = async (eventObj, newStart, newEnd, newWorkstation) => {
    const type = eventObj.extendedProps?.type;
    const docName = eventObj.extendedProps?.docName;
    const itemCode = eventObj.extendedProps?.itemCode || 'Product';
    const workOrder = eventObj.extendedProps?.workOrder;
    if (!type || !docName) throw new Error('Invalid event data');

    setSyncing(true);
    try {
      const formattedStart = type === 'jobcard' ? formatDateTimeLocal(newStart) : formatDateLocal(newStart);
      const formattedEnd = type === 'jobcard' ? formatDateTimeLocal(newEnd) : formatDateLocal(newEnd);

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

      await fetchSchedule();
    } catch (err) {
      console.error('Reschedule error:', err);
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

    // Add stations from events (both Job Cards and Work Orders)
    events.forEach(e => {
      const w = (e.extendedProps?.workstation || '').trim();
      if (w && w !== 'Unassigned') {
        if (hideOffStations && offStationNames.has(w)) return;
        set.add(w);
      }
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
  }, [backendWorkstations, events, hideOffStations, offStationNames]);

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
    setDraggedEvent(ev);
    try {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: ev.id }));
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) {
      // ignore
    }
  };

  const handleDragEnd = () => {
    setDraggedEvent(null);
    setDragOverCell(null);
  };

  const handleCellDragOver = (e, cellKey, cellStationName) => {
    e.preventDefault();
    if (!draggedEvent) return;

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
    window.open(`http://localhost:8080/app/${docType}/${encodeURIComponent(docName)}`, '_blank');
  };

  const monthTitle = activeDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  return (
    <div className="scheduler-app-root">
      {/* Top Application Bar */}
      <header className="production-header">
        <div className="header-left">
          <div className="logo-badge">PROD</div>
          <div>
            <h1 className="header-title">MONTHLY PRODUCTION SCHEDULE</h1>
            <div className="header-subtitle">ERPNext v16 Interactive Work Order & Job Card Scheduler</div>
          </div>
        </div>

        {/* View Tabs */}
        <div className="tab-buttons">
          <button
            className={`tab-btn ${activeTab === 'matrix' ? 'active' : ''}`}
            onClick={() => setActiveTab('matrix')}
          >
            📊 Workstation Matrix (Month)
          </button>
          <button
            className={`tab-btn ${activeTab === 'calendar' ? 'active' : ''}`}
            onClick={() => setActiveTab('calendar')}
          >
            📅 Calendar View
          </button>
        </div>

        <div className="header-right">
          <button onClick={fetchSchedule} className="btn-action btn-refresh" disabled={loading || syncing} title="Refresh data from ERPNext">
            <span className={loading || syncing ? 'spin' : ''}>🔄</span> {loading ? 'Loading...' : syncing ? 'Saving...' : 'Sync ERPNext'}
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
            <span className="search-icon">🔍</span>
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

          {/* Hide Off-Status Workstations Toggle (Matrix View only) */}
          {activeTab === 'matrix' && (
            <label className="hide-off-stations-toggle" title="Hide workstations marked as Off in ERPNext">
              <input
                type="checkbox"
                checked={hideOffStations}
                onChange={() => setHideOffStations(v => !v)}
              />
              <span>Hide Off Stations{offStationNames.size > 0 ? ` (${offStationNames.size})` : ''}</span>
            </label>
          )}
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
                {/* Two-tier Table Header */}
                <thead>
                  {/* Top Tier: Title and Week Numbers */}
                  <tr className="header-row-weeks">
                    <th className="th-station-sticky">
                      <div className="station-header-box">
                        <span className="station-th-title">MACHINE / STATION</span>
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
                          <span className="week-label-text">{group.label}</span>
                        </div>
                      </th>
                    ))}
                  </tr>

                  {/* Bottom Tier: Individual Days of Month */}
                  <tr className="header-row-days">
                    <th className="th-station-sticky-sub">
                      <div className="station-sub-label">Station Name</div>
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
                            <span className="day-date-str">{dayNum}-{monthShort}</span>
                            <span className="day-weekday-str">{isSunday ? '###' : weekdayShort}</span>
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

                    return (
                      <tr key={stationName} className={`matrix-row ${isDraggingThisStation ? 'row-active-drag' : ''} ${isDraggingOtherStation ? 'row-inactive-drag' : ''}`}>
                        {/* Left Fixed Station Header */}
                        <td
                          className={`td-station-sticky ${stationName !== 'Unassigned' ? 'clickable-station' : ''}`}
                          onClick={() => stationName !== 'Unassigned' && openDoc('workstation', stationName)}
                          title={stationName !== 'Unassigned' ? `Click to open Workstation "${stationName}" in ERPNext` : stationName}
                        >
                          <div className="station-cell-content">
                            <div className="station-name-text">
                              {stationName}
                              {stationName !== 'Unassigned' && <span className="external-link-icon" title="Open in ERPNext"> ↗</span>}
                            </div>
                            {stationMonthEvents.length > 0 && (
                              <span className="station-event-count" title={`${stationMonthEvents.length} scheduled jobs this month`}>
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
                                if (e.target.closest('.prod-card')) return;
                                openCreateWOModal(day, stationName);
                              }}
                              title={`Click to create a Work Order on ${day.toLocaleDateString()}`}
                            >
                              <div className="cell-events-container">
                                {cellEvents.map(ev => {
                                    const ext = ev.extendedProps || {};
                                    const itemCode = ext.itemCode || ext.raw?.production_item || ext.docName;
                                    const qty = ext.qty || ext.raw?.for_quantity || ext.raw?.qty;
                                    const isJobCard = ext.type === 'jobcard';
                                    const jobCards = Array.isArray(ext.jobCards) ? ext.jobCards : [];
                                    const rawOps = Array.isArray(ext.raw?.operations) ? ext.raw.operations : [];

                                    return (
                                      <div
                                        key={ev.id}
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, ev)}
                                        onDragEnd={handleDragEnd}
                                        onClick={() => openDoc(ext.type, ext.docName)}
                                        className={`prod-card ${isJobCard ? 'card-jobcard' : 'card-workorder'}`}
                                        style={{ borderLeftColor: ev.backgroundColor || '#2563eb' }}
                                        title={`[${ext.type.toUpperCase()}] ${ext.docName}\nItem: ${itemCode}\nQty: ${qty}\nStatus: ${ext.status}\nWorkstation: ${ext.workstation || 'N/A'}${jobCards.length > 0 ? `\n\nJob Cards:\n` + jobCards.map(j => `• ${j.name}: ${j.operation || ''} (${j.status})`).join('\n') : ''}\n\n👉 Click to open in ERPNext\n👉 Drag to reschedule`}
                                      >
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
                                              <span className="prod-doc-id-badge badge-jc" style={{ alignSelf: 'flex-start' }}>JC: {ext.docName}</span>
                                              {ext.operation && <span className="prod-op-tag" style={{ alignSelf: 'flex-start', marginTop: '2px' }}>{ext.operation}</span>}
                                            </>
                                          ) : (
                                            <>
                                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
                                                <span className="prod-doc-id-badge badge-wo" style={{ alignSelf: 'flex-start' }}>WO: {ext.docName}</span>
                                                <span className="prod-status-tag-sm" style={{ fontSize: '9px', color: '#64748b', fontWeight: '700' }}>{ext.status}</span>
                                              </div>

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
                                                        <span className="jc-item-status-dot" style={{ backgroundColor: getStatusColor(jc.status) }}></span>
                                                        <div className="jc-item-info">
                                                          <div className="jc-item-name-row">
                                                            <span className="jc-item-name">{jc.name}</span>
                                                            {jc.status && <span className="jc-item-status-pill">{jc.status}</span>}
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
                                                        <span className="jc-item-status-dot" style={{ backgroundColor: '#94a3b8' }}></span>
                                                        <div className="jc-item-info">
                                                          <div className="jc-item-name-row">
                                                            <span className="jc-item-name">{op.operation}</span>
                                                            {op.time_in_mins ? <span className="jc-item-status-pill">{op.time_in_mins}m</span> : null}
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

              {/* Quantity */}
              <div className="wo-form-group">
                <label className="wo-form-label">Quantity to Manufacture <span className="req">*</span></label>
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

              {/* Dates */}
              <div className="wo-form-row">
                <div className="wo-form-group">
                  <label className="wo-form-label">Planned Start Date <span className="req">*</span></label>
                  <input
                    className="wo-form-input"
                    type="date"
                    value={woForm.planned_start_date}
                    onChange={e => handleWOFormChange('planned_start_date', e.target.value)}
                    required
                  />
                </div>
                <div className="wo-form-group">
                  <label className="wo-form-label">Planned End Date</label>
                  <input
                    className="wo-form-input"
                    type="date"
                    value={woForm.planned_end_date}
                    min={woForm.planned_start_date}
                    onChange={e => handleWOFormChange('planned_end_date', e.target.value)}
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
                  {woSubmitting ? <span className="spin">⏳</span> : '🏭'} {woSubmitting ? 'Creating...' : 'Create Work Order'}
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
