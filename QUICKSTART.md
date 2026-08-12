# Quick Start Guide

## Setup (First Time Only)

### Windows Users:
1. **Double-click `setup.bat`** in the scheduler-app folder
   - This will install all dependencies automatically

### Mac/Linux Users:
```bash
cd scheduler-app
npm install
cd frontend
npm install
cd ..
```

---

## Running the Application

### Terminal 1 - Backend (from scheduler-app folder):
```bash
npm start
```
Backend will run on: **http://localhost:3000**

### Terminal 2 - Frontend (from scheduler-app/frontend folder):
```bash
cd frontend
npm start
```
Frontend will run on: **http://localhost:3001**

---

## First Time Configuration

### Get ERPNext API Credentials:

1. **Log in to ERPNext** (http://localhost:8080)
2. **Click your profile** (top right)
3. **Go to "Set User Preferences"**
4. **Scroll down to "API Access"**
5. **Click "Generate API Key"**
6. **Copy the Key and Secret**

### Update .env file:

Edit `scheduler-app/.env`:
```
ERPNEXT_URL=http://localhost:8080
ERPNEXT_API_KEY=your_key_here
ERPNEXT_API_SECRET=your_secret_here
PORT=3000
```

---

## Using the Scheduler

1. **Open** http://localhost:3001
2. **See all Job Cards and Work Orders** on the calendar
3. **Drag any event** to reschedule it
4. **Click any event** to open in ERPNext
5. **Use buttons** to switch between Month/Week/Day views
6. **Click Refresh** to reload from ERPNext

---

## Troubleshooting

### "Cannot connect to ERPNext"
- Verify ERPNext is running: http://localhost:8080
- Check ERPNEXT_URL in .env is correct
- Verify API key and secret are correct

### "npm: command not found"
- Install Node.js from https://nodejs.org/
- Restart terminal/computer

### Port already in use
- Backend: Change PORT in .env
- Frontend: Stop other React apps on port 3001

### Changes not saving
- Check browser console (F12) for errors
- Verify backend is running
- Check ERPNext permissions

---

## File Structure

```
scheduler-app/
├── server.js              # Backend API
├── package.json           # Backend dependencies
├── .env                   # Configuration
├── README.md              # Full documentation
├── setup.bat              # Windows setup script
└── frontend/
    ├── src/
    │   ├── App.js         # Main app
    │   ├── index.js       # Entry point
    │   └── components/
    │       ├── Scheduler.jsx
    │       └── Scheduler.css
    ├── public/
    │   └── index.html
    ├── package.json       # Frontend dependencies
    └── .env               # Frontend config
```

---

## Common Commands

```bash
# Backend
npm install              # Install dependencies
npm start               # Start server
npm run dev             # Start with auto-reload (if nodemon installed)

# Frontend
cd frontend
npm install             # Install dependencies
npm start              # Start dev server
npm run build          # Build for production
```

---

## Need Help?

1. **Check README.md** for detailed documentation
2. **Check browser console** (F12) for JavaScript errors
3. **Check backend terminal** for API errors
4. **Verify ERPNext connectivity** - can you access http://localhost:8080?

---

## Next Steps

1. ✅ Install everything (run setup.bat or npm install)
2. ✅ Update .env with API credentials
3. ✅ Start backend: `npm start`
4. ✅ Start frontend: `cd frontend && npm start`
5. ✅ Open http://localhost:3001
6. ✅ Test drag-and-drop!

**Ready to go!**
