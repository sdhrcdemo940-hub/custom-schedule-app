import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
import './SalesForecast.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3500/api';

const TREND_CONFIG = {
  growing:  { icon: '↑', label: 'Growing',  color: '#16a34a', bg: '#dcfce7' },
  declining:{ icon: '↓', label: 'Declining', color: '#dc2626', bg: '#fee2e2' },
  stable:   { icon: '→', label: 'Stable',   color: '#ca8a04', bg: '#fef9c3' },
};

const METHOD_COLORS = {
  sma:   '#3b82f6',
  wma:   '#8b5cf6',
  trend: '#f97316',
};

const BUFFER_OPTIONS = [0, 10, 20, 30];

// Custom tooltip for the chart
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="fc-tooltip">
      <div className="fc-tooltip-month">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="fc-tooltip-row" style={{ color: p.color }}>
          <span className="fc-tooltip-dot" style={{ background: p.color }} />
          <span className="fc-tooltip-name">{p.name}:</span>
          <span className="fc-tooltip-val">{p.value?.toLocaleString()} units</span>
        </div>
      ))}
    </div>
  );
};

export default function SalesForecast() {
  const [forecastData, setForecastData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedItem, setSelectedItem] = useState('all');
  const [bufferPct, setBufferPct] = useState(0);
  const [lastFetched, setLastFetched] = useState(null);

  const fetchForecast = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/sales-forecast`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      setForecastData(data);
      setLastFetched(new Date().toLocaleTimeString());
      // Auto-select first item
      if (data.items && data.items.length > 0 && selectedItem === 'all') {
        setSelectedItem(data.items[0].itemCode);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchForecast();
  }, [fetchForecast]);

  // Currently selected item data
  const itemData = useMemo(() => {
    if (!forecastData || selectedItem === 'all') return null;
    return forecastData.items.find(i => i.itemCode === selectedItem) || null;
  }, [forecastData, selectedItem]);

  // Summary across all items for "All Items" view
  const allItemsSummary = useMemo(() => {
    if (!forecastData) return null;
    const monthMap = {};
    forecastData.items.forEach(item => {
      item.historical.forEach(h => {
        monthMap[h.month] = (monthMap[h.month] || 0) + h.qty;
      });
    });
    const months = Object.keys(monthMap).sort();
    return months.map(m => ({ month: m, qty: monthMap[m] }));
  }, [forecastData]);

  // Build chart data: historical + 3-month forecast
  const chartData = useMemo(() => {
    if (!itemData) return [];
    const applyBuffer = (val) => Math.round(val * (1 + bufferPct / 100));

    const historicalPoints = itemData.historical.map(h => ({
      month: h.month,
      actual: h.qty,
      sma: null, wma: null, trend: null,
      isForecast: false,
    }));

    const forecastPoints = itemData.forecasts.map(f => ({
      month: f.month,
      actual: null,
      sma: applyBuffer(f.sma),
      wma: applyBuffer(f.wma),
      trend: applyBuffer(f.trend),
      isForecast: true,
    }));

    return [...historicalPoints, ...forecastPoints];
  }, [itemData, bufferPct]);

  // Summary card values for the 3 forecast months
  const forecastCards = useMemo(() => {
    if (!itemData) return [];
    const applyBuffer = (val) => Math.round(val * (1 + bufferPct / 100));
    return itemData.forecasts.map(f => ({
      month: f.month,
      sma: applyBuffer(f.sma),
      wma: applyBuffer(f.wma),
      trend: applyBuffer(f.trend),
      recommended: applyBuffer(Math.round((f.sma + f.wma + f.trend) / 3)),
    }));
  }, [itemData, bufferPct]);

  // CSV export
  const exportCSV = () => {
    if (!itemData) return;
    const rows = [
      ['Month', 'Actual Qty', 'SMA Forecast', 'WMA Forecast', 'Trend Forecast', 'Type'],
      ...itemData.historical.map(h => [h.month, h.qty, '', '', '', 'Historical']),
      ...itemData.forecasts.map(f => [
        f.month, '',
        Math.round(f.sma * (1 + bufferPct / 100)),
        Math.round(f.wma * (1 + bufferPct / 100)),
        Math.round(f.trend * (1 + bufferPct / 100)),
        'Forecast'
      ])
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales_forecast_${selectedItem}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const trendInfo = itemData ? TREND_CONFIG[itemData.trendDirection] : null;

  return (
    <div className="sf-root">
      {/* ─── Header Bar ─── */}
      <div className="sf-topbar">
        <div className="sf-topbar-left">
          <div className="sf-logo-badge">FCST</div>
          <div>
            <h1 className="sf-title">SALES DEMAND FORECAST</h1>
            <div className="sf-subtitle">
              ERPNext Historical Analysis &amp; 3-Month Forward Projection
            </div>
          </div>
        </div>
        <div className="sf-topbar-right">
          {lastFetched && (
            <span className="sf-last-updated">Last updated: {lastFetched}</span>
          )}
          <button
            className="sf-btn-refresh"
            onClick={fetchForecast}
            disabled={loading}
          >
            <span className={loading ? 'spin' : ''}>🔄</span>
            {loading ? 'Fetching...' : 'Refresh Data'}
          </button>
          {itemData && (
            <button className="sf-btn-export" onClick={exportCSV}>
              ⬇ Export CSV
            </button>
          )}
        </div>
      </div>

      {/* ─── Error ─── */}
      {error && (
        <div className="sf-error-banner">
          ⚠️ Failed to load forecast: {error}. Make sure the backend is running on port 3500.
        </div>
      )}

      {/* ─── Loading State ─── */}
      {loading && !forecastData && (
        <div className="sf-loading">
          <div className="sf-spinner" />
          <div className="sf-loading-text">
            Fetching &amp; analysing {forecastData?.totalOrders || ''} Sales Orders from ERPNext…
          </div>
        </div>
      )}

      {/* ─── Main Content ─── */}
      {forecastData && (
        <>
          {/* ─── Stats Row ─── */}
          <div className="sf-stats-row">
            <div className="sf-stat-card">
              <div className="sf-stat-value">{forecastData.totalOrders}</div>
              <div className="sf-stat-label">Sales Orders Analysed</div>
            </div>
            <div className="sf-stat-card">
              <div className="sf-stat-value">{forecastData.items.length}</div>
              <div className="sf-stat-label">Unique Items Tracked</div>
            </div>
            {itemData && (
              <>
                <div className="sf-stat-card">
                  <div className="sf-stat-value">{itemData.totalHistoricalQty.toLocaleString()}</div>
                  <div className="sf-stat-label">Total Historical Qty Sold</div>
                </div>
                <div className="sf-stat-card">
                  <div className="sf-stat-value">{itemData.avgMonthlyQty.toLocaleString()}</div>
                  <div className="sf-stat-label">Avg Monthly Qty</div>
                </div>
                {trendInfo && (
                  <div className="sf-stat-card sf-stat-trend" style={{ background: trendInfo.bg }}>
                    <div className="sf-stat-value" style={{ color: trendInfo.color }}>
                      {trendInfo.icon}
                    </div>
                    <div className="sf-stat-label" style={{ color: trendInfo.color }}>
                      {trendInfo.label} Trend
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ─── Controls Row ─── */}
          <div className="sf-controls-row">
            <div className="sf-control-group">
              <label className="sf-control-label">Item / Product</label>
              <select
                className="sf-select"
                value={selectedItem}
                onChange={e => setSelectedItem(e.target.value)}
              >
                {forecastData.items.map(it => (
                  <option key={it.itemCode} value={it.itemCode}>
                    {it.itemCode} — avg {it.avgMonthlyQty} / month
                  </option>
                ))}
              </select>
            </div>
            <div className="sf-control-group">
              <label className="sf-control-label">
                Safety Stock Buffer: <strong>+{bufferPct}%</strong>
              </label>
              <div className="sf-buffer-buttons">
                {BUFFER_OPTIONS.map(b => (
                  <button
                    key={b}
                    className={`sf-buffer-btn ${bufferPct === b ? 'active' : ''}`}
                    onClick={() => setBufferPct(b)}
                  >
                    +{b}%
                  </button>
                ))}
              </div>
            </div>
            <div className="sf-control-group sf-legend-group">
              <label className="sf-control-label">Forecast Methods</label>
              <div className="sf-method-legend">
                <span className="sf-legend-chip" style={{ borderColor: '#64748b', background: '#f1f5f9' }}>
                  <span className="sf-legend-bar" style={{ background: '#64748b' }} />
                  Actual Sales
                </span>
                {Object.entries(METHOD_COLORS).map(([key, color]) => (
                  <span key={key} className="sf-legend-chip" style={{ borderColor: color }}>
                    <span className="sf-legend-line" style={{ background: color }} />
                    {key.toUpperCase()}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* ─── 3-Month Forecast Cards ─── */}
          {forecastCards.length > 0 && (
            <div className="sf-forecast-cards">
              {forecastCards.map((fc, i) => (
                <div key={fc.month} className={`sf-fcard sf-fcard-${i + 1}`}>
                  <div className="sf-fcard-header">
                    <span className="sf-fcard-period">Month +{i + 1}</span>
                    <span className="sf-fcard-month">{fc.month}</span>
                  </div>
                  <div className="sf-fcard-recommended">
                    {fc.recommended.toLocaleString()}
                    {bufferPct > 0 && (
                      <span className="sf-fcard-buffer-badge">+{bufferPct}% buffer</span>
                    )}
                  </div>
                  <div className="sf-fcard-label">Recommended Order Qty</div>
                  <div className="sf-fcard-methods">
                    <div className="sf-fcard-method" style={{ color: METHOD_COLORS.sma }}>
                      SMA: {fc.sma.toLocaleString()}
                    </div>
                    <div className="sf-fcard-method" style={{ color: METHOD_COLORS.wma }}>
                      WMA: {fc.wma.toLocaleString()}
                    </div>
                    <div className="sf-fcard-method" style={{ color: METHOD_COLORS.trend }}>
                      Trend: {fc.trend.toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ─── Combined Chart ─── */}
          {chartData.length > 0 && (
            <div className="sf-chart-section">
              <div className="sf-chart-title">
                Historical Sales &amp; 3-Month Forward Projection — {selectedItem}
                {bufferPct > 0 && (
                  <span className="sf-chart-buffer-note"> (forecast includes +{bufferPct}% safety buffer)</span>
                )}
              </div>
              {/* Divider between history and forecast */}
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.toLocaleString()}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />

                  {/* Divider at the boundary between history and forecast */}
                  {itemData && itemData.historical.length > 0 && (
                    <ReferenceLine
                      x={itemData.historical[itemData.historical.length - 1].month}
                      stroke="#cbd5e1"
                      strokeDasharray="6 3"
                      label={{ value: '▶ Forecast starts', position: 'insideTopRight', fontSize: 10, fill: '#94a3b8' }}
                    />
                  )}

                  <Bar dataKey="actual" name="Actual Sales" fill="#64748b" radius={[3, 3, 0, 0]} maxBarSize={50} />
                  <Line type="monotone" dataKey="sma"   name="SMA Forecast"   stroke={METHOD_COLORS.sma}   strokeWidth={2.5} dot={{ r: 5 }} strokeDasharray="6 3" connectNulls />
                  <Line type="monotone" dataKey="wma"   name="WMA Forecast"   stroke={METHOD_COLORS.wma}   strokeWidth={2.5} dot={{ r: 5 }} strokeDasharray="6 3" connectNulls />
                  <Line type="monotone" dataKey="trend" name="Trend Forecast"  stroke={METHOD_COLORS.trend} strokeWidth={2.5} dot={{ r: 5 }} strokeDasharray="6 3" connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ─── Data Table ─── */}
          {itemData && (
            <div className="sf-table-section">
              <div className="sf-table-title">Monthly Sales History &amp; Forecast Table — {selectedItem}</div>
              <div className="sf-table-scroll">
                <table className="sf-table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Type</th>
                      <th>Actual Qty</th>
                      <th style={{ color: METHOD_COLORS.sma }}>SMA Forecast</th>
                      <th style={{ color: METHOD_COLORS.wma }}>WMA Forecast</th>
                      <th style={{ color: METHOD_COLORS.trend }}>Trend Forecast</th>
                      <th>Recommended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemData.historical.map(h => (
                      <tr key={h.month} className="sf-row-history">
                        <td className="sf-td-month">{h.month}</td>
                        <td><span className="sf-type-badge sf-type-actual">Actual</span></td>
                        <td className="sf-td-qty">{h.qty.toLocaleString()}</td>
                        <td className="sf-td-na">—</td>
                        <td className="sf-td-na">—</td>
                        <td className="sf-td-na">—</td>
                        <td className="sf-td-na">—</td>
                      </tr>
                    ))}
                    {forecastCards.map((fc, i) => (
                      <tr key={fc.month} className="sf-row-forecast">
                        <td className="sf-td-month">{fc.month}</td>
                        <td><span className="sf-type-badge sf-type-forecast">Forecast</span></td>
                        <td className="sf-td-na">—</td>
                        <td className="sf-td-sma">{fc.sma.toLocaleString()}</td>
                        <td className="sf-td-wma">{fc.wma.toLocaleString()}</td>
                        <td className="sf-td-trend">{fc.trend.toLocaleString()}</td>
                        <td className="sf-td-recommended">{fc.recommended.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ─── All Items Summary ─── */}
          <div className="sf-all-items-section">
            <div className="sf-table-title">All Items — Forecast Summary</div>
            <div className="sf-all-items-grid">
              {forecastData.items.map(item => {
                const tCfg = TREND_CONFIG[item.trendDirection];
                const next = item.forecasts[0];
                return (
                  <div
                    key={item.itemCode}
                    className={`sf-item-card ${selectedItem === item.itemCode ? 'selected' : ''}`}
                    onClick={() => setSelectedItem(item.itemCode)}
                  >
                    <div className="sf-item-card-header">
                      <span className="sf-item-code">{item.itemCode}</span>
                      <span className="sf-item-trend-badge" style={{ background: tCfg.bg, color: tCfg.color }}>
                        {tCfg.icon} {tCfg.label}
                      </span>
                    </div>
                    <div className="sf-item-stats">
                      <div>
                        <div className="sf-item-stat-val">{item.avgMonthlyQty.toLocaleString()}</div>
                        <div className="sf-item-stat-lbl">Avg/Month</div>
                      </div>
                      {next && (
                        <div>
                          <div className="sf-item-stat-val" style={{ color: METHOD_COLORS.sma }}>
                            {Math.round(next.sma * (1 + bufferPct / 100)).toLocaleString()}
                          </div>
                          <div className="sf-item-stat-lbl">Next Month (SMA)</div>
                        </div>
                      )}
                    </div>
                    <div className="sf-item-history-mini">
                      {item.historical.map(h => (
                        <div key={h.month} className="sf-mini-bar-wrap" title={`${h.month}: ${h.qty}`}>
                          <div
                            className="sf-mini-bar"
                            style={{
                              height: `${Math.min(100, (h.qty / (item.totalHistoricalQty || 1)) * 300)}%`,
                              background: item.trendDirection === 'growing' ? '#16a34a' :
                                          item.trendDirection === 'declining' ? '#dc2626' : '#3b82f6'
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
