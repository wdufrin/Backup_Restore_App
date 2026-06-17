import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
          process.env[key] = value;
        }
      }
    });
  }
} catch (err) {
  console.error('Error loading .env file:', err);
}


const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));

// --- Logging Configuration and Helpers ---
const LEVEL_VALUES = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const getLogLevel = (message) => {
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

const shouldLog = (message, currentLevel) => {
  const msgLevel = getLogLevel(message);
  const msgVal = LEVEL_VALUES[msgLevel] ?? 1;
  const currentVal = LEVEL_VALUES[currentLevel.toUpperCase()] ?? 1;
  return msgVal >= currentVal;
};

// Helper to determine base URL for Discovery Engine
const getDiscoveryEngineUrl = (location) => {
  return location === 'global'
    ? 'https://discoveryengine.googleapis.com'
    : `https://${location}-discoveryengine.googleapis.com`;
};

// Helper for native fetch requests with optional Bearer token
async function gapiRequest(url, method, token, projectId, body = null) {
  const headers = {
    'Accept': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (projectId) {
    headers['X-Goog-User-Project'] = projectId;
  }
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  };

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `API Request Failed: ${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed.error?.message) {
        errorMessage = parsed.error.message;
      }
    } catch (_) {}
    throw new Error(errorMessage);
  }
  return response.json();
}

// Dependency-free Concurrency Limiter
async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// --- API Endpoints ---

// 1. Server-Side Backup of Agents
app.post('/api/backup/agents', async (req, res) => {
  const { projectId, appLocation, collectionId, appId, assistantId, accessToken, logLevel: bodyLogLevel } = req.body;

  if (!projectId || !appLocation || !collectionId || !appId || !assistantId || !accessToken) {
    return res.status(400).json({ error: 'Missing required configuration fields or accessToken' });
  }

  const logLevel = bodyLogLevel || process.env.VITE_LOG_LEVEL || process.env.LOG_LEVEL || 'INFO';
  const logs = [];
  const addLog = (msg) => {
    if (shouldLog(msg, logLevel)) {
      const formatted = `[${new Date().toISOString()}] ${msg}`;
      logs.push(formatted);
      console.log(formatted);
    }
  };

  try {
    addLog(`Starting server-side backup for agents in Assistant: ${assistantId}...`);
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    
    // Step A: List all agents (paginated)
    const agents = [];
    let pageToken = undefined;
    do {
      let url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants/${assistantId}/agents?pageSize=200`;
      if (pageToken) url += `&pageToken=${pageToken}`;
      
      const response = await gapiRequest(url, 'GET', accessToken, projectId);
      agents.push(...(response.agents || []));
      pageToken = response.nextPageToken;
    } while (pageToken);

    addLog(`Found ${agents.length} agent(s) in project. Fetching views and policies in parallel...`);

    // Step B: Fetch Agent Views and IAM Policies in parallel (Concurrency Limit: 15)
    const lowCodeAgents = [];
    await mapConcurrent(agents, 15, async (agent) => {
      try {
        // Fetch Agent View to check type
        let isLowCode = true;
        try {
          const rawResponse = await gapiRequest(`${baseUrl}/v1alpha/${agent.name}:getAgentView`, 'GET', accessToken, projectId);
          const agentView = rawResponse?.agentView || rawResponse;
          const rawAgentType = agentView?.agentType;
          if (rawAgentType && rawAgentType !== 'LOW_CODE' && rawAgentType !== 'Low Code') {
            isLowCode = false;
          }
        } catch (viewErr) {
          // Fallback check if agent view fails
          if (agent.adkAgentDefinition || agent.a2aAgentDefinition) {
            isLowCode = false;
          }
        }

        if (!isLowCode) {
          return;
        }

        // Fetch IAM Policy
        let policy = null;
        try {
          policy = await gapiRequest(`${baseUrl}/v1alpha/${agent.name}:getIamPolicy`, 'GET', accessToken, projectId);
        } catch (iamErr) {
          addLog(`Warning: Failed to fetch IAM policy for agent ${agent.name}: ${iamErr.message}`);
        }

        const agentWithPolicy = { ...agent };
        if (policy) {
          agentWithPolicy.iamPolicy = policy;
        }
        lowCodeAgents.push(agentWithPolicy);
      } catch (err) {
        addLog(`Error backing up agent details for ${agent.name}: ${err.message}`);
      }
    });

    addLog(`Backup complete. Compiled ${lowCodeAgents.length} low-code agent(s).`);
    res.json({ agents: lowCodeAgents, logs });
  } catch (err) {
    addLog(`Critical backup failure: ${err.message}`);
    res.status(500).json({ error: err.message, logs });
  }
});

