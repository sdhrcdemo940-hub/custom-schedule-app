// Frontend - React Component
// src/components/Scheduler.jsx

import React, { useState, useEffect } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import dragDropPlugin from '@fullcalendar/daygrid';
import './Scheduler.css';

const Scheduler = () => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const API_URL = process.env.REACT_APP_API_URL;
  //const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';
  // Fetch data from backend
  useEffect(() => {
    fetchSchedule();
  }, []);

  const fetchSchedule = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/schedule`);
      const data = await response.json();

      // Transform Job Cards
      const jobCardEvents = data.jobCards.map(jc => ({
        id: `jc-${jc.name}`,
        title: `Job Card: ${jc.subject}`,
        start: jc.from_time,
        end: jc.to_time,
        type: 'jobcard',
        docName: jc.name,
        backgroundColor: getStatusColor(jc.status),
        borderColor: '#2c3e50',
        extendedProps: {
          status: jc.status,
          workOrder: jc.work_order
        }
      }));

      // Transform Work Orders
      const workOrderEvents = data.workOrders.map(wo => ({
        id: `wo-${wo.name}`,
        title: `Work Order: ${wo.title}`,
        start: wo.planned_start_date,
        end: wo.planned_end_date,
        type: 'workorder',
        docName: wo.name,
        backgroundColor: getStatusColorWO(wo.status),
        borderColor: '#34495e',
        extendedProps: {
          status: wo.status
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
  const handleEventDrop = async (info) => {
    const { event } = info;
    const { type, docName } = event;

    try {
      if (type === 'jobcard') {
        await fetch(`${API_URL}/job-cards/${docName}/reschedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_time: event.start.toISOString(),
            to_time: event.end.toISOString()
          })
        });
      } else if (type === 'workorder') {
        await fetch(`${API_URL}/work-orders/${docName}/reschedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            planned_start_date: event.start.toISOString().split('T')[0],
            planned_end_date: event.end.toISOString().split('T')[0]
          })
        });
      }

      // Refresh data
      await fetchSchedule();
    } catch (err) {
      alert(`Error rescheduling: ${err.message}`);
      info.revert(); // Revert the change on error
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

  if (loading) return <div className="scheduler-loading">Loading schedule...</div>;

  return (
    <div className="scheduler-container">
      <div className="scheduler-header">
        <h1>Production Scheduler</h1>
        <button onClick={fetchSchedule} className="btn-refresh">
          Refresh
        </button>
      </div>

      {error && <div className="scheduler-error">Error: {error}</div>}

      <div className="scheduler-info">
        <p>Drag and drop events to reschedule Job Cards and Work Orders</p>
        <div className="legend">
          <span><span className="legend-box" style={{ backgroundColor: '#3498db' }}></span> Job Card: Not Started</span>
          <span><span className="legend-box" style={{ backgroundColor: '#f39c12' }}></span> Job Card: In Progress</span>
          <span><span className="legend-box" style={{ backgroundColor: '#27ae60' }}></span> Job Card: Completed</span>
          <span><span className="legend-box" style={{ backgroundColor: '#9b59b6' }}></span> Work Order: Submitted</span>
        </div>
      </div>

      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, dragDropPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,timeGridWeek,timeGridDay'
        }}
        events={events}
        editable={true}
        eventDrop={handleEventDrop}
        eventDisplay="block"
        height="auto"
        eventClick={(info) => {
          window.open(`http://localhost:8080/app/${info.event.extendedProps.type === 'jobcard' ? 'job-card' : 'work-order'}/${info.event.extendedProps.docName}`, '_blank');
        }}
      />
    </div>
  );
};

export default Scheduler;
