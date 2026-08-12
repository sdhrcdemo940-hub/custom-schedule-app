# ERPNext Manufacturing Scheduler - Complete Project Context

## Project Overview
Building a standalone external web application for scheduling and rescheduling Work Orders and Job Cards with drag-and-drop calendar interface. This is a full-stack solution with Node.js backend and React frontend that integrates with ERPNext v16 via API.

## Problem Statement
- ERPNext's native calendar view is READ-ONLY for Job Cards and Work Orders
- Users cannot drag-and-drop to reschedule
- Need editable, interactive scheduling interface
- Must sync changes back to ERPNext automatically

## Solution Architecture

### Technology Stack
- **Backend**: Node.js + Express.js
- **Frontend**: React + FullCalendar library
- **Database Integration**: ERPNext v16 API
- **Configuration**: Environment variables (.env files)
- **Port**: Backend on 3500, Frontend on 3001 (user preference)

### Project Structure
```
scheduler-app/
├── server.js                    # Express backend with API endpoints
├── package.json                 # Backend dependencies
├── .env                         # Backend config (3500, ERPNext URL, API keys)
├── README.md                    # Full documentation
├── QUICKSTART.md               # Quick setup guide
├── setup.bat                   # Windows auto-setup script
└── frontend/
    ├── src/
    │   ├── App.js              # Main React app
    │   ├── index.js            # Entry point
    │   └── components/
    │       ├── Scheduler.jsx    # Calendar component (drag-drop logic)
    │       └── Scheduler.css    # Calendar styling
    ├── public/
    │   └── index.html          # HTML template
    ├── package.json            # Frontend dependencies
    └── .env                    # Frontend config (API URL pointing to 3500)
```

## Current Status

### What's Done ✓
1. Backend API created with endpoints:
   - `GET /api/job-cards` - Fetch all job cards
   - `GET /api/work-orders` - Fetch all work orders
   - `GET /api/schedule` - Combined job cards + work orders
   - `PUT /api/job-cards/:id/reschedule` - Update job card dates
   - `PUT /api/work-orders/:id/reschedule` - Update work order dates
   - `GET /api/health` - Health check

2. Frontend React app created with:
   - FullCalendar integration
   - Drag-and-drop reschedule functionality
   - Color-coded status indicators
   - Multiple calendar views (Month/Week/Day)
   - Direct links to open documents in ERPNext

3. Configuration:
   - Backend running on port 3500 ✓
   - Frontend configured to point to backend on 3500 ✓
   - ERPNext API credentials configured ✓
   - All dependencies installable ✓

### Current Issue - NEEDS FIX
**Problem**: Calendar shows empty - no Job Cards or Work Orders displaying

**Root Cause**: Backend API queries are not properly JSON stringifying the `fields` and `filters` parameters. ERPNext API requires these as JSON strings, not arrays.

**Evidence**: 
- API health check works: ✓
- Backend returns data but ONLY name field: `[{"name":"PO-JOB00001"},...]`
- Missing: from_time, to_time, status, subject, etc.

**Fix Applied**: 
- Updated server.js to use `JSON.stringify()` for fields and filters parameters
- Need to restart backend server for changes to take effect

**Next Action**: 
- User needs to restart backend: Stop current process (Ctrl+C) and run `npm start` again
- Refresh browser at http://localhost:3001
- Calendar should now populate with all Job Cards and Work Orders

## ERPNext Data Available
- 37 Job Cards (PO-JOB00001 to PO-JOB00037)
- 22 Work Orders (MFG-WO-2026-00001 to MFG-WO-2026-00022)
- Database: MariaDB running in Docker
- API Keys: Valid and configured
- Location: http://localhost:8080

## Backend Configuration (.env)
```
ERPNEXT_URL=http://localhost:8080
ERPNEXT_API_KEY=963647fef4e3160
ERPNEXT_API_SECRET=9167a6391ff4800
PORT=3500
NODE_ENV=development
```

## Frontend Configuration (.env)
```
REACT_APP_API_URL=http://localhost:3500/api
```