// 2. Server-Side Restore of Agents
app.post('/api/restore/agents', async (req, res) => {
  const {
    restoreConfig,
    agents,
    datastoreMapping = {},
    collectionMapping = {},
    sourceConfig = null,
    logLevel: bodyLogLevel
  } = req.body;

  const { projectId, appLocation, collectionId, appId, assistantId, accessToken } = restoreConfig;

  if (!projectId || !appLocation || !collectionId || !appId || !assistantId || !accessToken) {
    return res.status(400).json({ error: 'Missing target configuration parameters' });
  }

  const logLevel = bodyLogLevel || process.env.VITE_LOG_LEVEL || process.env.LOG_LEVEL || 'INFO';
  const logs = [];
  const addLog = (msg) => {
    if (shouldLog(msg, logLevel)) {
      const formatted = `[${new Date().toISOString()}] ${msg}`;
      logs.push(formatted);
      console.log(formatted);
    }
  };

  try {
    addLog(`Starting server-side restore of ${agents.length} agent(s)...`);
    const baseUrl = getDiscoveryEngineUrl(appLocation);

    // Step A: List existing target agents to detect duplicates
    const existingAgents = [];
    let pageToken = undefined;
    try {
      do {
        let url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants/${assistantId}/agents?pageSize=200`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const res = await gapiRequest(url, 'GET', accessToken, projectId);
        existingAgents.push(...(res.agents || []));
        pageToken = res.nextPageToken;
      } while (pageToken);
      addLog(`Target project check: Found ${existingAgents.length} existing agent(s).`);
    } catch (e) {
      addLog(`Warning: Failed to list existing target agents for duplication check: ${e.message}`);
    }

    // Step B: Helper to build payloads
    const buildPayload = (currentAgent) => {
      const finalStarterPrompts = (currentAgent.starterPrompts || [])
        .map(p => p.text ? p.text.trim() : '')
        .filter(text => text)
        .map(text => ({ text }));

      let restoredDisplayName = currentAgent.displayName;
      if (currentAgent.dataStoreConnections && currentAgent.dataStoreConnections.length > 0) {
        restoredDisplayName = `[Replace] ${restoredDisplayName}`;
      }

      const payload = {
        displayName: restoredDisplayName,
        description: currentAgent.description || '',
        icon: currentAgent.icon || undefined,
        starterPrompts: finalStarterPrompts.length > 0 ? finalStarterPrompts : undefined,
        authorizationConfig: currentAgent.authorizationConfig,
        authorizations: !currentAgent.authorizationConfig ? currentAgent.authorizations : undefined,
      };

      const blacklist = ['name', 'createTime', 'updateTime', 'agentIdentityInfo', 'iamPolicy', 'agentType', 'disabled', 'disabledReason', 'category'];
      for (const key of Object.keys(currentAgent)) {
        if (!blacklist.includes(key) && !(key in payload)) {
          payload[key] = currentAgent[key];
        }
      }

      // Remap datastores
      if (payload.dataStoreConnections) {
        const rewrittenConnections = [];
        for (const conn of payload.dataStoreConnections) {
          if (conn.dataStore) {
            const parts = conn.dataStore.split('/');
            const colIndex = parts.indexOf('collections');
            const oldColId = colIndex !== -1 ? parts[colIndex + 1] : 'default_collection';
            const oldDsId = conn.dataStore.split('/').pop();

            if (!oldDsId) {
              rewrittenConnections.push(conn);
              continue;
            }

            const mappedTargetId = datastoreMapping[oldDsId];
            if (mappedTargetId === undefined || mappedTargetId === '') {
              addLog(`Warning: Datastore '${oldDsId}' is not mapped. Skipping this connection.`);
              continue;
            }

            const targetLocation = appLocation || 'global';
            let targetCollection = 'default_collection';
            if (oldColId && collectionMapping[oldColId]) {
              targetCollection = collectionMapping[oldColId];
            }

            rewrittenConnections.push({
              ...conn,
              dataStore: `projects/${projectId}/locations/${targetLocation}/collections/${targetCollection}/dataStores/${mappedTargetId}`
            });
          } else {
            rewrittenConnections.push(conn);
          }
        }

        // Deduplicate
        const seenDataStores = new Set();
        payload.dataStoreConnections = rewrittenConnections.filter((conn) => {
          if (conn.dataStore) {
            if (seenDataStores.has(conn.dataStore)) return false;
            seenDataStores.add(conn.dataStore);
          }
          return true;
        });
      }

      // Remap authorizations
      const rewriteAuth = (authName) => {
        if (!authName) return authName;
        const authId = authName.split('/').pop();
        return `projects/${projectId}/locations/${appLocation || 'global'}/authorizations/${authId}`;
      };

      if (payload.authorizationConfig?.toolAuthorizations) {
        payload.authorizationConfig.toolAuthorizations = payload.authorizationConfig.toolAuthorizations.map(rewriteAuth);
      }
      if (payload.authorizations) {
        payload.authorizations = payload.authorizations.map(rewriteAuth);
      }

      // Replacements on agent definition
      const definitionKeys = Object.keys(payload).filter(key => key.toLowerCase().includes('agentdefinition'));
      for (const key of definitionKeys) {
        let definition = payload[key];
        if (definition) {
          if (definition.session) {
            delete definition.session;
          }
          if (definition.agentFiles) {
            delete definition.agentFiles;
          }
          if (definition.deployedAgentFiles) {
            delete definition.deployedAgentFiles;
          }

          let defStr = JSON.stringify(definition);

          const nameParts = currentAgent.name.split('/');
          const engineIndex = nameParts.indexOf('engines');
          const oldEngineId = engineIndex !== -1 ? nameParts[engineIndex + 1] : null;

          if (oldEngineId && appId) {
            defStr = defStr.split(oldEngineId).join(appId);
          }
          if (sourceConfig && sourceConfig.projectId) {
            defStr = defStr.split(sourceConfig.projectId).join(projectId);
          }
          const oldProjectNumber = nameParts[1];
          if (oldProjectNumber) {
            defStr = defStr.split(oldProjectNumber).join(projectId);
          }
          if (sourceConfig && sourceConfig.appLocation) {
            defStr = defStr.split(sourceConfig.appLocation).join(appLocation);
          }
          const oldLocation = nameParts[3];
          if (oldLocation) {
            defStr = defStr.split(`/locations/${oldLocation}/`).join(`/locations/${appLocation}/`);
          }

          // Remap collection & datastore references inside definition payload
          Object.entries(collectionMapping)
            .sort((a, b) => b[0].length - a[0].length)
            .forEach(([oldColId, newColId]) => {
              defStr = defStr.split(`/collections/${oldColId}/`).join(`/collections/${newColId}/`);
            });

          Object.entries(datastoreMapping)
            .sort((a, b) => b[0].length - a[0].length)
            .forEach(([oldDsId, newDsId]) => {
              if (newDsId) {
                defStr = defStr.split(`/dataStores/${oldDsId}`).join(`/dataStores/${newDsId}`);
              }
            });

          definition = JSON.parse(defStr);
        }
        payload[key] = definition;
      }

      return payload;
    };

    // Step C: Restore agents in parallel (Concurrency Limit: 10)
    await mapConcurrent(agents, 10, async (agent) => {
      const originalAgentId = agent.name.split('/').pop();
      addLog(`Preparing to restore agent: ${agent.displayName} (original ID: ${originalAgentId})`);

      const createPayload = buildPayload(agent);
      let targetAgentName = '';
      let targetAgentId = '';

      try {
        const targetId = agent.targetId || undefined;
        let createUrl = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants/${assistantId}/agents`;
        if (targetId) {
          createUrl += `?agentId=${targetId}`;
        }

        const newAgent = await gapiRequest(createUrl, 'POST', accessToken, projectId, createPayload);
        targetAgentName = newAgent.name;
        targetAgentId = targetAgentName.split('/').pop();
        addLog(`CREATED: Agent '${agent.displayName}' created with new ID '${targetAgentId}'.`);

        // Restore IAM Policy
        if (agent.iamPolicy && agent.iamPolicy.bindings) {
          const hasAgentUser = agent.iamPolicy.bindings.some(b => b.role === 'roles/discoveryengine.agentUser');
          if (hasAgentUser) {
            try {
              const currentPolicy = await gapiRequest(`${baseUrl}/v1alpha/${targetAgentName}:getIamPolicy`, 'GET', accessToken, projectId);
              
              const mappedBindings = agent.iamPolicy.bindings.map(b => {
                if (b.role === 'roles/discoveryengine.agentOwner') {
                  return { ...b, role: 'roles/discoveryengine.agentEditor' };
                }
                return b;
              });

              const mergedBindings = currentPolicy.bindings ? [...currentPolicy.bindings] : [];
              mappedBindings.forEach(backupBinding => {
                const existingBinding = mergedBindings.find(b => b.role === backupBinding.role);
                if (existingBinding) {
                  existingBinding.members = Array.from(new Set([...(existingBinding.members || []), ...(backupBinding.members || [])]));
                } else {
                  mergedBindings.push(backupBinding);
                }
              });

              const payloadPolicy = {
                bindings: mergedBindings,
                etag: currentPolicy.etag
              };

              await gapiRequest(`${baseUrl}/v1alpha/${targetAgentName}:setIamPolicy`, 'POST', accessToken, projectId, { policy: payloadPolicy });
              addLog(`IAM policy restored for agent: ${targetAgentId}`);
            } catch (iamErr) {
              addLog(`Warning: Failed to apply IAM policy for agent ${targetAgentId}: ${iamErr.message}`);
            }
          }
        }
      } catch (err) {
        addLog(`Failed to restore agent ${agent.displayName}: ${err.message}`);
      }
    });

    addLog('Restore processing completed.');
    res.json({ success: true, logs });
  } catch (err) {
    addLog(`Critical restore failure: ${err.message}`);
    res.status(500).json({ error: err.message, logs });
  }
});

// Serve frontend build static files
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback SPA routing - redirect non-file requests to index.html
app.get('*any', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
