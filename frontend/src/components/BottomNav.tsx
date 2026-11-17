import React from 'react';
import { Camera, History, LayoutDashboard, Sliders } from 'lucide-react';

export type AppTab = 'dashboard' | 'logs' | 'config';

interface BottomNavProps {
  activeTab: AppTab;
  onChangeTab: (tab: AppTab) => void;
  onSnapMeal: () => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onChangeTab,
  onSnapMeal,
}) => {
  return (
    <div className="bottom-nav-wrap">
      <nav className="bottom-nav bottom-nav--4" aria-label="Primary navigation">
        <button
          type="button"
          className={`bottom-nav-tab ${activeTab === 'dashboard' ? 'is-active' : ''}`}
          onClick={() => onChangeTab('dashboard')}
        >
          <LayoutDashboard size={18} />
          <span>Today</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-tab ${activeTab === 'logs' ? 'is-active' : ''}`}
          onClick={() => onChangeTab('logs')}
        >
          <History size={18} />
          <span>Logs</span>
        </button>

        <button type="button" className="bottom-nav-tab bottom-nav-add" onClick={onSnapMeal} aria-label="Add meal">
          <Camera size={18} />
          <span>Add</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-tab ${activeTab === 'config' ? 'is-active' : ''}`}
          onClick={() => onChangeTab('config')}
        >
          <Sliders size={18} />
          <span>Settings</span>
        </button>
      </nav>
    </div>
  );
};
