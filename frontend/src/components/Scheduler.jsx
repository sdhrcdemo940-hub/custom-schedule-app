import React, { useState, useEffect, useRef, useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import './Scheduler.css';

const Scheduler = () => {
  const calendarRef = useRef(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [viewFilter, setViewFilter] = useState('all');
  const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';
  const [activeDate, setActiveDate] = useState(() => new Date());
  const [showWorkstationWeek, setShowWorkstationWeek] = useState(false);

  // Fetch data from backend
  useEffect(() => {
    fetchSchedule();
  }, []);

  const fetchSchedule = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/schedule`);
      if (!response.ok) throw new Error('Failed to fetch schedule');
      
      const data = await response.json();
      
      const parseDateTime = (value) => {
        if (!value) return null;
        if (value instanceof Date) return value;
        const normalized = value.replace(' ', 'T');
        return new Date(normalized);
      };

      // Transform Job Cards (show parent Work Order in title)
      const jobCardEvents = (data.jobCards || []).map(jc => ({
        id: `jc-${jc.name}`,
        title: `JC: ${jc.subject || jc.name}${jc.work_order ? ' — WO: ' + jc.work_order : ''}`,
        start: parseDateTime(jc.from_time),
        end: parseDateTime(jc.to_time),
        allDay: false,
        backgroundColor: getStatusColor(jc.status),
        borderColor: '#2c3e50',
        extendedProps: {
          type: 'jobcard',
          docName: jc.name,
          status: jc.status,
          workOrder: jc.work_order,
          workstation: jc.workstation || jc.workstation_name || jc.work_center || jc.work_center_name || jc.machine || jc.workstation_id || null
        }
      }));

      // Show job cards and also keep Work Orders with status 'Not Started' so users can navigate
      const workOrderEvents = (data.workOrders || [])
        .filter(wo => (wo.status || '').toLowerCase() === 'not started')
        .map(wo => ({
          id: `wo-${wo.name}`,
          title: `WO: ${wo.title || wo.name}`,
          start: parseDateTime(wo.planned_start_date),
          end: parseDateTime(wo.planned_end_date),
          allDay: true,
          backgroundColor: getStatusColorWO(wo.status),
          borderColor: '#34495e',
          extendedProps: {
            type: 'workorder',
            docName: wo.name,
            status: wo.status,
            workstation: wo.workstation || wo.workstation_name || wo.work_center || wo.work_center_name || wo.machine || null
          }
        }));

      setEvents([...jobCardEvents, ...workOrderEvents]);
      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching schedule:', err);
    } finally {
      setLoading(false);
    }
  };

  // Handle drop event (reschedule)
  const handleApiResponse = async (response, defaultMessage) => {
    if (response.ok) return response;
    let errorText = defaultMessage;
    try {
      const data = await response.json();
      errorText = data.error || data.message || data.details?.message || data.details?._server_messages || defaultMessage;
    } catch (parseError) {
      // ignore parse errors
    }
    throw new Error(errorText);
  };

  const handleEventDrop = async (info) => {
    const { event } = info;
    const { type, docName } = event.extendedProps || {};
    console.log('Event dropped:', { id: event.id, title: event.title, type, docName, start: event.start, end: event.end });

    try {
      if (type === 'jobcard') {
        const response = await fetch(`${API_URL}/job-cards/${docName}/reschedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_time: formatDateTimeLocal(event.start),
            to_time: formatDateTimeLocal(event.end)
          })
        });
        await handleApiResponse(response, 'Failed to reschedule job card');
      } else if (type === 'workorder') {
        const response = await fetch(`${API_URL}/work-orders/${docName}/reschedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            planned_start_date: formatDateLocal(event.start),
            planned_end_date: formatDateLocal(event.end)
          })
        });
        await handleApiResponse(response, 'Failed to reschedule work order');
      }

      await fetchSchedule();
    } catch (err) {
      alert(`Error rescheduling: ${err.message}`);
      info.revert();
    }
  };

  // Drag & drop state and handlers for custom workstation-week grid
  const [dragOverCell, setDragOverCell] = useState(null);

  const handleDragStart = (e, ev) => {
    try {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: ev.id }));
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) {
      // ignore
    }
  };

  const handleCellDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleCellDrop = async (e, targetDate, targetWs) => {
    e.preventDefault();
    setDragOverCell(null);
    try {
      const raw = e.dataTransfer.getData('text/plain');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const eventId = parsed.id;
      const ev = events.find(x => x.id === eventId);
      if (!ev) throw new Error('Event not found');

      const isAllDay = !!ev.allDay;
      const origStart = ev.start instanceof Date ? ev.start : new Date(ev.start);
      const origEnd = ev.end ? (ev.end instanceof Date ? ev.end : new Date(ev.end)) : origStart;
      const durationMs = Math.max(0, origEnd.getTime() - origStart.getTime());

      let newStart, newEnd;
      if (isAllDay) {
        newStart = new Date(targetDate);
        newStart.setHours(0,0,0,0);
        newEnd = new Date(newStart);
      } else {
        newStart = new Date(targetDate);
        newStart.setHours(origStart.getHours(), origStart.getMinutes(), origStart.getSeconds(), 0);
        newEnd = new Date(newStart.getTime() + durationMs);
      }

      // call appropriate reschedule endpoint
      await rescheduleEvent(ev, newStart, newEnd, targetWs);
      await fetchSchedule();
    } catch (err) {
      console.error('Drop error', err);
      alert('Failed to move event: ' + (err.message || err));
    }
  };

  const rescheduleEvent = async (eventObj, newStart, newEnd, newWorkstation) => {
    const type = eventObj.extendedProps?.type;
    const docName = eventObj.extendedProps?.docName;
    if (!type || !docName) throw new Error('Invalid event data');

    if (type === 'jobcard') {
      const body = { from_time: formatDateTimeLocal(newStart), to_time: formatDateTimeLocal(newEnd) };
      if (newWorkstation) body.workstation = newWorkstation;
      const response = await fetch(`${API_URL}/job-cards/${docName}/reschedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      await handleApiResponse(response, 'Failed to reschedule job card');
    } else if (type === 'workorder') {
      const body = { planned_start_date: formatDateLocal(newStart), planned_end_date: formatDateLocal(newEnd) };
      if (newWorkstation) body.workstation = newWorkstation;
      const response = await fetch(`${API_URL}/work-orders/${docName}/reschedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      await handleApiResponse(response, 'Failed to reschedule work order');
    } else {
      throw new Error('Unknown event type');
    }
  };

  // Determine color based on Job Card status
  const getStatusColor = (status) => {
    const colors = {
      'Not Started': '#3498db',
      'In Progress': '#f39c12',
      'Completed': '#27ae60',
      'On Hold': '#e74c3c',
      'Open': '#95a5a6'
    };
    return colors[status] || '#3498db';
  };

  const formatDateTimeLocal = (date) => {
    if (!date) return null;
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  const formatDateLocal = (date) => {
    if (!date) return null;
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  // Determine color based on Work Order status
  const getStatusColorWO = (status) => {
    const colors = {
      'Draft': '#bdc3c7',
      'Submitted': '#9b59b6',
      'In Progress': '#f39c12',
      'Completed': '#27ae60',
      'Cancelled': '#e74c3c'
    };
    return colors[status] || '#3498db';
  };

  const workstations = useMemo(() => {
    const s = new Set();
    events.forEach(e => {
      const w = e.extendedProps?.workstation || 'Unassigned';
      s.add(w);
    });
    return Array.from(s);
  }, [events]);

  const formatWeekTitle = (date) => {
    const start = new Date(date);
    // find start of week (Monday)
    const day = start.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // make Monday the first day
    start.setDate(start.getDate() + diff);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const opts = { month: 'short', day: 'numeric' };
    return `${start.toLocaleDateString(undefined, opts)} - ${end.toLocaleDateString(undefined, opts)}`;
  };

  const getWeekDays = (date) => {
    const start = new Date(date);
    const day = start.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // Monday start
    start.setDate(start.getDate() + diff);
    start.setHours(0,0,0,0);
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      d.setHours(0,0,0,0);
      return d;
    });
  };

  const eventIntersectsDay = (ev, day) => {
    if (!ev) return false;
    const s = ev.start instanceof Date ? ev.start : new Date(ev.start);
    let en = ev.end ? (ev.end instanceof Date ? ev.end : new Date(ev.end)) : s;
    // normalize times
    const dayStart = new Date(day); dayStart.setHours(0,0,0,0);
    const dayEnd = new Date(day); dayEnd.setHours(23,59,59,999);
    return s <= dayEnd && en >= dayStart;
  };

  if (loading) return <div className="scheduler-loading">Loading schedule...</div>;

  return (
    <div className="scheduler-container">
      <div className="scheduler-header">
        <h1>Production Scheduler</h1>
        <div className="scheduler-actions">
          <button onClick={() => setViewFilter('all')} className={viewFilter === 'all' ? 'btn-active' : ''}>
            All
          </button>
          {/* Work Orders are displayed under Job Cards; standalone Work Orders hidden */}
          <button onClick={() => setViewFilter('jobcard')} className={viewFilter === 'jobcard' ? 'btn-active' : ''}>
            Job Cards
          </button>
          <button onClick={fetchSchedule} className="btn-refresh">
            Refresh
          </button>
          <button onClick={() => setShowWorkstationWeek(s => !s)} className={showWorkstationWeek ? 'btn-active' : ''}>
            Workstation Week
          </button>
        </div>
      </div>

      {error && <div className="scheduler-error">Error: {error}</div>}

      <div className="scheduler-info">
        <p>Drag and drop events to reschedule Job Cards and Work Orders</p>
        <div className="legend">
          <span><span className="legend-box" style={{ backgroundColor: getStatusColor('Not Started'), border: '1px solid #2c3e50' }}></span> JC: Not Started</span>
          <span><span className="legend-box" style={{ backgroundColor: getStatusColor('In Progress'), border: '1px solid #2c3e50' }}></span> JC: In Progress</span>
          <span><span className="legend-box" style={{ backgroundColor: getStatusColor('Completed'), border: '1px solid #2c3e50' }}></span> JC: Completed</span>
          <span><span className="legend-box" style={{ backgroundColor: getStatusColorWO('Draft'), border: '1px solid #34495e' }}></span> WO: Not Started</span>
        </div>
      </div>

      <div className="calendar-wrapper">
        {!showWorkstationWeek && (
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              left: 'prev,next today',
              center: 'title',
              right: 'dayGridMonth,timeGridWeek,timeGridDay'
            }}
            events={events.filter((event) => {
              if (viewFilter === 'all') return true;
              return event.extendedProps?.type === viewFilter;
            })}
            editable={true}
            eventDrop={handleEventDrop}
            eventResize={handleEventDrop}
            eventDisplay="block"
            height="auto"
            dateClick={(info) => {
              const calendarApi = calendarRef.current.getApi();
              calendarApi.changeView('timeGridDay', info.date);
            }}
            eventClick={(info) => {
              const docType = info.event.extendedProps.type === 'jobcard' ? 'job-card' : 'work-order';
              window.open(`http://localhost:8080/app/${docType}/${info.event.extendedProps.docName}`, '_blank');
            }}
          />
        )}

        {showWorkstationWeek && (
          <div className="ws-grid">
            <div className="ws-controls">
                <button onClick={() => setActiveDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() - 7); return nd; })}>&lt;</button>
                <button onClick={() => setActiveDate(new Date())}>Today</button>
                <button onClick={() => setActiveDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() + 7); return nd; })}>&gt;</button>
                <div className="ws-week-title">{formatWeekTitle(activeDate)}</div>
              </div>
            <div className="ws-name-col">Workstation</div>
            <div className="ws-date-row">
              <div className="ws-date-col">
                <div className="ws-date-grid">
                  {(() => {
                    const days = [];
                    const start = new Date(activeDate);
                    const day = start.getDay();
                    const diff = (day === 0 ? -6 : 1) - day; // Monday start
                    start.setDate(start.getDate() + diff);
                    for (let i = 0; i < 7; i++) {
                      const d = new Date(start);
                      d.setDate(start.getDate() + i);
                      days.push(d);
                    }
                    return days.map(d => (
                      <div key={d.toISOString()} className="ws-date-cell">
                        <div className="ws-date-day">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                        <div className="ws-date-num">{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>

            {/* Single shared date header row */}
            

            {(() => {
              const days = getWeekDays(activeDate);
              return workstations.map((ws) => (
                <div className="ws-row" key={ws}>
                  <div className="ws-name-col">{ws}</div>
                  <div className="ws-row-grid">
                    {days.map(d => {
                      const cellEvents = events.filter(e => {
                        const matchesType = viewFilter === 'all' ? true : e.extendedProps?.type === viewFilter;
                        const evtWs = e.extendedProps?.workstation || 'Unassigned';
                        return matchesType && evtWs === ws && eventIntersectsDay(e, d);
                      });
                      const cellKey = `${ws}::${d.toISOString()}`;
                      return (
                        <div
                          className={`ws-cell ${dragOverCell === cellKey ? 'drag-over' : ''}`}
                          key={d.toISOString()}
                          onDragOver={handleCellDragOver}
                          onDragEnter={() => setDragOverCell(cellKey)}
                          onDragLeave={() => setDragOverCell(null)}
                          onDrop={(e) => handleCellDrop(e, d, ws)}
                        >
                          {cellEvents.map(ev => (
                            <div
                              key={ev.id}
                              className="ws-event"
                              draggable
                              onDragStart={(e) => handleDragStart(e, ev)}
                              style={{ backgroundColor: ev.backgroundColor || '#3498db', border: `1px solid ${ev.borderColor || '#2c3e50'}` }}
                              onClick={() => window.open(`http://localhost:8080/app/${ev.extendedProps.type === 'jobcard' ? 'job-card' : 'work-order'}/${ev.extendedProps.docName}`, '_blank')}
                            >
                              {ev.title}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ));
            })()}
          </div>
        )}
      </div>
    </div>
  );
};

export default Scheduler;
