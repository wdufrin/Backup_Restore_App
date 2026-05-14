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
import ChatHistoryArchiveViewer from './components/backup/ChatHistoryArchiveViewer';
import ClientSecretPrompt from './components/backup/ClientSecretPrompt';
import CurlInfoModal from './components/CurlInfoModal';


interface BackupPageProps {
  accessToken: string;
  projectNumber: string;
  setProjectNumber: (projectNumber: string) => void;
  userEmail: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));




;




// --- Main Page Component ---

const BackupPage: React.FC<BackupPageProps> = ({ accessToken: _, projectNumber, setProjectNumber, userEmail }) => {
  const [config, setConfig] = useState({
    appLocation: 'global',
    appId: '',
    reasoningEngineLocation: 'us-central1',
    reasoningEngineId: '', // Added Agent Engine selection
    collectionId: 'default_collection',
    assistantId: 'default_assistant',
  });
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
                        owner = ownerBinding.members[0].replace('user:', '').replace('serviceAccount:', '');
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


  const uploadBackupToGcs = async (data: object, filenamePrefix: string) => {
      if (!selectedBucket) {
          throw new Error("No GCS bucket selected for backup.");
      }
      const jsonString = JSON.stringify(data, null, 2);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${filenamePrefix}__${timestamp}.json`;
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
    
    const backupData = { type: 'Agents', createdAt: new Date().toISOString(), sourceConfig: apiConfig, agents };
    await uploadBackupToGcs(backupData, `agentspace-agents__${apiConfig.appId || 'N/A'}__${apiConfig.appLocation}`);
    addLog(`Backup complete! Found ${agents.length} agents.`);
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

    const backupData = { type: 'NotebookLM', createdAt: new Date().toISOString(), sourceConfig: apiConfig, notebooks: fullNotebooks };
    await uploadBackupToGcs(backupData, `agentspace-notebooks__${apiConfig.appId || 'N/A'}__${apiConfig.appLocation}`);
    addLog(`Backup complete! Found ${fullNotebooks.length} fully resolved NotebookLMs.`);
  });




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

  const restoreAgentsIntoAssistant = async (agents: Agent[], restoreConfig: typeof apiConfig) => {
    addLog(`  - Restoring ${agents.length} agent(s)...`);
    for (const agent of agents) {
      const originalAgentId = agent.name.split('/').pop()!;
      addLog(`    - Preparing to restore agent: ${agent.displayName} (from original ID: ${originalAgentId}) as a new agent.`);

      const buildPayload = (currentAgent: Agent): any => {
        const finalStarterPrompts = (currentAgent.starterPrompts || [])
          .map(p => p.text ? p.text.trim() : '')
          .filter(text => text)
          .map(text => ({ text }));

        // Base payload
        const payload: any = {
          displayName: currentAgent.displayName,
          description: currentAgent.description || '',
          icon: currentAgent.icon || undefined,
          starterPrompts: finalStarterPrompts.length > 0 ? finalStarterPrompts : undefined,
          authorizationConfig: currentAgent.authorizationConfig,
          authorizations: !currentAgent.authorizationConfig ? currentAgent.authorizations : undefined,
        };

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

        // Dynamically copy ANY definition property from the currentAgent
        const definitionKeys = Object.keys(currentAgent).filter(key => key.toLowerCase().includes('agentdefinition'));
        for (const key of definitionKeys) {
          if (key === 'adkAgentDefinition') {
            const adkDef = currentAgent.adkAgentDefinition;
            let reasoningEngineStr = adkDef?.provisionedReasoningEngine?.reasoningEngine;

            if (reasoningEngineStr) {
              const parts = reasoningEngineStr.split('/');
              if (parts.length >= 6) {
                const oldReId = parts.pop()!;
                parts.pop(); // reasoningEngines
                const oldReLoc = parts.pop()!;
                parts.pop(); // locations
                parts.pop(); // consume project ID
                parts.pop(); // projects
                // Rebuild with new project and new location
                reasoningEngineStr = `projects/${restoreConfig.projectId}/locations/${restoreConfig.appLocation || oldReLoc}/reasoningEngines/${oldReId}`;
              }
            }

            payload.adkAgentDefinition = {
              toolSettings: { toolDescription: adkDef?.toolSettings?.toolDescription },
              provisionedReasoningEngine: { reasoningEngine: reasoningEngineStr }
            };
          } else {
            // For any other agent definition (a2aAgentDefinition, managedAgentDefinition, dialogflowAgentDefinition, generativeAgentDefinition, etc.)
            // We just pass it along directly in camelCase as the Google Cloud API accepts both cases.
            payload[key] = (currentAgent as any)[key];
          }
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
          owner = ownerBinding.members[0].replace('user:', '').replace('serviceAccount:', '');
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
            await restoreAgentsIntoAssistant(data.agents, restoreConfig);
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
              addLog(`    - Restoring ${notebook.sources.length} sources for notebook '${newNotebookId}'...`);
              const sourceRequests = notebook.sources.map((source: any) => {
                // Determine source type from metadata or other hints
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
              });

              try {
                await api.batchCreateNotebookSources(apiConfig, newNotebookId, sourceRequests);
                addLog(`      - SUCCESS: Batch created ${sourceRequests.length} sources.`);
              } catch (srcErr: any) {
                addLog(`      - ERROR: Failed to batch create sources for notebook '${newNotebookId}': ${srcErr.message}`);
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto p-6 text-gray-900">
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
      {infoModalKey && (
        <CurlInfoModal infoKey={infoModalKey} onClose={() => setInfoModalKey(null)} />
      )}

      {/* Left Pane - Configuration */}
      <div className="lg:col-span-4 space-y-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold text-gray-900 tracking-tight">Target Application Configuration</h2>
          </div>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Project ID / Number</label>
              <div className="flex gap-2">
                <ProjectInput value={projectNumber} onChange={handleProjectNumberChange} />

              </div>
            </div>
            
            <div>
              <label htmlFor="appLocation" className="block text-sm font-medium text-gray-700 mb-1">Target Location (Discovery)</label>
              <div className="relative">
                <select name="appLocation" value={config.appLocation} onChange={handleConfigChange} className="bg-gray-50 border border-gray-300 rounded-lg pl-3 pr-10 py-2.5 text-sm text-gray-900 focus:ring-blue-500 focus:border-blue-500 w-full transition-all appearance-none">
                  <option value="global">global</option>
                  <option value="us">us</option>
                  <option value="eu">eu</option>
                </select>
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
            
            <div>
              <label htmlFor="appId" className="block text-sm font-medium text-gray-700 mb-1">Target Gemini Enterprise ID</label>
              <div className="relative flex items-center gap-2">
                <div className="relative flex-grow">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <select name="appId" value={config.appId} onChange={handleConfigChange} disabled={isLoadingApps || apps.length === 0} className="bg-gray-50 border border-gray-300 rounded-lg pl-10 pr-10 py-2.5 text-sm text-gray-900 focus:ring-blue-500 focus:border-blue-500 w-full disabled:bg-gray-100 disabled:text-gray-400 transition-all appearance-none">
                    <option value="">{isLoadingApps ? 'Loading...' : 'Select App...'}</option>
                    {apps.map(a => {
                        const id = a.name.split('/').pop() || '';
                        return <option key={a.name} value={id}>{a.displayName || id}</option>
                    })}
                  </select>
                  <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                <button className="p-2.5 bg-gray-50 border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-500 flex-shrink-0">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </button>
              </div>
            </div>
            
            <div>
              <label htmlFor="reasoningEngineLocation" className="block text-sm font-medium text-gray-700 mb-1">Agent Engine Location</label>
              <div className="relative">
                <select name="reasoningEngineLocation" value={config.reasoningEngineLocation} onChange={handleConfigChange} className="bg-gray-50 border border-gray-300 rounded-lg pl-3 pr-10 py-2.5 text-sm text-gray-900 focus:ring-blue-500 focus:border-blue-500 w-full transition-all appearance-none">
                    <option value="us-central1">us-central1</option>
                    <option value="europe-west1">europe-west1</option>
                    <option value="asia-east1">asia-east1</option>
                </select>
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
            
            <div>
              <label htmlFor="reasoningEngineId" className="block text-sm font-medium text-gray-700 mb-1">Target Agent Engine</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <select name="reasoningEngineId" value={config.reasoningEngineId} onChange={handleConfigChange} disabled={isLoadingReasoningEngines || reasoningEngines.length === 0} className="bg-gray-50 border border-gray-300 rounded-lg pl-10 pr-10 py-2.5 text-sm text-gray-900 focus:ring-blue-500 focus:border-blue-500 w-full disabled:bg-gray-100 disabled:text-gray-400 transition-all appearance-none">
                  <option value="">{isLoadingReasoningEngines ? 'Loading...' : 'Select Engine ...'}</option>
                  {reasoningEngines.map(re => {
                      const id = re.name.split('/').pop() || '';
                      return <option key={re.name} value={id}>{re.displayName} ({id})</option>
                  })}
                </select>
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Backup Bucket (GCS)</label>
              <div className="relative">
                <select 
                    value={selectedBucket} 
                    onChange={(e) => setSelectedBucket(e.target.value)} 
                    className="bg-gray-50 border border-gray-300 rounded-lg pl-3 pr-10 py-2.5 text-sm text-gray-900 focus:ring-blue-500 focus:border-blue-500 w-full transition-all appearance-none"
                >
                    <option value="">Select Bucket ...</option>
                    {buckets.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
                </select>
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Pane - Actions */}
      <div className="lg:col-span-8 space-y-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-gray-900 tracking-tight">Backup & Restore Actions</h2>
          </div>
          
          <div className="bg-blue-50 text-blue-700 p-3 rounded-lg text-sm mb-6 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <span>All backups are stored in a secure Google Cloud Storage bucket.</span>
          </div>



          {/* Resource List / Table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden mb-6">
            <table className="w-full text-sm text-left text-gray-700">
              <thead className="text-xs text-gray-500 uppercase bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 font-medium">Resource Name</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Location</th>
                  <th className="px-4 py-3 font-medium">Last Backup</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {cardConfigs.map(card => {
                  const availableBackups = backupFiles[card.section] || [];
                  const lastBackup = availableBackups[0]?.filename || 'Never';
                  return (
                    <tr key={card.section} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {card.title}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{card.section}</td>
                      <td className="px-4 py-3 text-gray-500">{card.scope}</td>
                      <td className="px-4 py-3 text-gray-500">{lastBackup}</td>
                      <td className="px-4 py-3 text-right flex items-center justify-end gap-2">
                        <button 
                          onClick={card.backupHandler}
                          disabled={isLoading || !selectedBucket}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors disabled:bg-gray-300"
                        >
                          Backup
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Detailed Action Sections */}
          <div className="space-y-6">
            {cardConfigs.map(card => {
                const isBackupLoading = loadingSection === `Backup${card.section}`;
                const availableBackups = backupFiles[card.section] || [];


                return (
                  <div key={card.section} className="border-t border-gray-200 pt-4">
                    <h3 className="text-base font-semibold text-gray-900 mb-3">{card.title}</h3>
                    <div className="border border-gray-200 rounded-lg overflow-x-auto">
                      <table className="w-full text-sm text-left text-gray-700 table-fixed">
                        <thead className="text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th 
                              className="px-4 py-2 font-medium relative group"
                              style={{ width: `${fileNameWidth}px` }}
                            >
                              File name
                              <div
                                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize bg-gray-300 opacity-0 group-hover:opacity-100 hover:bg-blue-500 transition-all"
                                onMouseDown={(e) => handleResizeMouseDown(e, 'fileName')}
                              />
                            </th>
                            <th 
                              className="px-4 py-2 font-medium relative group"
                              style={{ width: `${sourceAppWidth}px` }}
                            >
                              Source App
                              <div
                                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize bg-gray-300 opacity-0 group-hover:opacity-100 hover:bg-blue-500 transition-all"
                                onMouseDown={(e) => handleResizeMouseDown(e, 'sourceApp')}
                              />
                            </th>
                            <th 
                              className="px-4 py-2 font-medium relative group"
                              style={{ width: `${regionWidth}px` }}
                            >
                              Region
                              <div
                                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize bg-gray-300 opacity-0 group-hover:opacity-100 hover:bg-blue-500 transition-all"
                                onMouseDown={(e) => handleResizeMouseDown(e, 'region')}
                              />
                            </th>
                            <th className="px-4 py-2 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {isBackupLoading && (
                            <tr className="border-b border-gray-100 text-xs">

                              <td className="px-4 py-2">
                                <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full text-xs font-medium">Backup in prog...</span>
                              </td>
                              <td className="px-4 py-2 text-gray-500">Healthy</td>
                              <td className="px-4 py-2 flex gap-1">
                                <button className="px-2 py-1 bg-blue-600 text-white text-xs font-semibold rounded opacity-50 cursor-not-allowed" disabled>Backup New</button>
                                <button className="px-2 py-1 bg-blue-600 text-white text-xs font-semibold rounded opacity-50 cursor-not-allowed" disabled>Restore Selected</button>
                                <button className="px-2 py-1 bg-blue-600 text-white text-xs font-semibold rounded opacity-50 cursor-not-allowed" disabled>Delete Selected</button>
                              </td>
                            </tr>
                          )}
                          
                          {availableBackups.length === 0 && !isBackupLoading ? (
                            <tr className="text-xs text-gray-500">
                              <td className="px-4 py-3" colSpan={4}>No backups available. Click "Backup New" to create one.</td>
                            </tr>
                          ) : (
                            availableBackups.map((fileObj: any) => (
                              <tr key={fileObj.filename} className="border-b border-gray-100 text-xs hover:bg-gray-50 transition-colors">

                                <td 
                                  className="px-4 py-2 text-gray-900 font-medium truncate"
                                  style={{ width: `${fileNameWidth}px`, maxWidth: `${fileNameWidth}px` }}
                                  title={fileObj.filename}
                                >
                                  {fileObj.filename}
                                </td>
                                <td 
                                  className="px-4 py-2 text-gray-500 truncate"
                                  style={{ width: `${sourceAppWidth}px`, maxWidth: `${sourceAppWidth}px` }}
                                  title={fileObj.sourceApp}
                                >
                                  {fileObj.sourceApp}
                                </td>
                                <td 
                                  className="px-4 py-2 text-gray-500 truncate"
                                  style={{ width: `${regionWidth}px`, maxWidth: `${regionWidth}px` }}
                                  title={fileObj.region}
                                >
                                  {fileObj.region}
                                </td>
                                <td className="px-4 py-2 flex gap-1">
                                  <button 
                                    onClick={() => handleViewGcsFile(fileObj.filename)}
                                    disabled={isLoading}
                                    className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded disabled:bg-gray-300 transition-colors"
                                  >
                                    View
                                  </button>
                                  <button 
                                    onClick={() => handleRestore(card.section, card.restoreProcessor, fileObj.filename)}
                                    disabled={isLoading}
                                    className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded disabled:bg-gray-300 transition-colors"
                                  >
                                    Restore Selected
                                  </button>
                                  <button 
                                    onClick={() => handleDownloadGcsFile(fileObj.filename)}
                                    disabled={isLoading}
                                    className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded disabled:bg-gray-300 transition-colors"
                                  >
                                    Download Selected
                                  </button>
                                  <button 
                                    onClick={() => handleDeleteGcsFile(fileObj.filename)}
                                    disabled={isLoading}
                                    className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded disabled:bg-gray-300 transition-colors"
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                    
                    {/* Quick Action for Backup if empty */}
                    {availableBackups.length === 0 && !isBackupLoading && (
                      <div className="mt-2">
                        <button 
                          onClick={card.backupHandler}
                          disabled={isLoading || !selectedBucket}
                          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded shadow-sm transition-colors disabled:bg-gray-300"
                        >
                          Backup New
                        </button>
                      </div>
                    )}
                  </div>
                );
            })}
          </div>

        </div>

        {/* Logs Section */}
        {(isLoading || logs.length > 0) && (
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 mt-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4 flex items-center">
              {isLoading && <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-blue-600 mr-3"></div>}
              {isLoading ? `Running: ${loadingSection?.replace(/[A-Z]/g, ' $&').trim()}` : 'Operation Logs'}
            </h2>
            {error && <div className="text-sm text-red-600 p-3 mb-3 bg-red-50 border border-red-200 rounded-lg">{error}</div>}
            <pre className="bg-gray-50 text-xs text-gray-700 p-4 rounded-lg h-64 overflow-y-auto font-mono border border-gray-200">
              {logs.join('\n')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

export default BackupPage;