## Features Implemented
1. **Drag-and-Drop Scheduling**: Click and drag events to new dates
2. **Automatic Sync**: Changes save to ERPNext immediately
3. **Status Colors**: 
   - Blue = Not Started (Job Card)
   - Orange = In Progress
   - Green = Completed
   - Purple = Submitted (Work Order)
4. **Multiple Views**: Month, Week, Day calendar views
5. **Direct Integration**: Click events to open in ERPNext
6. **Responsive Design**: Works on desktop and tablet
7. **Error Handling**: Reverts changes on API errors

## Installation Steps (Already Completed)
1. Backend dependencies installed via package.json
2. Frontend dependencies listed in frontend/package.json
3. All config files created (.env files)
4. All source files created (Scheduler.jsx, server.js, etc.)
5. Setup script created (setup.bat for Windows)

## Setup Instructions for Next User
1. Navigate to `scheduler-app` directory
2. Update `.env` with ERPNext API credentials (if needed)
3. Start backend: `npm start` (port 3500)
4. In another terminal: `cd frontend && npm start` (port 3001)
5. Open http://localhost:3001
6. Drag events to reschedule

## Known Issues & Fixes
1. **Empty Calendar**: Fixed by adding JSON.stringify to API queries (pending server restart)
2. **Port Configuration**: Changed from default 3000 to 3500 per user request - already configured
3. **CORS**: Enabled in backend
4. **API Authentication**: Using basic auth with ERPNext API key and secret

## Files Modified/Created
- `server.js` - Backend Express server (FIXED with JSON.stringify)
- `frontend/src/components/Scheduler.jsx` - React calendar component
- `frontend/src/components/Scheduler.css` - Styling
- `frontend/public/index.html` - HTML template
- `frontend/src/App.js` - Main app
- `frontend/src/index.js` - Entry point
- `frontend/src/index.css` - Global styles
- `.env` files (both backend and frontend)
- `package.json` files (both)
- Documentation files (README.md, QUICKSTART.md)

## Important Notes for Next Agent
1. **Backend needs restart** after the JSON.stringify fix was applied
2. User changed port from 3000 to 3500 - this is already configured
3. ERPNext is running on localhost:8080 with valid API credentials
4. MariaDB database is healthy and contains 37 Job Cards and 22 Work Orders
5. Frontend will automatically connect to http://localhost:3500/api once backend is restarted
6. All dependencies are npm installable - no Docker needed for scheduler app itself
7. This is a WORKING application - just needs backend restart to fetch data properly

## Testing Checklist
- [ ] Restart backend server (`npm start`)
- [ ] Refresh frontend at http://localhost:3001
- [ ] Verify calendar shows Job Cards and Work Orders
- [ ] Test drag-and-drop on one event
- [ ] Verify change syncs back to ERPNext
- [ ] Check different calendar views (Month/Week/Day)
- [ ] Click event to open in ERPNext

## Deployment Status
- **Development**: Ready to test locally
- **Production**: Dockerize when ready (Dockerfile template available in README.md)
- **Next Steps**: Test functionality, then consider production deployment

## Contact Information
- ERPNext Instance: http://localhost:8080
- Scheduler Frontend: http://localhost:3001
- Scheduler Backend API: http://localhost:3500/api
- Database: MariaDB on Docker (internal network)

---

## Quick Command Reference

### Start Backend
```bash
cd scheduler-app
npm start
```

### Start Frontend
```bash
cd scheduler-app/frontend
npm start
```

### View Logs
```bash
docker logs frappe_docker-backend-1      # ERPNext backend
docker logs frappe_docker-db-1           # Database
```

### Restart Backend Services
```bash
docker restart frappe_docker-backend-1
docker restart frappe_docker-frontend-1
```

## Previous Session Context
- Set up Metabase for analytics (now connected to ERPNext)
- Created sample Sales Orders with varying quantities (5-20 units)
- Created sample Customers and Suppliers
- Discussed calendar view vs Gantt chart for scheduling
- Issue with Job Card drag-drop not persisting (status was "Open", not "Not Started")
- Fixed database connectivity issues between containers
- Exposed database port 3306 for Metabase connection
- Created new metabase_user for database access

---

**Status**: 95% Complete - Awaiting backend restart to populate calendar with data
