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
import { saveMigrationPayload, getMigrationPayload, clearMigrationPayload } from './utils/migrationDb';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_VALUES: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const getLogLevel = (message: string): LogLevel => {
  const upper = message.toUpperCase();
  if (upper.includes('[DEBUG]') || upper.includes('DEBUG:')) {
    return 'DEBUG';
  }
  if (upper.includes('WARNING:') || upper.includes('WARN:') || upper.includes('WARNING')) {
    return 'WARN';
  }
  if (upper.includes('ERROR:') || upper.includes('FAILED') || upper.includes('FATAL') || upper.includes('CRITICAL')) {
    return 'ERROR';
  }
  return 'INFO';
};



interface BackupPageProps {
  accessToken: string;
  sourceToken?: string;
  targetToken?: string;
  onGoogleSignIn?: () => void;
  onWifSignIn?: () => void;
  onOktaSignIn?: () => void;
  onSignOut?: () => void;
  projectNumber: string;
  setProjectNumber: (projectNumber: string) => void;
  userEmail: string;
  userSub: string;
  isSettingsOpen?: boolean;
  onCloseSettings?: () => void;
  poolId?: string;
  featureFlags: { idpChangeEnabled: boolean, enableGoogleIdp: boolean, enableWifIdp: boolean, enableOktaIdp?: boolean };
  setFeatureFlags: React.Dispatch<React.SetStateAction<{ idpChangeEnabled: boolean, enableGoogleIdp: boolean, enableWifIdp: boolean, enableOktaIdp?: boolean }>>;
  googleClientId: string;
  setGoogleClientId: (id: string) => void;
  wifConfigState: any;
  setWifConfigState: React.Dispatch<React.SetStateAction<any>>;
  oktaConfigState: any;
  setOktaConfigState: React.Dispatch<React.SetStateAction<any>>;
  sourceIdp: string;
  setSourceIdp: (idp: string) => void;
  targetIdp: string;
  setTargetIdp: (idp: string) => void;
  runtimeConfig?: any;
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

const areAgentDefinitionsEquivalent = (agentA: any, agentB: any): boolean => {
  if ((agentA.description || '').trim() !== (agentB.description || '').trim()) return false;

  const getInstructionsText = (agent: any): string => {
    if (agent.adkAgentDefinition?.toolSettings?.toolDescription) {
      return agent.adkAgentDefinition.toolSettings.toolDescription;
    }
    if (agent.lowCodeAgentDefinition) {
      const lowCodeDef = agent.lowCodeAgentDefinition;
      
      // 1. Direct instructions at root of lowCodeDef
      if (lowCodeDef.systemInstruction?.additionalSystemInstruction) return lowCodeDef.systemInstruction.additionalSystemInstruction;
      if (lowCodeDef.systemInstruction) return typeof lowCodeDef.systemInstruction === 'string' ? lowCodeDef.systemInstruction : JSON.stringify(lowCodeDef.systemInstruction);
      if (lowCodeDef.instruction) return typeof lowCodeDef.instruction === 'string' ? lowCodeDef.instruction : JSON.stringify(lowCodeDef.instruction);
      if (lowCodeDef.instructions) return typeof lowCodeDef.instructions === 'string' ? lowCodeDef.instructions : JSON.stringify(lowCodeDef.instructions);
      
      // 2. Nested instructions inside nodes for LLM Agent Node
      if (lowCodeDef.nodes && Array.isArray(lowCodeDef.nodes)) {
        for (const node of lowCodeDef.nodes) {
          if (node.llmAgentNode?.instruction) {
            return node.llmAgentNode.instruction;
          }
        }
      }
      
      // 3. Nested instructions inside deployedNodes for LLM Agent Node
      if (lowCodeDef.deployedNodes && Array.isArray(lowCodeDef.deployedNodes)) {
        for (const node of lowCodeDef.deployedNodes) {
          if (node.llmAgentNode?.instruction) {
            return node.llmAgentNode.instruction;
          }
        }
      }
    }
    if (agent.a2aAgentDefinition?.jsonAgentCard) {
      return agent.a2aAgentDefinition.jsonAgentCard;
    }
    const definitionKeys = Object.keys(agent).filter(key => key.toLowerCase().includes('agentdefinition'));
    for (const key of definitionKeys) {
      const def = agent[key];
      if (def) {
        if (typeof def === 'string') return def;
        if (def.systemInstruction) return typeof def.systemInstruction === 'string' ? def.systemInstruction : JSON.stringify(def.systemInstruction);
        if (def.instruction) return typeof def.instruction === 'string' ? def.instruction : JSON.stringify(def.instruction);
        if (def.instructions) return typeof def.instructions === 'string' ? def.instructions : JSON.stringify(def.instructions);
      }
    }
    return '';
  };

  const instA = getInstructionsText(agentA);
  const instB = getInstructionsText(agentB);

  const sanitize = (str: string): string => {
    if (!str) return '';
    let s = str.trim().toLowerCase();
    s = s.replace(/projects\/[^/]+/g, 'projects/PROJECT_PLACEHOLDER');
    s = s.replace(/locations\/[^/]+/g, 'locations/LOCATION_PLACEHOLDER');
    s = s.replace(/collections\/[^/]+/g, 'collections/COLLECTION_PLACEHOLDER');
    s = s.replace(/dataStores\/[^/]+/g, 'dataStores/DATASTORE_PLACEHOLDER');
    s = s.replace(/engines\/[^/]+/g, 'engines/ENGINE_PLACEHOLDER');
    s = s.replace(/assistants\/[^/]+/g, 'assistants/ASSISTANT_PLACEHOLDER');
    s = s.replace(/agents\/[^/]+/g, 'agents/AGENT_PLACEHOLDER');
    s = s.replace(/files\/[^/]+/g, 'files/FILE_PLACEHOLDER');
    return s;
  };

  return sanitize(instA) === sanitize(instB);
};

const checkAgentCollision = async (
  agent: any,
  targetAgents: any[],
  targetConfig: any,
  userEmail: string,
  userSub: string,
  poolId?: string,
  addLog?: (msg: string) => void
): Promise<{ disabled: boolean; disabledReason?: string }> => {
  const collidingAgents = targetAgents.filter(ta => {
    const taName = ta.displayName.replace('[Replace] ', '').trim().toLowerCase();
    const bkName = agent.displayName.replace('[Replace] ', '').trim().toLowerCase();
    return taName === bkName;
  });

  if (collidingAgents.length === 0) {
    return { disabled: false };
  }

  let isAlreadyRestored = false;

  for (const collidingAgent of collidingAgents) {
    let collidingAgentWithView = collidingAgent;
    try {
      if (addLog) {
        addLog(`  - Fetching target agent view for duplicate check on: ${collidingAgent.displayName}...`);
      }
      const rawViewResponse = await api.getAgentView(collidingAgent.name, targetConfig);
      const targetAgentView = rawViewResponse?.agentView || rawViewResponse;
      collidingAgentWithView = {
        ...collidingAgent,
        ...targetAgentView
      };
    } catch (viewErr: any) {
      if (addLog) {
        addLog(`    - Warning: Failed to fetch target agent view: ${viewErr.message}. Fallback to basic details.`);
      }
    }

    const equivalent = areAgentDefinitionsEquivalent(collidingAgentWithView, agent);
    if (equivalent) {
      isAlreadyRestored = true;
      break;
    }
  }

  if (isAlreadyRestored) {
    return {
      disabled: true,
      disabledReason: 'Already restored (same name, description & instructions)'
    };
  }

  return { disabled: false };
};

const isAgentOwnedByUser = (agent: any, userEmail: string, userSub: string, poolId?: string): boolean => {
  let owner = "N/A";
  let fullMember = "";
  if (agent.iamPolicy && agent.iamPolicy.bindings) {
    const ownerBinding = agent.iamPolicy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
    if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
      fullMember = ownerBinding.members[0];
      owner = getOwnerFromBinding(fullMember);
    }
  }
  
  // 1. Match by direct email
  if (owner === userEmail) return true;
  
  // 2. Match by WIF subject ID if available
  if (userSub && owner === userSub) return true;
  
  // 3. Match by full WIF principal format
  if (poolId && userSub) {
    const wifPrincipal = `principal://iam.googleapis.com/locations/global/workforcePools/${poolId}/subject/${userSub}`;
    if (fullMember === wifPrincipal) return true;
  }

  // 4. Check low-code agent definition owner
  const definitionKeys = Object.keys(agent).filter(key => key.toLowerCase().includes('agentdefinition'));
  for (const key of definitionKeys) {
    const definition = (agent as any)[key];
    if (definition && definition.owner) {
      if (definition.owner === userEmail) return true;
      if (userSub && definition.owner === userSub) return true;
      if (poolId && userSub) {
        const wifPrincipal = `principal://iam.googleapis.com/locations/global/workforcePools/${poolId}/subject/${userSub}`;
        if (definition.owner === wifPrincipal) return true;
      }
      // Google gaia hex ID check
      let userGaiaIdHex = "";
      try {
        if (userSub && /^\d+$/.test(userSub)) {
          userGaiaIdHex = `gaia:0x${BigInt(userSub).toString(16)}#`;
          if (definition.owner === userGaiaIdHex) return true;
        }
      } catch {}
    }
  }

  // 5. Smart prefix-based match (e.g., matching Google user 'wdufrin' with WIF principal 'admin@wdufrin.allostrat.com')
  if (userEmail) {
    const prefix = userEmail.split('@')[0].toLowerCase();
    if (prefix && prefix.length > 2) {
      if (owner && owner.toLowerCase().includes(prefix)) return true;
      if (fullMember && fullMember.toLowerCase().includes(prefix)) return true;
      if (agent.ownerDisplayName && agent.ownerDisplayName.toLowerCase().includes(prefix)) return true;
      if (agent.ownerUserPrincipal && agent.ownerUserPrincipal.toLowerCase().includes(prefix)) return true;
      if (agent.agentView?.ownerUserPrincipal && agent.agentView.ownerUserPrincipal.toLowerCase().includes(prefix)) return true;
      if (agent.agentView?.ownerDisplayName && agent.agentView.ownerDisplayName.toLowerCase().includes(prefix)) return true;

      for (const key of definitionKeys) {
        const definition = (agent as any)[key];
        if (definition && definition.owner && definition.owner.toLowerCase().includes(prefix)) return true;
      }
    }
  }

  return false;
};

const isMemberCurrentUser = (member: string, userEmail: string, userSub: string, poolId?: string): boolean => {
  const owner = getOwnerFromBinding(member);
  
  // 1. Direct email match
  if (userEmail && (owner === userEmail || member.includes(userEmail))) return true;
  
  // 2. Direct subject match
  if (userSub && (owner === userSub || member.includes(userSub))) return true;
  
  // 3. Full WIF principal match
  if (poolId && userSub) {
    const wifPrincipal = `principal://iam.googleapis.com/locations/global/workforcePools/${poolId}/subject/${userSub}`;
    if (member === wifPrincipal) return true;
  }
  
  return false;
};

// --- Main Page Component ---

