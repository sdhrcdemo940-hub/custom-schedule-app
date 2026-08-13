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

      // Transform Job Cards
      const jobCardEvents = (data.jobCards || []).map(jc => ({
        id: `jc-${jc.name}`,
        title: `JC: ${jc.subject || jc.name}`,
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

      // Transform Work Orders
      const workOrderEvents = (data.workOrders || []).map(wo => ({
        id: `wo-${wo.name}`,
        title: `WO: ${wo.title || wo.name}`,
        start: wo.planned_start_date,
        end: wo.planned_end_date,
        allDay: true,
        backgroundColor: getStatusColorWO(wo.status),
        borderColor: '#34495e',
        extendedProps: {
          type: 'workorder',
          docName: wo.name,
          status: wo.status
          ,workstation: wo.workstation || wo.workstation_name || wo.work_center || wo.work_center_name || wo.machine || null
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

  if (loading) return <div className="scheduler-loading">Loading schedule...</div>;

  return (
    <div className="scheduler-container">
      <div className="scheduler-header">
        <h1>Production Scheduler</h1>
        <div className="scheduler-actions">
          <button onClick={() => setViewFilter('all')} className={viewFilter === 'all' ? 'btn-active' : ''}>
            All
          </button>
          <button onClick={() => setViewFilter('workorder')} className={viewFilter === 'workorder' ? 'btn-active' : ''}>
            Work Orders
          </button>
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
          <span><span className="legend-box" style={{ backgroundColor: '#3498db' }}></span> JC: Not Started</span>
          <span><span className="legend-box" style={{ backgroundColor: '#f39c12' }}></span> JC: In Progress</span>
          <span><span className="legend-box" style={{ backgroundColor: '#27ae60' }}></span> JC: Completed</span>
          <span><span className="legend-box" style={{ backgroundColor: '#9b59b6' }}></span> WO: Submitted</span>
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
            <div className="ws-grid-header">
              <div className="ws-name-col">Workstation</div>
              <div className="ws-controls">
                <button onClick={() => setActiveDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() - 7); return nd; })}>&lt;</button>
                <button onClick={() => setActiveDate(new Date())}>Today</button>
                <button onClick={() => setActiveDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() + 7); return nd; })}>&gt;</button>
                <div className="ws-week-title">{formatWeekTitle(activeDate)}</div>
              </div>
            </div>

            {workstations.map((ws) => (
              <div className="ws-row" key={ws}>
                <div className="ws-name-col">{ws}</div>
                <div className="ws-calendar-col">
                  <FullCalendar
                    plugins={[timeGridPlugin, interactionPlugin]}
                    initialView="timeGridWeek"
                    initialDate={activeDate}
                    headerToolbar={false}
                    events={events.filter(e => {
                      const matchesType = viewFilter === 'all' ? true : e.extendedProps?.type === viewFilter;
                      const evtWs = e.extendedProps?.workstation || e.extendedProps?.workOrder || 'Unassigned';
                      return matchesType && evtWs === ws;
                    })}
                    editable={true}
                    eventDrop={handleEventDrop}
                    eventResize={handleEventDrop}
                    eventDisplay="block"
                    height={120}
                    allDaySlot={false}
                    slotMinTime="06:00:00"
                    slotMaxTime="20:00:00"
                    nowIndicator={true}
                    eventClick={(info) => {
                      const docType = info.event.extendedProps.type === 'jobcard' ? 'job-card' : 'work-order';
                      window.open(`http://localhost:8080/app/${docType}/${info.event.extendedProps.docName}`, '_blank');
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Scheduler;
