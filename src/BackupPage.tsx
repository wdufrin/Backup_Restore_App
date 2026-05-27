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


import React, { useState, useMemo, useEffect } from 'react';
import type { Agent, AppEngine, Authorization, Config, ReasoningEngine, GcsBucket, Collection, DataStore } from './types';
import * as api from './services/apiService';
import ProjectInput from './components/ProjectInput';
import RestoreSelectionModal from './components/backup/RestoreSelectionModal';
import type { SelectableItem } from './components/backup/RestoreSelectionModal';
import ChatHistoryArchiveViewer from './components/backup/ChatHistoryArchiveViewer';
import ClientSecretPrompt from './components/backup/ClientSecretPrompt';
import CurlInfoModal from './components/CurlInfoModal';



interface BackupPageProps {
  accessToken: string;
  sourceToken?: string;
  targetToken?: string;
  onGoogleSignIn?: () => void;
  onWifSignIn?: () => void;
  projectNumber: string;
  setProjectNumber: (projectNumber: string) => void;
  userEmail: string;
  isSettingsOpen?: boolean;
  onCloseSettings?: () => void;
  poolId?: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const isRestorableSource = (source: any): boolean => {
  // Skip if it's identified as a local file or unsupported source
  if (source.metadata?.agentspaceMetadata) {
    return false;
  }
  
  // Keep if it's a supported link
  return !!(
    source.metadata?.googleDocsMetadata ||
    source.metadata?.youtubeMetadata ||
    source.metadata?.webpageMetadata ||
    source.url ||
    source.webScrapeConfig
  );
};

const mapSourceToPayload = (source: any) => {
  const sourcePayload: any = {};
  const sourceName = source.title || source.displayName || 'Restored Source';

  if (source.metadata?.googleDocsMetadata) {
    sourcePayload.googleDriveContent = {
      sourceName: sourceName,
      documentId: source.metadata.googleDocsMetadata.documentId,
      mimeType: source.metadata.googleDocsMetadata.mimeType || 'application/vnd.google-apps.document'
    };
  } else if (source.metadata?.youtubeMetadata) {
    sourcePayload.videoContent = {
      youtubeUrl: source.metadata.youtubeMetadata.youtubeUrl || source.metadata.youtubeMetadata.uri || source.metadata.youtubeMetadata.url
    };
  } else if (source.metadata?.agentspaceMetadata) {
    sourcePayload.agentspaceContent = {
      documentName: source.metadata.agentspaceMetadata.documentName
    };
  } else if (source.metadata?.webpageMetadata || source.webScrapeConfig || source.url) {
    sourcePayload.webContent = {
      sourceName: sourceName,
      url: source.metadata?.webpageMetadata?.webpageUrl || source.url || (source.webScrapeConfig && source.webScrapeConfig.url)
    };
  } else {
    // Fallback to minimal text content if unidentifiable or unsupported
    sourcePayload.textContent = {
      sourceName: sourceName,
      content: source.content || source.text || `[Restored Source: ${source.name || sourceName}]`
    };
  }
  return sourcePayload;
};

const getOwnerFromBinding = (member: string): string => {
  if (member.startsWith('user:')) {
    return member.replace('user:', '');
  } else if (member.startsWith('principal://')) {
    return member.split('/subject/').pop() || member;
  } else {
    return member.replace('serviceAccount:', '');
  }
};




// --- Main Page Component ---

const BackupPage: React.FC<BackupPageProps> = ({ accessToken, sourceToken, targetToken, onGoogleSignIn, onWifSignIn, projectNumber, setProjectNumber, userEmail, isSettingsOpen, onCloseSettings, poolId }) => {
  const [config, setConfig] = useState({
    appLocation: 'global',
    appId: '',
    reasoningEngineLocation: 'us-central1',
    reasoningEngineId: '', // Added Agent Engine selection
    collectionId: 'default_collection',
    assistantId: 'default_assistant',
  });
  const isAdminModeEnabled = import.meta.env.VITE_ENABLE_ADMIN_MODE === 'true';
  const [activeTab, setActiveTab] = useState<'admin' | 'user'>(isAdminModeEnabled ? 'admin' : 'user');
  const [userTabConfig, setUserTabConfig] = useState({
    sourceProject: import.meta.env.VITE_SOURCE_PROJECT || '',
    sourceLocation: import.meta.env.VITE_SOURCE_LOCATION || 'global',
    sourceAppId: import.meta.env.VITE_SOURCE_APP_ID || '',
    targetProject: import.meta.env.VITE_TARGET_PROJECT || '',
    targetLocation: import.meta.env.VITE_TARGET_LOCATION || 'global',
    targetAppId: import.meta.env.VITE_TARGET_APP_ID || '',
    targetAppUrl: import.meta.env.VITE_TARGET_APP_URL || '',
  });
  const [isUserConfigModalOpen, setIsUserConfigModalOpen] = useState(false);
  const [sourceApps, setSourceApps] = useState<any[]>([]);
  const [targetApps, setTargetApps] = useState<any[]>([]);
  const [sourceDatastores, setSourceDatastores] = useState<any[]>([]);
  const [targetDatastores, setTargetDatastores] = useState<any[]>([]);
  const [isLoadingSourceDatastores, setIsLoadingSourceDatastores] = useState(false);
  const [isLoadingTargetDatastores, setIsLoadingTargetDatastores] = useState(false);
  const [datastoreMapping, setDatastoreMapping] = useState<Record<string, string>>(() => {
    const envMapping = import.meta.env.VITE_DATASTORE_MAPPING;
    try {
      return envMapping ? JSON.parse(envMapping) : {};
    } catch (e) {
      console.error("Failed to parse VITE_DATASTORE_MAPPING from env", e);
      return {};
    }
  });
  const [sourceCollections, setSourceCollections] = useState<any[]>([]);
  const [targetCollections, setTargetCollections] = useState<any[]>([]);
  const [collectionMapping, setCollectionMapping] = useState<Record<string, string>>(() => {
    const envMapping = import.meta.env.VITE_COLLECTION_MAPPING;
    try {
      return envMapping ? JSON.parse(envMapping) : {};
    } catch (e) {
      console.error("Failed to parse VITE_COLLECTION_MAPPING from env", e);
      return {};
    }
  });
  const [shouldMigrateAgents, setShouldMigrateAgents] = useState(import.meta.env.VITE_MIGRATE_AGENTS !== 'false');
  const [shouldMigrateNotebooks, setShouldMigrateNotebooks] = useState(import.meta.env.VITE_MIGRATE_NOTEBOOKS !== 'false');
  const [isStep1Complete, setIsStep1Complete] = useState(false);
  const [isRestoreComplete, setIsRestoreComplete] = useState(false);

  const fetchDataAssets = async (project: string, location: string) => {
    const configOverride = { ...apiConfig, projectId: project, appLocation: location };
    const allDatastores: any[] = [];
    const collectionsWithConnectors: any[] = [];

    try {
      addLog(`Fetching collections for project ${project}...`);
      const collectionsResponse = await api.listResources('collections', configOverride);
      const collections = collectionsResponse.collections || [];
      addLog(`Found ${collections.length} collections. Checking for connectors...`);
      
      for (const col of collections) {
        const collectionId = col.name.split('/').pop()!;
        const colConfig = { ...configOverride, collectionId };

        // Check for Data Connector
        let isConnector = false;
        try {
          const connector = await api.getDataConnector(colConfig);
          if (connector) {
            isConnector = true;
            collectionsWithConnectors.push(col);
            addLog(`  - Collection ${collectionId} has a Data Connector.`);
          }
        } catch (e) {
          // Ignore 404 or other errors implying no connector
        }

        // List DataStores in this collection
        try {
          const dsResponse = await api.listResources('dataStores', colConfig);
          const dataStores = dsResponse.dataStores || [];
          // Add collection info to datastores for later filtering
          dataStores.forEach((ds: any) => {
            ds.collectionId = collectionId;
            ds.isConnector = isConnector;
          });
          allDatastores.push(...dataStores);
        } catch (dsErr) {
          addLog(`Error fetching datastores for collection ${collectionId}: ${(dsErr as any).message}`);
        }
      }
      
      return { datastores: allDatastores, collections: collectionsWithConnectors };
    } catch (err: any) {
      addLog(`Error fetching data assets: ${err.message}`);
      return { datastores: [], collections: [] };
    }
  };
  const exportAdminConfig = () => {
    const configToExport = {
      userTabConfig,
      datastoreMapping,
      collectionMapping,
    };
    const jsonStr = JSON.stringify(configToExport, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `admin_config__${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const importAdminConfig = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        if (json.userTabConfig) {
          setUserTabConfig(json.userTabConfig);
          
          // Automatically fetch apps for source and target projects
          if (json.userTabConfig.sourceProject) {
            const sourceLoc = json.userTabConfig.sourceLocation || 'global';
            fetchAppsForProject(json.userTabConfig.sourceProject, sourceLoc).then(apps => setSourceApps(apps));
          }
          if (json.userTabConfig.targetProject) {
            const targetLoc = json.userTabConfig.targetLocation || 'global';
            fetchAppsForProject(json.userTabConfig.targetProject, targetLoc).then(apps => setTargetApps(apps));
          }
        }
        if (json.datastoreMapping) {
          setDatastoreMapping(json.datastoreMapping);
        }
        if (json.collectionMapping) {
          setCollectionMapping(json.collectionMapping);
        }
        addLog(`Admin configuration imported successfully from ${file.name}`);
      } catch (err: any) {
        addLog(`Error importing admin configuration: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const [isLoadingSourceApps, setIsLoadingSourceApps] = useState(false);
  const [isLoadingTargetApps, setIsLoadingTargetApps] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [restoreFileContent, setRestoreFileContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingSection, setLoadingSection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  
  // GCS State
  const [buckets, setBuckets] = useState<GcsBucket[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<string>('');
  const [, setIsLoadingBuckets] = useState(false);
  
  // Available Backup Files (Keyed by section prefix)
  const [backupFiles, setBackupFiles] = useState<Record<string, any[]>>({});

  const [, setIsLoadingFiles] = useState(false);

  const [modalData, setModalData] = useState<{
    section: string;
    title: string;
    items: any[];
    processor: (data: any) => Promise<void>;
    originalData: any;
  } | null>(null);

  const [chatHistoryArchiveData, setChatHistoryArchiveData] = useState<{ sessions: any[]; fileName: string } | null>(null);

  const [secretPrompt, setSecretPrompt] = useState<{ auth: Authorization; resolve: (secret: string | null) => void; customMessage?: string; } | null>(null);
  const [viewModalData, setViewModalData] = useState<{ filename: string, content: string } | null>(null);
  const [expandedAgentIdx, setExpandedAgentIdx] = useState<number | null>(null);
  const [expandedNotebookIdx, setExpandedNotebookIdx] = useState<number | null>(null);
  const [showRawJsonIdx, setShowRawJsonIdx] = useState<number | null>(null);

  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [selectionModalItems, setSelectionModalItems] = useState<SelectableItem[]>([]);
  const [selectionModalTitle, setSelectionModalTitle] = useState('');
  const [selectionModalSubtitle, setSelectionModalSubtitle] = useState('');
  const [selectionModalAction, setSelectionModalAction] = useState<'backup' | 'restore'>('backup');
  const [pendingBackupData, setPendingBackupData] = useState<any>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());

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

  interface ManualActionReportItem {
    agentName?: string;
    notebookTitle?: string;
    sharedWith: string[];
    unmappedDatastores?: string[];
    knowledgeAttachments?: string[];
    localFiles?: string[];
    agentFiles?: string[];
  }

  const [manualActionReport, setManualActionReport] = useState<ManualActionReportItem[]>([]);




  const [userIdStatus, setUserIdStatus] = useState<{ status: 'pass' | 'fail' | 'pending', details?: string }>({ status: 'pending' });
  const [isIdCheckExpanded, setIsIdCheckExpanded] = useState(false);
  
  // Resizable column widths
  const [fileNameWidth, setFileNameWidth] = useState<number>(200);
  const [sourceAppWidth, setSourceAppWidth] = useState<number>(120);
  const [regionWidth, setRegionWidth] = useState<number>(80);

  const handleResizeMouseDown = (e: React.MouseEvent, column: 'fileName' | 'sourceApp' | 'region') => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = column === 'fileName' ? fileNameWidth : (column === 'sourceApp' ? sourceAppWidth : regionWidth);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const minWidth = column === 'region' ? 50 : 100;
      const newWidth = Math.max(minWidth, startWidth + (moveEvent.clientX - startX));
      if (column === 'fileName') {
        setFileNameWidth(newWidth);
      } else if (column === 'sourceApp') {
        setSourceAppWidth(newWidth);
      } else {
        setRegionWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const renderBackupContent = (contentStr: string) => {
    try {
      const data = JSON.parse(contentStr);
      if (data.type === 'Agents' && data.agents) {
        return (
          <div className="space-y-4">
            <div className="text-sm text-gray-500">Backup Type: <span className="font-semibold text-gray-900">Agents</span></div>
            <div className="text-sm text-gray-500">Created At: {new Date(data.createdAt).toLocaleString()}</div>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm text-left text-gray-700">
                <thead className="text-xs text-gray-500 uppercase bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-2 font-medium">Display Name</th>
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Owner</th>
                    <th className="px-4 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((agent: any, idx: number) => {
                    let agentType = "Low Code";
                    if (agent.adkAgentDefinition) agentType = "ADK";
                    else if (agent.a2aAgentDefinition) agentType = "A2A";
                    
                    let owner = "N/A";
                    if (agent.iamPolicy && agent.iamPolicy.bindings) {
                      const ownerBinding = agent.iamPolicy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
                      if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
                        owner = getOwnerFromBinding(ownerBinding.members[0]);
                      }
                    }

                    const isExpanded = expandedAgentIdx === idx;
                    const isRawJson = showRawJsonIdx === idx;

                    return (
                      <React.Fragment key={idx}>
                        <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-2 font-medium text-gray-900">{agent.displayName}</td>
                          <td className="px-4 py-2 text-gray-500 truncate max-w-xs">{agent.description || 'No description'}</td>
                          <td className="px-4 py-2"><span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{agentType}</span></td>
                          <td className="px-4 py-2 text-gray-500 truncate max-w-xs">{owner}</td>
                          <td className="px-4 py-2">
                            <button 
                              onClick={() => setExpandedAgentIdx(isExpanded ? null : idx)}
                              className="text-blue-600 hover:text-blue-800 text-xs font-semibold"
                            >
                              {isExpanded ? 'Hide Details' : 'Details'}
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-gray-50 border-b border-gray-100">
                            <td colSpan={5} className="px-4 py-3">
                              <div className="text-xs space-y-2">
                                <div><span className="font-semibold">Full Name:</span> {agent.name}</div>
                                {/* Compact View */}
                                {!isRawJson ? (
                                  <>
                                    {agent.adkAgentDefinition && (
                                      <div className="mt-2">
                                        <span className="font-semibold">ADK Configuration:</span>
                                        <div className="bg-white p-2 rounded border border-gray-200 mt-1 text-xs">
                                          <div><span className="font-medium">Tool Description:</span> {agent.adkAgentDefinition.toolSettings?.toolDescription || 'N/A'}</div>
                                          <div><span className="font-medium">Reasoning Engine:</span> {agent.adkAgentDefinition.provisionedReasoningEngine?.reasoningEngine || 'N/A'}</div>
                                        </div>
                                      </div>
                                    )}
                                    {agent.iamPolicy && (
                                      <div className="mt-2">
                                        <span className="font-semibold">IAM Policy Bindings:</span>
                                        <div className="bg-white p-2 rounded border border-gray-200 mt-1 text-xs">
                                          {agent.iamPolicy.bindings?.map((b: any, bIdx: number) => (
                                            <div key={bIdx} className="mb-1">
                                              <span className="font-medium">{b.role}:</span> {b.members?.join(', ')}
                                            </div>
                                          ))}
                                          {(!agent.iamPolicy.bindings || agent.iamPolicy.bindings.length === 0) && <div>No bindings found.</div>}
                                        </div>
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  // Raw JSON View
                                  <div className="mt-2">
                                    <span className="font-semibold">Raw Configuration JSON:</span>
                                    <pre className="bg-white p-2 rounded border border-gray-200 mt-1 overflow-x-auto max-w-full font-mono text-[10px]">
                                      {JSON.stringify(agent, null, 2)}
                                    </pre>
                                  </div>
                                )}

                                <div className="flex justify-between mt-2 items-center">
                                  <button 
                                    onClick={() => setShowRawJsonIdx(isRawJson ? null : idx)}
                                    className="text-blue-600 hover:text-blue-800 font-semibold"
                                  >
                                    {isRawJson ? 'Show Summary' : 'Show Raw JSON'}
                                  </button>
                                  <button 
                                    onClick={() => {
                                      setExpandedAgentIdx(null);
                                      setShowRawJsonIdx(null); // Reset raw view too
                                    }}
                                    className="text-blue-600 hover:text-blue-800 font-semibold"
                                  >
                                    Close Details
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      } else if (data.type === 'NotebookLM' && data.notebooks) {
        return (
          <div className="space-y-4">
            <div className="text-sm text-gray-500">Backup Type: <span className="font-semibold text-gray-900">NotebookLM</span></div>
            <div className="text-sm text-gray-500">Created At: {new Date(data.createdAt).toLocaleString()}</div>
            <div className="space-y-3">
              {data.notebooks.map((nb: any, idx: number) => (
                <div key={idx} className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="font-medium text-gray-900">{nb.title || nb.displayName || 'Unnamed Notebook'}</h4>
                    <button 
                      onClick={() => setExpandedNotebookIdx(expandedNotebookIdx === idx ? null : idx)}
                      className="text-blue-600 hover:text-blue-800 text-xs font-semibold"
                    >
                      {expandedNotebookIdx === idx ? 'Hide Details' : 'Details'}
                    </button>
                  </div>
                  <div className="text-xs text-gray-500 mb-1">Sources: {nb.sources?.length || 0}</div>
                  {expandedNotebookIdx === idx && (
                    <ul className="text-xs text-gray-600 list-disc list-inside space-y-0.5 mt-2">
                      {nb.sources?.map((src: any, sIdx: number) => (
                        <li key={sIdx} className="truncate">{src.title || src.displayName || 'Untitled Source'}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      }
      return (
        <pre className="text-xs text-gray-700 font-mono whitespace-pre-wrap break-all bg-white p-4 rounded-lg border border-gray-200">
          {JSON.stringify(data, null, 2)}
        </pre>
      );
    } catch (e) {
      return (
        <pre className="text-xs text-gray-700 font-mono whitespace-pre-wrap break-all bg-white p-4 rounded-lg border border-gray-200">
          {contentStr}
        </pre>
      );
    }
  };
  
  const [infoModalKey, setInfoModalKey] = useState<string | null>(null);

  // State for dropdown options
  const [apps, setApps] = useState<AppEngine[]>([]);
  const [isLoadingApps, setIsLoadingApps] = useState(false);
  
  const [reasoningEngines, setReasoningEngines] = useState<ReasoningEngine[]>([]);
  const [isLoadingReasoningEngines, setIsLoadingReasoningEngines] = useState(false);


  const apiConfig: Omit<Config, 'accessToken'> = useMemo(() => ({
      ...config,
      projectId: projectNumber,
  }), [config, projectNumber]);

  async function fetchAppsForProject(projectId: string, location: string): Promise<any[]> {
    if (!projectId) return [];
    try {
      const mockConfig = {
        projectId: projectId,
        appLocation: location,
        collectionId: 'default_collection',
        appId: '',
        assistantId: 'default_assistant',
      };
      const response = await api.listResources('engines', mockConfig);
      return response.engines || [];
    } catch (e: any) {
      addLog(`Failed to fetch apps for project ${projectId}: ${e.message}`);
      return [];
    }
  };

  const handleConfigChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setConfig(prev => ({ ...prev, [name]: value }));
  };

  const handleProjectNumberChange = (newValue: string) => {
    setProjectNumber(newValue);
    // Reset dependent fields when project changes
    setConfig(prev => ({
        ...prev,
        appId: '',
        reasoningEngineId: '',
    }));
    setApps([]);
    setReasoningEngines([]);
    setBuckets([]);
    setSelectedBucket('');
  };
  
  const addLog = (message: string) => {
      setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`]);
  };

  // --- Effects to fetch dropdown data ---
  
  // Fetch GCS Buckets
  useEffect(() => {
      if (!apiConfig.projectId) return;
      const fetchBuckets = async () => {
          setIsLoadingBuckets(true);
          setBuckets([]);
          try {
              const res = await api.listBuckets(apiConfig.projectId);
              const items = res.items || [];
              setBuckets(items);
              if (items.length > 0) {
                  // Default to first bucket if not set
                  if (!selectedBucket) setSelectedBucket(items[0].name);
              }
          } catch (e) {
              console.error("Failed to fetch buckets", e);
          } finally {
              setIsLoadingBuckets(false);
          }
      };
      fetchBuckets();
  }, [apiConfig.projectId]);

  const fetchBackups = async () => {
      if (!selectedBucket || !apiConfig.projectId) return;
      setIsLoadingFiles(true);
      setBackupFiles({}); // Clear while loading
      try {
          const res = await api.listGcsObjects(selectedBucket, '', apiConfig.projectId);
          const objects = res.items || [];
          
          // Categorize files based on prefixes
        const categorized: Record<string, any[]> = {
          'Agents': [],
          'NotebookLM': [],
        };

        objects.forEach((obj: any) => {
          const name = obj.name;
          let sourceApp = "N/A";
          let region = "N/A";
          
          const parts = name.split('__');
          if (parts.length >= 4) {
            sourceApp = parts[1];
            region = parts[2];
          } else if (name.startsWith('agentspace-agents')) {
            // Fallback for old format
            const oldParts = name.split('-');
            if (oldParts.length >= 4) {
              sourceApp = oldParts[2];
            }
          }
          
          const fileObj = { filename: name, sourceApp, region };
          
          if (name.startsWith('agentspace-agents')) categorized['Agents'].push(fileObj);
          else if (name.startsWith('agentspace-notebooks')) categorized['NotebookLM'].push(fileObj);
        });

        // Sort chronologically (names contain ISO timestamp, so alphabetical reverse works)
        Object.keys(categorized).forEach(key => {
            categorized[key].sort((a: any, b: any) => b.filename.localeCompare(a.filename));
        });

          setBackupFiles(categorized);
      } catch (e) {
          console.error("Failed to list objects", e);
          addLog(`Error listing backup files: ${(e as any).message}`);
      } finally {
          setIsLoadingFiles(false);
      }
  };

  // Fetch Backup Files when bucket changes
  useEffect(() => {
      fetchBackups();
  }, [selectedBucket, apiConfig.projectId]);


  useEffect(() => {
    if (!apiConfig.projectId || !apiConfig.appLocation) {
        setApps([]);
        return;
    }
    const fetchApps = async () => {
        setIsLoadingApps(true);
        setApps([]);
        try {
            const response = await api.listResources('engines', apiConfig);
            const fetchedApps = response.engines || [];
            setApps(fetchedApps);
            if (fetchedApps.length === 1) {
                const singleAppId = fetchedApps[0].name.split('/').pop();
                if (singleAppId) {
                    setConfig(prev => ({ ...prev, appId: singleAppId }));
                }
            }
        } catch (err) {
            console.error("Failed to fetch apps:", err);
        } finally {
            setIsLoadingApps(false);
        }
    };
    fetchApps();
  }, [apiConfig.projectId, apiConfig.appLocation, apiConfig.collectionId]);

  useEffect(() => {
    const targetProject = userTabConfig.sourceProject;
    if (accessToken && targetProject) {
      setUserIdStatus({ status: 'pending' });
      
      const testConfig = {
        projectId: targetProject,
        appLocation: userTabConfig.sourceLocation || 'global',
        collectionId: 'default_collection',
        appId: '',
        assistantId: 'default_assistant',
      };

      api.listResources('engines', testConfig)
        .then(response => {
          setUserIdStatus({ 
            status: 'pass', 
            details: `Permission check passed! You can list engines in project ${targetProject}.` 
          });
        })
        .catch(err => {
          setUserIdStatus({ 
            status: 'fail', 
            details: `Permission check failed for project ${targetProject}: ${err.message}.\n\nHow to fix (Admin Steps):\n\nStep 1: Create the custom role:\n\ngcloud iam roles create customBackupViewer \\\n    --project=${targetProject} \\\n    --title="Discovery Engine Custom Backup Viewer" \\\n    --permissions="discoveryengine.engines.list,discoveryengine.engines.get,discoveryengine.assistants.list,discoveryengine.assistants.get,discoveryengine.agents.list,discoveryengine.agents.get,discoveryengine.agents.manage,discoveryengine.agents.getIamPolicy,discoveryengine.notebooks.list,discoveryengine.notebooks.get" \\\n    --stage=GA\n\nStep 2: Assign the role to your user (Dynamic based on your login):\n\ngcloud projects add-iam-policy-binding ${targetProject} \\\n    --member="principal://iam.googleapis.com/locations/global/workforcePools/${poolId || 'YOUR_POOL_ID'}/subject/${userEmail}" \\\n    --role="projects/${targetProject}/roles/customBackupViewer"\n\nAlternatively, assign to your group if you prefer group-based access control:\n\ngcloud projects add-iam-policy-binding ${targetProject} \\\n    --member="principalSet://iam.googleapis.com/locations/global/workforcePools/${poolId || 'YOUR_POOL_ID'}/group/YOUR_GROUP_ID" \\\n    --role="projects/${targetProject}/roles/customBackupViewer"` 
          });
        });
    }
  }, [accessToken, userTabConfig.sourceProject, userTabConfig.sourceLocation, apiConfig.projectId]);

  useEffect(() => {
    if (isSettingsOpen) {
      setIsUserConfigModalOpen(true);
    }
  }, [isSettingsOpen]);

  // Fetch Agent Engines
  useEffect(() => {
    if(!apiConfig.projectId || !apiConfig.reasoningEngineLocation) return;
    const fetchREs = async () => {
        setIsLoadingReasoningEngines(true);
        setReasoningEngines([]);
        try {
            const res = await api.listReasoningEngines(apiConfig);
            const engines = res.reasoningEngines || [];
            setReasoningEngines(engines);
            // Auto select if only one
             if (engines.length === 1) {
                 const id = engines[0].name.split('/').pop() || '';
                 setConfig(p => ({...p, reasoningEngineId: id}));
             }
        } catch(e) { 
          console.error("Failed to fetch agent engines:", e); 
        } finally { 
            setIsLoadingReasoningEngines(false); 
        }
    }
    fetchREs();
  }, [apiConfig.projectId, apiConfig.reasoningEngineLocation]);


  const uploadBackupToGcs = async (data: object, filenamePrefix: string, useTimestamp: boolean = true) => {
      if (!selectedBucket) {
          throw new Error("No GCS bucket selected for backup.");
      }
      const jsonString = JSON.stringify(data, null, 2);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = useTimestamp 
        ? `${filenamePrefix}__${timestamp}.json`
        : `${filenamePrefix}.json`;
      const file = new File([jsonString], filename, { type: 'application/json' });
      
      addLog(`Uploading backup to gs://${selectedBucket}/${filename}...`);
      await api.uploadFileToGcs(selectedBucket, filename, file, apiConfig.projectId);
      addLog(`Upload successful.`);
      
      // Refresh file list to show the new backup
      await fetchBackups();
  };
  
  const executeOperation = async (section: string, operation: () => Promise<void>) => {
      setIsLoading(true);
      setLoadingSection(section);
      setError(null);
      setLogs([]);
      try {
          await operation();
      } catch (err: any) {
          setError(err.message || `An unknown error occurred in ${section}.`);
          addLog(`FATAL ERROR: ${err.message}`);
      } finally {
          setIsLoading(false);
          setLoadingSection(null);
      }
  };

  const handleDownloadGcsFile = async (filename: string) => {
    if (!selectedBucket) return;
    executeOperation('DownloadFile', async () => {
      addLog(`Downloading file: gs://${selectedBucket}/${filename}...`);
      const fileContent = await api.getGcsObjectContent(selectedBucket, filename, apiConfig.projectId);
      const blob = new Blob([fileContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addLog(`Download triggered.`);
    });
  };



  const handleViewGcsFile = async (filename: string) => {
    if (!selectedBucket) return;
    executeOperation('ViewFile', async () => {
      addLog(`Fetching content for: gs://${selectedBucket}/${filename}...`);
      const fileContent = await api.getGcsObjectContent(selectedBucket, filename, apiConfig.projectId);
      setViewModalData({ filename, content: fileContent });
      addLog(`Content fetched.`);
    });
  };

  const handleDeleteGcsFile = async (filename: string) => {
    if (!selectedBucket) return;
    if (!window.confirm(`Are you sure you want to delete backup file: ${filename}?`)) return;
    executeOperation('DeleteFile', async () => {
      addLog(`Deleting backup file: gs://${selectedBucket}/${filename}...`);
      await api.deleteGcsObject(selectedBucket, filename, apiConfig.projectId);
      addLog(`File deleted successfully.`);
      fetchBackups(); // Refresh the list
    });
  };



  // --- Backup Handlers ---

  const handleBackupAgents = async () => executeOperation('BackupAgents', async () => {
    if (!apiConfig.appId) {
      throw new Error("Gemini Enterprise ID must be set to back up agents.");
    }
    addLog(`Starting backup for agents in Assistant: ${apiConfig.assistantId}...`);
    
    const agents: Agent[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const agentsResponse = await api.listResources('agents', apiConfig, pageToken);
      agents.push(...(agentsResponse.agents || []));
      pageToken = agentsResponse.nextPageToken;
    } while (pageToken);

    for (const agent of agents) {
      try {
        const policy = await api.getAgentIamPolicy(agent.name, apiConfig);
        if (policy) {
          (agent as any).iamPolicy = policy;
        }
      } catch (e) {
        addLog(`  - Warning: Failed to backup IAM policy for agent ${agent.name}: ${(e as any).message}`);
      }
    }
    
    let agentsToSave = agents;
    if (activeTab === 'user') {
      agentsToSave = agents.filter((agent: any) => {
        let owner = "N/A";
        if (agent.iamPolicy && agent.iamPolicy.bindings) {
          const ownerBinding = agent.iamPolicy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
          if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
            owner = getOwnerFromBinding(ownerBinding.members[0]);
          }
        }
        return owner === userEmail;
      });
      addLog(`  - User Tab: Filtered down to ${agentsToSave.length} agents owned by you.`);
    }
    
    const backupData = { type: 'Agents', createdAt: new Date().toISOString(), sourceConfig: apiConfig, agents: agentsToSave };
    await uploadBackupToGcs(backupData, `agentspace-agents__${apiConfig.appId || 'N/A'}__${apiConfig.appLocation}`);
    addLog(`Backup complete! Found ${agentsToSave.length} agents.`);
  });


  const handleBackupNotebooks = async () => executeOperation('BackupNotebookLM', async () => {
    addLog(`Starting backup for Notebooks in ${apiConfig.appLocation}...`);
    const response = await api.listNotebooks(apiConfig);
    const notebooks = response.notebooks || [];

    addLog(`Found ${notebooks.length} notebooks. Fetching detailed sources...`);
    const fullNotebooks = [];

    for (const nb of notebooks) {
      const notebookId = nb.name.split('/').pop()!;
      try {
        const rawNotebook = await api.getNotebook(apiConfig, notebookId);



        // Loop through the sources to pull full metadata
        const fullSources = [];
        for (const source of (rawNotebook.sources || [])) {
          const sourceId = source.name.split('/').pop()!;
          try {
            const fullSource = await api.getNotebookSource(apiConfig, notebookId, sourceId);
            fullSources.push(fullSource);
          } catch (sourceErr: any) {
            addLog(`  - Warning: Could not fetch details for source ${sourceId} in notebook ${notebookId}: ${sourceErr.message}`);
            fullSources.push(source); // Fallback to shallow copy
          }
        }
        rawNotebook.sources = fullSources;
        fullNotebooks.push(rawNotebook);
        addLog(`  - Fetched details for: ${rawNotebook.displayName || notebookId} (${fullSources.length} sources)`);
      } catch (nbErr: any) {
        addLog(`  - Error fetching details for notebook ${notebookId}: ${nbErr.message}`);
      }
      await delay(500); // Rate limit
    }

    let notebooksToSave = fullNotebooks;
    if (activeTab === 'user') {
      notebooksToSave = fullNotebooks.filter((nb: any) => {
        return nb.metadata?.userRole === 'PROJECT_ROLE_OWNER';
      });
      addLog(`  - User Tab: Filtered down to ${notebooksToSave.length} notebooks owned by you.`);
    }

    const backupData = { type: 'NotebookLM', createdAt: new Date().toISOString(), sourceConfig: apiConfig, notebooks: notebooksToSave };
    await uploadBackupToGcs(backupData, `agentspace-notebooks__${apiConfig.appId || 'N/A'}__${apiConfig.appLocation}`);
    addLog(`Backup complete! Found ${notebooksToSave.length} fully resolved NotebookLMs.`);
  });

  const handleUserBackupCombined = async () => executeOperation('BackupUserData', async () => {
    addLog(`Starting combined backup for user: ${userEmail}...`);
    
    let userGaiaIdHex = "";
    try {
      const userInfo = await api.getUserInfo(accessToken);
      if (userInfo && userInfo.sub) {
        // Convert decimal sub to hex and format as gaia:0x...#
        userGaiaIdHex = `gaia:0x${BigInt(userInfo.sub).toString(16)}#`;
        if (isDebugMode) {
          addLog(`[DEBUG] Resolved User GAIA ID: ${userGaiaIdHex}`);
        }
      }
    } catch (err: any) {
      addLog(`Warning: Failed to fetch user info for GAIA ID filtering: ${err.message}`);
    }
    
    const sourceConfig = {
      ...apiConfig,
      projectId: userTabConfig.sourceProject,
      appLocation: userTabConfig.sourceLocation || apiConfig.appLocation,
      appId: userTabConfig.sourceAppId || apiConfig.appId,
    };

    if (isDebugMode) {
      addLog(`[DEBUG] Resolved Source Config: ${JSON.stringify(sourceConfig, null, 2)}`);
    }

    // 1. Backup Agents
    addLog(`Fetching agents from ${sourceConfig.appId} in ${sourceConfig.appLocation}...`);
    const agents: Agent[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const agentsResponse = await api.listResources('agents', sourceConfig, pageToken);
      agents.push(...(agentsResponse.agents || []));
      pageToken = agentsResponse.nextPageToken;
    } while (pageToken);

    // Fetch IAM policies and filter
    const userAgents = [];
    for (const agent of agents) {
      try {
        const policy = await api.getAgentIamPolicy(agent.name, sourceConfig);
        let owner = "N/A";
        if (policy && policy.bindings) {
          const ownerBinding = policy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
          if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
            owner = getOwnerFromBinding(ownerBinding.members[0]);
          }
        }
        
        let isOwner = false;
        if (owner === userEmail) {
          isOwner = true;
        }

        // Extra check for low-code agents if GAIA ID is available
        if (userGaiaIdHex) {
          const definitionKeys = Object.keys(agent).filter(key => key.toLowerCase().includes('agentdefinition'));
          for (const key of definitionKeys) {
            const definition = (agent as any)[key];
            if (definition && definition.owner) {
              if (definition.owner === userGaiaIdHex) {
                isOwner = true; // Confirmed owner!
              } else {
                isOwner = false; // Overwrite IAM policy if JSON owner doesn't match!
              }
              break;
            }
          }
        }

        if (isOwner) {
          (agent as any).iamPolicy = policy;
          userAgents.push(agent);
        }
      } catch (e) {
        addLog(`  - Warning: Failed to backup IAM policy for agent ${agent.name}: ${(e as any).message}`);
      }
    }
    addLog(`Found ${userAgents.length} agents owned by you.`);
    if (isDebugMode) {
      addLog(`[DEBUG] Owned Agents: ${JSON.stringify(userAgents.map(a => a.displayName), null, 2)}`);
    }

    // 2. Backup Notebooks
    addLog(`Fetching notebooks...`);
    const response = await api.listNotebooks(sourceConfig);
    const notebooks = response.notebooks || [];
    const userNotebooks = [];

    for (const nb of notebooks) {
      const notebookId = nb.name.split('/').pop()!;
      try {
        const rawNotebook = await api.getNotebook(sourceConfig, notebookId);
        if (rawNotebook.metadata?.userRole === 'PROJECT_ROLE_OWNER') {
          // Fetch sources
          const fullSources = [];
          for (const source of (rawNotebook.sources || [])) {
            const sourceId = source.name.split('/').pop()!;
            try {
              const fullSource = await api.getNotebookSource(sourceConfig, notebookId, sourceId);
              fullSources.push(fullSource);
            } catch (sourceErr: any) {
              fullSources.push(source);
            }
          }
          rawNotebook.sources = fullSources;
          userNotebooks.push(rawNotebook);
        }
      } catch (nbErr: any) {
        addLog(`  - Error fetching details for notebook ${notebookId}: ${nbErr.message}`);
      }
      await delay(500); // Rate limit
    }
    addLog(`Found ${userNotebooks.length} notebooks owned by you.`);
    if (isDebugMode) {
      addLog(`[DEBUG] Owned Notebooks: ${JSON.stringify(userNotebooks.map(n => n.title), null, 2)}`);
    }

    // 3. Combine and Open Selection Modal
    const backupData = {
      type: 'UserBackup',
      createdAt: new Date().toISOString(),
      userEmail,
      sourceConfig: apiConfig,
      agents: userAgents,
      notebooks: userNotebooks
    };

    const agentItems: SelectableItem[] = userAgents.map(agent => ({
      name: agent.name,
      displayName: agent.displayName || 'Unnamed Agent',
      agentType: 'Agent'
    }));

    const notebookItems: SelectableItem[] = userNotebooks.map(nb => ({
      name: nb.name,
      displayName: nb.title || 'Unnamed Notebook',
      agentType: 'Notebook'
    }));

    setSelectionModalItems([...agentItems, ...notebookItems]);
    setSelectionModalTitle('Select Items to Backup');
    setSelectionModalSubtitle('Select the agents and notebooks you want to include in the backup file.');
    setSelectionModalAction('backup');
    setPendingBackupData(backupData);
    setIsSelectionModalOpen(true);
  });

  const handleSingleClickMigration = async () => executeOperation('MigrateUserData', async () => {
    const sourceIdp = import.meta.env.VITE_SOURCE_IDP || 'Google';
    const targetIdp = import.meta.env.VITE_TARGET_IDP || 'Google';
    const isIdpChangeEnabled = sourceIdp !== targetIdp;

    if (isIdpChangeEnabled) {
      if (!sourceToken) {
        addLog(`Source token missing. Please log into ${sourceIdp}...`);
        if (sourceIdp === 'Google') onGoogleSignIn?.();
        else onWifSignIn?.();
        return;
      }
      if (!targetToken) {
        addLog(`Target token missing. Please log into ${targetIdp}...`);
        if (targetIdp === 'Google') onGoogleSignIn?.();
        else onWifSignIn?.();
        return;
      }
    }

    addLog(`Starting single-click migration...`);
    
    let userGaiaIdHex = "";
    try {
      const userInfo = await api.getUserInfo(accessToken);
      if (userInfo && userInfo.sub) {
        userGaiaIdHex = `gaia:0x${BigInt(userInfo.sub).toString(16)}#`;
      }
    } catch (err: any) {
      addLog(`Warning: Failed to fetch user info for GAIA ID filtering: ${err.message}`);
    }
    
    const sourceConfig = {
      ...apiConfig,
      projectId: userTabConfig.sourceProject,
      appLocation: userTabConfig.sourceLocation || apiConfig.appLocation,
      appId: userTabConfig.sourceAppId || apiConfig.appId,
      accessToken: sourceToken || accessToken,
    };

    addLog(`Fetching agents from ${sourceConfig.appId}...`);
    const agents: Agent[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const agentsResponse = await api.listResources('agents', sourceConfig, pageToken);
      agents.push(...(agentsResponse.agents || []));
      pageToken = agentsResponse.nextPageToken;
    } while (pageToken);

    const userAgents = [];
    for (const agent of agents) {
      try {
        const policy = await api.getAgentIamPolicy(agent.name, sourceConfig);
        let owner = "N/A";
        if (policy && policy.bindings) {
          const ownerBinding = policy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
          if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
            owner = getOwnerFromBinding(ownerBinding.members[0]);
          }
        }
        
        let isOwner = owner === userEmail;

        if (userGaiaIdHex) {
          const definitionKeys = Object.keys(agent).filter(key => key.toLowerCase().includes('agentdefinition'));
          for (const key of definitionKeys) {
            const definition = (agent as any)[key];
            if (definition && definition.owner) {
              if (definition.owner === userGaiaIdHex) isOwner = true;
              else isOwner = false;
              break;
            }
          }
        }

        if (isOwner) {
          (agent as any).iamPolicy = policy;
          userAgents.push(agent);
        }
      } catch (e) {
        addLog(`  - Warning: Failed to backup IAM policy for agent ${agent.name}: ${(e as any).message}`);
      }
    }

    addLog(`Fetching notebooks...`);
    const response = await api.listNotebooks(sourceConfig);
    const notebooks = response.notebooks || [];
    const userNotebooks = [];

    for (const nb of notebooks) {
      const notebookId = nb.name.split('/').pop()!;
      try {
        const rawNotebook = await api.getNotebook(sourceConfig, notebookId);
        if (rawNotebook.metadata?.userRole === 'PROJECT_ROLE_OWNER') {
          const fullSources = [];
          for (const source of (rawNotebook.sources || [])) {
            const sourceId = source.name.split('/').pop()!;
            try {
              const fullSource = await api.getNotebookSource(sourceConfig, notebookId, sourceId);
              fullSources.push(fullSource);
            } catch (sourceErr: any) {
              fullSources.push(source);
            }
          }
          rawNotebook.sources = fullSources;
          userNotebooks.push(rawNotebook);
        }
      } catch (nbErr: any) {
        addLog(`  - Error fetching details for notebook ${notebookId}: ${nbErr.message}`);
      }
      await delay(500);
    }

    const targetConfig = {
      ...apiConfig,
      projectId: userTabConfig.targetProject,
      appLocation: userTabConfig.targetLocation || apiConfig.appLocation,
      appId: userTabConfig.targetAppId || apiConfig.appId,
      accessToken: targetToken || accessToken,
    };

    addLog(`Starting restore to target environment...`);
    
    if (shouldMigrateAgents && userAgents.length > 0) {
      addLog(`Restoring ${userAgents.length} agents to ${targetConfig.appId}...`);
      await restoreAgentsIntoAssistant(userAgents, targetConfig, sourceConfig);
    }

    const report: ManualActionReportItem[] = [];

    if (shouldMigrateAgents && userAgents.length > 0) {
      for (const agent of userAgents) {
        const dataStoreConnections = (agent as any).dataStoreConnections;
        const iamPolicy = (agent as any).iamPolicy;
        
        const sharedWith: string[] = [];
        
        if (iamPolicy && iamPolicy.bindings) {
          for (const binding of iamPolicy.bindings) {
            if (binding.role === 'roles/discoveryengine.agentOwner') continue;
            if (binding.members) {
              const filteredMembers = binding.members.filter((member: string) => !userEmail || !member.includes(userEmail));
              sharedWith.push(...filteredMembers);
            }
          }
        }

        const unmappedDatastores: string[] = [];
        const knowledgeAttachments: string[] = [];
        if (dataStoreConnections && dataStoreConnections.length > 0) {
          for (const conn of dataStoreConnections) {
            if (conn.dataStore) {
              const oldDsId = conn.dataStore.split('/').pop();
              if (oldDsId) {
                knowledgeAttachments.push(oldDsId);
                if (!datastoreMapping[oldDsId]) {
                  unmappedDatastores.push(oldDsId);
                }
              }
            }
          }
        }

        const agentFiles: string[] = [];
        const definitionKeys = Object.keys(agent).filter(key => key.toLowerCase().includes('agentdefinition'));
        
        for (const key of definitionKeys) {
          const definition = (agent as any)[key];
          if (definition) {
            const files = definition.deployedAgentFiles || definition.agentFiles;
            if (files && files.length > 0) {
              for (const file of files) {
                if (file.fileName) {
                  agentFiles.push(file.fileName);
                }
              }
            }
          }
        }
        
        report.push({
          agentName: agent.displayName,
          sharedWith: Array.from(new Set(sharedWith)),
          unmappedDatastores: unmappedDatastores,
          knowledgeAttachments: knowledgeAttachments,
          agentFiles: agentFiles,
        });
      }
    }

    if (shouldMigrateNotebooks && userNotebooks.length > 0) {
      addLog(`Restoring ${userNotebooks.length} notebooks to ${targetConfig.appId}...`);
      
      let existingNotebooks: any[] = [];
      try {
        const listResponse = await api.listNotebooks(targetConfig);
        existingNotebooks = listResponse.notebooks || [];
      } catch (listErr: any) {
        addLog(`Warning: Could not list existing notebooks in target: ${listErr.message}`);
      }

      for (const nb of userNotebooks) {
        const targetTitle = `${nb.title || 'Restored Notebook'} (Restored)`;
        
        const alreadyExists = existingNotebooks.some((n: any) => n.title === targetTitle);
        if (alreadyExists) {
          addLog(`  - Skipping notebook "${nb.title}" (already restored)`);
          continue;
        }

        try {
          const payload = {
            title: targetTitle,
            metadata: nb.metadata
          };
          const newNotebook = await api.createNotebook(targetConfig, payload);
          const newNotebookId = newNotebook.name.split('/').pop()!;
          addLog(`  - Created Notebook: ${newNotebookId}`);

          if (nb.sources && nb.sources.length > 0) {
            const sourceRequests = nb.sources.filter(isRestorableSource).map(mapSourceToPayload);
            if (sourceRequests.length > 0) {
              try {
                addLog(`    - Adding ${sourceRequests.length} sources to notebook...`);
                await api.batchCreateNotebookSources(targetConfig, newNotebookId, sourceRequests);
                addLog(`    - Sources added.`);
              } catch (srcErr: any) {
                addLog(`    - Error adding sources: ${srcErr.message}`);
              }
            }
          }
          
          // Collect report info
          const sharedWith: string[] = [];
          if (nb.iamPolicy && nb.iamPolicy.bindings) {
            for (const binding of nb.iamPolicy.bindings) {
              if (binding.role === 'roles/discoveryengine.agentOwner') continue;
              if (binding.members) {
                const filteredMembers = binding.members.filter((member: string) => !userEmail || !member.includes(userEmail));
                sharedWith.push(...filteredMembers);
              }
            }
          }

          const localFiles: string[] = [];
          if (nb.sources && nb.sources.length > 0) {
            for (const source of nb.sources) {
              if (source.metadata?.agentspaceMetadata) {
                localFiles.push(source.metadata.agentspaceMetadata.documentName || source.title || 'Unnamed File');
              } else if (!source.metadata?.googleDocsMetadata && !source.metadata?.youtubeMetadata && !source.metadata?.webpageMetadata && !source.url && !source.webScrapeConfig) {
                localFiles.push(source.title || source.displayName || 'Unsupported Source');
              }
            }
          }

          report.push({
            notebookTitle: nb.title || nb.displayName || 'Unnamed Notebook',
            sharedWith: Array.from(new Set(sharedWith)),
            localFiles: localFiles,
          });

        } catch (nbErr: any) {
          addLog(`  - Error restoring notebook ${nb.title}: ${nbErr.message}`);
        }
      }
    }
    
    setManualActionReport(report);
    addLog(`Migration complete!`);
    setIsRestoreComplete(true);
  });

  const handleUserRestoreCombined = async () => executeOperation('RestoreUserData', async () => {
    if (!restoreFileContent) {
      throw new Error("No backup file selected or file is empty.");
    }
    
    const targetConfig = {
      ...apiConfig,
      projectId: userTabConfig.targetProject,
      appLocation: userTabConfig.targetLocation || apiConfig.appLocation,
      appId: userTabConfig.targetAppId || apiConfig.appId,
    };

    if (isDebugMode) {
      addLog(`[DEBUG] Resolved Target Config: ${JSON.stringify(targetConfig, null, 2)}`);
    }

    try {
      addLog(`Loading backup data from selected file...`);
      const backupData = JSON.parse(restoreFileContent);
      
      if (backupData.type !== 'UserBackup') {
        throw new Error(`Invalid backup file type. Expected 'UserBackup', but found '${backupData.type}'.`);
      }

      // Connector validation removed as per user request

      addLog(`Backup file loaded. Created at: ${backupData.createdAt}`);

      // Fetch target resources for validation
      addLog(`Fetching current resources from target environment for validation...`);
      const targetAgents: Agent[] = [];
      let pageToken: string | undefined = undefined;
      try {
        do {
          const agentsResponse = await api.listResources('agents', targetConfig, pageToken);
          targetAgents.push(...(agentsResponse.agents || []));
          pageToken = agentsResponse.nextPageToken;
        } while (pageToken);
      } catch (err: any) {
        addLog(`  - Warning: Failed to fetch target agents for validation: ${err.message}`);
      }

      let targetNotebooks: any[] = [];
      try {
        const response = await api.listNotebooks(targetConfig);
        targetNotebooks = response.notebooks || [];
      } catch (err: any) {
        addLog(`  - Warning: Failed to fetch target notebooks for validation: ${err.message}`);
      }

      const targetAgentNames = new Set(targetAgents.map(a => a.displayName));
      const targetNotebookTitles = new Set(targetNotebooks.map(n => n.title));

      const agentItems: SelectableItem[] = (backupData.agents || []).map((agent: any) => {
        const exists = targetAgentNames.has(agent.displayName);
        return {
          name: agent.name,
          displayName: agent.displayName || 'Unnamed Agent',
          agentType: 'Agent',
          disabled: exists,
          disabledReason: exists ? 'Already exists in target' : undefined
        };
      });

      const notebookItems: SelectableItem[] = (backupData.notebooks || []).map((nb: any) => {
        const targetTitle = `${nb.title || 'Restored Notebook'} (Restored)`;
        const exists = targetNotebookTitles.has(nb.title) || targetNotebookTitles.has(targetTitle);
        return {
          name: nb.name,
          displayName: nb.title || 'Unnamed Notebook',
          agentType: 'Notebook',
          disabled: exists,
          disabledReason: exists ? 'Already exists in target' : undefined
        };
      });

      setSelectionModalItems([...agentItems, ...notebookItems]);
      setSelectionModalTitle('Select Items to Restore');
      setSelectionModalSubtitle('Select the agents and notebooks you want to restore. Items that already exist in the target are greyed out.');
      setSelectionModalAction('restore');
      setPendingBackupData(backupData);
      setIsSelectionModalOpen(true);
      
      return; // Actual restore happens in handleSelectionConfirm
    } catch (err: any) {
      addLog(`Restore failed: ${err.message}`);
      throw err;
    }
  });

  const handleSelectionConfirm = async (selectedItems: SelectableItem[]) => {
    setIsSelectionModalOpen(false);
    
    const selectedNames = new Set(selectedItems.map(i => i.name));
    
    if (selectionModalAction === 'backup') {
      executeOperation('BackupUserData', async () => {
        addLog(`Creating backup for selected items...`);
        const filteredAgents = pendingBackupData.agents.filter((a: any) => selectedNames.has(a.name));
        const filteredNotebooks = pendingBackupData.notebooks.filter((n: any) => selectedNames.has(n.name));
        
        const finalBackupData = {
          ...pendingBackupData,
          agents: filteredAgents,
          notebooks: filteredNotebooks
        };
        
        const jsonStr = JSON.stringify(finalBackupData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `agentspace-user-backup__${userEmail}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        addLog(`Backup complete! File downloaded: agentspace-user-backup__${userEmail}.json`);
      });
    } else if (selectionModalAction === 'restore') {
      executeOperation('RestoreUserData', async () => {
        addLog(`Restoring selected items...`);
        const filteredAgents = pendingBackupData.agents.filter((a: any) => selectedNames.has(a.name));
        const filteredNotebooks = pendingBackupData.notebooks.filter((n: any) => selectedNames.has(n.name));
        
        const targetConfig = {
          ...apiConfig,
          projectId: userTabConfig.targetProject,
          appLocation: userTabConfig.targetLocation || apiConfig.appLocation,
          appId: userTabConfig.targetAppId || apiConfig.appId,
        };

        // 1. Restore Agents
        if (filteredAgents.length > 0) {
          addLog(`Restoring ${filteredAgents.length} agents to ${targetConfig.appId}...`);
          await restoreAgentsIntoAssistant(filteredAgents, targetConfig, pendingBackupData.sourceConfig);
        }

        // 2. Restore Notebooks
        if (filteredNotebooks.length > 0) {
          addLog(`Restoring ${filteredNotebooks.length} notebooks to ${targetConfig.appId}...`);
          
          addLog(`Checking for existing notebooks in target...`);
          let existingNotebooks: any[] = [];
          try {
            const listResponse = await api.listNotebooks(targetConfig);
            existingNotebooks = listResponse.notebooks || [];
          } catch (listErr: any) {
            addLog(`Warning: Could not list existing notebooks in target: ${listErr.message}`);
          }

          for (const nb of filteredNotebooks) {
            const targetTitle = `${nb.title || 'Restored Notebook'} (Restored)`;
            
            const alreadyExists = existingNotebooks.some((n: any) => n.title === targetTitle);
            if (alreadyExists) {
              addLog(`  - Skipping notebook "${nb.title}" (already restored)`);
              continue;
            }

            try {
              const payload = {
                title: targetTitle,
                metadata: nb.metadata
              };
              const newNotebook = await api.createNotebook(targetConfig, payload);
              const newNotebookId = newNotebook.name.split('/').pop()!;
              addLog(`  - Created Notebook: ${newNotebookId}`);

              if (nb.sources && nb.sources.length > 0) {
                const sourceRequests = nb.sources.filter(isRestorableSource).map(mapSourceToPayload);
                if (sourceRequests.length > 0) {
                  await api.batchCreateNotebookSources(targetConfig, newNotebookId, sourceRequests);
                  addLog(`    - Restored ${sourceRequests.length} sources.`);
                } else {
                  addLog(`    - No restorable sources found (skipping local files).`);
                }
              }
            } catch (nbErr: any) {
              addLog(`  - Error restoring notebook ${nb.name}: ${nbErr.message}`);
            }
          }
        }

        // Compile Manual Action Report
        const report: ManualActionReportItem[] = [];
        
        for (const agent of filteredAgents) {
          const dataStoreConnections = (agent as any).dataStoreConnections;
          const iamPolicy = (agent as any).iamPolicy;
          
          const sharedWith: string[] = [];
          const userEmail = pendingBackupData?.userEmail;
          
          if (iamPolicy && iamPolicy.bindings) {
            for (const binding of iamPolicy.bindings) {
              // Skip owner role as requested by user
              if (binding.role === 'roles/discoveryengine.agentOwner') {
                continue;
              }
              if (binding.members) {
                const filteredMembers = binding.members.filter((member: string) => {
                  return !userEmail || !member.includes(userEmail);
                });
                sharedWith.push(...filteredMembers);
              }
            }
          }

          const unmappedDatastores: string[] = [];
          const knowledgeAttachments: string[] = [];
          if (dataStoreConnections && dataStoreConnections.length > 0) {
            for (const conn of dataStoreConnections) {
              if (conn.dataStore) {
                const oldDsId = conn.dataStore.split('/').pop();
                if (oldDsId) {
                  knowledgeAttachments.push(oldDsId);
                  if (!datastoreMapping[oldDsId]) {
                    unmappedDatastores.push(oldDsId);
                  }
                }
              }
            }
          }

          const agentFiles: string[] = [];
          
          // Find definition keys (like workflowAgentDefinition) that contain the files
          const definitionKeys = Object.keys(agent).filter(key => key.toLowerCase().includes('agentdefinition'));
          
          for (const key of definitionKeys) {
            const definition = (agent as any)[key];
            if (definition) {
              const files = definition.deployedAgentFiles || definition.agentFiles;
              if (files && files.length > 0) {
                for (const file of files) {
                  if (file.fileName) {
                    agentFiles.push(file.fileName);
                  }
                }
              }
            }
          }
          
          report.push({
            agentName: agent.displayName,
            sharedWith: Array.from(new Set(sharedWith)),
            unmappedDatastores: unmappedDatastores,
            knowledgeAttachments: knowledgeAttachments,
            agentFiles: agentFiles,
          });
        }

        // Compile Manual Action Report for Notebooks
        for (const nb of filteredNotebooks) {
          const sharedWith: string[] = [];
          const userEmail = pendingBackupData?.userEmail;
          const iamPolicy = (nb as any).iamPolicy;
          
          if (iamPolicy && iamPolicy.bindings) {
            for (const binding of iamPolicy.bindings) {
              if (binding.role === 'roles/discoveryengine.agentOwner') {
                continue;
              }
              if (binding.members) {
                const filteredMembers = binding.members.filter((member: string) => {
                  return !userEmail || !member.includes(userEmail);
                });
                sharedWith.push(...filteredMembers);
              }
            }
          }

          const localFiles: string[] = [];
          if (nb.sources && nb.sources.length > 0) {
            for (const source of nb.sources) {
              if (source.metadata?.agentspaceMetadata) {
                localFiles.push(source.metadata.agentspaceMetadata.documentName || source.title || 'Unnamed File');
              } else if (!source.metadata?.googleDocsMetadata && !source.metadata?.youtubeMetadata && !source.metadata?.webpageMetadata && !source.url && !source.webScrapeConfig) {
                localFiles.push(source.title || source.displayName || 'Unsupported Source');
              }
            }
          }

          report.push({
            notebookTitle: nb.title || nb.displayName || 'Unnamed Notebook',
            sharedWith: Array.from(new Set(sharedWith)),
            localFiles: localFiles,
          });
        }
        
        setManualActionReport(report);
        // Removed setIsStepsDrawerOpen(true) as per user request to use Step 3 instead
        if (report.length > 0) {
          addLog(`Generated manual action report with ${report.length} items.`);
        }

        addLog(`Restore complete!`);
        setIsRestoreComplete(true);
      });
    }
  };

  const downloadStepsAsText = () => {
    let content = "Post-Restore Steps\n";
    content += "==================\n\n";
    content += "Please complete the following manual steps to finalize your restoration.\n\n";

    manualActionReport.forEach(item => {
      if (item.agentName) {
        content += `🤖 Agent: "${item.agentName}"\n`;
        content += `----------------------------------------\n`;
        content += `- Status: All restored agents are in draft and will need to be created/published.\n`;
        
        if (item.sharedWith && item.sharedWith.length > 0) {
          content += `- Sharing: Please reshare this agent with:\n`;
          item.sharedWith.forEach(email => {
            content += `    * ${email}\n`;
          });
        } else {
          content += `- Sharing: No sharing permissions found in backup.\n`;
        }

        if (item.knowledgeAttachments && item.knowledgeAttachments.length > 0) {
          content += `- Knowledge Attachments:\n`;
          item.knowledgeAttachments.forEach(dsId => {
            content += `    * ${dsId}\n`;
          });
        }

        if (item.agentFiles && item.agentFiles.length > 0) {
          content += `- Knowledge Files:\n`;
          item.agentFiles.forEach(fileName => {
            content += `    * ${fileName}\n`;
          });
        }

        if (item.unmappedDatastores && item.unmappedDatastores.length > 0) {
          content += `- Unmapped Datastores: The following datastores could not be remapped and need manual review:\n`;
          item.unmappedDatastores.forEach(dsId => {
            content += `    * ${dsId}\n`;
          });
        } else {
          content += `- Datastores: All datastores were successfully mapped or none were attached.\n`;
        }
      } else {
        content += `📓 Notebook: "${item.notebookTitle}"\n`;
        content += `----------------------------------------\n`;
        content += `- Status: Notebook restored. Please check sources and sharing.\n`;
        if (item.sharedWith && item.sharedWith.length > 0) {
          content += `- Sharing: Please reshare this notebook with:\n`;
          item.sharedWith.forEach(email => {
            content += `    * ${email}\n`;
          });
        } else {
          content += `- Sharing: We are unable to retrieve shared users from source. Please manually document and reshare your notebooks if needed.\n`;
        }

        if (item.localFiles && item.localFiles.length > 0) {
          content += `- Local Files: The following local files were attached to the original notebook and need to be re-added manually:\n`;
          item.localFiles.forEach(file => {
            content += `    * ${file}\n`;
          });
        } else {
          content += `- Local Files: No local files detected or all sources are external.\n`;
        }
      }
      content += `\n`;
    });

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `post_restore_steps.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // --- Restore Handlers & Processors ---



  const handleRestore = async (section: string, processor: (data: any) => Promise<void>, filename: string) => {
    if (!filename || !selectedBucket) {
      setError(`Please select a bucket and a backup file for ${section}.`);
      return;
    }
    
    const sectionName = section.replace(/[A-Z]/g, ' $&').trim(); // e.g., 'DiscoveryResources' -> 'Discovery Resources'
    executeOperation(`Restore${section}`, async () => {
      addLog(`Downloading file: gs://${selectedBucket}/${filename}...`);
      
      const fileContent = await api.getGcsObjectContent(selectedBucket, filename, apiConfig.projectId);
      const backupData = JSON.parse(fileContent);
      
      if (backupData.type !== section) {
        // Allow backward compatibility or relaxed checking if needed, but for now strict.
        // Actually, some backups might be old format?
        // ChatHistory backups have type 'ChatHistory'.
        throw new Error(`Invalid backup file type. Expected '${section}', but found '${backupData.type}'.`);
      }

      if (section === 'ChatHistory') {
        // Special handling for Chat History: Open Archive Viewer
        const sessions = [
          ...(backupData.discoverySessions || []),
          ...(backupData.reasoningSessions || [])
        ];
        setChatHistoryArchiveData({ sessions, fileName: filename });
        addLog(`Opened Chat History Archive Viewer for ${filename}.`);
      } else {
        await processor(backupData);
      }

      addLog(`Restore process for ${sectionName} finished.`);
    });
  };

  const handleConfirmRestore = (section: string, items: any[], processor: (data: any) => Promise<void>, originalData: any) => {
    setModalData(null); // Close the modal first

    const sectionName = section.replace(/[A-Z]/g, ' $&').trim();
    executeOperation(`Restore${section}`, async () => {
      let dataToRestore = { ...originalData };
      
      // Filter the original data based on the selected items
      switch (section) {
          case 'DiscoveryResources':
              dataToRestore.collections = originalData.collections.filter((c: Collection) => items.some(item => item.name === c.name));
              break;
          case 'ReasoningEngine':
              // It's a single item select for now
              dataToRestore.engine = items.length > 0 ? items[0] : null; 
              break;
          case 'Assistant':
              dataToRestore.assistant.agents = originalData.assistant.agents.filter((a: Agent) => items.some(item => item.name === a.name));
              break;
          case 'Agents':
              dataToRestore.agents = originalData.agents.filter((a: Agent) => items.some(item => item.name === a.name));
              break;
          case 'DataStores':
              dataToRestore.dataStores = originalData.dataStores.filter((ds: DataStore) => items.some(item => item.name === ds.name));
              break;
          case 'Authorizations':
              dataToRestore.authorizations = originalData.authorizations.filter((auth: Authorization) => items.some(item => item.name === auth.name));
              break;
        case 'NotebookLM':
          dataToRestore.notebooks = originalData.notebooks.filter((nb: any) => items.some(item => item.name === nb.name));
          break;
          default:
              throw new Error(`Unknown section type for selective restore: ${section}`);
      }
      
      addLog(`Starting restore of ${items.length} selected ${sectionName}...`);
      await processor(dataToRestore);
      addLog(`Restore process for ${sectionName} finished.`);
    });
  };

  const restoreAgentsIntoAssistant = async (agents: Agent[], restoreConfig: typeof apiConfig, sourceConfig?: any) => {
    addLog(`  - Restoring ${agents.length} agent(s)...`);
    for (const agent of agents) {
      const originalAgentId = agent.name.split('/').pop()!;
      addLog(`    - Preparing to restore agent: ${agent.displayName} (from original ID: ${originalAgentId}) as a new agent.`);

      const buildPayload = (currentAgent: Agent): any => {
        const finalStarterPrompts = (currentAgent.starterPrompts || [])
          .map(p => p.text ? p.text.trim() : '')
          .filter(text => text)
          .map(text => ({ text }));

        // Prefix display name with [Replace] if it has data store connections (knowledge files)
        let restoredDisplayName = currentAgent.displayName;
        if ((currentAgent as any).dataStoreConnections && (currentAgent as any).dataStoreConnections.length > 0) {
          restoredDisplayName = `[Replace] ${restoredDisplayName}`;
        }

        // Base payload
        const payload: any = {
          displayName: restoredDisplayName,
          description: currentAgent.description || '',
          icon: currentAgent.icon || undefined,
          starterPrompts: finalStarterPrompts.length > 0 ? finalStarterPrompts : undefined,
          authorizationConfig: currentAgent.authorizationConfig,
          authorizations: !currentAgent.authorizationConfig ? currentAgent.authorizations : undefined,
        };

        // Copy all other fields except blacklist to be complete
        const blacklist = ['name', 'createTime', 'updateTime', 'agentIdentityInfo', 'iamPolicy'];
        for (const key of Object.keys(currentAgent)) {
          if (!blacklist.includes(key) && !(key in payload)) {
            payload[key] = (currentAgent as any)[key];
          }
        }

        // Rewrite DataStore connections based on mapping
        if (payload.dataStoreConnections) {
          const rewrittenConnections = payload.dataStoreConnections.map((conn: any) => {
            if (conn.dataStore) {
              const parts = conn.dataStore.split('/');
              const colIndex = parts.indexOf('collections');
              const oldColId = colIndex !== -1 ? parts[colIndex + 1] : 'default_collection';
              
              const oldDsId = conn.dataStore.split('/').pop();
              
              const targetProject = restoreConfig.projectId;
              const targetLocation = restoreConfig.appLocation || 'global';
              
              let targetCollection = 'default_collection';
              if (oldColId && collectionMapping[oldColId]) {
                targetCollection = collectionMapping[oldColId];
                if (isDebugMode) {
                  addLog(`    - [DEBUG] Root Connection: Remapping collection ${oldColId} -> ${targetCollection}`);
                }
              }
              
              let newDsId = oldDsId;
              if (oldDsId && datastoreMapping[oldDsId]) {
                newDsId = datastoreMapping[oldDsId];
                if (isDebugMode) {
                  addLog(`    - [DEBUG] Root Connection: Remapping datastore ${oldDsId} -> ${newDsId}`);
                }
              }
              
              return {
                ...conn,
                dataStore: `projects/${targetProject}/locations/${targetLocation}/collections/${targetCollection}/dataStores/${newDsId}`
              };
            }
            return conn;
          });

          // Deduplicate based on dataStore path
          const seenDataStores = new Set<string>();
          payload.dataStoreConnections = rewrittenConnections.filter((conn: any) => {
            if (conn.dataStore) {
              if (seenDataStores.has(conn.dataStore)) {
                return false; // Duplicate
              }
              seenDataStores.add(conn.dataStore);
            }
            return true;
          });
        }

        // Rewrite Authorizations to the NEW project/location
        const rewriteAuth = (authName: string) => {
          if (!authName) return authName;
          const authId = authName.split('/').pop()!;
          // Always target the new project/location for authorizations
          return `projects/${restoreConfig.projectId}/locations/${restoreConfig.appLocation || 'global'}/authorizations/${authId}`;
        };

        if (payload.authorizationConfig?.toolAuthorizations) {
          payload.authorizationConfig.toolAuthorizations = payload.authorizationConfig.toolAuthorizations.map(rewriteAuth);
        }
        if (payload.authorizations) {
          payload.authorizations = payload.authorizations.map(rewriteAuth);
        }

        // Apply replacements on definition fields in payload
        const definitionKeys = Object.keys(payload).filter(key => key.toLowerCase().includes('agentdefinition'));
        for (const key of definitionKeys) {
          let definition = payload[key];
          
          if (definition) {
            // Scrub hardcoded session references that cause permission errors
            if ((definition as any).session) {
              if (isDebugMode) {
                addLog(`    - [DEBUG] Scrubbing hardcoded session: ${(definition as any).session}`);
              }
              delete (definition as any).session;
            }

            let defStr = JSON.stringify(definition);
            
            if (isDebugMode) {
              addLog(`[DEBUG] Agent ${currentAgent.displayName} - Payload BEFORE replacement: ${defStr}`);
            }
            
            // Extract old engine ID from agent name
            const nameParts = currentAgent.name.split('/');
            const engineIndex = nameParts.indexOf('engines');
            const oldEngineId = engineIndex !== -1 ? nameParts[engineIndex + 1] : null;

            if (oldEngineId && restoreConfig.appId) {
              defStr = defStr.split(oldEngineId).join(restoreConfig.appId);
            }
            
            // Still use sourceConfig for project and location if available
            if (sourceConfig && sourceConfig.projectId && restoreConfig.projectId) {
              defStr = defStr.split(sourceConfig.projectId).join(restoreConfig.projectId);
            }

            // Replace old project number if present in agent name
            const oldProjectNumber = nameParts[1]; // projects/{number}/...
            if (oldProjectNumber && restoreConfig.projectId) {
              defStr = defStr.split(oldProjectNumber).join(restoreConfig.projectId);
            }
            if (sourceConfig && sourceConfig.appLocation && restoreConfig.appLocation) {
              defStr = defStr.split(sourceConfig.appLocation).join(restoreConfig.appLocation);
            }

            // Replace old location from agent name if present
            const oldLocation = nameParts[3]; // projects/{number}/locations/{location}/...
            if (oldLocation && restoreConfig.appLocation) {
              defStr = defStr.split(`/locations/${oldLocation}/`).join(`/locations/${restoreConfig.appLocation}/`);
            }

            // Apply collection mapping (sorted by length descending)
            Object.entries(collectionMapping)
              .sort((a, b) => b[0].length - a[0].length)
              .forEach(([oldColId, newColId]) => {
                if (defStr.includes(`/collections/${oldColId}/`)) {
                  if (isDebugMode) {
                    addLog(`    - [DEBUG] Remapping collection in definition: ${oldColId} -> ${newColId}`);
                  }
                  defStr = defStr.split(`/collections/${oldColId}/`).join(`/collections/${newColId}/`);
                }
              });

            // Apply datastore mapping (sorted by length descending)
            Object.entries(datastoreMapping)
              .sort((a, b) => b[0].length - a[0].length)
              .forEach(([oldDsId, newDsId]) => {
                if (defStr.includes(`/dataStores/${oldDsId}`)) {
                  if (isDebugMode) {
                    addLog(`    - [DEBUG] Remapping datastore in definition: ${oldDsId} -> ${newDsId}`);
                  }
                  defStr = defStr.split(`/dataStores/${oldDsId}`).join(`/dataStores/${newDsId}`);
                }
              });
            
            if (isDebugMode) {
              addLog(`[DEBUG] Agent ${currentAgent.displayName} - Payload AFTER replacement: ${defStr}`);
            }
            
            definition = JSON.parse(defStr);
          }
          
          payload[key] = definition;
        }

        return payload;
      };

      let createPayload = buildPayload(agent);
  
      try {
        // Create the agent, specifying the target ID if provided.
        const targetId = (agent as any).targetId;
        const newAgent = await api.createAgent(createPayload, restoreConfig, targetId);
        const newAgentId = newAgent.name.split('/').pop()!;
        addLog(`      - CREATED: Agent '${agent.displayName}' created successfully with new ID '${newAgentId}'.`);
        
        if ((agent as any).iamPolicy && (agent as any).iamPolicy.bindings) {
          const hasAgentUser = (agent as any).iamPolicy.bindings.some((b: any) => b.role === 'roles/discoveryengine.agentUser');
          
          if (hasAgentUser) {
            try {
              addLog(`      - Fetching current IAM policy for new agent: ${newAgentId} to get etag...`);
              const currentPolicy = await api.getAgentIamPolicy(newAgent.name, restoreConfig);
            
            addLog(`      - Restoring IAM policy bindings for new agent: ${newAgentId}...`);
            // Map agentOwner to agentEditor to bypass API restrictions
            const mappedBindings = (agent as any).iamPolicy.bindings.map((b: any) => {
              if (b.role === 'roles/discoveryengine.agentOwner') {
                return { ...b, role: 'roles/discoveryengine.agentEditor' };
              }
              return b;
            });
            
            const payloadPolicy = { 
              bindings: mappedBindings,
              etag: currentPolicy.etag
            };
            await api.setAgentIamPolicy(newAgent.name, payloadPolicy, restoreConfig);
            addLog(`      - IAM policy successfully restored for agent: ${newAgentId}`);
          } catch (iamErr: any) {
            addLog(`      - WARNING: Failed to apply IAM policy snapshot for agent ${newAgentId}: ${iamErr.message}`);
          }
          } else {
            addLog(`      - Skipping IAM policy restore as backup does not contain any agentUser bindings (likely a private agent).`);
          }
        }
      } catch (err: any) {
        if (err.message && err.message.includes("is used by another agent")) {
          addLog(`      - WARNING: Authorization is in use. Attempting to create a new one.`);
          // IMPORTANT: we need the ORIGINAL authorization name to fetch details, which we grab from the backup agent directly.
          const originalAuthName = agent.authorizationConfig?.toolAuthorizations?.[0] || agent.authorizations?.[0];
          if (!originalAuthName) {
            addLog(`      - ERROR: Cannot resolve authorization conflict. Agent in backup has no authorization specified. Skipping agent.`);
            continue;
          }

          try {
            // We fetch the authorization by providing the Old Project ID through a custom config override,
            // because `restoreConfig` points to the *new* project. 
            // `originalAuthName` contains `projects/[old_project]/...` so apiService should parse it out if it handles full paths, 
            // but we can extract it explicitly to be safe.
            const oldProjectMatch = originalAuthName.match(/projects\/([^/]+)/);
            const oldProject = oldProjectMatch ? oldProjectMatch[1] : restoreConfig.projectId;
            const originalAuthConfig = { ...restoreConfig, projectId: oldProject };

            addLog(`        - Fetching details for original authorization: ${originalAuthName.split('/').pop()} from project: ${oldProject}`);
            const originalAuthDetails = await api.getAuthorization(originalAuthName, originalAuthConfig);
            
            const originalAuthId = originalAuthName.split('/').pop()!;
            const newAuthId = `${originalAuthId}-${Date.now()}`;
            addLog(`        - Proposing new authorization ID: ${newAuthId}`);
            
            // The prompt uses the *new* project ID
            const tempAuthForPrompt: Authorization = { name: `projects/${restoreConfig.projectId}/locations/global/authorizations/${newAuthId}`, serverSideOauth2: originalAuthDetails.serverSideOauth2 };
            const clientSecret = await promptForSecret(tempAuthForPrompt, `The original authorization ('${originalAuthId}') is in use. A new one named "${newAuthId}" will be created. Please provide the client secret to proceed.`);
            
            if (!clientSecret) {
                addLog(`        - SKIPPED: User did not provide a secret for the new authorization. Cannot restore agent.`);
                continue;
            }

            addLog(`        - Creating new authorization: ${newAuthId} in target project: ${restoreConfig.projectId}`);
            const newAuthPayload = { serverSideOauth2: { ...originalAuthDetails.serverSideOauth2, clientSecret } };
            // We intentionally pass `restoreConfig` to create it in the new project
            const newAuthorization = await api.createAuthorization(newAuthId, newAuthPayload, restoreConfig);
            addLog(`        - CREATED: New authorization created: ${newAuthorization.name}`);
            
            addLog(`        - Retrying agent creation with new authorization...`);
            createPayload.authorizationConfig = { toolAuthorizations: [newAuthorization.name] };
            delete createPayload.authorizations; // Ensure legacy field is removed if present
            const newAgent = await api.createAgent(createPayload, restoreConfig);
            const newAgentId = newAgent.name.split('/').pop()!;
            addLog(`      - CREATED: Agent '${agent.displayName}' created successfully with new ID '${newAgentId}' and new authorization.`);
            
            if ((agent as any).iamPolicy && (agent as any).iamPolicy.bindings) {
              const hasAgentUser = (agent as any).iamPolicy.bindings.some((b: any) => b.role === 'roles/discoveryengine.agentUser');
              
              if (hasAgentUser) {
                try {
                  addLog(`      - Fetching current IAM policy for new agent: ${newAgentId} to get etag...`);
                  const currentPolicy = await api.getAgentIamPolicy(newAgent.name, restoreConfig);
                
                addLog(`      - Restoring IAM policy bindings for new agent: ${newAgentId}...`);
                // Map agentOwner to agentEditor to bypass API restrictions
                const mappedBindings = (agent as any).iamPolicy.bindings.map((b: any) => {
                  if (b.role === 'roles/discoveryengine.agentOwner') {
                    return { ...b, role: 'roles/discoveryengine.agentEditor' };
                  }
                  return b;
                });

                const payloadPolicy = { 
                  bindings: mappedBindings,
                  etag: currentPolicy.etag
                };
                await api.setAgentIamPolicy(newAgent.name, payloadPolicy, restoreConfig);
                addLog(`      - IAM policy successfully restored for agent: ${newAgentId}`);
              } catch (iamErr: any) {
                addLog(`      - WARNING: Failed to apply IAM policy snapshot for agent ${newAgentId}: ${iamErr.message}`);
              }
              } else {
                addLog(`      - Skipping IAM policy restore as backup does not contain any agentUser bindings (likely a private agent).`);
              }
            }

          } catch (recoveryErr: any) {
            addLog(`      - ERROR: Failed during authorization recovery process: ${recoveryErr.message}. Skipping agent.`);
          }
        } else {
            addLog(`      - ERROR: Failed to create new agent for '${agent.displayName}': ${err.message}`);
        }
      }
      await delay(1000); // Rate limit
    }
  };


  
  const processRestoreAgents = async (backupData: any) => {
    const { agents } = backupData;
    if (!agents) {
        addLog("No agent data found in the backup.");
        return;
    }

    const restoreConfig = apiConfig;
    if (!restoreConfig.appId) {
        throw new Error("You must select a target Gemini Enterprise in the configuration before restoring agents.");
    }

    const filteredAgents = agents.filter((agent: any) => {
      let owner = "N/A";
      if (agent.iamPolicy && agent.iamPolicy.bindings) {
        const ownerBinding = agent.iamPolicy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
        if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
          owner = getOwnerFromBinding(ownerBinding.members[0]);
        }
      }
      
      return owner === userEmail;
    });

    const itemsWithTypes = filteredAgents.map((agent: any) => {
      let agentType = "Low Code";
      if (agent.adkAgentDefinition) agentType = "ADK";
      else if (agent.a2aAgentDefinition) agentType = "A2A";
      
      return { ...agent, agentType: agentType, disabled: false, disabledReason: undefined };
    });

    setModalData({
        section: 'Agents',
        title: 'Select Agents to Restore',
      items: itemsWithTypes,
        originalData: backupData,
        processor: async (data) => {
            await restoreAgentsIntoAssistant(data.agents, restoreConfig, backupData.sourceConfig);
        },
    });
  };



  const processRestoreNotebooks = async (backupData: any) => {
    if (!backupData.notebooks || backupData.notebooks.length === 0) {
      addLog("No notebooks found in backup file to restore.");
      return;
    }

    const displayableNotebooks = backupData.notebooks.map((notebook: any) => ({
      ...notebook,
      displayName: notebook.displayName || notebook.title || notebook.name?.split('/').pop() || 'Unnamed Notebook'
    }));

    setModalData({
      section: 'NotebookLM',
      title: 'Select Notebooks to Restore',
      items: displayableNotebooks,
      originalData: { ...backupData, notebooks: displayableNotebooks },
      processor: async (data) => {
        addLog(`Restoring ${data.notebooks.length} Notebooks...`);
        for (const notebook of data.notebooks) {
          addLog(`  - Restoring Notebook '${notebook.displayName}'...`);

          // Construct a clean payload
          const { name, displayName, createTime, updateTime, sources, ...rest } = notebook;
          const payload: any = { ...rest };

          if (notebook.displayName || notebook.title) {
            payload.title = notebook.displayName || notebook.title;
          }

          try {
            const newNotebook = await api.createNotebook(apiConfig, payload);
            const newNotebookId = newNotebook.name.split('/').pop()!;
            addLog(`    - CREATED: Notebook '${newNotebookId}'`);

            // Restore sources
            if (notebook.sources && notebook.sources.length > 0) {
              const sourceRequests = notebook.sources.filter(isRestorableSource).map(mapSourceToPayload);
              
              if (sourceRequests.length > 0) {
                addLog(`    - Restoring ${sourceRequests.length} supported sources for notebook '${newNotebookId}'...`);
                try {
                  await api.batchCreateNotebookSources(apiConfig, newNotebookId, sourceRequests);
                  addLog(`      - SUCCESS: Batch created ${sourceRequests.length} sources.`);
                } catch (srcErr: any) {
                  addLog(`      - ERROR: Failed to batch create sources for notebook '${newNotebookId}': ${srcErr.message}`);
                }
              } else {
                addLog(`    - No restorable sources found for notebook '${newNotebookId}' (skipping local files).`);
              }
            }
          } catch (err: any) {
            addLog(`    - ERROR: Failed to create notebook '${notebook.displayName}': ${err.message}`);
          }
          await delay(2000); // Rate limit between notebooks
        }
      }
    });
  };

  const promptForSecret = (auth: Authorization, customMessage?: string): Promise<string | null> => {
    return new Promise((resolve) => {
      setSecretPrompt({ auth, resolve, customMessage });
    });
  };





  const handleSecretSubmit = (secret: string) => {
    secretPrompt?.resolve(secret);
    setSecretPrompt(null);
  };

  const handleSecretClose = () => {
    secretPrompt?.resolve(null);
    setSecretPrompt(null);
  };
  


  const cardConfigs: Array<{
    section: string;
    title: string;
    scope: 'Global' | 'User Specific';
    backupHandler: () => Promise<void>;
    restoreProcessor: (data: any) => Promise<void>;
  }> = [
      { section: 'Agents', title: 'Agents', scope: 'Global', backupHandler: handleBackupAgents, restoreProcessor: processRestoreAgents },
      { section: 'NotebookLM', title: 'NotebookLMs', scope: 'User Specific', backupHandler: handleBackupNotebooks, restoreProcessor: processRestoreNotebooks },
  ];

  const selectedSourceApp = sourceApps.find(app => app.name.split('/').pop() === userTabConfig.sourceAppId);
  const allowedSourceDsIds = selectedSourceApp?.dataStoreIds || [];
  const filteredSourceDatastores = userTabConfig.sourceAppId
    ? sourceDatastores.filter(ds => allowedSourceDsIds.includes(ds.name.split('/').pop()))
    : [];

  const selectedTargetApp = targetApps.find(app => app.name.split('/').pop() === userTabConfig.targetAppId);
  const allowedTargetDsIds = selectedTargetApp?.dataStoreIds || [];
  const filteredTargetDatastores = userTabConfig.targetAppId
    ? targetDatastores.filter(ds => allowedTargetDsIds.includes(ds.name.split('/').pop()))
    : [];

  const collectionsInUse = new Set<string>();
  Object.keys(datastoreMapping).forEach(dsId => {
    if (dsId.includes('-federated_') || dsId.includes('-connector_')) {
      const colMatch = dsId.match(/^([^-]+-(?:federated|connector)_\d{13})/);
      if (colMatch) {
        collectionsInUse.add(colMatch[1]);
      }
    }
  });

  const filteredSourceCollections = collectionsInUse.size > 0
    ? sourceCollections.filter(col => collectionsInUse.has(col.name.split('/').pop()!))
    : sourceCollections;

  return (
    <div className="max-w-7xl mx-auto p-6 text-gray-900">
      {/* Modals */}
      {viewModalData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-lg max-w-5xl w-full max-h-[80vh] flex flex-col border border-gray-200">
            <div className="flex justify-between items-center p-6 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900 truncate">Viewing: {viewModalData.filename}</h2>
              <button onClick={() => setViewModalData(null)} className="text-gray-400 hover:text-gray-600 transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-grow bg-gray-50">
              {renderBackupContent(viewModalData.content)}
            </div>
            <div className="flex justify-end p-6 border-t border-gray-100 bg-white rounded-b-2xl">
              <button onClick={() => setViewModalData(null)} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold rounded-lg transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}
      {chatHistoryArchiveData && (
        <ChatHistoryArchiveViewer
          sessions={chatHistoryArchiveData.sessions}
          fileName={chatHistoryArchiveData.fileName}
          onClose={() => setChatHistoryArchiveData(null)}
          config={apiConfig}
        />
      )}
      {modalData && (
        <RestoreSelectionModal
          isOpen={!!modalData}
          onClose={() => setModalData(null)}
          onConfirm={(selectedItems) => handleConfirmRestore(modalData.section, selectedItems, modalData.processor, modalData.originalData)}
          title={modalData.title}
          items={modalData.items}
          isLoading={isLoading}
          showIdInput={false}
        />
      )}
      {secretPrompt && (
        <ClientSecretPrompt
          isOpen={!!secretPrompt}
          authId={secretPrompt.auth.name.split('/').pop() || ''}
          onSubmit={handleSecretSubmit}
          onClose={handleSecretClose}
          customMessage={secretPrompt.customMessage}
        />
      )}

      {isSelectionModalOpen && (
        <RestoreSelectionModal
          isOpen={isSelectionModalOpen}
          onClose={() => setIsSelectionModalOpen(false)}
          onConfirm={handleSelectionConfirm}
          title={selectionModalTitle}
          subtitle={selectionModalSubtitle}
          items={selectionModalItems}
          isLoading={isLoading}
          showIdInput={false}
          actionLabel={selectionModalAction === 'backup' ? 'Backup' : 'Restore'}
        />
      )}



      {isUserConfigModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-lg max-w-2xl w-full flex flex-col border border-gray-200 p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-bold text-gray-900">Configure User Tab</h2>
              <button onClick={() => { setIsUserConfigModalOpen(false); onCloseSettings?.(); }} className="text-gray-400 hover:text-gray-600 transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="space-y-6">
              {/* Source Config */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Source Environment (for Backup)</h3>
                <div className="grid grid-cols-3 gap-4 items-end">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Project ID</label>
                    <div className="flex gap-1">
                      <input type="text" value={userTabConfig.sourceProject} onChange={(e) => setUserTabConfig(prev => ({ ...prev, sourceProject: e.target.value }))} className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full" />
                      <button 
                        onClick={async () => {
                          setIsLoadingSourceApps(true);
                          const apps = await fetchAppsForProject(userTabConfig.sourceProject, userTabConfig.sourceLocation);
                          setSourceApps(apps);
                          setIsLoadingSourceApps(false);
                        }}
                        disabled={isLoadingSourceApps || !userTabConfig.sourceProject}
                        className="px-2 py-1 bg-gray-600 hover:bg-gray-700 text-white text-xs font-semibold rounded-lg disabled:bg-gray-300"
                      >
                        {isLoadingSourceApps ? '...' : 'Load'}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Location</label>
                    <select 
                      value={userTabConfig.sourceLocation} 
                      onChange={async (e) => {
                        const newLoc = e.target.value;
                        setUserTabConfig(prev => ({ ...prev, sourceLocation: newLoc }));
                        if (userTabConfig.sourceProject) {
                          setIsLoadingSourceApps(true);
                          const apps = await fetchAppsForProject(userTabConfig.sourceProject, newLoc);
                          setSourceApps(apps);
                          setIsLoadingSourceApps(false);
                        }
                      }} 
                      className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full"
                    >
                      <option value="global">global</option>
                      <option value="eu">eu</option>
                      <option value="us">us</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Engine ID</label>
                    {sourceApps.length > 0 ? (
                      <select 
                        value={userTabConfig.sourceAppId} 
                        onChange={(e) => setUserTabConfig(prev => ({ ...prev, sourceAppId: e.target.value }))} 
                        className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full"
                      >
                        <option value="">Select Engine ...</option>
                        {sourceApps.map(app => <option key={app.name} value={app.name.split('/').pop()}>{app.displayName || app.name.split('/').pop()}</option>)}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={userTabConfig.sourceAppId}
                        onChange={(e) => setUserTabConfig(prev => ({ ...prev, sourceAppId: e.target.value }))}
                        placeholder="Enter Engine ID..."
                        className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full"
                      />
                    )}
                  </div>
                </div>
              </div>

              {/* Target Config */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Target Environment (for Restore)</h3>
                <div className="grid grid-cols-3 gap-4 items-end">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Project ID</label>
                    <div className="flex gap-1">
                      <input type="text" value={userTabConfig.targetProject} onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetProject: e.target.value }))} className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full" />
                      <button 
                        onClick={async () => {
                          setIsLoadingTargetApps(true);
                          const apps = await fetchAppsForProject(userTabConfig.targetProject, userTabConfig.targetLocation);
                          setTargetApps(apps);
                          setIsLoadingTargetApps(false);
                        }}
                        disabled={isLoadingTargetApps || !userTabConfig.targetProject}
                        className="px-2 py-1 bg-gray-600 hover:bg-gray-700 text-white text-xs font-semibold rounded-lg disabled:bg-gray-300"
                      >
                        {isLoadingTargetApps ? '...' : 'Load'}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Location</label>
                    <select 
                      value={userTabConfig.targetLocation} 
                      onChange={async (e) => {
                        const newLoc = e.target.value;
                        setUserTabConfig(prev => ({ ...prev, targetLocation: newLoc }));
                        if (userTabConfig.targetProject) {
                          setIsLoadingTargetApps(true);
                          const apps = await fetchAppsForProject(userTabConfig.targetProject, newLoc);
                          setTargetApps(apps);
                          setIsLoadingTargetApps(false);
                        }
                      }} 
                      className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full"
                    >
                      <option value="global">global</option>
                      <option value="eu">eu</option>
                      <option value="us">us</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Engine ID</label>
                    {targetApps.length > 0 ? (
                      <select 
                        value={userTabConfig.targetAppId} 
                        onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetAppId: e.target.value }))} 
                        className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full"
                      >
                        <option value="">Select Engine ...</option>
                        {targetApps.map(app => <option key={app.name} value={app.name.split('/').pop()}>{app.displayName || app.name.split('/').pop()}</option>)}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={userTabConfig.targetAppId}
                        onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetAppId: e.target.value }))}
                        placeholder="Enter Engine ID..."
                        className="bg-gray-50 border border-gray-300 rounded-lg p-2 text-sm w-full"
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end mt-6">
              <button onClick={() => { 
                setIsUserConfigModalOpen(false); 
                onCloseSettings?.(); 
                const newProject = userTabConfig.sourceProject || userTabConfig.targetProject;
                if (newProject) {
                  setProjectNumber(newProject);
                }
              }} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors">Save & Close</button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-6 border-b border-gray-200">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          <button
            onClick={() => setActiveTab('user')}
            className={`${
              activeTab === 'user'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm font-semibold transition-colors`}
          >
            User View
          </button>
          {isAdminModeEnabled && (
            <button
              onClick={() => setActiveTab('admin')}
              className={`${
                activeTab === 'admin'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm font-semibold transition-colors`}
            >
              Admin View
            </button>
          )}
        </nav>
      </div>

      {activeTab === 'user' && (
        <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-200 dark:border-slate-700 relative">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">My Backups</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Manage backups and restores for your personal agents and notebooks.</p>
          
          {isAdminModeEnabled && (
            <div className={`mb-6 p-4 rounded-lg border ${userIdStatus.status === 'pass' ? 'bg-green-50 border-green-200' : userIdStatus.status === 'fail' ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">Permission Check:</span>
                  {userIdStatus.status === 'pass' ? (
                    <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-green-100 text-green-700">PASS</span>
                  ) : userIdStatus.status === 'fail' ? (
                    <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-red-100 text-red-700">FAIL</span>
                  ) : !userTabConfig.sourceProject ? (
                    <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-yellow-100 text-yellow-700">ENTER A PROJECT</span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-gray-100 text-gray-700">PENDING</span>
                  )}
                </div>
                {userIdStatus.status === 'fail' && (
                  <button onClick={() => setIsIdCheckExpanded(!isIdCheckExpanded)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                    {isIdCheckExpanded ? 'Hide Details' : 'Show Details'}
                  </button>
                )}
              </div>
              <div className="mt-2 text-xs text-gray-600">
                {userIdStatus.details}
              </div>
            </div>
          )}

          {isAdminModeEnabled && (
            <div className="flex items-center gap-2 mb-4">
              <input 
                type="checkbox" 
                id="debugMode" 
                checked={isDebugMode} 
                onChange={(e) => setIsDebugMode(e.target.checked)}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <label htmlFor="debugMode" className="text-sm text-gray-700 dark:text-white font-medium cursor-pointer">
                Enable Verbose Debug Logging
              </label>
            </div>
          )}

          {/* Step 1: Connector Authentication */}
          <div className="mb-6 p-4 rounded-lg border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-2">Step 1: Authenticate Connectors</h3>
            <div className="mb-3">
              <p className="text-xs text-gray-600 dark:text-slate-300 mb-3">
                Log into the target Gemini Enterprise app and ensure all required federated connectors (SharePoint, OneDrive, Outlook, etc.) are authenticated.
              </p>
              {userTabConfig.targetProject && (
                <a 
                  href={userTabConfig.targetAppUrl || "https://vertexaisearch.cloud.google.com/"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-md flex items-center justify-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  <span>Open Gemini Enterprise</span>
                </a>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input 
                type="checkbox" 
                id="step1Auth" 
                checked={isStep1Complete} 
                onChange={(e) => setIsStep1Complete(e.target.checked)}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <label htmlFor="step1Auth" className="text-sm text-gray-700 dark:text-white font-medium cursor-pointer">
                I have authenticated all required connectors in the target environment.
              </label>
            </div>
          </div>

          {/* Step 2: Backup & Restore */}
          <div className={`mb-6 p-4 rounded-lg border ${isStep1Complete ? 'border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700' : 'border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 opacity-50'}`}>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-2">Step 2: Backup or Restore</h3>
            
            <div className="flex flex-col items-center justify-center py-4 space-y-6">
              {import.meta.env.VITE_SINGLE_CLICK_MIGRATION !== 'true' && (
                <div className="w-full max-w-md mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Upload Backup File for Restore</label>
                  <input 
                    type="file" 
                    accept=".json"
                    disabled={!isStep1Complete}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                          setRestoreFileContent(e.target?.result as string);
                          addLog(`File selected: ${file.name}`);
                        };
                        reader.readAsText(file);
                      }
                    }}
                    className="block w-full text-sm text-gray-500 dark:text-white file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:file:bg-gray-100 disabled:file:text-gray-400"
                  />
                </div>
              )}

              {import.meta.env.VITE_SINGLE_CLICK_MIGRATION === 'true' ? (
                <div className="flex flex-col gap-4">
                  <div className="flex gap-6">
                    <button
                      onClick={handleSingleClickMigration}
                      disabled={isLoading || !userTabConfig.sourceProject || !isStep1Complete}
                      className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-xl shadow-md transition-colors disabled:bg-gray-300 flex items-center gap-2"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                      </svg>
                      Migrate My Data
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-6">
                  <button
                    onClick={handleUserBackupCombined}
                    disabled={isLoading || !userTabConfig.sourceProject || !isStep1Complete}
                    className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-md transition-colors disabled:bg-gray-300 flex items-center gap-2"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Backup My Data
                  </button>
                  
                  <button
                    onClick={handleUserRestoreCombined}
                    disabled={isLoading || !restoreFileContent || !userTabConfig.targetProject || !isStep1Complete}
                    className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl shadow-md transition-colors disabled:bg-gray-300 flex items-center gap-2"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Restore My Data
                  </button>
                </div>
              )}
              
              <div className="text-xs text-gray-500 dark:text-white text-center max-w-md">
                This will backup or restore all agents and notebooks owned by you in the current target project and location.
              </div>
            </div>
          </div>

          {/* Step 3: Finalization */}
          <div className={`mb-6 p-4 rounded-lg border ${isRestoreComplete ? 'border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700' : 'border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 opacity-50'}`}>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-2">Step 3: Complete Setup</h3>
            
            {!isRestoreComplete ? (
              <p className="text-xs text-gray-600">
                After restore completes, manual steps required to finalize your agents will appear here.
              </p>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-gray-600 dark:text-white mb-3">
                  Please complete the following manual steps to finalize your restoration.
                </p>
                
                <div className="space-y-4">
                  {manualActionReport.map((item, idx) => (
                    <div key={idx} className="bg-gray-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm space-y-3">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                        {item.agentName ? (
                          <><span className="text-blue-500">🤖</span> {item.agentName}</>
                        ) : (
                          <><span className="text-green-500">📓</span> {item.notebookTitle}</>
                        )}
                      </h3>
                      
                      {item.agentName ? (
                        <>
                          <div className="text-xs text-gray-600">
                            <p className="font-medium text-yellow-700 bg-yellow-50 p-2 rounded-lg border border-yellow-100">
                              ℹ️ All restored agents are in draft and will need to be created/published.
                            </p>
                          </div>

                          {item.sharedWith && item.sharedWith.length > 0 ? (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                                <span className="text-purple-500">👥</span> Reshare with:
                              </h4>
                              <div className="flex flex-wrap gap-1">
                                {item.sharedWith.map((user, uidx) => (
                                  <span key={uidx} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px] font-medium">
                                    {user}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="text-xs text-gray-500 flex items-center gap-1">
                              <span className="text-purple-300">👥</span> No sharing permissions found in backup.
                            </div>
                          )}

                          {item.knowledgeAttachments && item.knowledgeAttachments.length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                                <span className="text-blue-500">📚</span> Knowledge Attachments:
                              </h4>
                              <ul className="space-y-1 text-xs text-gray-600">
                                {item.knowledgeAttachments.map((dsId, dsIdx) => (
                                  <li key={dsIdx} className="font-mono text-gray-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 inline-block mr-1 mb-1">
                                    {dsId}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {item.agentFiles && item.agentFiles.length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                                <span className="text-blue-500">📄</span> Knowledge Files:
                              </h4>
                              <ul className="space-y-1 text-xs text-gray-600">
                                {item.agentFiles.map((fileName, fIdx) => (
                                  <li key={fIdx} className="text-gray-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 inline-block mr-1 mb-1">
                                    {fileName}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {item.unmappedDatastores && item.unmappedDatastores.length > 0 ? (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                                <span className="text-red-500">📦</span> Unmapped Datastores (Action Required):
                              </h4>
                              <ul className="space-y-1 text-xs text-gray-600">
                                {item.unmappedDatastores.map((dsId, dsIdx) => (
                                  <li key={dsIdx} className="font-mono text-gray-500 bg-red-50 px-1.5 py-0.5 rounded border border-red-100 inline-block mr-1 mb-1">
                                    {dsId}
                                  </li>
                                ))}
                              </ul>
                              <p className="text-[10px] text-red-500 mt-1">
                                These datastores were not able to be remapped to new datastores and will need to be reviewed and manually re-added.
                              </p>
                            </div>
                          ) : (
                            <div className="text-xs text-gray-500 flex items-center gap-1">
                              <span className="text-green-500">📦</span> All datastores successfully mapped or none attached.
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="text-xs text-gray-600 dark:text-white">
                            <p className="font-medium text-blue-700 dark:text-white bg-blue-50 dark:bg-blue-900 p-2 rounded-lg border border-blue-100 dark:border-blue-800">
                              ℹ️ Notebook restored. Please check sources and sharing.
                            </p>
                          </div>

                          {item.sharedWith && item.sharedWith.length > 0 ? (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                                <span className="text-purple-500">👥</span> Reshare with:
                              </h4>
                              <div className="flex flex-wrap gap-1">
                                {item.sharedWith.map((user, uidx) => (
                                  <span key={uidx} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px] font-medium">
                                    {user}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-700 dark:text-white mb-1 flex items-center gap-1">
                                <span className="text-purple-500">👥</span> Sharing:
                              </h4>
                              <p className="text-xs text-gray-600 dark:text-white">
                                We are unable to retrieve shared users from source. Please manually document and reshare your notebooks if needed.
                              </p>
                            </div>
                          )}

                          {item.localFiles && item.localFiles.length > 0 ? (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-700 dark:text-white mb-1 flex items-center gap-1">
                                <span className="text-yellow-500">📁</span> Local Files (Action Required):
                              </h4>
                              <p className="text-xs text-gray-600 dark:text-white mb-1">
                                The following local files were attached to the original notebook and need to be re-added manually:
                              </p>
                              <ul className="space-y-1 text-xs text-gray-600 dark:text-white">
                                {item.localFiles.map((file, fIdx) => (
                                  <li key={fIdx} className="text-gray-700 dark:text-white bg-yellow-50 dark:bg-slate-900 px-1.5 py-0.5 rounded border border-yellow-100 dark:border-slate-700 inline-block mr-1 mb-1">
                                    {file}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <div className="text-xs text-gray-500 flex items-center gap-1">
                              <span className="text-yellow-300">📁</span> No local files detected or all sources are external.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}

                  {manualActionReport.length === 0 && (
                    <div className="text-center py-4 text-gray-500 text-sm">
                      No manual steps required! All items were successfully restored.
                    </div>
                  )}
                </div>
                
                <div className="mt-4">
                  <button
                    onClick={downloadStepsAsText}
                    className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Steps
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'admin' && (
        <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-200 dark:border-slate-700 relative">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Admin Configuration</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Configure source and target environments and map datastores.</p>
          
          <div className="flex justify-end gap-2 mb-4">
            <button
              onClick={exportAdminConfig}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm flex items-center gap-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export Config
            </button>
            <label className="px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-700 text-xs font-semibold rounded-lg border border-gray-300 transition-colors shadow-sm cursor-pointer flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Import Config
              <input type="file" accept=".json" onChange={importAdminConfig} className="hidden" />
            </label>
          </div>
          <div className="space-y-6">
            {/* Source Config */}
            <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Source Environment</h3>
              <div className="grid grid-cols-4 gap-4 items-end">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Project ID</label>
                  <div className="flex gap-1">
                    <input type="text" value={userTabConfig.sourceProject} onChange={(e) => setUserTabConfig(prev => ({ ...prev, sourceProject: e.target.value }))} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                    <button 
                      onClick={async () => {
                        setIsLoadingSourceApps(true);
                        const apps = await fetchAppsForProject(userTabConfig.sourceProject, userTabConfig.sourceLocation);
                        setSourceApps(apps);
                        setIsLoadingSourceApps(false);
                      }}
                      disabled={isLoadingSourceApps || !userTabConfig.sourceProject}
                      className="px-2 py-1 bg-gray-600 hover:bg-gray-700 text-white text-xs font-semibold rounded-lg disabled:bg-gray-300 shadow-sm"
                    >
                      {isLoadingSourceApps ? '...' : 'Load'}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Location</label>
                  <select 
                    value={userTabConfig.sourceLocation} 
                    onChange={async (e) => {
                      const newLocation = e.target.value;
                      setUserTabConfig(prev => ({ ...prev, sourceLocation: newLocation }));
                      if (userTabConfig.sourceProject) {
                        setIsLoadingSourceApps(true);
                        const apps = await fetchAppsForProject(userTabConfig.sourceProject, newLocation);
                        setSourceApps(apps);
                        setIsLoadingSourceApps(false);
                      }
                    }}
                    className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                  >
                    <option value="global">global</option>
                    <option value="eu">eu</option>
                    <option value="us">us</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">App ID</label>
                  {sourceApps.length > 0 ? (
                    <select 
                      value={userTabConfig.sourceAppId} 
                      onChange={(e) => setUserTabConfig(prev => ({ ...prev, sourceAppId: e.target.value }))} 
                      className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                    >
                      <option value="">Select App ...</option>
                      {sourceApps.map(app => <option key={app.name} value={app.name.split('/').pop()}>{app.displayName || app.name.split('/').pop()}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={userTabConfig.sourceAppId} onChange={(e) => setUserTabConfig(prev => ({ ...prev, sourceAppId: e.target.value }))} className="bg-white border border-gray-300 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500" placeholder="Enter App ID..." />
                  )}
                </div>
                <div>
                  <button
                    onClick={async () => {
                      setIsLoadingSourceDatastores(true);
                      
                      if (userTabConfig.sourceAppId && !sourceApps.some(app => app.name.split('/').pop() === userTabConfig.sourceAppId)) {
                        try {
                          addLog(`Fetching details for app ${userTabConfig.sourceAppId}...`);
                          const app = await api.getEngine(userTabConfig.sourceAppId, { 
                            ...apiConfig, 
                            projectId: userTabConfig.sourceProject, 
                            appLocation: userTabConfig.sourceLocation,
                            collectionId: 'default_collection'
                          });
                          setSourceApps(prev => [...prev, app]);
                          addLog(`App details fetched.`);
                        } catch (e: any) {
                          addLog(`Failed to fetch details for app ${userTabConfig.sourceAppId}: ${e.message}`);
                        }
                      }

                      const { datastores, collections } = await fetchDataAssets(userTabConfig.sourceProject, userTabConfig.sourceLocation);
                      setSourceDatastores(datastores);
                      setSourceCollections(collections);
                      setIsLoadingSourceDatastores(false);
                    }}
                    disabled={isLoadingSourceDatastores || !userTabConfig.sourceProject}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed shadow-sm"
                  >
                    {isLoadingSourceDatastores ? 'Loading...' : 'Fetch Source Assets'}
                  </button>
                </div>
              </div>
              {sourceDatastores.length > 0 && (
                <div className="mt-3 text-xs text-gray-600 dark:text-white">
                  Found {sourceDatastores.length} datastores in source.
                </div>
              )}
            </div>

            {/* Target Config */}
            <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Target Environment</h3>
              <div className="grid grid-cols-4 gap-4 items-end">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Project ID</label>
                  <div className="flex gap-1">
                    <input type="text" value={userTabConfig.targetProject} onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetProject: e.target.value }))} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                    <button 
                      onClick={async () => {
                        setIsLoadingTargetApps(true);
                        const apps = await fetchAppsForProject(userTabConfig.targetProject, userTabConfig.targetLocation);
                        setTargetApps(apps);
                        setIsLoadingTargetApps(false);
                      }}
                      disabled={isLoadingTargetApps || !userTabConfig.targetProject}
                      className="px-2 py-1 bg-gray-600 hover:bg-gray-700 text-white text-xs font-semibold rounded-lg disabled:bg-gray-300 shadow-sm"
                    >
                      {isLoadingTargetApps ? '...' : 'Load'}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Location</label>
                  <select 
                    value={userTabConfig.targetLocation} 
                    onChange={async (e) => {
                      const newLocation = e.target.value;
                      setUserTabConfig(prev => ({ ...prev, targetLocation: newLocation }));
                      if (userTabConfig.targetProject) {
                        setIsLoadingTargetApps(true);
                        const apps = await fetchAppsForProject(userTabConfig.targetProject, newLocation);
                        setTargetApps(apps);
                        setIsLoadingTargetApps(false);
                      }
                    }}
                    className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                  >
                    <option value="global">global</option>
                    <option value="eu">eu</option>
                    <option value="us">us</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">App ID</label>
                  {targetApps.length > 0 ? (
                    <select 
                      value={userTabConfig.targetAppId} 
                      onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetAppId: e.target.value }))} 
                      className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                    >
                      <option value="">Select App ...</option>
                      {targetApps.map(app => <option key={app.name} value={app.name.split('/').pop()}>{app.displayName || app.name.split('/').pop()}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={userTabConfig.targetAppId} onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetAppId: e.target.value }))} className="bg-white border border-gray-300 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500" placeholder="Enter App ID..." />
                  )}
                </div>
                <div>
                  <button
                    onClick={async () => {
                      setIsLoadingTargetDatastores(true);
                      
                      if (userTabConfig.targetAppId && !targetApps.some(app => app.name.split('/').pop() === userTabConfig.targetAppId)) {
                        try {
                          addLog(`Fetching details for app ${userTabConfig.targetAppId}...`);
                          const app = await api.getEngine(userTabConfig.targetAppId, { 
                            ...apiConfig, 
                            projectId: userTabConfig.targetProject, 
                            appLocation: userTabConfig.targetLocation,
                            collectionId: 'default_collection'
                          });
                          setTargetApps(prev => [...prev, app]);
                          addLog(`App details fetched.`);
                        } catch (e: any) {
                          addLog(`Failed to fetch details for app ${userTabConfig.targetAppId}: ${e.message}`);
                        }
                      }

                      const { datastores, collections } = await fetchDataAssets(userTabConfig.targetProject, userTabConfig.targetLocation);
                      setTargetDatastores(datastores);
                      setTargetCollections(collections);
                      setIsLoadingTargetDatastores(false);
                    }}
                    disabled={isLoadingTargetDatastores || !userTabConfig.targetProject}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed shadow-sm"
                  >
                    {isLoadingTargetDatastores ? 'Loading...' : 'Fetch Target Assets'}
                  </button>
                </div>
              </div>
              <div className="mt-3">
                <label className="block text-xs text-gray-500 dark:text-white mb-1">Target GE App URL (Optional - for direct link in Step 1)</label>
                <input 
                  type="text" 
                  value={userTabConfig.targetAppUrl} 
                  onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetAppUrl: e.target.value }))} 
                  className="bg-white border border-gray-300 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500" 
                  placeholder="Enter full URL (e.g., https://vertexaisearch.cloud.google.com/home/cid/...)" 
                />
              </div>
              {targetDatastores.length > 0 && (
                <div className="mt-3 text-xs text-gray-600 dark:text-white">
                  Found {targetDatastores.length} datastores in target.
                </div>
              )}
            </div>

            {/* Collection Mapping */}
            {filteredSourceCollections.length > 0 && (
              <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600 mb-6">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Collection Mapping (for Connectors)</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left text-gray-700 dark:text-slate-300">
                    <thead className="text-xs text-gray-500 dark:text-slate-400 uppercase bg-gray-100 dark:bg-slate-800">
                      <tr>
                        <th className="px-4 py-2">Source Collection</th>
                        <th className="px-4 py-2">Target Collection</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSourceCollections.map((srcCol) => {
                        const srcId = srcCol.name.split('/').pop()!;
                        return (
                          <tr key={srcCol.name} className="border-b border-gray-100 dark:border-slate-600">
                            <td className="px-4 py-2 font-mono text-xs dark:text-slate-200">
                              {srcCol.displayName || srcId} ({srcId})
                            </td>
                            <td className="px-4 py-2">
                              <select
                                value={collectionMapping[srcId] || ''}
                                onChange={(e) => setCollectionMapping(prev => ({ ...prev, [srcId]: e.target.value }))}
                                className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-1 text-xs w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                              >
                                <option value="">Select Target Collection...</option>
                                {targetCollections.map((tgtCol) => {
                                  const tgtId = tgtCol.name.split('/').pop()!;
                                  return (
                                    <option key={tgtCol.name} value={tgtId}>
                                      {tgtCol.displayName || tgtId} ({tgtId})
                                    </option>
                                  );
                                })}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Datastore Mapping */}
            {userTabConfig.sourceAppId && filteredSourceDatastores.length === 0 && (
              <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600 text-sm text-gray-500 dark:text-slate-400 text-center mb-4">
                No datastores attached to the selected source app.
              </div>
            )}
            {filteredSourceDatastores.length > 0 && (
              <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Datastore Mapping</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left text-gray-700 dark:text-slate-300">
                    <thead className="text-xs text-gray-500 dark:text-slate-400 uppercase bg-gray-100 dark:bg-slate-800">
                      <tr>
                        <th className="px-4 py-2">Source Datastore (Old)</th>
                        <th className="px-4 py-2">Target Datastore (New)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSourceDatastores.map((srcDs) => {
                        const srcId = srcDs.name.split('/').pop()!;
                        return (
                          <tr key={srcDs.name} className="border-b border-gray-100 dark:border-slate-600">
                            <td className="px-4 py-2 font-mono text-xs dark:text-slate-200">
                              {srcDs.displayName || srcId} ({srcId})
                            </td>
                            <td className="px-4 py-2">
                              <select
                                value={datastoreMapping[srcId] || ''}
                                onChange={(e) => setDatastoreMapping(prev => ({ ...prev, [srcId]: e.target.value }))}
                                className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-1 text-xs w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                              >
                                <option value="">Select Target Datastore...</option>
                                {filteredTargetDatastores.map((tgtDs) => {
                                  const tgtId = tgtDs.name.split('/').pop()!;
                                  return (
                                    <option key={tgtDs.name} value={tgtId}>
                                      {tgtDs.displayName || tgtId} ({tgtId})
                                    </option>
                                  );
                                })}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

        {/* Logs Section */}
        {isAdminModeEnabled && (isLoading || logs.length > 0) && (
          <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-200 dark:border-slate-700 mt-6">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center">
              {isLoading && <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-blue-600 mr-3"></div>}
              {isLoading ? `Running: ${loadingSection?.replace(/[A-Z]/g, ' $&').trim()}` : 'Operation Logs'}
            </h2>
            {error && <div className="text-sm text-red-600 p-3 mb-3 bg-red-50 border border-red-200 rounded-lg">{error}</div>}
            <pre className="bg-gray-50 dark:bg-slate-900 text-xs text-gray-700 dark:text-slate-300 p-4 rounded-lg h-64 overflow-y-auto font-mono border border-gray-200 dark:border-slate-700">
              {logs.join('\n')}
            </pre>
          </div>
        )}
    </div>
  );
};

export default BackupPage;
