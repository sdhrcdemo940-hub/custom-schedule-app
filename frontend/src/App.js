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
          🏭 Production Scheduler
        </button>
        <button
          className={`app-nav-btn ${activeApp === 'forecast' ? 'active' : ''}`}
          onClick={() => handleTabChange('forecast')}
        >
          📈 Sales Forecast
        </button>
      </div>

      {activeApp === 'scheduler' && <Scheduler />}
      {activeApp === 'forecast' && <SalesForecast />}
    </div>
  );
}

export default App;
