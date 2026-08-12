# ERPNext Work Order & Job Card Scheduler

A standalone web application for scheduling and rescheduling Work Orders and Job Cards with drag-and-drop calendar interface.

## Features

✅ **Drag-and-Drop Calendar** - Reschedule Job Cards and Work Orders by dragging
✅ **Real-time Sync** - Changes sync back to ERPNext automatically
✅ **Color-coded Status** - Visual representation of document status
✅ **Multiple Views** - Month, Week, and Day views
✅ **Direct Links** - Click to open documents in ERPNext
✅ **API-based** - No modifications to ERPNext required

## Architecture

```
Scheduler App
├── Backend (Node.js/Express)
│   ├── Job Card API endpoints
│   ├── Work Order API endpoints
│   └── ERPNext API integration
├── Frontend (React + FullCalendar)
│   ├── Calendar component
│   ├── Drag-drop handler
│   └── Status legend
└── Database (SQLite for caching)
```

## Installation

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- ERPNext v16 with API key and secret
- Port 3000 (backend) and 3001 (frontend) available

### Backend Setup

1. **Navigate to backend directory**
```bash
cd scheduler-app
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
```

Edit `.env` and add:
```
ERPNEXT_URL=http://localhost:8080
ERPNEXT_API_KEY=your_api_key
ERPNEXT_API_SECRET=your_api_secret
PORT=3000
```

4. **Get API Key from ERPNext**
   - Log in to ERPNext as Administrator
   - Go to: Setup → Users and Permissions → Users
   - Click on your user
   - Scroll to "API Access" section
   - Click "Generate API Key"
   - Copy Key and Secret to .env

5. **Start backend server**
```bash
npm start
```
Backend will run on `http://localhost:3000`

### Frontend Setup

1. **Create React app**
```bash
npx create-react-app frontend
cd frontend
```

2. **Install dependencies**
```bash
npm install @fullcalendar/react @fullcalendar/daygrid @fullcalendar/timegrid @fullcalendar/interaction axios
```

3. **Copy Scheduler component**
- Copy `src/components/Scheduler.jsx` to `frontend/src/components/`
- Copy `src/components/Scheduler.css` to `frontend/src/components/`

4. **Update App.js**
```javascript
import Scheduler from './components/Scheduler';

function App() {
  return <Scheduler />;
}

export default App;
```

5. **Create .env file**
```bash
REACT_APP_API_URL=http://localhost:3000/api
```

6. **Start frontend**
```bash
npm start
```
Frontend will run on `http://localhost:3001`

## API Endpoints

### Job Cards
- `GET /api/job-cards` - Get all job cards
- `GET /api/job-cards/:id` - Get single job card
- `PUT /api/job-cards/:id/reschedule` - Update dates
  ```json
  {
    "from_time": "2026-08-15T10:00:00",
    "to_time": "2026-08-15T14:00:00"
  }
  ```

### Work Orders
- `GET /api/work-orders` - Get all work orders
- `GET /api/work-orders/:id` - Get single work order
- `PUT /api/work-orders/:id/reschedule` - Update dates
  ```json
  {
    "planned_start_date": "2026-08-15",
    "planned_end_date": "2026-08-20"
  }
  ```

### Combined
- `GET /api/schedule` - Get all job cards and work orders combined

## Usage

1. **Open Application**
   - Go to http://localhost:3001

2. **View Schedule**
   - Calendar displays all Job Cards and Work Orders
   - Color legend shows status

3. **Reschedule**
   - Click and drag any event to a new date
   - Changes save automatically to ERPNext
   - If error occurs, change reverts

4. **View Details**
   - Click on event to open in ERPNext
   - Edit complex fields in ERPNext directly

## Color Legend

### Job Cards
- 🔵 Blue = Not Started
- 🟠 Orange = In Progress
- 🟢 Green = Completed
- 🔴 Red = On Hold

### Work Orders
- ⚫ Gray = Draft
- 🟣 Purple = Submitted
- 🟠 Orange = In Progress
- 🟢 Green = Completed

## Features Explained

### Drag-and-Drop
- Click and hold an event
- Drag to target date
- Release to reschedule
- Works with all date fields

### Multiple Views
- **Month** - See entire month at once
- **Week** - See 7-day week with hourly slots
- **Day** - See single day details

### Status Indicators
- Color-coded bars show document status
- Green = Ready/Completed
- Orange = In Progress
- Red = Issues/On Hold

### Direct Integration
- All changes sync immediately to ERPNext
- No manual approval needed
- Maintains ERPNext validation

## Troubleshooting

### "Connection refused"
- Ensure ERPNext is running on http://localhost:8080
- Check ERPNEXT_URL in .env

### "Authentication failed"
- Verify API Key and Secret are correct
- User account must have API access enabled
- Check ERPNext user permissions

### Events not updating
- Check browser console for errors
- Verify network tab shows POST requests
- Check backend logs for API errors

### Dates reverting
- ERPNext validation may reject date
- Open in ERPNext to see validation error
- Adjust dates based on dependencies

## Deployment

### Docker Deployment
Create `Dockerfile`:
```dockerfile
FROM node:16
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t erpnext-scheduler .
docker run -p 3000:3000 --env-file .env erpnext-scheduler
```

### Production Setup
1. Use Nginx as reverse proxy
2. Enable HTTPS/SSL
3. Set NODE_ENV=production
4. Configure CORS for production domain
5. Set up PM2 for process management

## Advanced Features (Optional)

### Add to list
- Resource/Machine allocation
- Dependency management
- Conflict detection
- Capacity planning
- Multi-shift scheduling

### Future Enhancements
- Real-time notifications
- Bulk reschedule
- Gantt timeline view
- Resource allocation view
- Mobile app

## Support

For issues or questions:
1. Check ERPNext logs: `docker logs frappe_docker-backend-1`
2. Check application logs in browser console
3. Verify API connectivity: `curl http://localhost:3000/api/health`
4. Check ERPNext permissions and API access

## License

MIT
