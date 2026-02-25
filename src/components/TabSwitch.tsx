import React from 'react';
import { motion } from 'motion/react';
import { TabType, TABS } from '../types/ui';

interface TabSwitchProps {
  activeTab: TabType;
  onChange: (tab: TabType) => void;
}

export function TabSwitch({ activeTab, onChange }: TabSwitchProps) {
  return (
    <div className="flex bg-[#1E1E1E] p-1 rounded-[16px] w-fit relative overflow-hidden">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id as TabType)}
            className={`
              relative px-6 py-2.5 text-sm font-medium transition-colors z-10 rounded-[12px]
              ${isActive ? 'text-white' : 'text-gray-400 hover:text-gray-200'}
            `}
          >
            {isActive && (
              <motion.div
                layoutId="activeTabIndicator"
                className="absolute inset-0 bg-[#333333] rounded-[12px] -z-10"
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 30
                }}
              />
            )}
            <span className="relative z-10">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
