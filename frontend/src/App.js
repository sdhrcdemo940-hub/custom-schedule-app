import React, { useState } from 'react';
import Scheduler from './components/Scheduler';
import SalesForecast from './components/SalesForecast';
import './App.css';

function App() {
  const [activeApp, setActiveApp] = useState(() => {
    const saved = localStorage.getItem('app_active_section');
    return (saved === 'forecast') ? 'forecast' : 'scheduler';
  });

  const handleTabChange = (tab) => {
    setActiveApp(tab);
    try { localStorage.setItem('app_active_section', tab); } catch (e) {}
  };

  return (
    <div className="App">
      {/* Global App Switcher */}
      <div className="app-nav-bar">
        <button
          className={`app-nav-btn ${activeApp === 'scheduler' ? 'active' : ''}`}
          onClick={() => handleTabChange('scheduler')}
        >
          <svg className="app-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
          <span>Production Scheduler</span>
        </button>
        <button
          className={`app-nav-btn ${activeApp === 'forecast' ? 'active' : ''}`}
          onClick={() => handleTabChange('forecast')}
        >
          <svg className="app-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"></line>
            <line x1="12" y1="20" x2="12" y2="4"></line>
            <line x1="6" y1="20" x2="6" y2="14"></line>
          </svg>
          <span>Sales Forecast</span>
        </button>
      </div>

      {activeApp === 'scheduler' && <Scheduler />}
      {activeApp === 'forecast' && <SalesForecast />}
    </div>
  );
}

export default App;
