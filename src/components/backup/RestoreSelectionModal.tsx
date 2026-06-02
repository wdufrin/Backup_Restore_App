/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useState, useEffect } from 'react';

// A generic item with a unique name and a display name
export interface SelectableItem {
  name: string;
  displayName: string;
  agentType?: string; // Optional property for displaying agent type
  disabled?: boolean;
  disabledReason?: string;
  targetId?: string; // Custom ID for restore
  category?: 'core' | 'optional';
}

interface RestoreSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (selectedItems: SelectableItem[]) => void;
  title: string;
  items: SelectableItem[];
  isLoading: boolean;
  showIdInput?: boolean;
  subtitle?: string;
  actionLabel?: string;
  connectorStatus?: Record<string, 'green' | 'red' | 'grey'>;
}

const RestoreSelectionModal: React.FC<RestoreSelectionModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  items,
  actionLabel,
  isLoading,
  showIdInput = false,
  subtitle,
  connectorStatus,
}) => {
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [customIds, setCustomIds] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setSelectedNames(new Set(items.filter(item => !item.disabled && item.category !== 'optional').map(item => item.name)));
    }
  }, [isOpen, items]);



  const handleToggle = (itemName: string) => {
    setSelectedNames(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemName)) {
        newSet.delete(itemName);
      } else {
        newSet.add(itemName);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    setSelectedNames(new Set(items.filter(item => !item.disabled).map(item => item.name)));
  };

  const handleDeselectAll = () => {
    setSelectedNames(new Set());
  };

  const handleConfirm = () => {
    const selectedItems = items.filter(item => selectedNames.has(item.name)).map(item => ({
      ...item,
      targetId: customIds[item.name] || undefined
    }));
    onConfirm(selectedItems);
  };
  
  const isAllSelected = selectedNames.size === items.length && items.length > 0;

  const coreItems = items.filter(item => item.category !== 'optional');
  const optionalItems = items.filter(item => item.category === 'optional');

  const renderItem = (item: SelectableItem) => {
    const itemId = item.name.split('/').pop() || item.name;
    return (
      <li key={item.name} className={`p-3 rounded-lg transition-colors ${item.disabled ? 'opacity-50 cursor-not-allowed bg-gray-50' : 'hover:bg-gray-50 border border-transparent hover:border-gray-200'}`}>
        <label className={`flex items-center ${item.disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`} title={item.disabledReason}>
          <input
            type="checkbox"
            checked={selectedNames.has(item.name)}
            onChange={() => !item.disabled && handleToggle(item.name)}
            disabled={item.disabled}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
          />
          <div className="ml-3 text-sm flex-grow">
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-900">{item.displayName}</span>
              {item.agentType && (
                <span className={`ml-2 px-1.5 py-0.5 text-[10px] font-bold rounded-full uppercase tracking-wider ${item.disabled ? 'bg-gray-100 text-gray-400 border-gray-200' : 'bg-blue-100 text-blue-700 border border-blue-200'}`}>
                  {item.agentType}
                </span>
              )}
            </div>
            <p className="text-gray-500 font-mono text-xs mt-0.5">{itemId}</p>
            {showIdInput && !item.disabled && (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs text-gray-500">Target ID:</span>
                <input 
                  type="text" 
                  value={customIds[item.name] || ''} 
                  onChange={(e) => setCustomIds(prev => ({ ...prev, [item.name]: e.target.value }))}
                  placeholder="Auto-generate"
                  className="bg-white border border-gray-300 rounded px-2 py-0.5 text-xs focus:ring-blue-500 focus:border-blue-500 w-32"
                />
              </div>
            )}
            {item.disabledReason && (
              <p className="text-red-600 text-xs mt-1 font-medium">{item.disabledReason}</p>
            )}
          </div>
        </label>
      </li>
    );
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4" aria-modal="true" role="dialog">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-gray-200">
        <header className="p-6 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          <p className="text-sm text-gray-500 mt-1">{subtitle || 'Select the items you wish to restore from the backup file.'}</p>
        </header>

        <div className="p-6 flex-1 overflow-y-auto bg-gray-50">
          <div className="bg-yellow-50 text-yellow-700 p-3 rounded-lg text-xs mb-4 flex items-center gap-2 border border-yellow-200">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <span><strong>Important:</strong> If you are restoring agents with federated connectors, ensure they are authenticated in the new environment *before* restoring.</span>
          </div>
          {connectorStatus && Object.keys(connectorStatus).length > 0 && (
            <div className="mb-4 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
                <span className="text-blue-500">🔌</span> Required Connectors Status
              </h3>
              <ul className="space-y-1 text-xs">
                {Object.entries(connectorStatus).map(([colId, status]) => (
                  <li key={colId} className="flex items-center justify-between py-1 border-b border-gray-50 last:border-0">
                    <span className="font-mono text-gray-600">{colId}</span>
                    <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full uppercase tracking-wider ${
                      status === 'green' ? 'bg-green-100 text-green-700 border border-green-200' :
                      status === 'red' ? 'bg-red-100 text-red-700 border border-red-200' :
                      'bg-gray-100 text-gray-500 border border-gray-200'
                    }`}>
                      {status === 'green' ? 'Authenticated' : status === 'red' ? 'Failed / Action Required' : 'Not Found'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-between items-center mb-4">
            <div className="text-sm text-gray-700 font-medium">
              {selectedNames.size} of {items.length} selected
            </div>
            <div className="space-x-4">
              <button onClick={handleSelectAll} disabled={isAllSelected} className="text-sm font-semibold text-blue-600 hover:text-blue-700 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors">Select All</button>
              <button onClick={handleDeselectAll} disabled={selectedNames.size === 0} className="text-sm font-semibold text-blue-600 hover:text-blue-700 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors">Deselect All</button>
            </div>
          </div>
          
          {optionalItems.length > 0 ? (
            <div className="space-y-6">
              {coreItems.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1 select-none">
                    ⭐ Core Agents & Notebooks (Owned by you)
                  </h3>
                  <ul className="space-y-2 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                    {coreItems.map(renderItem)}
                  </ul>
                </div>
              )}
              <div>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1 select-none">
                  ➕ Optional / Shared Agents (No explicit WIF owner)
                </h3>
                <ul className="space-y-2 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                  {optionalItems.map(renderItem)}
                </ul>
              </div>
            </div>
          ) : (
            <ul className="space-y-2 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
              {items.map(renderItem)}
            </ul>
          )}
        </div>

        <footer className="p-6 border-t border-gray-100 flex justify-end space-x-3 bg-white rounded-b-2xl">
          <button onClick={onClose} disabled={isLoading} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={isLoading || selectedNames.size === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed shadow-sm"
          >
            {isLoading ? 'Processing...' : `${actionLabel || 'Restore'} ${selectedNames.size} Item(s)`}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default RestoreSelectionModal;