const BackupPage: React.FC<BackupPageProps> = ({ 
  accessToken, 
  sourceToken, 
  targetToken, 
  onGoogleSignIn, 
  onWifSignIn, 
  onOktaSignIn,
  onSignOut, 
  projectNumber, 
  setProjectNumber, 
  userEmail, 
  userSub, 
  isSettingsOpen, 
  onCloseSettings, 
  poolId,
  featureFlags,
  setFeatureFlags,
  googleClientId,
  setGoogleClientId,
  wifConfigState,
  setWifConfigState,
  oktaConfigState,
  setOktaConfigState,
  sourceIdp,
  setSourceIdp,
  targetIdp,
  setTargetIdp,
  runtimeConfig
}) => {
  const [config, setConfig] = useState({
    appLocation: 'global',
    appId: '',
    reasoningEngineLocation: 'us-central1',
    reasoningEngineId: '', // Added Agent Engine selection
    collectionId: 'default_collection',
    assistantId: 'default_assistant',
  });
  const isAdminModeEnabled = 
    import.meta.env.VITE_ENABLE_ADMIN_MODE === 'true' || 
    Array.from(new URLSearchParams(window.location.search).entries())
      .some(([key, val]) => key.toLowerCase() === 'admin' && val.toLowerCase() === 'true');
  const [activeTab, setActiveTab] = useState<'admin' | 'user'>(isAdminModeEnabled ? 'admin' : 'user');
  interface UserTabConfig {
    sourceProject: string;
    sourceLocation: string;
    sourceAppId: string;
    targetProject: string;
    targetLocation: string;
    targetAppId: string;
    targetAppUrl: string;
    bypassOwnerFilter?: boolean;
    enableAgentViewFallback?: boolean;
  }

  const [userTabConfig, setUserTabConfig] = useState<UserTabConfig>(() => {
    const saved = localStorage.getItem('agentspace-userTabConfig');
    return saved ? JSON.parse(saved) : {
      sourceProject: import.meta.env.VITE_SOURCE_PROJECT || '',
      sourceLocation: import.meta.env.VITE_SOURCE_LOCATION || 'global',
      sourceAppId: import.meta.env.VITE_SOURCE_APP_ID || '',
      targetProject: import.meta.env.VITE_TARGET_PROJECT || '',
      targetLocation: import.meta.env.VITE_TARGET_LOCATION || 'global',
      targetAppId: import.meta.env.VITE_TARGET_APP_ID || '',
      targetAppUrl: import.meta.env.VITE_TARGET_APP_URL || '',
      bypassOwnerFilter: import.meta.env.VITE_BYPASS_OWNER_FILTER === 'true',
      enableAgentViewFallback: true, // Default to true
    };
  });
  const [isUserConfigModalOpen, setIsUserConfigModalOpen] = useState(false);
  const [logLevel, setLogLevel] = useState<LogLevel>(() => {
    const saved = localStorage.getItem('agentspace-logLevel');
    return (saved as LogLevel) || (import.meta.env.VITE_LOG_LEVEL as LogLevel) || 'INFO';
  });
  const [sourceApps, setSourceApps] = useState<any[]>([]);
  const [targetApps, setTargetApps] = useState<any[]>([]);
  const [sourceDatastores, setSourceDatastores] = useState<any[]>([]);
  const [targetDatastores, setTargetDatastores] = useState<any[]>([]);
  const [isLoadingSourceDatastores, setIsLoadingSourceDatastores] = useState(false);
  const [isLoadingTargetDatastores, setIsLoadingTargetDatastores] = useState(false);
  const [datastoreMapping, setDatastoreMapping] = useState<Record<string, string>>(() => {
    const saved = localStorage.getItem('agentspace-datastoreMapping');
    if (saved) return JSON.parse(saved);
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
    const saved = localStorage.getItem('agentspace-collectionMapping');
    if (saved) return JSON.parse(saved);
    const envMapping = import.meta.env.VITE_COLLECTION_MAPPING;
    try {
      return envMapping ? JSON.parse(envMapping) : {};
    } catch (e) {
      console.error("Failed to parse VITE_COLLECTION_MAPPING from env", e);
      return {};
    }
  });
  const [shouldMigrateAgents, setShouldMigrateAgents] = useState(() => {
    const saved = localStorage.getItem('agentspace-shouldMigrateAgents');
    return saved ? saved === 'true' : import.meta.env.VITE_MIGRATE_AGENTS !== 'false';
  });
  const [shouldMigrateNotebooks, setShouldMigrateNotebooks] = useState(() => {
    const saved = localStorage.getItem('agentspace-shouldMigrateNotebooks');
    return saved ? saved === 'true' : import.meta.env.VITE_MIGRATE_NOTEBOOKS !== 'false';
  });
  const [isStep1Complete, setIsStep1Complete] = useState<boolean>(() => {
    const saved = localStorage.getItem('agentspace-step1Complete');
    return saved === 'true';
  });
  const [isRestoreComplete, setIsRestoreComplete] = useState(false);
  const [cachedBackupInfo, setCachedBackupInfo] = useState<{ timestamp: string; itemCount: number } | null>(null);
  const [isCachedBackupLoaded, setIsCachedBackupLoaded] = useState<boolean>(false);

  useEffect(() => {
    if (!runtimeConfig) return;
    
    // Merge runtime data on top of build-time env defaults
    const base = {
      VITE_SOURCE_PROJECT: runtimeConfig.VITE_SOURCE_PROJECT || import.meta.env.VITE_SOURCE_PROJECT,
      VITE_SOURCE_LOCATION: runtimeConfig.VITE_SOURCE_LOCATION || import.meta.env.VITE_SOURCE_LOCATION,
      VITE_SOURCE_APP_ID: runtimeConfig.VITE_SOURCE_APP_ID || import.meta.env.VITE_SOURCE_APP_ID,
      VITE_TARGET_PROJECT: runtimeConfig.VITE_TARGET_PROJECT || import.meta.env.VITE_TARGET_PROJECT,
      VITE_TARGET_LOCATION: runtimeConfig.VITE_TARGET_LOCATION || import.meta.env.VITE_TARGET_LOCATION,
      VITE_TARGET_APP_ID: runtimeConfig.VITE_TARGET_APP_ID || import.meta.env.VITE_TARGET_APP_ID,
      VITE_TARGET_APP_URL: runtimeConfig.VITE_TARGET_APP_URL || import.meta.env.VITE_TARGET_APP_URL,
      VITE_BYPASS_OWNER_FILTER: runtimeConfig.VITE_BYPASS_OWNER_FILTER !== undefined ? runtimeConfig.VITE_BYPASS_OWNER_FILTER : import.meta.env.VITE_BYPASS_OWNER_FILTER,
      VITE_DATASTORE_MAPPING: runtimeConfig.VITE_DATASTORE_MAPPING || import.meta.env.VITE_DATASTORE_MAPPING,
      VITE_COLLECTION_MAPPING: runtimeConfig.VITE_COLLECTION_MAPPING || import.meta.env.VITE_COLLECTION_MAPPING,
    };

    if (!localStorage.getItem('agentspace-userTabConfig')) {
      setUserTabConfig({
        sourceProject: base.VITE_SOURCE_PROJECT || '',
        sourceLocation: base.VITE_SOURCE_LOCATION || 'global',
        sourceAppId: base.VITE_SOURCE_APP_ID || '',
        targetProject: base.VITE_TARGET_PROJECT || '',
        targetLocation: base.VITE_TARGET_LOCATION || 'global',
        targetAppId: base.VITE_TARGET_APP_ID || '',
        targetAppUrl: base.VITE_TARGET_APP_URL || '',
        bypassOwnerFilter: base.VITE_BYPASS_OWNER_FILTER === 'true',
        enableAgentViewFallback: true,
      });
    }
    
    if (!localStorage.getItem('agentspace-datastoreMapping')) {
      const envDsMapping = base.VITE_DATASTORE_MAPPING;
      try {
        setDatastoreMapping(envDsMapping ? JSON.parse(envDsMapping) : {});
      } catch (e) {
        setDatastoreMapping({});
      }
    }
    
    if (!localStorage.getItem('agentspace-collectionMapping')) {
      const envCollMapping = base.VITE_COLLECTION_MAPPING;
      try {
        setCollectionMapping(envCollMapping ? JSON.parse(envCollMapping) : {});
      } catch (e) {
        setCollectionMapping({});
      }
    }
  }, [runtimeConfig]);

  useEffect(() => {
    localStorage.setItem('agentspace-step1Complete', String(isStep1Complete));
  }, [isStep1Complete]);
  useEffect(() => {
    getMigrationPayload().then(payload => {
      if (payload && payload.data) {
        setRestoreFileContent(JSON.stringify(payload.data));
        setIsCachedBackupLoaded(true);
        setCachedBackupInfo({
          timestamp: payload.timestamp,
          itemCount: (payload.data.agents?.length || 0) + (payload.data.notebooks?.length || 0)
        });
        addLog(`[Cache] Found active migration cache in browser. Pre-loaded backup data.`);
      }
    });
  }, []);

  const handleClearCachedBackup = () => {
    clearMigrationPayload().then(() => {
      setRestoreFileContent('');
      setIsCachedBackupLoaded(false);
      setCachedBackupInfo(null);
      addLog(`[Cache] Browser migration cache cleared.`);
    });
  };
  // Feature flags, Google Client ID, and WIF config are now passed as props from App component for unified reactivity

  useEffect(() => {
    if (activeTab === 'admin') {
      if (userTabConfig.sourceProject && sourceApps.length === 0) {
        setIsLoadingSourceApps(true);
        fetchAppsForProject(userTabConfig.sourceProject, userTabConfig.sourceLocation)
          .then(apps => setSourceApps(apps))
          .finally(() => setIsLoadingSourceApps(false));
      }
      if (userTabConfig.targetProject && targetApps.length === 0) {
        setIsLoadingTargetApps(true);
        fetchAppsForProject(userTabConfig.targetProject, userTabConfig.targetLocation, targetToken || accessToken)
          .then(apps => setTargetApps(apps))
          .finally(() => setIsLoadingTargetApps(false));
      }
    }
  }, [activeTab]);

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
    let content = `# --- App Mode & Feature Flags ---\n`;
    content += `VITE_ENABLE_ADMIN_MODE=${import.meta.env.VITE_ENABLE_ADMIN_MODE || 'true'}\n`;
    content += `VITE_SINGLE_CLICK_MIGRATION=${import.meta.env.VITE_SINGLE_CLICK_MIGRATION || 'true'}\n`;
    content += `VITE_IDP_CHANGE_ENABLED=${featureFlags.idpChangeEnabled}\n`;
    content += `VITE_ENABLE_GOOGLE_IDP=${featureFlags.enableGoogleIdp}\n`;
    content += `VITE_ENABLE_WIF_IDP=${featureFlags.enableWifIdp}\n`;
    content += `VITE_GOOGLE_CLIENT_ID=${googleClientId}\n`;
    content += `VITE_LOG_LEVEL=${logLevel}\n\n`;

    content += `# --- Source Environment ---\n`;
    content += `VITE_SOURCE_PROJECT=${userTabConfig.sourceProject}\n`;
    content += `VITE_SOURCE_LOCATION=${userTabConfig.sourceLocation}\n`;
    content += `VITE_SOURCE_APP_ID=${userTabConfig.sourceAppId}\n`;
    content += `VITE_BYPASS_OWNER_FILTER=${userTabConfig.bypassOwnerFilter || false}\n`;
    content += `VITE_ENABLE_AGENT_VIEW_FALLBACK=${userTabConfig.enableAgentViewFallback || false}\n`;
    
    const sourceIdpVal = sourceIdp;
    if (sourceIdpVal !== targetIdp) {
      content += `VITE_SOURCE_IDP=${sourceIdpVal}\n\n`;
    } else {
      content += `#VITE_SOURCE_IDP=${sourceIdpVal}\n\n`;
    }

    content += `# --- Target Environment ---\n`;
    content += `VITE_TARGET_PROJECT=${userTabConfig.targetProject}\n`;
    content += `VITE_TARGET_LOCATION=${userTabConfig.targetLocation}\n`;
    content += `VITE_TARGET_APP_ID=${userTabConfig.targetAppId}\n`;
    content += `VITE_TARGET_APP_URL=${userTabConfig.targetAppUrl}\n`;
    
    const targetIdpVal = targetIdp;
    if (sourceIdpVal !== targetIdpVal) {
      content += `VITE_TARGET_IDP=${targetIdpVal}\n\n`;
    } else {
      content += `#VITE_TARGET_IDP=${targetIdpVal}\n\n`;
    }

    content += `# --- Workforce Identity Federation (WIF) / Entra ID Config ---\n`;
    content += `VITE_WIF_USER_PROJECT=${wifConfigState.userProject}\n`;
    content += `VITE_WIF_POOL_ID=${wifConfigState.poolId}\n`;
    content += `VITE_WIF_PROVIDER_ID=${wifConfigState.providerId}\n`;
    content += `VITE_WIF_CLIENT_ID=${wifConfigState.clientId}\n`;
    content += `VITE_WIF_AUTH_ENDPOINT=${wifConfigState.authEndpoint}\n`;
    content += `VITE_WIF_REDIRECT_URI=${wifConfigState.redirectUri}\n\n`;

    content += `# --- Workforce Identity Federation (WIF) / Okta Config ---\n`;
    content += `VITE_OKTA_USER_PROJECT=${oktaConfigState.userProject}\n`;
    content += `VITE_OKTA_POOL_ID=${oktaConfigState.poolId}\n`;
    content += `VITE_OKTA_PROVIDER_ID=${oktaConfigState.providerId}\n`;
    content += `VITE_OKTA_CLIENT_ID=${oktaConfigState.clientId}\n`;
    content += `VITE_OKTA_CLIENT_SECRET=${oktaConfigState.clientSecret || ''}\n`;
    content += `VITE_OKTA_AUTH_ENDPOINT=${oktaConfigState.authEndpoint}\n`;
    content += `VITE_OKTA_REDIRECT_URI=${oktaConfigState.redirectUri}\n\n`;

    content += `# --- Migration Settings ---\n`;
    content += `VITE_MIGRATE_AGENTS=${shouldMigrateAgents}\n`;
    content += `VITE_MIGRATE_NOTEBOOKS=${shouldMigrateNotebooks}\n\n`;

    content += `# --- Mappings ---\n`;
    content += `VITE_DATASTORE_MAPPING='${JSON.stringify(datastoreMapping)}'\n`;
    content += `VITE_COLLECTION_MAPPING='${JSON.stringify(collectionMapping)}'\n`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `.env.exported`;
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
        const content = e.target?.result as string;
        if (content.trim().startsWith('{')) {
          // JSON format (Fallback for old exports)
          const json = JSON.parse(content);
          if (json.userTabConfig) {
            setUserTabConfig(json.userTabConfig);
            if (json.userTabConfig.sourceProject) {
              const sourceLoc = json.userTabConfig.sourceLocation || 'global';
              fetchAppsForProject(json.userTabConfig.sourceProject, sourceLoc).then(apps => setSourceApps(apps));
            }
            if (json.userTabConfig.targetProject) {
              const targetLoc = json.userTabConfig.targetLocation || 'global';
              fetchAppsForProject(json.userTabConfig.targetProject, targetLoc, targetToken || accessToken).then(apps => setTargetApps(apps));
            }
          }
          if (json.logLevel) {
            setLogLevel(json.logLevel as LogLevel);
          }
          if (json.datastoreMapping) {
            setDatastoreMapping(json.datastoreMapping);
          }
          if (json.collectionMapping) {
            setCollectionMapping(json.collectionMapping);
          }
          addLog(`Admin configuration imported successfully from JSON file.`);
        } else {
          // .env format
          const lines = content.split('\n');
          const config: any = {};
          
          lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const parts = trimmed.split('=');
            if (parts.length >= 2) {
              const key = parts[0].trim();
              let value = parts.slice(1).join('=').trim();
              // Remove surrounding single quotes if any
              if (value.startsWith("'") && value.endsWith("'")) {
                value = value.slice(1, -1);
              }
              config[key] = value;
            }
          });

          const newUserTabConfig = {
            sourceProject: config.VITE_SOURCE_PROJECT || '',
            sourceLocation: config.VITE_SOURCE_LOCATION || 'global',
            sourceAppId: config.VITE_SOURCE_APP_ID || '',
            targetProject: config.VITE_TARGET_PROJECT || '',
            targetLocation: config.VITE_TARGET_LOCATION || 'global',
            targetAppId: config.VITE_TARGET_APP_ID || '',
            targetAppUrl: config.VITE_TARGET_APP_URL || '',
            bypassOwnerFilter: config.VITE_BYPASS_OWNER_FILTER === 'true',
            enableAgentViewFallback: config.VITE_ENABLE_AGENT_VIEW_FALLBACK !== 'false', // Default to true if missing/not set to false
          };
          setUserTabConfig(newUserTabConfig);

          if (config.VITE_DATASTORE_MAPPING) {
            setDatastoreMapping(JSON.parse(config.VITE_DATASTORE_MAPPING));
          }
          if (config.VITE_COLLECTION_MAPPING) {
            setCollectionMapping(JSON.parse(config.VITE_COLLECTION_MAPPING));
          }

          if (config.VITE_WIF_USER_PROJECT) {
            setWifConfigState({
              userProject: config.VITE_WIF_USER_PROJECT || '',
              poolId: config.VITE_WIF_POOL_ID || '',
              providerId: config.VITE_WIF_PROVIDER_ID || '',
              clientId: config.VITE_WIF_CLIENT_ID || '',
              authEndpoint: config.VITE_WIF_AUTH_ENDPOINT || '',
              redirectUri: config.VITE_WIF_REDIRECT_URI || '',
            });
          }

          if (config.VITE_IDP_CHANGE_ENABLED) {
            setFeatureFlags({
              idpChangeEnabled: config.VITE_IDP_CHANGE_ENABLED === 'true',
              enableGoogleIdp: config.VITE_ENABLE_GOOGLE_IDP !== 'false',
              enableWifIdp: config.VITE_ENABLE_WIF_IDP === 'true',
            });
          }

          if (config.VITE_GOOGLE_CLIENT_ID) {
            setGoogleClientId(config.VITE_GOOGLE_CLIENT_ID);
          }

          if (config.VITE_LOG_LEVEL) {
            setLogLevel(config.VITE_LOG_LEVEL as LogLevel);
          }

          if (config.VITE_SOURCE_IDP) {
            setSourceIdp(config.VITE_SOURCE_IDP);
          }
          if (config.VITE_TARGET_IDP) {
            setTargetIdp(config.VITE_TARGET_IDP);
          }

          if (config.VITE_MIGRATE_AGENTS) {
            setShouldMigrateAgents(config.VITE_MIGRATE_AGENTS === 'true');
          }
          if (config.VITE_MIGRATE_NOTEBOOKS) {
            setShouldMigrateNotebooks(config.VITE_MIGRATE_NOTEBOOKS === 'true');
          }

          if (newUserTabConfig.sourceProject) {
            const sourceLoc = newUserTabConfig.sourceLocation || 'global';
            fetchAppsForProject(newUserTabConfig.sourceProject, sourceLoc).then(apps => setSourceApps(apps));
          }
          if (newUserTabConfig.targetProject) {
            const targetLoc = newUserTabConfig.targetLocation || 'global';
            fetchAppsForProject(newUserTabConfig.targetProject, targetLoc, targetToken || accessToken).then(apps => setTargetApps(apps));
          }

          addLog(`Admin configuration imported successfully from .env file.`);
        }
      } catch (err: any) {
        addLog(`Error importing admin configuration: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const handleSaveAdminConfig = () => {
    localStorage.setItem('agentspace-userTabConfig', JSON.stringify(userTabConfig));
    localStorage.setItem('agentspace-featureFlags', JSON.stringify(featureFlags));
    localStorage.setItem('agentspace-googleClientId', googleClientId);
    localStorage.setItem('agentspace-wifConfig', JSON.stringify(wifConfigState));
    localStorage.setItem('agentspace-shouldMigrateAgents', String(shouldMigrateAgents));
    localStorage.setItem('agentspace-shouldMigrateNotebooks', String(shouldMigrateNotebooks));
    localStorage.setItem('agentspace-datastoreMapping', JSON.stringify(datastoreMapping));
    localStorage.setItem('agentspace-collectionMapping', JSON.stringify(collectionMapping));
    localStorage.setItem('agentspace-sourceIdp', sourceIdp);
    localStorage.setItem('agentspace-targetIdp', targetIdp);
    localStorage.setItem('agentspace-logLevel', logLevel);
    addLog(`Admin configuration saved to browser storage.`);
  };

  const handleResetAdminConfig = () => {
    localStorage.removeItem('agentspace-userTabConfig');
    localStorage.removeItem('agentspace-featureFlags');
    localStorage.removeItem('agentspace-googleClientId');
    localStorage.removeItem('agentspace-wifConfig');
    localStorage.removeItem('agentspace-shouldMigrateAgents');
    localStorage.removeItem('agentspace-shouldMigrateNotebooks');
    localStorage.removeItem('agentspace-datastoreMapping');
    localStorage.removeItem('agentspace-collectionMapping');
    localStorage.removeItem('agentspace-sourceIdp');
    localStorage.removeItem('agentspace-targetIdp');
    localStorage.removeItem('agentspace-logLevel');
    
    const base = { ...import.meta.env, ...runtimeConfig };
    setUserTabConfig({
      sourceProject: base.VITE_SOURCE_PROJECT || '',
      sourceLocation: base.VITE_SOURCE_LOCATION || 'global',
      sourceAppId: base.VITE_SOURCE_APP_ID || '',
      targetProject: base.VITE_TARGET_PROJECT || '',
      targetLocation: base.VITE_TARGET_LOCATION || 'global',
      targetAppId: base.VITE_TARGET_APP_ID || '',
      targetAppUrl: base.VITE_TARGET_APP_URL || '',
    });
    setFeatureFlags({
      idpChangeEnabled: base.VITE_IDP_CHANGE_ENABLED === 'true',
      enableGoogleIdp: base.VITE_ENABLE_GOOGLE_IDP !== 'false',
      enableWifIdp: base.VITE_ENABLE_WIF_IDP === 'true',
    });
    setGoogleClientId(base.VITE_GOOGLE_CLIENT_ID || '');
    setWifConfigState({
      userProject: base.VITE_WIF_USER_PROJECT || '',
      poolId: base.VITE_WIF_POOL_ID || '',
      providerId: base.VITE_WIF_PROVIDER_ID || '',
      clientId: base.VITE_WIF_CLIENT_ID || '',
      authEndpoint: base.VITE_WIF_AUTH_ENDPOINT || '',
      redirectUri: base.VITE_WIF_REDIRECT_URI || '',
    });
    setSourceIdp(base.VITE_SOURCE_IDP || 'Google');
    setTargetIdp(base.VITE_TARGET_IDP || 'Google');
    setShouldMigrateAgents(base.VITE_MIGRATE_AGENTS !== 'false');
    setShouldMigrateNotebooks(base.VITE_MIGRATE_NOTEBOOKS !== 'false');
    setLogLevel((base.VITE_LOG_LEVEL as LogLevel) || 'INFO');

    const envDsMapping = base.VITE_DATASTORE_MAPPING;
    try {
      setDatastoreMapping(envDsMapping ? JSON.parse(envDsMapping) : {});
    } catch (e) {
      setDatastoreMapping({});
    }

    const envCollMapping = base.VITE_COLLECTION_MAPPING;
    try {
      setCollectionMapping(envCollMapping ? JSON.parse(envCollMapping) : {});
    } catch (e) {
      setCollectionMapping({});
    }
    addLog(`Admin configuration reset to environment defaults.`);
  };

  const [isLoadingSourceApps, setIsLoadingSourceApps] = useState(false);
  const [isLoadingTargetApps, setIsLoadingTargetApps] = useState(false);
  const isDebugMode = logLevel === 'DEBUG';
  const [restoreFileContent, setRestoreFileContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingSection, setLoadingSection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ percent: number; text: string } | null>(null);
  
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
  const [selectionModalAction, setSelectionModalAction] = useState<'backup' | 'restore' | 'migrate'>('backup');
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

  async function fetchAppsForProject(projectId: string, location: string, token?: string): Promise<any[]> {
    if (!projectId) return [];
    try {
      const mockConfig = {
        projectId: projectId,
        appLocation: location,
        collectionId: 'default_collection',
        appId: '',
        assistantId: 'default_assistant',
        accessToken: token || accessToken,
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
    const msgLevel = getLogLevel(message);
    if (LEVEL_VALUES[msgLevel] >= LEVEL_VALUES[logLevel]) {
      setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`]);
    }
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
            details: `Permission check failed for project ${targetProject}: ${err.message}.

How to fix (Admin Steps):

Step 1: Create the custom role:

gcloud iam roles create customBackupViewer \\
    --project=${targetProject} \\
    --title="Discovery Engine Custom Backup Viewer" \\
    --permissions="discoveryengine.engines.list,\\
discoveryengine.engines.get,\\
discoveryengine.assistants.list,\\
discoveryengine.assistants.get,\\
discoveryengine.agents.list,\\
discoveryengine.agents.get,\\
discoveryengine.agents.manage,\\
discoveryengine.agents.getIamPolicy,\\
discoveryengine.notebooks.list,\\
discoveryengine.notebooks.get,\\
serviceusage.services.use" \\
    --stage=GA

Step 2: Assign the role to your user (Dynamic based on your login):

gcloud projects add-iam-policy-binding ${targetProject} \\
    --member="principal://iam.googleapis.com/locations/global/workforcePools/${poolId || 'YOUR_POOL_ID'}/subject/${userEmail}" \\
    --role="projects/${targetProject}/roles/customBackupViewer"

Alternatively, assign to your group if you prefer group-based access control:

gcloud projects add-iam-policy-binding ${targetProject} \\
    --member="principalSet://iam.googleapis.com/locations/global/workforcePools/${poolId || 'YOUR_POOL_ID'}/group/YOUR_GROUP_ID" \\
    --role="projects/${targetProject}/roles/customBackupViewer"` 
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
      setProgress({ percent: 0, text: 'Initializing operation...' });
      try {
          await operation();
          setProgress({ percent: 100, text: 'Operation completed successfully!' });
      } catch (err: any) {
          setError(err.message || `An unknown error occurred in ${section}.`);
          addLog(`FATAL ERROR: ${err.message}`);
          setProgress(prev => prev ? { ...prev, text: `Failed: ${err.message}` } : null);
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
    addLog(`Starting server-side backup for agents in Assistant: ${apiConfig.assistantId}...`);
    
    const result = await api.backupAgentsServerSide({ ...apiConfig, accessToken }, logLevel);
    if (result.logs) {
      result.logs.forEach((log: string) => addLog(`  [Server] ${log}`));
    }
    const lowCodeAgents: Agent[] = result.agents || [];

    let agentsToSave = lowCodeAgents;
    if (activeTab === 'user') {
      if (userTabConfig.bypassOwnerFilter) {
        addLog(`  - User Tab: Bypassing WIF owner filtering (migrating all agents in the selected app context).`);
      } else {
        agentsToSave = lowCodeAgents.filter((agent: any) => isAgentOwnedByUser(agent, userEmail, userSub, poolId));
        addLog(`  - User Tab: Filtered down to ${agentsToSave.length} agents owned by you.`);
      }
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
    if (userSub && /^\d+$/.test(userSub)) {
      userGaiaIdHex = `gaia:0x${BigInt(userSub).toString(16)}#`;
      if (isDebugMode) {
        addLog(`[DEBUG] Resolved User GAIA ID from userSub prop: ${userGaiaIdHex}`);
      }
    } else if (!poolId) {
      try {
        const userInfo = await api.getUserInfo(accessToken);
        if (userInfo && userInfo.sub && /^\d+$/.test(userInfo.sub)) {
          userGaiaIdHex = `gaia:0x${BigInt(userInfo.sub).toString(16)}#`;
          if (isDebugMode) {
            addLog(`[DEBUG] Resolved User GAIA ID from Google userinfo: ${userGaiaIdHex}`);
          }
        }
      } catch (err: any) {
        addLog(`Warning: Failed to fetch user info for GAIA ID filtering: ${err.message}`);
      }
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
    setProgress({ percent: 5, text: 'Fetching agents from source...' });
    addLog(`Fetching agents from ${sourceConfig.appId} in ${sourceConfig.appLocation}...`);
    const agents: Agent[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const agentsResponse = await api.listResources('agents', sourceConfig, pageToken);
      agents.push(...(agentsResponse.agents || []));
      pageToken = agentsResponse.nextPageToken;
    } while (pageToken);

    // Fetch IAM policies and categorize, while filtering ONLY low-code agents
    const userAgents: any[] = [];
    const BATCH_SIZE = 10;
    let resolvedAgentCount = 0;

    for (let i = 0; i < agents.length; i += BATCH_SIZE) {
      const batch = agents.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async (agent) => {
        try {
          // 1. Fetch Agent View to check type
          let isLowCode = true;
          try {
            const rawResponse = await api.getAgentView(agent.name, sourceConfig);
            const agentView = rawResponse?.agentView || rawResponse;
            const rawAgentType = agentView?.agentType;
            if (rawAgentType && rawAgentType !== 'LOW_CODE' && rawAgentType !== 'Low Code') {
              isLowCode = false;
            }
          } catch (viewErr) {
            // Structural detection fallback if Agent View fetch fails and fallback is enabled
            if (userTabConfig.enableAgentViewFallback) {
              if (agent.adkAgentDefinition || agent.a2aAgentDefinition) {
                isLowCode = false;
              }
            } else {
              isLowCode = false; // Skip if fallback is disabled
            }
          }

          if (!isLowCode) {
            if (isDebugMode) {
              addLog(`[DEBUG] Skipping non-low-code agent ${agent.displayName || agent.name} from backup.`);
            }
            return;
          }

          const policy = await api.getAgentIamPolicy(agent.name, sourceConfig);
          const agentWithPolicy = { ...agent, iamPolicy: policy, agentType: 'Low Code' };
          const isOwned = isAgentOwnedByUser(agentWithPolicy, userEmail, userSub, poolId);
          (agentWithPolicy as any).category = isOwned ? 'core' : 'optional';
          userAgents.push(agentWithPolicy);
        } catch (e) {
          if (userTabConfig.enableAgentViewFallback) {
            // Fallback: check structural type before adding as optional
            let isLowCode = true;
            if (agent.adkAgentDefinition || agent.a2aAgentDefinition) {
              isLowCode = false;
            }
            if (isLowCode) {
              addLog(`  - Warning: Failed to backup IAM policy for agent ${agent.name}: ${(e as any).message}`);
              const agentCopy = { ...agent, category: 'optional' };
              userAgents.push(agentCopy);
            }
          } else {
            addLog(`  - Warning: Failed to backup agent ${agent.displayName || agent.name} due to view/policy fetch error: ${(e as any).message}. Skipping agent.`);
          }
        } finally {
          resolvedAgentCount++;
          setProgress({
            percent: 10 + Math.round((resolvedAgentCount / agents.length) * 35),
            text: `Fetching agent details (${resolvedAgentCount}/${agents.length}): ${agent.displayName || agent.name}...`
          });
        }
      }));
    }
    addLog(`Found ${userAgents.length} agents in selected engine.`);
    if (isDebugMode) {
      addLog(`[DEBUG] Agents: ${JSON.stringify(userAgents.map(a => `${a.displayName} (${(a as any).category})`), null, 2)}`);
    }

    // 2. Backup Notebooks
    setProgress({ percent: 50, text: 'Fetching notebooks...' });
    addLog(`Fetching notebooks...`);
    const response = await api.listNotebooks(sourceConfig);
    const notebooks = response.notebooks || [];
    const userNotebooks = [];

    let notebookIndex = 0;
    for (const nb of notebooks) {
      notebookIndex++;
      setProgress({
        percent: 55 + Math.round((notebookIndex / notebooks.length) * 40),
        text: `Fetching notebook details (${notebookIndex}/${notebooks.length}): ${nb.title || nb.name}...`
      });
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

    setProgress({ percent: 95, text: 'Preparing modal selection view...' });
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
      agentType: agent.agentType || 'Low Code',
      category: (agent as any).category
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
    const isIdpChangeEnabled = sourceIdp !== targetIdp;

    if (isIdpChangeEnabled) {
      if (!sourceToken) {
        addLog(`Source token missing. Please log into ${sourceIdp}...`);
        if (sourceIdp === 'Google') onGoogleSignIn?.();
        else if (sourceIdp === 'Okta') onOktaSignIn?.();
        else onWifSignIn?.();
        return;
      }
      if (!targetToken) {
        addLog(`Target token missing. Please log into ${targetIdp}...`);
        if (targetIdp === 'Google') onGoogleSignIn?.();
        else if (targetIdp === 'Okta') onOktaSignIn?.();
        else onWifSignIn?.();
        return;
      }
    }

    addLog(`Starting single-click migration...`);
    
    let userGaiaIdHex = "";
    if (userSub && /^\d+$/.test(userSub)) {
      userGaiaIdHex = `gaia:0x${BigInt(userSub).toString(16)}#`;
      if (isDebugMode) {
        addLog(`[DEBUG] Resolved User GAIA ID from userSub prop: ${userGaiaIdHex}`);
      }
    } else if (!poolId) {
      try {
        const userInfo = await api.getUserInfo(accessToken);
        if (userInfo && userInfo.sub && /^\d+$/.test(userInfo.sub)) {
          userGaiaIdHex = `gaia:0x${BigInt(userInfo.sub).toString(16)}#`;
          if (isDebugMode) {
            addLog(`[DEBUG] Resolved User GAIA ID from Google userinfo: ${userGaiaIdHex}`);
          }
        }
      } catch (err: any) {
        addLog(`Warning: Failed to fetch user info for GAIA ID filtering: ${err.message}`);
      }
    }
    
    const sourceConfig = {
      ...apiConfig,
      projectId: userTabConfig.sourceProject,
      appLocation: userTabConfig.sourceLocation || apiConfig.appLocation,
      appId: userTabConfig.sourceAppId || apiConfig.appId,
      accessToken: sourceToken || accessToken,
    };

    const targetConfig = {
      ...apiConfig,
      projectId: userTabConfig.targetProject,
      appLocation: userTabConfig.targetLocation || apiConfig.appLocation,
      appId: userTabConfig.targetAppId || apiConfig.appId,
      accessToken: targetToken || accessToken,
    };

    setProgress({ percent: 5, text: 'Fetching target resources for validation...' });
    addLog(`Fetching target resources for migration validation...`);
    const targetAgents: Agent[] = [];
    let targetPageToken: string | undefined = undefined;
    try {
      do {
        const agentsResponse = await api.listResources('agents', targetConfig, targetPageToken);
        targetAgents.push(...(agentsResponse.agents || []));
        targetPageToken = agentsResponse.nextPageToken;
      } while (targetPageToken);
    } catch (err: any) {
      addLog(`Warning: Failed to fetch target agents for validation: ${err.message}`);
    }

    let targetNotebooks: any[] = [];
    try {
      const response = await api.listNotebooks(targetConfig);
      targetNotebooks = response.notebooks || [];
    } catch (err: any) {
      addLog(`Warning: Failed to fetch target notebooks for validation: ${err.message}`);
    }

    setProgress({ percent: 15, text: 'Fetching source agents...' });
    addLog(`Fetching agents from ${sourceConfig.appId}...`);
    const agents: Agent[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const agentsResponse = await api.listResources('agents', sourceConfig, pageToken);
      agents.push(...(agentsResponse.agents || []));
      pageToken = agentsResponse.nextPageToken;
    } while (pageToken);

    const fullBackupAgents: any[] = [];
    const selectableAgents: any[] = [];

    addLog(`Fetching and analyzing agents via Agent View...`);
    const BATCH_SIZE = 10;
    let resolvedAgentCount = 0;

    for (let i = 0; i < agents.length; i += BATCH_SIZE) {
      const batch = agents.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async (agent) => {
        try {
          // 1. Fetch Agent View for exact type and owner details
          const rawResponse = await api.getAgentView(agent.name, sourceConfig);
          const agentView = rawResponse?.agentView || rawResponse;
          
          if (isDebugMode) {
            addLog(`[DEBUG] Agent View for ${agent.displayName}: ${JSON.stringify(rawResponse, null, 2)}`);
          }

          const rawAgentType = agentView?.agentType;
          
          // Skip if it is explicitly ADK or A2A or not LOW_CODE
          if (rawAgentType && rawAgentType !== 'LOW_CODE' && rawAgentType !== 'Low Code') {
            if (isDebugMode) {
              addLog(`[DEBUG] Skipping non-low-code agent ${agent.displayName || agent.name} (Type: ${rawAgentType}) from migration.`);
            }
            return;
          }

          // If rawAgentType is missing, perform structural fallback check
          if (!rawAgentType && (agent.adkAgentDefinition || agent.a2aAgentDefinition)) {
            if (isDebugMode) {
              addLog(`[DEBUG] Structural Fallback: Skipping non-low-code agent ${agent.displayName || agent.name} from migration.`);
            }
            return;
          }

          // 2. Fetch IAM Policy
          let policy: any = null;
          try {
            policy = await api.getAgentIamPolicy(agent.name, sourceConfig);
          } catch (policyErr: any) {
            if (isDebugMode) {
              addLog(`    - Warning: Failed to fetch IAM policy: ${policyErr.message}`);
            }
          }

          // 3. Resolve Owner
          const agentOwner = agentView?.ownerUserPrincipal || agentView?.ownerDisplayName || agentView?.agentOwner || agentView?.owner;
          let isOwned = false;
          let hasOwner = false;

          if (agentOwner) {
            hasOwner = true;
            isOwned = agentOwner.toLowerCase().includes(userEmail.toLowerCase()) || 
                      (userSub && agentOwner.includes(userSub));
            
            // Prefix-based matching fallback to handle workforce pools and domain mismatches gracefully
            if (!isOwned && userEmail) {
              const prefix = userEmail.split('@')[0].toLowerCase();
              if (prefix && prefix.length > 2) {
                isOwned = agentOwner.toLowerCase().includes(prefix);
              }
            }
          } else if (policy && policy.bindings) {
            const ownerBinding = policy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
            if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
              hasOwner = true;
              const firstMember = ownerBinding.members[0];
              isOwned = firstMember.toLowerCase().includes(userEmail.toLowerCase()) ||
                        (userSub && firstMember.includes(userSub)) ||
                        (poolId && firstMember.includes(poolId));
              
              // Prefix-based matching fallback
              if (!isOwned && userEmail) {
                const prefix = userEmail.split('@')[0].toLowerCase();
                if (prefix && prefix.length > 2) {
                  isOwned = firstMember.toLowerCase().includes(prefix);
                }
              }
            }
          }

          const enrichedAgent = { 
            ...agent, 
            agentType: 'Low Code',
            iamPolicy: policy
          };
          fullBackupAgents.push(enrichedAgent);

          // Only show WIF user-owned agents OR shared/unowned agents (no explicit owner)
          if (isOwned || !hasOwner) {
            const collision = await checkAgentCollision(
              enrichedAgent,
              targetAgents,
              targetConfig,
              userEmail,
              userSub,
              poolId,
              addLog
            );
            const disabled = collision.disabled;
            const disabledReason = collision.disabledReason;

            selectableAgents.push({
              name: agent.name,
              displayName: agent.displayName,
              agentType: 'Low Code',
              disabled,
              disabledReason,
              category: isOwned ? 'core' : 'optional'
            });
          }
        } catch (e: any) {
          if (userTabConfig.enableAgentViewFallback) {
            addLog(`  - Warning: Failed to fetch Agent View for agent ${agent.displayName || agent.name}: ${e.message}. Attempting structural & IAM policy fallback...`);
            
            // 1. Structural Type Check
            let agentType = "Low Code";
            if (agent.adkAgentDefinition) agentType = "ADK";
            else if (agent.a2aAgentDefinition) agentType = "A2A";

            if (agentType !== 'Low Code') {
              if (isDebugMode) {
                addLog(`[DEBUG] Fallback: Skipping non-low-code agent ${agent.displayName || agent.name} (Type: ${agentType}) from migration.`);
              }
              return;
            }

            // 2. IAM Policy Owner Check
            let isOwned = false;
            let hasOwner = false;
            let agentWithPolicy: any = { ...agent };
            try {
              const policy = await api.getAgentIamPolicy(agent.name, sourceConfig);
              agentWithPolicy = { ...agent, iamPolicy: policy };
              
              isOwned = isAgentOwnedByUser(agentWithPolicy, userEmail, userSub, poolId);
              
              if (policy && policy.bindings) {
                const ownerBinding = policy.bindings.find((b: any) => b.role === 'roles/discoveryengine.agentOwner');
                if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
                  hasOwner = true;
                }
              }
              
              fullBackupAgents.push(agentWithPolicy);
            } catch (policyErr: any) {
              addLog(`    - Warning: Failed to fetch IAM policy for fallback: ${policyErr.message}`);
              fullBackupAgents.push(agent);
            }

            // Only show WIF user-owned agents OR shared/unowned agents (no explicit owner)
            if (isOwned || !hasOwner) {
               const collision = await checkAgentCollision(
                 agentWithPolicy,
                 targetAgents,
                 targetConfig,
                 userEmail,
                 userSub,
                 poolId,
                 addLog
               );
               const disabled = collision.disabled;
               const disabledReason = collision.disabledReason;

              selectableAgents.push({
                name: agent.name,
                displayName: agent.displayName,
                agentType: 'Low Code',
                disabled,
                disabledReason,
                category: isOwned ? 'core' : 'optional'
              });
            }
          } else {
            addLog(`  - Warning: Failed to fetch Agent View for agent ${agent.displayName || agent.name}: ${e.message}. Skipping agent.`);
          }
        } finally {
          resolvedAgentCount++;
          setProgress({
            percent: 20 + Math.round((resolvedAgentCount / agents.length) * 35),
            text: `Analyzing source agent (${resolvedAgentCount}/${agents.length}): ${agent.displayName || agent.name}...`
          });
        }
      }));
    }

    setProgress({ percent: 60, text: 'Fetching notebooks...' });
    addLog(`Fetching notebooks...`);
    const response = await api.listNotebooks(sourceConfig);
    const notebooks = response.notebooks || [];
    const fullBackupNotebooks: any[] = [];
    const selectableNotebooks: any[] = [];

    let notebookIndex = 0;
    for (const nb of notebooks) {
      notebookIndex++;
      setProgress({
        percent: 65 + Math.round((notebookIndex / notebooks.length) * 30),
        text: `Analyzing source notebook (${notebookIndex}/${notebooks.length}): ${nb.title || nb.name}...`
      });
      const notebookId = nb.name.split('/').pop()!;
      try {
        const rawNotebook = await api.getNotebook(sourceConfig, notebookId);
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
        fullBackupNotebooks.push(rawNotebook);

        const isOwned = rawNotebook.metadata?.userRole === 'PROJECT_ROLE_OWNER';
        
        const cleanTitle = rawNotebook.title || rawNotebook.displayName || 'Restored Notebook';
        const targetTitle = cleanTitle.endsWith(' (Restored)') ? cleanTitle : `${cleanTitle} (Restored)`;
        const exists = targetNotebooks.some(n => n.title === cleanTitle || n.title === targetTitle);

        selectableNotebooks.push({
          name: rawNotebook.name,
          displayName: cleanTitle,
          agentType: 'Notebook',
          disabled: exists,
          disabledReason: exists ? 'Already exists in target' : undefined,
          category: isOwned ? 'core' : 'optional'
        });
      } catch (nbErr: any) {
        addLog(`  - Error fetching details for notebook ${notebookId}: ${nbErr.message}`);
      }
      await delay(300);
    }

    if (selectableAgents.length === 0 && selectableNotebooks.length === 0) {
      addLog("No agents or notebooks auto-detected for migration.");
      return;
    }

    // Save state for the interactive confirmation popup
    setPendingBackupData({
      agents: fullBackupAgents,
      notebooks: fullBackupNotebooks,
      sourceConfig,
      userEmail
    });

    setSelectionModalItems([...selectableAgents, ...selectableNotebooks]);
    setSelectionModalTitle('Confirm Items to Migrate');
    setSelectionModalSubtitle('Please review the auto-detected items. Under "Optional / Shared Agents", we listed agents that have no specific owner assigned to them—select any you wish to include.');
    setSelectionModalAction('migrate');
    setIsSelectionModalOpen(true);
    
    addLog("Auto-detection complete. Presenting confirmation popup to review items...");
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
      accessToken: targetToken || accessToken,
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

      const targetNotebookTitles = new Set(targetNotebooks.map(n => n.title));

      const agentItems: SelectableItem[] = [];
      const backupAgentsList = backupData.agents || [];
      let agentIndex = 0;
      for (const agent of backupAgentsList) {
        agentIndex++;
        setProgress({
          percent: 25 + Math.round((agentIndex / backupAgentsList.length) * 65),
          text: `Analyzing collision for agent (${agentIndex}/${backupAgentsList.length}): ${agent.displayName || agent.name}...`
        });
        const collision = await checkAgentCollision(
          agent,
          targetAgents,
          targetConfig,
          userEmail,
          userSub,
          poolId,
          addLog
        );
        const disabled = collision.disabled;
        const disabledReason = collision.disabledReason;

        agentItems.push({
          name: agent.name,
          displayName: agent.displayName || 'Unnamed Agent',
          agentType: agent.agentType || 'Low Code',
          disabled,
          disabledReason,
          category: agent.category
        });
      }

      const notebookItems: SelectableItem[] = (backupData.notebooks || []).map((nb: any) => {
        const cleanTitle = nb.title || 'Restored Notebook';
        const targetTitle = cleanTitle.endsWith(' (Restored)') ? cleanTitle : `${cleanTitle} (Restored)`;
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
        
        let cacheSuccess = false;
        try {
          await saveMigrationPayload(finalBackupData);
          addLog(`[Cache] Backup copy saved to browser cache for zero-download restore.`);
          setRestoreFileContent(jsonStr);
          setIsCachedBackupLoaded(true);
          setCachedBackupInfo({
            timestamp: new Date().toISOString(),
            itemCount: filteredAgents.length + filteredNotebooks.length
          });
          cacheSuccess = true;
        } catch (cacheErr: any) {
          addLog(`Warning: Failed to cache backup in browser: ${cacheErr.message}`);
        }

        const forceDownload = import.meta.env.VITE_FORCE_DOWNLOAD_BACKUP === 'true';
        if (!cacheSuccess || forceDownload) {
          if (forceDownload) {
            addLog(`Force download enabled. Triggering local backup file download.`);
          } else {
            addLog(`Falling back to local file download.`);
          }
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
        } else {
          addLog(`Backup complete! Data cached in browser. Ready to switch accounts.`);
        }
      });
    } else if (selectionModalAction === 'restore' || selectionModalAction === 'migrate') {
      executeOperation('RestoreUserData', async () => {
        addLog(`Restoring selected items...`);
        const filteredAgents = pendingBackupData.agents.filter((a: any) => selectedNames.has(a.name));
        const filteredNotebooks = pendingBackupData.notebooks.filter((n: any) => selectedNames.has(n.name));
        
        const targetConfig = {
          ...apiConfig,
          projectId: userTabConfig.targetProject,
          appLocation: userTabConfig.targetLocation || apiConfig.appLocation,
          appId: userTabConfig.targetAppId || apiConfig.appId,
          accessToken: targetToken || accessToken,
        };

        // 1. Restore Agents
        if (filteredAgents.length > 0) {
          setProgress({ percent: 10, text: `Restoring ${filteredAgents.length} agents...` });
          addLog(`Restoring ${filteredAgents.length} agents to ${targetConfig.appId}...`);
          await restoreAgentsIntoAssistant(filteredAgents, targetConfig, pendingBackupData.sourceConfig);
        }

        // 2. Restore Notebooks
        if (filteredNotebooks.length > 0) {
          setProgress({ percent: 50, text: `Checking existing notebooks in target...` });
          addLog(`Restoring ${filteredNotebooks.length} notebooks to ${targetConfig.appId}...`);
          
          addLog(`Checking for existing notebooks in target...`);
          let existingNotebooks: any[] = [];
          try {
            const listResponse = await api.listNotebooks(targetConfig);
            existingNotebooks = listResponse.notebooks || [];
          } catch (listErr: any) {
            addLog(`Warning: Could not list existing notebooks in target: ${listErr.message}`);
          }

          let notebookIndex = 0;
          for (const nb of filteredNotebooks) {
            notebookIndex++;
            setProgress({
              percent: 55 + Math.round((notebookIndex / filteredNotebooks.length) * 40),
              text: `Restoring notebook (${notebookIndex}/${filteredNotebooks.length}): ${nb.title || nb.name}...`
            });
            const cleanTitle = nb.title || 'Restored Notebook';
            const targetTitle = cleanTitle.endsWith(' (Restored)') ? cleanTitle : `${cleanTitle} (Restored)`;
            
            const alreadyExists = existingNotebooks.some((n: any) => n.title === targetTitle || n.title === cleanTitle);
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

              if (binding.members) {
                const filteredMembers = binding.members.filter((member: string) => {
                  return !isMemberCurrentUser(member, userEmail || '', userSub || '', poolId) &&
                         (!pendingBackupData?.userEmail || !isMemberCurrentUser(member, pendingBackupData.userEmail, '', poolId));
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

              if (binding.members) {
                const filteredMembers = binding.members.filter((member: string) => {
                  return !isMemberCurrentUser(member, userEmail || '', userSub || '', poolId) &&
                         (!pendingBackupData?.userEmail || !isMemberCurrentUser(member, pendingBackupData.userEmail, '', poolId));
                });
                sharedWith.push(...filteredMembers);
              }
            }
          }
          
          if (sharedWith.length === 0 && nb.metadata?.isShared === true) {
            sharedWith.push("UNKNOWN_SHARED_USERS_PLACEHOLDER");
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
        // Clear IndexedDB cache since migration finished successfully
        clearMigrationPayload().then(() => {
          setRestoreFileContent('');
          setIsCachedBackupLoaded(false);
          setCachedBackupInfo(null);
          addLog(`[Cache] Browser migration cache cleared automatically.`);
        });
      });
    }
  };

  const downloadStepsAsDocx = async () => {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');

    const restoredAgents = manualActionReport.filter(item => item.agentName);
    const restoredNotebooks = manualActionReport.filter(item => item.notebookTitle);

    const children: any[] = [];

    // Header Title
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [
          new TextRun({
            text: "Post-Restoration Checklist",
            bold: true,
            size: 36, // 18pt
            color: "1A365D",
            font: "Calibri",
          }),
        ],
        spacing: { before: 100, after: 50 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: "Backup & Restore App — Finalization Action Items",
            size: 20, // 10pt
            italics: true,
            color: "4A5568",
            font: "Calibri",
          }),
        ],
        spacing: { after: 200 },
      })
    );

    // Step 1: Publish Restored Agents
    if (restoredAgents.length > 0) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: "Step 1: Publish Restored Agents",
              bold: true,
              size: 26, // 13pt
              color: "2B6CB0",
              font: "Calibri",
            }),
          ],
          spacing: { before: 240, after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: "Restored agents are imported in Draft mode. You must deploy and publish each agent to make them live.",
              size: 22, // 11pt
              color: "4A5568",
              font: "Calibri",
            }),
          ],
          spacing: { after: 100 },
        })
      );

      restoredAgents.forEach(agent => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "☐  ",
                bold: true,
                size: 24,
                font: "Calibri",
              }),
              new TextRun({
                text: `Publish Agent: "${agent.agentName}"`,
                bold: true,
                size: 22,
                font: "Calibri",
              }),
            ],
            spacing: { before: 60, after: 40 },
          })
        );
      });
    }

    // Step 2: Update Agent Configurations
    if (restoredAgents.length > 0) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: "Step 2: Update Agent Configurations",
              bold: true,
              size: 26,
              color: "4C51BF",
              font: "Calibri",
            }),
          ],
          spacing: { before: 240, after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: "Verify and update configuration settings for restored agents (e.g., system instructions, models, parameters).",
              size: 22,
              color: "4A5568",
              font: "Calibri",
            }),
          ],
          spacing: { after: 100 },
        })
      );

      restoredAgents.forEach(agent => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "☐  ",
                bold: true,
                size: 24,
                font: "Calibri",
              }),
              new TextRun({
                text: `Verify configurations for: "${agent.agentName}"`,
                bold: true,
                size: 22,
                font: "Calibri",
              }),
            ],
            spacing: { before: 60, after: 40 },
          })
        );
      });
    }

    // Step 3: Adding Files
    const step3AgentItems = restoredAgents.filter(item => 
      (item.knowledgeAttachments && item.knowledgeAttachments.length > 0) || 
      (item.agentFiles && item.agentFiles.length > 0) ||
      (item.unmappedDatastores && item.unmappedDatastores.length > 0)
    );
    const step3NotebookItems = restoredNotebooks.filter(item => 
      item.localFiles && item.localFiles.length > 0
    );

    if (step3AgentItems.length > 0 || step3NotebookItems.length > 0) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: "Step 3: Adding Files & Missing Datastores",
              bold: true,
              size: 26,
              color: "D69E2E",
              font: "Calibri",
            }),
          ],
          spacing: { before: 240, after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: "Re-upload local knowledge files or re-attach datastores that could not be mapped automatically.",
              size: 22,
              color: "4A5568",
              font: "Calibri",
            }),
          ],
          spacing: { after: 100 },
        })
      );

      step3AgentItems.forEach(agent => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "☐  ",
                bold: true,
                size: 24,
                font: "Calibri",
              }),
              new TextRun({
                text: `Restore knowledge attachments for Agent: "${agent.agentName}"`,
                bold: true,
                size: 22,
                font: "Calibri",
              }),
            ],
            spacing: { before: 60, after: 40 },
          })
        );

        if (agent.unmappedDatastores && agent.unmappedDatastores.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: "     * Unmapped Datastores (Action Required): " + agent.unmappedDatastores.join(", "),
                  size: 20,
                  color: "E53E3E",
                  font: "Calibri",
                }),
              ],
              spacing: { after: 40 },
            })
          );
        }

        if (agent.agentFiles && agent.agentFiles.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: "     * Missing Knowledge Files: " + agent.agentFiles.join(", "),
                  size: 20,
                  color: "D69E2E",
                  font: "Calibri",
                }),
              ],
              spacing: { after: 40 },
            })
          );
        }
      });

      step3NotebookItems.forEach(nb => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "☐  ",
                bold: true,
                size: 24,
                font: "Calibri",
              }),
              new TextRun({
                text: `Re-upload local files for Notebook: "${nb.notebookTitle}"`,
                bold: true,
                size: 22,
                font: "Calibri",
              }),
            ],
            spacing: { before: 60, after: 40 },
          })
        );

        if (nb.localFiles && nb.localFiles.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: "     * Local Files: " + nb.localFiles.join(", "),
                  size: 20,
                  color: "D69E2E",
                  font: "Calibri",
                }),
              ],
              spacing: { after: 40 },
            })
          );
        }
      });
    }

    // Step 4: Sharing
    const step4AgentItems = restoredAgents.filter(item => item.sharedWith && item.sharedWith.length > 0);
    const step4NotebookItems = restoredNotebooks.filter(item => item.sharedWith && item.sharedWith.length > 0);

    if (step4AgentItems.length > 0 || step4NotebookItems.length > 0) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: "Step 4: Share & Restore Permissions",
              bold: true,
              size: 26,
              color: "6B46C1",
              font: "Calibri",
            }),
          ],
          spacing: { before: 240, after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: "Reshare restored agents and notebooks with appropriate users or groups.",
              size: 22,
              color: "4A5568",
              font: "Calibri",
            }),
          ],
          spacing: { after: 100 },
        })
      );

      step4AgentItems.forEach(agent => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "☐  ",
                bold: true,
                size: 24,
                font: "Calibri",
              }),
              new TextRun({
                text: `Share Agent: "${agent.agentName}"`,
                bold: true,
                size: 22,
                font: "Calibri",
              }),
            ],
            spacing: { before: 60, after: 40 },
          })
        );

        if (agent.sharedWith && agent.sharedWith.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: "     * Share with: " + agent.sharedWith.join(", "),
                  size: 20,
                  color: "6B46C1",
                  font: "Calibri",
                }),
              ],
              spacing: { after: 40 },
            })
          );
        }
      });

      step4NotebookItems.forEach(nb => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "☐  ",
                bold: true,
                size: 24,
                font: "Calibri",
              }),
              new TextRun({
                text: `Share Notebook: "${nb.notebookTitle}"`,
                bold: true,
                size: 22,
                font: "Calibri",
              }),
            ],
            spacing: { before: 60, after: 40 },
          })
        );

        if (nb.sharedWith && nb.sharedWith.length > 0) {
          const isPlaceholder = nb.sharedWith.includes("UNKNOWN_SHARED_USERS_PLACEHOLDER");
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: isPlaceholder 
                    ? "     * ⚠️ WARNING: This notebook was shared in the source project, but the Notebook API does not expose the list of shared users. Please check your source notebook and manually share this notebook in the target project."
                    : "     * Share with: " + nb.sharedWith.join(", "),
                  size: 20,
                  color: isPlaceholder ? "D97706" : "6B46C1",
                  font: "Calibri",
                  bold: isPlaceholder
                }),
              ],
              spacing: { after: 40 },
            })
          );
        }
      });
    }

    // Create the Document
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: children,
        },
      ],
    });

    // Pack and download
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `post_restore_steps.docx`;
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
    addLog(`  - Starting server-side restore of ${agents.length} agent(s)...`);
    try {
      const result = await api.restoreAgentsServerSide(
        restoreConfig,
        agents,
        datastoreMapping,
        collectionMapping,
        sourceConfig,
        logLevel
      );
      if (result.logs) {
        result.logs.forEach((log: string) => addLog(`  [Server] ${log}`));
      }
      addLog(`  - Server-side restore of agents completed successfully.`);
    } catch (err: any) {
      addLog(`  - ERROR: Server-side restore of agents failed: ${err.message}`);
      throw err;
    }
  };


  
  const processRestoreAgents = async (backupData: any) => {
    const { agents } = backupData;
    if (!agents) {
        addLog("No agent data found in the backup.");
        return;
    }

    const restoreConfig = { ...apiConfig, accessToken };
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
          const { name, displayName, createTime, updateTime, sources, disabled, disabledReason, agentType, ...rest } = notebook;
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

  const renderManualSteps = () => {
    if (!isRestoreComplete) {
      return (
        <p className="text-xs text-gray-600">
          After restore completes, manual steps required to finalize your agents will appear here.
        </p>
      );
    }

    const restoredAgents = manualActionReport.filter(item => item.agentName);
    const restoredNotebooks = manualActionReport.filter(item => item.notebookTitle);

    // Step 3 items
    const step3AgentItems = restoredAgents.filter(item => 
      (item.knowledgeAttachments && item.knowledgeAttachments.length > 0) || 
      (item.agentFiles && item.agentFiles.length > 0) ||
      (item.unmappedDatastores && item.unmappedDatastores.length > 0)
    );
    const step3NotebookItems = restoredNotebooks.filter(item => 
      item.localFiles && item.localFiles.length > 0
    );

    // Step 4 items: only show items that are shared with at least one user
    const step4AgentItems = restoredAgents.filter(item => item.sharedWith && item.sharedWith.length > 0);
    const step4NotebookItems = restoredNotebooks.filter(item => item.sharedWith && item.sharedWith.length > 0);

    return (
      <div className="space-y-6 text-xs text-gray-800 dark:text-gray-200">
        <p className="text-xs text-gray-600 dark:text-white mb-4 font-medium">
          Please complete the following manual steps to finalize your restoration.
        </p>

        {/* Step 1: Publish */}
        {restoredAgents.length > 0 && (
          <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-blue-600 dark:text-blue-400 flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-[10px] font-bold">1</span>
              Step 1: Publish Restored Agents
            </h3>
            <p className="text-gray-500 text-[11px]">
              Restored agents are imported in <strong>Draft</strong> mode. You must deploy and publish each agent to make them live.
            </p>
            <div className="space-y-2 pt-1">
              {restoredAgents.map((agent, idx) => (
                <div key={idx} className="flex items-start gap-2 bg-gray-50 dark:bg-slate-800 p-2 rounded-lg border border-gray-100 dark:border-slate-700">
                  <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer" />
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-white">Publish Agent: "{agent.agentName}"</p>
                    <p className="text-[10px] text-gray-500">Navigate to the agent console and click <strong>Deploy/Publish</strong>.</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Update Agent Configurations */}
        {restoredAgents.length > 0 && (
          <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-bold">2</span>
              Step 2: Update Agent Configurations
            </h3>
            <p className="text-gray-500 text-[11px]">
              Verify and update configuration settings for the restored agents to ensure proper functioning.
            </p>
            <div className="space-y-2 pt-1">
              {restoredAgents.map((agent, idx) => (
                <div key={idx} className="flex items-start gap-2 bg-gray-50 dark:bg-slate-800 p-2 rounded-lg border border-gray-100 dark:border-slate-700">
                  <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" />
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-white">Verify Config for Agent: "{agent.agentName}"</p>
                    <p className="text-[10px] text-gray-500">Check and update the system instructions, model, and tool parameters.</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Add Missing Files */}
        {(step3AgentItems.length > 0 || step3NotebookItems.length > 0) && (
          <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-amber-600 dark:text-amber-400 flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-600 text-[10px] font-bold">3</span>
              Step 3: Add Missing Files & Binds
            </h3>
            <p className="text-gray-500 text-[11px]">
              Re-upload local knowledge files and verify datastore mappings that could not be automatically resolved.
            </p>
            <div className="space-y-2 pt-1">
              {step3AgentItems.map((agent, idx) => (
                <div key={idx} className="bg-gray-50 dark:bg-slate-800 p-3 rounded-lg border border-gray-100 dark:border-slate-700 space-y-2">
                  <div className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-amber-600 focus:ring-amber-500 cursor-pointer" />
                    <div>
                      <p className="font-semibold text-gray-900 dark:text-white">Restore knowledge links for Agent: "{agent.agentName}"</p>
                    </div>
                  </div>
                  <div className="pl-6 space-y-2">
                    {agent.unmappedDatastores && agent.unmappedDatastores.length > 0 && (
                      <div>
                        <p className="font-semibold text-[10px] text-red-600 mb-0.5">Unmapped Datastores (Action Required):</p>
                        <div className="flex flex-wrap gap-1">
                          {agent.unmappedDatastores.map((dsId, dsIdx) => (
                            <span key={dsIdx} className="px-1.5 py-0.5 bg-red-50 text-red-700 rounded text-[10px] font-mono font-medium">
                              {dsId}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {agent.agentFiles && agent.agentFiles.length > 0 && (
                      <div>
                        <p className="font-semibold text-[10px] text-amber-700 mb-0.5">Missing Knowledge Files:</p>
                        <div className="flex flex-wrap gap-1">
                          {agent.agentFiles.map((fileName, fIdx) => (
                            <span key={fIdx} className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded text-[10px] font-medium">
                              {fileName}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {step3NotebookItems.map((nb, idx) => (
                <div key={idx} className="bg-gray-50 dark:bg-slate-800 p-3 rounded-lg border border-gray-100 dark:border-slate-700 space-y-2">
                  <div className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-amber-600 focus:ring-amber-500 cursor-pointer" />
                    <div>
                      <p className="font-semibold text-gray-900 dark:text-white">Re-upload missing files for Notebook: "{nb.notebookTitle}"</p>
                    </div>
                  </div>
                  <div className="pl-6 font-mono text-gray-500">
                    {nb.localFiles && nb.localFiles.length > 0 && (
                      <div>
                        <p className="font-semibold text-[10px] text-amber-700 mb-0.5">Local Files to re-upload:</p>
                        <div className="flex flex-wrap gap-1">
                          {nb.localFiles.map((file, fIdx) => (
                            <span key={fIdx} className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded text-[10px] font-medium font-sans">
                              {file}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 4: Sharing */}
        {(step4AgentItems.length > 0 || step4NotebookItems.length > 0) && (
          <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-purple-600 dark:text-purple-400 flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-purple-100 text-purple-600 text-[10px] font-bold">4</span>
              Step 4: Share & Restore Permissions
            </h3>
            <p className="text-gray-500 text-[11px]">
              Reshare the restored items with the appropriate team members or groups.
            </p>
            <div className="space-y-2 pt-1">
              {step4AgentItems.map((agent, idx) => (
                <div key={idx} className="bg-gray-50 dark:bg-slate-800 p-3 rounded-lg border border-gray-100 dark:border-slate-700 space-y-2">
                  <div className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 cursor-pointer" />
                    <div>
                      <p className="font-semibold text-gray-900 dark:text-white">Share Agent: "{agent.agentName}"</p>
                    </div>
                  </div>
                  <div className="pl-6">
                    {agent.sharedWith && agent.sharedWith.length > 0 ? (
                      <div>
                        <p className="font-semibold text-[10px] text-purple-700 mb-1">Share with the following users:</p>
                        <div className="flex flex-wrap gap-1">
                          {agent.sharedWith.map((user, uidx) => (
                            <span key={uidx} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px] font-medium">
                              {user}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-[10px] text-gray-400">No sharing permissions found in backup.</p>
                    )}
                  </div>
                </div>
              ))}

              {step4NotebookItems.map((nb, idx) => (
                <div key={idx} className="bg-gray-50 dark:bg-slate-800 p-3 rounded-lg border border-gray-100 dark:border-slate-700 space-y-2">
                  <div className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 cursor-pointer" />
                    <div>
                      <p className="font-semibold text-gray-900 dark:text-white">Share Notebook: "{nb.notebookTitle}"</p>
                    </div>
                  </div>
                  <div className="pl-6">
                    {nb.sharedWith && nb.sharedWith.length > 0 && !nb.sharedWith.includes("UNKNOWN_SHARED_USERS_PLACEHOLDER") ? (
                      <div>
                        <p className="font-semibold text-[10px] text-purple-700 mb-1">Share with the following users:</p>
                        <div className="flex flex-wrap gap-1">
                          {nb.sharedWith.map((user, uidx) => (
                            <span key={uidx} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px] font-medium">
                              {user}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-[10px] text-amber-600 font-semibold bg-amber-50 dark:bg-slate-700 dark:text-amber-400 p-1.5 rounded border border-amber-200 dark:border-slate-650">
                        ⚠️ This notebook was shared in the source project. However, the Notebook API does not expose the list of shared users. Please check your source notebook and manually share this notebook in the target project.
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {manualActionReport.length === 0 && (
          <div className="text-center py-4 text-gray-500 text-sm">
            No manual steps required! All items were successfully restored.
          </div>
        )}

        <div className="mt-4">
          <button
            onClick={downloadStepsAsDocx}
            className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2 cursor-pointer font-sans"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download DOCX Checklist
          </button>
        </div>
      </div>
    );
  };

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
          actionLabel={selectionModalAction === 'backup' ? 'Backup' : (selectionModalAction === 'migrate' ? 'Migrate' : 'Restore')}
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
                          const apps = await fetchAppsForProject(userTabConfig.targetProject, userTabConfig.targetLocation, targetToken || accessToken);
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
                          const apps = await fetchAppsForProject(userTabConfig.targetProject, newLoc, targetToken || accessToken);
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

              {/* Migration Scope / Security Options */}
              <div className="border-t border-gray-100 pt-4 space-y-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Migration Scope & Agent View Settings</h3>
                <div className="flex items-start gap-2">
                  <input 
                    type="checkbox" 
                    id="bypassOwnerFilter"
                    checked={!!userTabConfig.bypassOwnerFilter} 
                    onChange={(e) => setUserTabConfig(prev => ({ ...prev, bypassOwnerFilter: e.target.checked }))} 
                    className="mt-1 w-4 h-4 rounded text-indigo-600 border-gray-300 focus:ring-indigo-500"
                  />
                  <div>
                    <label htmlFor="bypassOwnerFilter" className="text-sm font-medium text-gray-700 cursor-pointer select-none">
                      Migrate all agents in selected Engine (bypasses WIF user-level owner filtering)
                    </label>
                    <p className="text-xs text-gray-400 mt-1">
                      Check this if the selected source Engine represents a personal or single-user workspace app. Bypassing individual owner check ensures default agents (e.g., HR-Advisory2) and shared assets are correctly migrated.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2 border-t border-gray-50 pt-3">
                  <input 
                    type="checkbox" 
                    id="enableAgentViewFallback"
                    checked={!!userTabConfig.enableAgentViewFallback} 
                    onChange={(e) => setUserTabConfig(prev => ({ ...prev, enableAgentViewFallback: e.target.checked }))} 
                    className="mt-1 w-4 h-4 rounded text-indigo-600 border-gray-300 focus:ring-indigo-500"
                  />
                  <div>
                    <label htmlFor="enableAgentViewFallback" className="text-sm font-medium text-gray-700 cursor-pointer select-none">
                      Enable Agent View Fallback
                    </label>
                    <p className="text-xs text-gray-400 mt-1">
                      When enabled, if the main Agent View API fails (e.g., due to workforce pool permissions), the application will fall back to structural check and IAM policy queries to classify low-code agents and verify ownership.
                    </p>
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
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(userIdStatus.details || '');
                      alert('Instructions copied to clipboard!');
                    }} 
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    Copy Instructions
                  </button>
                )}
              </div>
              <div className="mt-2 text-xs text-gray-600 whitespace-pre-wrap">
                {userIdStatus.details}
              </div>
            </div>
          )}



          {featureFlags.idpChangeEnabled ? (
            <>
              {/* Step 1: Backup from Source */}
              <div className="mb-6 p-4 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-2">Step 1: Backup from Source</h3>
                <p className="text-xs text-gray-600 dark:text-slate-300 mb-3">
                  Log in with your source account and click "Backup My Data" to download your configuration.
                </p>
                <button
                  onClick={handleUserBackupCombined}
                  disabled={isLoading || !userTabConfig.sourceProject}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-md transition-colors disabled:bg-gray-300 flex items-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Backup My Data
                </button>
              </div>

              {/* Step 2: Switch Account & Verify Connectors */}
              <div className="mb-6 p-4 rounded-lg border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-2">Step 2: Switch Account & Verify Connectors</h3>
                <div className="mb-3">
                  <p className="text-xs text-gray-600 dark:text-slate-300 mb-3">
                    Log out of the source account, log into the target environment using the destination IDP, and ensure all required federated connectors are authenticated.
                  </p>
                  <button 
                    onClick={onSignOut}
                    className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-md flex items-center justify-center gap-2 mb-3"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    <span>Sign Out & Switch to {import.meta.env.VITE_TARGET_IDP || 'Target IDP'}</span>
                  </button>
                  {userTabConfig.targetAppUrl && (
                    <a 
                      href={userTabConfig.targetAppUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-md flex items-center justify-center gap-2 mb-3"
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
                    id="step2Auth" 
                    checked={isStep1Complete} 
                    onChange={(e) => setIsStep1Complete(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="step2Auth" className="text-sm text-gray-700 dark:text-white font-medium cursor-pointer">
                    I have authenticated all required connectors in the target environment.
                  </label>
                </div>
              </div>

              {/* Step 3: Restore to Target */}
              <div className={`mb-6 p-4 rounded-lg border ${isStep1Complete ? 'border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700' : 'border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 opacity-50'}`}>
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-2">Step 3: Restore to Target</h3>
                {isCachedBackupLoaded && cachedBackupInfo ? (
                  <div className="mb-4 p-3 bg-green-50 dark:bg-slate-800 border border-green-200 dark:border-slate-600 rounded-lg flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-ping"></span>
                      <span className="text-xs font-semibold text-green-800 dark:text-green-200">
                        Ready: Browser cached backup loaded ({cachedBackupInfo.itemCount} items)
                      </span>
                    </div>
                    <button 
                      onClick={handleClearCachedBackup}
                      className="text-xs text-red-600 hover:text-red-800 underline font-semibold"
                    >
                      Clear Cache & Upload file
                    </button>
                  </div>
                ) : (
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

              {/* Step 4: Finalize */}
              <div className={`mb-6 p-4 rounded-lg border ${isRestoreComplete ? 'border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700' : 'border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 opacity-50'}`}>
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-2">Step 4: Complete Setup</h3>
                {renderManualSteps()}
              </div>
            </>
          ) : (
            <>
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
                    <>
                      {isCachedBackupLoaded && cachedBackupInfo ? (
                        <div className="w-full max-w-md mb-4 p-3 bg-green-50 dark:bg-slate-800 border border-green-200 dark:border-slate-600 rounded-lg flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-ping"></span>
                            <span className="text-xs font-semibold text-green-800 dark:text-green-200">
                              Ready: Browser cached backup loaded ({cachedBackupInfo.itemCount} items)
                            </span>
                          </div>
                          <button 
                            onClick={handleClearCachedBackup}
                            className="text-xs text-red-600 hover:text-red-800 underline font-semibold"
                          >
                            Clear Cache
                          </button>
                        </div>
                      ) : (
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
                    </>
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
                {renderManualSteps()}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'admin' && (
        <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-200 dark:border-slate-700 relative">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Admin Configuration</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Configure source and target environments and map datastores.</p>
          
          <div className="flex justify-end gap-2 mb-4">
            <button
              onClick={handleResetAdminConfig}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm flex items-center gap-1"
            >
              Reset
            </button>
            <button
              onClick={handleSaveAdminConfig}
              className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm flex items-center gap-1"
            >
              Save
            </button>
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
              <div className="grid grid-cols-5 gap-4 items-end">
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
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Identity Provider (IDP)</label>
                  <select 
                    value={sourceIdp} 
                    onChange={(e) => setSourceIdp(e.target.value)}
                    className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                  >
                    <option value="Google">Google</option>
                    <option value="WiF">WiF</option>
                    <option value="Okta">Okta</option>
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
              <div className="grid grid-cols-5 gap-4 items-end">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Project ID</label>
                  <div className="flex gap-1">
                    <input type="text" value={userTabConfig.targetProject} onChange={(e) => setUserTabConfig(prev => ({ ...prev, targetProject: e.target.value }))} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                    <button 
                      onClick={async () => {
                        setIsLoadingTargetApps(true);
                        const apps = await fetchAppsForProject(userTabConfig.targetProject, userTabConfig.targetLocation, targetToken || accessToken);
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
                        const apps = await fetchAppsForProject(userTabConfig.targetProject, newLocation, targetToken || accessToken);
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
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Identity Provider (IDP)</label>
                  <select 
                    value={targetIdp} 
                    onChange={(e) => setTargetIdp(e.target.value)}
                    className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                  >
                    <option value="Google">Google</option>
                    <option value="WiF">WiF</option>
                    <option value="Okta">Okta</option>
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

            {/* Feature Flags */}
            <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Feature Flags</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id="idpChangeEnabled" 
                    checked={featureFlags.idpChangeEnabled} 
                    onChange={(e) => setFeatureFlags({...featureFlags, idpChangeEnabled: e.target.checked})}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="idpChangeEnabled" className="text-xs text-gray-700 dark:text-white font-medium cursor-pointer">
                    IDP Change Enabled
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id="enableGoogleIdp" 
                    checked={featureFlags.enableGoogleIdp} 
                    onChange={(e) => setFeatureFlags({...featureFlags, enableGoogleIdp: e.target.checked})}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="enableGoogleIdp" className="text-xs text-gray-700 dark:text-white font-medium cursor-pointer">
                    Enable Google IDP
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id="enableWifIdp" 
                    checked={featureFlags.enableWifIdp} 
                    onChange={(e) => setFeatureFlags({...featureFlags, enableWifIdp: e.target.checked})}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="enableWifIdp" className="text-xs text-gray-700 dark:text-white font-medium cursor-pointer">
                    Enable WiF IDP
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id="enableOktaIdp" 
                    checked={featureFlags.enableOktaIdp} 
                    onChange={(e) => setFeatureFlags({...featureFlags, enableOktaIdp: e.target.checked})}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="enableOktaIdp" className="text-xs text-gray-700 dark:text-white font-medium cursor-pointer">
                    Enable Okta IDP
                  </label>
                </div>
              </div>
            </div>

            {/* Google Configuration */}
            {featureFlags.enableGoogleIdp && (
              <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Google Configuration</h3>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Google Client ID</label>
                  <input 
                    type="text" 
                    value={googleClientId} 
                    onChange={(e) => setGoogleClientId(e.target.value)} 
                    className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" 
                  />
                </div>
              </div>
            )}

            {/* WIF Configuration */}
            {featureFlags.enableWifIdp && (
              <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">WIF Configuration</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">User Project</label>
                    <input type="text" value={wifConfigState.userProject} onChange={(e) => setWifConfigState({...wifConfigState, userProject: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Pool ID</label>
                    <input type="text" value={wifConfigState.poolId} onChange={(e) => setWifConfigState({...wifConfigState, poolId: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Provider ID</label>
                    <input type="text" value={wifConfigState.providerId} onChange={(e) => setWifConfigState({...wifConfigState, providerId: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Client ID</label>
                    <input type="text" value={wifConfigState.clientId} onChange={(e) => setWifConfigState({...wifConfigState, clientId: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Auth Endpoint</label>
                    <input type="text" value={wifConfigState.authEndpoint} onChange={(e) => setWifConfigState({...wifConfigState, authEndpoint: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Redirect URI</label>
                    <input type="text" value={wifConfigState.redirectUri} onChange={(e) => setWifConfigState({...wifConfigState, redirectUri: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                </div>
              </div>
            )}

            {/* Okta Configuration */}
            {featureFlags.enableOktaIdp && (
              <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Okta Configuration</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">User Project</label>
                    <input type="text" value={oktaConfigState.userProject} onChange={(e) => setOktaConfigState({...oktaConfigState, userProject: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Pool ID</label>
                    <input type="text" value={oktaConfigState.poolId} onChange={(e) => setOktaConfigState({...oktaConfigState, poolId: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Provider ID</label>
                    <input type="text" value={oktaConfigState.providerId} onChange={(e) => setOktaConfigState({...oktaConfigState, providerId: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Client ID</label>
                    <input type="text" value={oktaConfigState.clientId} onChange={(e) => setOktaConfigState({...oktaConfigState, clientId: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Client Secret (Optional for SPA)</label>
                    <input type="password" placeholder="••••••••" value={oktaConfigState.clientSecret || ''} onChange={(e) => setOktaConfigState({...oktaConfigState, clientSecret: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div className="flex items-center gap-2 pt-4 col-span-2">
                    <input 
                      type="checkbox" 
                      id="pageOktaUseBackendExchange" 
                      checked={!!oktaConfigState.useBackendExchange} 
                      onChange={(e) => setOktaConfigState({...oktaConfigState, useBackendExchange: e.target.checked})}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <label htmlFor="pageOktaUseBackendExchange" className="text-xs font-semibold text-gray-700 dark:text-white cursor-pointer">
                      Use Backend Exchange (Web Application)
                    </label>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Auth Endpoint</label>
                    <input type="text" value={oktaConfigState.authEndpoint} onChange={(e) => setOktaConfigState({...oktaConfigState, authEndpoint: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 dark:text-white mb-1">Redirect URI</label>
                    <input type="text" value={oktaConfigState.redirectUri} onChange={(e) => setOktaConfigState({...oktaConfigState, redirectUri: e.target.value})} className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white" />
                  </div>
                </div>
              </div>
            )}

            {/* Migration Settings */}
            <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600 space-y-4">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Migration Settings</h3>
              <div className="flex gap-4 pb-3 border-b border-gray-200 dark:border-slate-600">
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id="migrateAgents" 
                    checked={shouldMigrateAgents} 
                    onChange={(e) => setShouldMigrateAgents(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="migrateAgents" className="text-xs text-gray-700 dark:text-white font-medium cursor-pointer">
                    Migrate Agents
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id="migrateNotebooks" 
                    checked={shouldMigrateNotebooks} 
                    onChange={(e) => setShouldMigrateNotebooks(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="migrateNotebooks" className="text-xs text-gray-700 dark:text-white font-medium cursor-pointer">
                    Migrate Notebooks
                  </label>
                </div>
              </div>

              <div className="space-y-3 pt-1">
                <div className="flex items-start gap-2">
                  <input 
                    type="checkbox" 
                    id="adminBypassOwnerFilter" 
                    checked={!!userTabConfig.bypassOwnerFilter} 
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setUserTabConfig(prev => ({ ...prev, bypassOwnerFilter: checked }));
                    }}
                    className="mt-0.5 w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                  />
                  <div>
                    <label htmlFor="adminBypassOwnerFilter" className="text-xs text-gray-700 dark:text-white font-semibold cursor-pointer select-none">
                      Bypass user WIF owner filter (Migrate all agents in context)
                    </label>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Ensures default workspace agents and shared assets are migrated without restriction.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <input 
                    type="checkbox" 
                    id="adminEnableAgentViewFallback" 
                    checked={!!userTabConfig.enableAgentViewFallback} 
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setUserTabConfig(prev => ({ ...prev, enableAgentViewFallback: checked }));
                    }}
                    className="mt-0.5 w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                  />
                  <div>
                    <label htmlFor="adminEnableAgentViewFallback" className="text-xs text-gray-700 dark:text-white font-semibold cursor-pointer select-none">
                      Enable Agent View Fallback (structural check & IAM policy fallback)
                    </label>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Falls back to structural detection and IAM queries if getAgentView returns a permission failure.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Logging Settings */}
            <div className="bg-gray-50 dark:bg-slate-700 p-4 rounded-lg border border-gray-200 dark:border-slate-600">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-white mb-3">Logging Settings</h3>
              <div className="grid grid-cols-5 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 dark:text-white mb-1">Logging Level</label>
                  <select 
                    value={logLevel} 
                    onChange={(e) => setLogLevel(e.target.value as LogLevel)}
                    className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg p-2 text-sm w-full focus:ring-blue-500 focus:border-blue-500 dark:text-white"
                  >
                    <option value="DEBUG">DEBUG (Verbose)</option>
                    <option value="INFO">INFO (Standard)</option>
                    <option value="WARN">WARN (Warnings & Errors)</option>
                    <option value="ERROR">ERROR (Errors Only)</option>
                  </select>
                </div>
              </div>
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
        {(isLoading || logs.length > 0) && (
          <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-200 dark:border-slate-700 mt-6">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center">
              {isLoading && <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-blue-600 mr-3"></div>}
              {isLoading ? `Running: ${loadingSection?.replace(/[A-Z]/g, ' $&').trim()}` : 'Operation Logs'}
            </h2>
            {error && <div className="text-sm text-red-600 p-3 mb-3 bg-red-50 border border-red-200 rounded-lg">{error}</div>}
            
            {/* Progress Bar */}
            {isLoading && progress && (
              <div className="mb-4">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-semibold text-gray-600 dark:text-slate-400">
                    {progress.text}
                  </span>
                  <span className="text-xs font-bold text-blue-600 dark:text-blue-400">
                    {progress.percent}%
                  </span>
                </div>
                <div className="w-full bg-gray-100 dark:bg-slate-900 rounded-full h-2 overflow-hidden border border-gray-200 dark:border-slate-700">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out" 
                    style={{ width: `${progress.percent}%` }}
                  ></div>
                </div>
              </div>
            )}

            <pre className="bg-gray-50 dark:bg-slate-900 text-xs text-gray-700 dark:text-slate-300 p-4 rounded-lg h-64 overflow-y-auto font-mono border border-gray-200 dark:border-slate-700">
              {logs.join('\n')}
            </pre>
          </div>
        )}
    </div>
  );
};

export default BackupPage;
