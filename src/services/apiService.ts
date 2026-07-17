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
 * 
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


import type { Agent, AppEngine, Assistant, Authorization, Config, DataStore, Document, ReasoningEngine, CloudRunService, DiscoverySession, ReasoningEngineSession, WidgetConfig } from '../types';
import { getGapiClient } from './gapiService';

const DISCOVERY_API_VERSION = 'v1alpha';
const DISCOVERY_API_BETA = 'v1beta';

// Helper to determine base URL for Discovery Engine
const getDiscoveryEngineUrl = (location: string) => {
  return location === 'global'
    ? 'https://discoveryengine.googleapis.com'
    : `https://${location}-discoveryengine.googleapis.com`;
};

// Debug Logger Callback Type
type DebugLogger = (log: { method: string, url: string, headers: any, body: any, curlCommand: string }) => void;

let debugLogger: DebugLogger | null = null;

export const setDebugLogger = (logger: DebugLogger | null) => {
    debugLogger = logger;
};

// Helper to generate cURL command
const generateCurlCommand = (url: string, method: string, headers: any, body: any): string => {
    let command = `curl -X ${method} \\\n  "${url}"`;

    Object.keys(headers).forEach(key => {
        command += ` \\\n  -H "${key}: ${headers[key]}"`;
    });

    if (body) {
        // Ensure body is stringified if it's an object
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        // Escape single quotes (basic escaping)
        const escapedBody = bodyStr.replace(/'/g, "'\\''");
        command += ` \\\n  -d '${escapedBody}'`;
    }

    return command;
};

// Generic gapi request wrapper
const resolveQuotaProject = (projectId?: string, requestHeaders?: any, accessToken?: string): string | undefined => {
    if (!projectId) return undefined;

    try {
        const getSessionItem = (key: string): string | null => {
            if (typeof sessionStorage !== 'undefined' && sessionStorage && typeof sessionStorage.getItem === 'function') {
                return sessionStorage.getItem(key);
            }
            return null;
        };

        const getLocalItem = (key: string): string | null => {
            if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
                return localStorage.getItem(key);
            }
            return null;
        };

        const sourceToken = getSessionItem('agentspace-sourceToken');
        const targetToken = getSessionItem('agentspace-targetToken');
        const defaultToken = getSessionItem('agentspace-accessToken');
        
        const sourceIdp = getLocalItem('agentspace-sourceIdp') || 'Google';
        const targetIdp = getLocalItem('agentspace-targetIdp') || 'Google';
        
        let requestToken = accessToken;
        if (!requestToken && requestHeaders && requestHeaders['Authorization']) {
            const authHeader = requestHeaders['Authorization'];
            if (authHeader.startsWith('Bearer ')) {
                requestToken = authHeader.replace('Bearer ', '').trim();
            }
        }
        if (!requestToken) {
            requestToken = sourceToken || defaultToken || undefined;
        }

        console.log("[DEBUG QUOTA] resolveQuotaProject inputs:", {
            projectId,
            sourceIdp,
            targetIdp,
            hasSourceToken: !!sourceToken,
            hasTargetToken: !!targetToken,
            hasDefaultToken: !!defaultToken,
            hasRequestToken: !!requestToken,
            requestTokenMatchesSource: requestToken === sourceToken,
            requestTokenMatchesTarget: requestToken === targetToken,
            requestTokenMatchesDefault: requestToken === defaultToken,
        });
        
        const getWifUserProject = (idp: string): string | undefined => {
            console.log("[DEBUG QUOTA] getWifUserProject for IDP:", idp);
            if (idp === 'WiF' || idp === 'Okta') {
                const configKey = idp === 'WiF' ? 'agentspace-wifConfig' : 'agentspace-oktaConfig';
                const configStr = getLocalItem(configKey);
                console.log(`[DEBUG QUOTA] Config key ${configKey} exists:`, !!configStr);
                if (configStr) {
                    const parsed = JSON.parse(configStr);
                    console.log(`[DEBUG QUOTA] Config userProject:`, parsed.userProject);
                    if (parsed.userProject) return parsed.userProject;
                }
                
                const fallbackKey = idp === 'WiF' ? 'agentspace-oktaConfig' : 'agentspace-wifConfig';
                const fallbackStr = getLocalItem(fallbackKey);
                console.log(`[DEBUG QUOTA] Fallback key ${fallbackKey} exists:`, !!fallbackStr);
                if (fallbackStr) {
                    const parsed = JSON.parse(fallbackStr);
                    console.log(`[DEBUG QUOTA] Fallback userProject:`, parsed.userProject);
                    if (parsed.userProject) return parsed.userProject;
                }
            }
            return undefined;
        };

        let resolved = projectId;
        if (sourceToken && targetToken) {
            if (requestToken === sourceToken) {
                const wifProject = getWifUserProject(sourceIdp);
                if (wifProject) resolved = wifProject;
            } else if (requestToken === targetToken) {
                const wifProject = getWifUserProject(targetIdp);
                if (wifProject) resolved = wifProject;
            }
        } else {
            const activeIdp = (requestToken === targetToken) ? targetIdp : sourceIdp;
            const wifProject = getWifUserProject(activeIdp);
            if (wifProject) resolved = wifProject;
        }
        
        console.log("[DEBUG QUOTA] resolveQuotaProject output:", resolved);
        return resolved;
        
    } catch (e) {
        console.warn("Failed to resolve WIF user project for quota headers:", e);
    }
    
    return projectId;
};

export const gapiRequest = async <T>(
    path: string, 
    method: string = 'GET', 
    projectId?: string, 
    params?: any, 
    body?: any, 
    headers?: any,
    suppressErrorLog: boolean = false,
    accessToken?: string
): Promise<T> => {
  const client = await getGapiClient();
    const requestHeaders = headers || {};

    const quotaProject = resolveQuotaProject(projectId, requestHeaders, accessToken);
    if (quotaProject) {
        requestHeaders['X-Goog-User-Project'] = quotaProject;
    }

    // Only populate Authorization header if not already explicitly provided in headers
    if (!requestHeaders['Authorization']) {
        const token = accessToken || client.getToken()?.access_token;
        if (token) {
            requestHeaders['Authorization'] = `Bearer ${token}`;
        }
    }

    // Ensure Content-Type is set for POST/PUT if body exists
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        if (!requestHeaders['Content-Type']) {
            requestHeaders['Content-Type'] = 'application/json';
        }
    }

    // Basic cURL logging
    if (debugLogger) {
        // Ensure we have the token for the curl command
        const token = client.getToken()?.access_token;
        const logHeaders = { ...requestHeaders };
        if (token) {
            logHeaders['Authorization'] = `Bearer $(gcloud auth print-access-token)`; // Use placeholder for cleaner display
        }

        const curlCommand = generateCurlCommand(path, method, logHeaders, body);
        debugLogger({
            method,
            url: path,
            headers: logHeaders,
            body,
            curlCommand
        });
    }

  const requestOptions: any = {
    path,
    method,
    params,
    body,
      headers: requestHeaders
  };

  try {
    const response = await client.request(requestOptions);
    return response.result;
  } catch (error: any) {
    if (!suppressErrorLog) {
        console.error("API Request Failed", error);
    }
    
    // Robust error message extraction to avoid [object Object]
    let errorMessage = "Unknown API Error";
    
    // Try to extract from gapi result error structure
    if (error?.result?.error?.message) {
        errorMessage = error.result.error.message;
    } 
    // Try to extract from top-level error message
    else if (error?.message) {
        errorMessage = error.message;
    } 
    // Otherwise, stringify the whole response result for maximum visibility
    else if (error?.result) {
        errorMessage = JSON.stringify(error.result, null, 2);
    }
    // Fallback to stringifying the error object itself
    else if (typeof error === 'object' && error !== null) {
        try {
            errorMessage = JSON.stringify(error.result, null, 2);
        } catch (e) {
            errorMessage = "Complex Error Object (cannot stringify)";
        }
    } else if (error) {
        errorMessage = String(error);
    }
    
    throw new Error(errorMessage, { cause: error });
  }
};

// --- Project & IAM ---

export const getProjectNumber = async (projectId: string): Promise<string> => {
    const response = await gapiRequest<any>(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`, 'GET', projectId);
    return response.projectNumber;
};

export const getProject = async (projectNumberOrId: string): Promise<{ projectId: string, projectNumber: string, name?: string }> => {
    const response = await gapiRequest<any>(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectNumberOrId}`, 'GET', projectNumberOrId.match(/^\d+$/) ? undefined : projectNumberOrId);
    return { projectId: response.projectId, projectNumber: response.projectNumber, name: response.name };
};

export const validateEnabledApis = async (projectId: string): Promise<{ enabled: string[], disabled: string[] }> => {
    const requiredApis = [
        'discoveryengine.googleapis.com',
        'aiplatform.googleapis.com',
        'run.googleapis.com',
        'cloudbuild.googleapis.com',
        'storage.googleapis.com',
        'bigquery.googleapis.com',
        'logging.googleapis.com',
        'cloudbilling.googleapis.com',
        'cloudresourcemanager.googleapis.com',
        'iam.googleapis.com',
        'serviceusage.googleapis.com',
        'dialogflow.googleapis.com'
    ];
    
    const response = await gapiRequest<any>(`https://serviceusage.googleapis.com/v1/projects/${projectId}/services?filter=state:ENABLED&pageSize=200`, 'GET', projectId);
    const enabledServices = new Set((response.services || []).map((s: any) => s.config.name));
    
    const enabled: string[] = [];
    const disabled: string[] = [];
    
    requiredApis.forEach(api => {
        if (enabledServices.has(api)) enabled.push(api);
        else disabled.push(api);
    });
    
    return { enabled, disabled };
};

export const batchEnableApis = async (projectId: string, apis: string[]) => {
    return gapiRequest<any>(
        `https://serviceusage.googleapis.com/v1/projects/${projectId}/services:batchEnable`,
        'POST',
        projectId,
        undefined,
        { serviceIds: apis }
    );
};

export const getServiceUsageOperation = async (name: string) => {
    return gapiRequest<any>(`https://serviceusage.googleapis.com/v1/${name}`);
};

export const checkServiceAccountPermissions = async (projectId: string, _saEmail: string, permissions: string[]): Promise<{ hasAll: boolean, missing: string[] }> => {
    const response = await gapiRequest<any>(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
        'POST',
        projectId,
        undefined,
        { permissions }
    );
    const granted = new Set(response.permissions || []);
    const missing = permissions.filter(p => !granted.has(p));
    return { hasAll: missing.length === 0, missing };
};

export const listServiceAccounts = async (projectId: string): Promise<any[]> => {
    let allAccounts: any[] = [];
    let pageToken = '';
    do {
        let url = `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts?pageSize=100`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const response = await gapiRequest<any>(url, 'GET', projectId);
        if (response.accounts) {
            allAccounts = allAccounts.concat(response.accounts);
        }
        pageToken = response.nextPageToken || '';
    } while (pageToken);
    return allAccounts;
};

export const listWorkloadIdentityPools = async (projectId: string): Promise<any[]> => {
    let allPools: any[] = [];
    let pageToken = '';
    do {
        let url = `https://iam.googleapis.com/v1/projects/${projectId}/locations/global/workloadIdentityPools?pageSize=50`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const response = await gapiRequest<any>(url, 'GET', projectId);
        if (response.workforcePools) {
            allPools = allPools.concat(response.workforcePools.filter((p: any) => p.state !== 'DELETED'));
        }
        pageToken = response.nextPageToken || '';
    } while (pageToken);
    return allPools;
};

export const listWorkloadIdentityProviders = async (poolName: string, projectId: string): Promise<any[]> => {
    let allProviders: any[] = [];
    let pageToken = '';
    do {
        let url = `https://iam.googleapis.com/v1/${poolName}/providers?pageSize=50`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const response = await gapiRequest<any>(url, 'GET', projectId);
        if (response.workforcePoolProviders) {
            allProviders = allProviders.concat(response.workforcePoolProviders.filter((p: any) => p.state !== 'DELETED'));
        }
        pageToken = response.nextPageToken || '';
    } while (pageToken);
    return allProviders;
};

export const getServiceAccountIamPolicy = async (saEmail: string, projectId: string): Promise<any> => {
    const url = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:getIamPolicy`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, {});
};

export const getProjectIamPolicy = async (projectId: string): Promise<any> => {
    const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, {
        options: { requestedPolicyVersion: 3 }
    });
};

export const setProjectIamPolicy = async (projectId: string, policy: any): Promise<any> => {
    const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:setIamPolicy`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, { policy });
};

// --- BigQuery & Logging Sinks ---

export const getDataset = async (projectId: string, datasetId: string): Promise<any> => {
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetId}`;
    return gapiRequest<any>(url, 'GET', projectId);
};

export const updateDatasetAccess = async (projectId: string, datasetId: string, access: any[]): Promise<any> => {
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetId}`;
    const body = { access };
    return gapiRequest<any>(url, 'PATCH', projectId, undefined, body);
};

export const createLoggingSink = async (projectId: string, sinkName: string, destination: string, filter: string): Promise<any> => {
    const url = `https://logging.googleapis.com/v2/projects/${projectId}/sinks`;
    const body = {
        name: sinkName,
        destination: destination,
        filter: filter
    };
    const params = { uniqueWriterIdentity: true };
    return gapiRequest<any>(url, 'POST', projectId, params, body);
};

export const getLoggingSink = async (projectId: string, sinkName: string): Promise<any> => {
    const url = `https://logging.googleapis.com/v2/projects/${projectId}/sinks/${sinkName}`;
    return gapiRequest<any>(url, 'GET', projectId);
};

export const listLoggingSinks = async (projectId: string): Promise<any> => {
    const url = `https://logging.googleapis.com/v2/projects/${projectId}/sinks`;
    return gapiRequest<any>(url, 'GET', projectId);
};


// --- Discovery Engine Resources ---

export const listResources = async (resourceType: 'agents' | 'engines' | 'dataStores' | 'collections' | 'assistants', config: Config, pageToken?: string, pageSize: number = 200): Promise<any> => {
    const { projectId, appLocation, collectionId, appId, assistantId } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    let url = '';
    
    switch (resourceType) {
        case 'collections':
            url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections`;
            break;
        case 'engines':
            url = `${baseUrl}/${DISCOVERY_API_BETA}/projects/${projectId}/locations/${appLocation}/collections/${collectionId || 'default_collection'}/engines`;
            break;
        case 'assistants':
            url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants`;
            break;
        case 'agents':
            url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants/${assistantId}/agents`;
            break;
        case 'dataStores':
            url = `${baseUrl}/${DISCOVERY_API_BETA}/projects/${projectId}/locations/${appLocation}/collections/${collectionId || 'default_collection'}/dataStores`;
            break;
    }

    url += `?pageSize=${pageSize}`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    return gapiRequest(url, 'GET', projectId, undefined, undefined, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

// FIX: Added missing createCollection function.
export const createCollection = async (collectionId: string, payload: any, config: Config) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections?collectionId=${collectionId}`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, payload);
};

export const updateCollection = async (name: string, payload: any, updateMask: string[], config: Config) => {
    const { projectId } = config;
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/${name}?updateMask=${updateMask.join(',')}`;
    return gapiRequest<any>(url, 'PATCH', projectId, undefined, payload);
};


export const getDiscoveryOperation = async (name: string, config: Config, apiVersion: string = DISCOVERY_API_VERSION) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    return gapiRequest<any>(`${baseUrl}/${apiVersion}/${name}`, 'GET', config.projectId);
};

export const listOperations = async (config: Config, filter?: string) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    let url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${config.projectId}/locations/${config.appLocation}/collections/${config.collectionId || 'default_collection'}/operations`;
    // Fallback to global operations if collection-specific fails or if we want broader scope? 
    // User's curl example was: projects/.../locations/global/operations. 
    // Let's support both or stick to the global one if that's what they asked.
    // The user asked for: `https://discoveryengine.googleapis.com/v1beta/projects/.../locations/global/operations`
    // So let's add a robust version.

    url = `${baseUrl}/${DISCOVERY_API_BETA}/projects/${config.projectId}/locations/${config.appLocation}/operations`;
    if (filter) {
        url += `?filter=${encodeURIComponent(filter)}`;
    }
    return gapiRequest<any>(url, 'GET', config.projectId);
};

export const listDiscoverySessions = async (config: Config, pageToken?: string, pageSize: number = 50) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    // Logic: Sessions are usually under a Data Store for "Search" or an App for "Chat".
    // For "Chat" / "Gemini Enterprise" (Conversational), they are under `projects/.../conversations` OR `projects/.../collections/.../engines/.../sessions`.
    // Actually, for Vertex AI Search (Discovery Engine) "Chat" apps, sessions are:
    // `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}/sessions`
    // OR `projects/{project}/locations/{location}/collections/{collection}/dataStores/{dataStore}/sessions`

    // We will assume Engine-based sessions if appId is present (which is typical for this app's "Engines/Apps").
    let url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${config.projectId}/locations/${config.appLocation}/collections/${config.collectionId || 'default_collection'}/engines/${config.appId}/sessions?pageSize=${pageSize}`;
    if (pageToken) {
        url += `&pageToken=${pageToken}`;
    }
    return gapiRequest<{ sessions: DiscoverySession[], nextPageToken?: string }>(url, 'GET', config.projectId);
};

export const getDiscoveryAnswer = async (name: string, config: Config) => {
    // name is full resource name: projects/.../answers/...
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/${name}`;
    return gapiRequest<any>(url, 'GET', config.projectId);
};

export const createDiscoverySession = async (session: DiscoverySession, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    // API: POST .../sessions (Server-generated ID)
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${config.projectId}/locations/${config.appLocation}/collections/${config.collectionId || 'default_collection'}/engines/${config.appId}/sessions`;

    // Client-assigned IDs via 'session_id' query param are NOT supported in v1alpha/v1beta.
    // We must accept a new Session ID generated by the server.
    const finalUrl = url;

    const cleanPayload: any = {};
    if (session.userPseudoId) {
        cleanPayload.user_pseudo_id = session.userPseudoId;
    }
    // We include 'turns' to restore history.
    if (session.turns) cleanPayload.turns = session.turns;

    // UI Visibility Hacks for Restored Sessions
    if (session.state) cleanPayload.state = session.state;
    if (session.startTime) cleanPayload.startTime = session.startTime;

    // Pass through other fields if needed, but be careful of output-only ones.
    // if (session.labels) cleanPayload.labels = session.labels;

    return gapiRequest<DiscoverySession>(finalUrl, 'POST', config.projectId, undefined, cleanPayload);
};

export const getDiscoverySession = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    // name is full resource name
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/${name}`;
    return gapiRequest<DiscoverySession>(url, 'GET', config.projectId);
};

export const getVertexAiOperation = async (name: string, config: Config) => {
    const parts = name.split('/');
    const locIndex = parts.indexOf('locations');
    const location = (locIndex !== -1 && parts.length > locIndex + 1) ? parts[locIndex + 1] : (config.reasoningEngineLocation || 'us-central1');
    
    const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${name}`;
    return gapiRequest<any>(url, 'GET', config.projectId);
};

// Engines
// Engines
export const getEngine = async (name: string, config: Config) => {
    const { projectId, appLocation, collectionId = 'default_collection' } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    
    const resourcePath = name.startsWith('projects/') 
        ? name 
        : `projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${name}`;

    const engine = await gapiRequest<AppEngine>(`${baseUrl}/${DISCOVERY_API_BETA}/${resourcePath}`, 'GET', projectId, undefined, undefined, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
    console.log('[DEBUG] getEngine:', engine);
    return engine;
};

export const createEngine = async (engineId: string, payload: any, config: Config) => {
    const { projectId, appLocation, collectionId = 'default_collection' } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_BETA}/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines?engineId=${engineId}`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, payload, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const updateEngine = async (name: string, payload: any, updateMask: string[], config: Config) => {
    const { projectId, appLocation, collectionId = 'default_collection' } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);

    const resourcePath = name.startsWith('projects/') 
        ? name 
        : `projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${name}`;

    const url = `${baseUrl}/${DISCOVERY_API_BETA}/${resourcePath}?updateMask=${updateMask.join(',')}`;
    return gapiRequest<AppEngine>(url, 'PATCH', projectId, undefined, payload, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const getEngineIamPolicy = async (name: string, config: Config) => {
    const { projectId, appLocation, collectionId = 'default_collection' } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const resourcePath = name.startsWith('projects/') 
        ? name 
        : `projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${name}`;
    const url = `${baseUrl}/v1/${resourcePath}:getIamPolicy`;
    return gapiRequest<any>(url, 'GET', projectId, undefined, undefined, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const setEngineIamPolicy = async (name: string, policy: any, config: Config) => {
    const { projectId, appLocation, collectionId = 'default_collection' } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const resourcePath = name.startsWith('projects/') 
        ? name 
        : `projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${name}`;
    const url = `${baseUrl}/v1/${resourcePath}:setIamPolicy`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, { policy }, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const getWidgetConfig = async (name: string, config: Config) => {
    // name is the engine name
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    // Widget configs use v1alpha in the user's curl payload, but we can try v1beta if available. We'll use v1alpha to match HAR capture safely. 
    const url = `${baseUrl}/v1alpha/${name}/widgetConfigs/default_search_widget_config`;
    return gapiRequest<WidgetConfig>(url, 'GET', projectId);
};

export const updateWidgetConfig = async (name: string, payload: any, updateMask: string[], config: Config) => {
    // name is the engine name
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const url = `${baseUrl}/v1alpha/${name}/widgetConfigs/default_search_widget_config?updateMask=${updateMask.join(',')}`;
    return gapiRequest<WidgetConfig>(url, 'PATCH', projectId, undefined, payload);
};

// AclConfig (Location level IDP)
export const getAclConfig = async (config: Config) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_BETA}/projects/${projectId}/locations/${appLocation}/aclConfig`;
    return gapiRequest<any>(url, 'GET', projectId); // Type will be AclConfig
};

export const updateAclConfig = async (payload: any, updateMask: string[], config: Config) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_BETA}/projects/${projectId}/locations/${appLocation}/aclConfig?updateMask=${updateMask.join(',')}`;
    return gapiRequest<any>(url, 'PATCH', projectId, undefined, payload); // Type will be AclConfig
};

// IAM Workforce Pool Providers
export const getWorkforcePoolProviders = async (poolName: string, config: Config) => {
    // poolName is typically formatted as: "locations/global/workforcePools/wdufrin-okta"
    const poolId = poolName.split('/').pop();
    if (!poolId) return { workforcePoolProviders: [] };

    // Use standard IAM API to get the providers for the given pool
    const url = `https://iam.googleapis.com/v1/locations/global/workforcePools/${poolId}/providers`;
    try {
        const response = await gapiRequest<any>(url, 'GET', config.projectId);
        return response;
    } catch (err) {
        console.error("Failed to fetch workforce pool providers:", err);
        return { workforcePoolProviders: [] };
    }
};

export const getWorkforcePoolProviderScimTenants = async (providerName: string, config: Config) => {
    // providerName is typically formatted as: "locations/global/workforcePools/{poolId}/providers/{providerId}"
    const url = `https://iam.googleapis.com/v1/${providerName}/scimTenants?showDeleted=False`;
    try {
        const response = await gapiRequest<any>(url, 'GET', config.projectId);
        return response;
    } catch (err) {
        console.error("Failed to fetch workforce pool provider SCIM tenants:", err);
        return { workforcePoolProviderScimTenants: [] };
    }
};

// Assistants
export const getAssistant = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    return gapiRequest<Assistant>(
        `${baseUrl}/${DISCOVERY_API_VERSION}/${name}`, 
        'GET', 
        config.projectId,
        undefined,
        undefined,
        undefined,
        config.suppressErrorLog
    );
};

export const updateAssistant = async (name: string, payload: any, updateMask: string[], config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/${name}?updateMask=${updateMask.join(',')}`;
    return gapiRequest<Assistant>(url, 'PATCH', config.projectId, undefined, payload);
};

export const createAssistant = async (assistantId: string, payload: any, config: Config) => {
    const { projectId, appLocation, collectionId, appId } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants?assistantId=${assistantId}`;
    return gapiRequest<Assistant>(url, 'POST', projectId, undefined, payload);
};

// Agents
export const getAgent = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    return gapiRequest<Agent>(`${baseUrl}/${DISCOVERY_API_VERSION}/${name}`, 'GET', config.projectId);
};

export const getAgentView = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    // Suppress error logging here because 403 Forbidden is expected for agents the user cannot view.
    return gapiRequest<any>(`${baseUrl}/${DISCOVERY_API_VERSION}/${name}:getAgentView`, 'GET', config.projectId, undefined, undefined, undefined, true);
};

export const createAgent = async (payload: any, config: Config, agentId?: string) => {
    const { projectId, appLocation, collectionId, appId, assistantId } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    let url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants/${assistantId}/agents`;
    if (agentId) {
        url += `?agentId=${agentId}`;
    }
    return gapiRequest<Agent>(url, 'POST', projectId, undefined, payload);
};

export const updateAgent = async (agent: Agent, payload: any, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const updateMask: string[] = [];
    if (payload.displayName) updateMask.push('display_name');
    if (payload.description) updateMask.push('description');
    if (payload.icon) updateMask.push('icon');
    if (payload.starterPrompts) updateMask.push('starter_prompts');
    if (payload.adkAgentDefinition) updateMask.push('adk_agent_definition');
    if (payload.a2aAgentDefinition) updateMask.push('a2a_agent_definition');
    if (payload.a2aAgentDefinition) updateMask.push('a2a_agent_definition');
    if (payload.authorizations) updateMask.push('authorizations');
    if (payload.authorizationConfig) updateMask.push('authorization_config');

    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/${agent.name}?updateMask=${updateMask.join(',')}`;
    return gapiRequest<Agent>(url, 'PATCH', config.projectId, undefined, payload);
};

export const disableAgent = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    await gapiRequest(`${baseUrl}/${DISCOVERY_API_VERSION}/${name}:disableAgent`, 'POST', config.projectId);
    return getAgent(name, config);
};

export const enableAgent = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    await gapiRequest(`${baseUrl}/${DISCOVERY_API_VERSION}/${name}:enableAgent`, 'POST', config.projectId);
    return getAgent(name, config);
};

export const shareAgent = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const flatName = name.replace('/assistants/default_assistant', '');
    await gapiRequest(`${baseUrl}/${DISCOVERY_API_VERSION}/${flatName}:share`, 'POST', config.projectId);
    return getAgent(name, config);
};




export const deleteResource = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    return gapiRequest(`${baseUrl}/${DISCOVERY_API_VERSION}/${name}`, 'DELETE', config.projectId);
};

// Data Stores
export const getDataStore = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    return gapiRequest<DataStore>(`${baseUrl}/${DISCOVERY_API_BETA}/${name}`, 'GET', config.projectId);
};

export const createDataStore = async (dataStoreId: string, payload: any, config: Config) => {
    const { projectId, appLocation, collectionId } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_BETA}/projects/${projectId}/locations/${appLocation}/collections/${collectionId || 'default_collection'}/dataStores?dataStoreId=${dataStoreId}`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, payload);
};

export const updateDataStore = async (name: string, payload: any, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const updateMask = Object.keys(payload).join(',');
    const url = `${baseUrl}/${DISCOVERY_API_BETA}/${name}?updateMask=${updateMask}`;
    return gapiRequest<DataStore>(url, 'PATCH', config.projectId, undefined, payload);
};

export const deleteDataStore = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    return gapiRequest(`${baseUrl}/${DISCOVERY_API_BETA}/${name}`, 'DELETE', config.projectId);
};

export const getDataConnector = async (config: Config) => {
    const { projectId, appLocation, collectionId } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    // Note: The API is singleton per collection
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections/${collectionId || 'default_collection'}/dataConnector`;
    return gapiRequest<any>(url, 'GET', projectId, undefined, undefined, undefined, true);
};

export const listDocuments = async (dataStoreName: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    return gapiRequest<{ documents: Document[] }>(`${baseUrl}/${DISCOVERY_API_BETA}/${dataStoreName}/branches/default_branch/documents`, 'GET', config.projectId);
};

export const searchDocuments = async (dataStoreName: string, config: Config, query: string = '*') => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    // Construct Serving Config name from Data Store name
    // DataStore: projects/.../dataStores/ID
    // Serving: projects/.../dataStores/ID/servingConfigs/default_search
    const url = `${baseUrl}/${DISCOVERY_API_BETA}/${dataStoreName}/servingConfigs/default_search:search`;

    const body = {
        query: query,
        pageSize: 1,
        // We just need the ID to fetch full ACLs via getDocument, but sometimes search returns enough info.

    };

    return gapiRequest<{ results: { document: Document }[] }>(url, 'POST', config.projectId, undefined, body);
};

/**
 * Searches a Data Store using the Discovery Engine Search API.
 * Equivalent to the Python discoveryengine_v1beta.SearchServiceClient.search() method.
 */
export const queryDataStore = async (
    dataStoreName: string,
    config: Config,
    query: string,
    pageSize: number = 10,
    pageToken?: string,
    servingConfigId: string = 'default_serving_config',
) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_BETA}/${dataStoreName}/servingConfigs/${servingConfigId}:search`;

    const body: any = {
        query,
        pageSize,
    };
    if (pageToken) {
        body.pageToken = pageToken;
    }

    return gapiRequest<{
        results: { id: string; document: Document }[];
        totalSize?: number;
        nextPageToken?: string;
        summary?: { summaryText?: string; summaryWithMetadata?: any };
        queryExpansionInfo?: any;
    }>(url, 'POST', config.projectId, undefined, body);
};

// --- Workforce Identity Federation (WIF) ---

/**
 * Fetches the workforce pool provider configuration from GCP IAM.
 * Used to auto-discover the OIDC issuer and client ID for sign-in.
 */
export const fetchWorkforceProviderConfig = async (
    poolId: string,
    providerId: string,
): Promise<{
    name: string;
    displayName?: string;
    oidc?: { issuerUri: string; clientId: string; webSsoConfig?: { responseType: string; assertionClaimsMapping?: Record<string, string> } };
    saml?: { idpMetadataXml: string };
    state?: string;
}> => {
    const url = `https://iam.googleapis.com/v1/locations/global/workforcePools/${poolId}/providers/${providerId}`;
    return gapiRequest(url, 'GET');
};

/**
 * Opens an OIDC sign-in popup to the identity provider's authorization endpoint.
 * Returns the ID token from the redirect fragment.
 * 
 * IMPORTANT: The redirect URI (window.location.origin) must be registered as a
 * redirect URI in the identity provider's application configuration.
 */
// Helper functions for OAuth 2.1 PKCE (Proof Key for Code Exchange)
const generateCodeVerifier = (): string => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => ('0' + byte.toString(16)).slice(-2)).join('');
};

const sha256 = async (plain: string): Promise<ArrayBuffer> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return crypto.subtle.digest('SHA-256', data);
};

const base64UrlEncode = (a: ArrayBuffer): string => {
    const str = String.fromCharCode(...new Uint8Array(a));
    return btoa(str)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
};

const generateCodeChallenge = async (verifier: string): Promise<string> => {
    const hashed = await sha256(verifier);
    return base64UrlEncode(hashed);
};

/**
 * Opens an OIDC sign-in popup to the identity provider's authorization endpoint.
 * Utilizes Authorization Code Flow with PKCE for secure token acquisition.
 * 
 * IMPORTANT: The redirect URI (window.location.origin) must be registered as a
 * redirect URI in the identity provider's application configuration under the "SPA" platform.
 */
export const signInWithOidcPopup = async (
    authorizationEndpoint: string,
    clientId: string,
    redirectUri: string,
    scope: string = 'openid profile email',
): Promise<{ idToken: string; email?: string; sub?: string }> => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = crypto.randomUUID();

    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });

    const popupUrl = `${authorizationEndpoint}?${params.toString()}`;
    const popup = window.open(popupUrl, 'wif-oidc-signin', 'width=500,height=700,left=200,top=100');

    if (!popup) {
        throw new Error('Popup was blocked. Please allow popups for this site.');
    }

    return new Promise((resolve, reject) => {
        let settled = false;

        const pollInterval = setInterval(async () => {
            try {
                if (popup.closed) {
                    clearInterval(pollInterval);
                    if (!settled) {
                        settled = true;
                        reject(new Error('Sign-in window was closed before completing authentication.'));
                    }
                    return;
                }

                // Try to read popup URL — throws cross-origin error while on IdP domain
                const currentUrl = popup.location.href;

                // If we can read it and it starts with our redirect URI, capture the authorization code
                if (currentUrl.startsWith(redirectUri)) {
                    clearInterval(pollInterval);
                    settled = true;

                    const urlObj = new URL(currentUrl);
                    const searchParams = urlObj.searchParams;
                    const code = searchParams.get('code');
                    const error = searchParams.get('error');
                    const errorDescription = searchParams.get('error_description');

                    popup.close();

                    if (error) {
                        reject(new Error(`Identity provider error: ${errorDescription || error}`));
                        return;
                    }

                    if (!code) {
                        reject(new Error('No authorization code received from the identity provider.'));
                        return;
                    }

                    if (searchParams.get('state') !== state) {
                        reject(new Error('State mismatch — possible CSRF attack.'));
                        return;
                    }

                    // Dynamically derive the token endpoint by replacing '/authorize' with '/token'
                    const tokenEndpoint = authorizationEndpoint
                         .replace(/\/authorize$/, '/token')
                         .replace(/\/authorization\.oauth2$/, '/token.oauth2');

                    console.log("[DEBUG] Exchanging authorization code client-side.");

                    // Exchange Authorization Code + Code Verifier for the ID Token
                    const tokenExchangeBody = new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: clientId,
                        redirect_uri: redirectUri,
                        code,
                        code_verifier: codeVerifier,
                    });

                    const tokenResponse = await fetch(tokenEndpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: tokenExchangeBody.toString(),
                    });

                    if (!tokenResponse.ok) {
                        const errText = await tokenResponse.text();
                        reject(new Error(`Failed to exchange authorization code: ${errText || tokenResponse.statusText}`));
                        return;
                    }
                    const tokenData = await tokenResponse.json();

                    const idToken = tokenData.id_token;

                    if (!idToken) {
                        reject(new Error('Identity provider did not return an ID Token in the token response.'));
                        return;
                    }

                    // Decode JWT to extract email claim (best-effort)
                    let email: string | undefined;
                    let sub: string | undefined;
                    try {
                        const payload = JSON.parse(atob(idToken.split('.')[1]));
                        console.log("[DEBUG] ID Token Payload:", payload);
                        email = payload.email || payload.preferred_username || payload.upn;
                        sub = payload.sub;
                    } catch { /* ignore decode errors */ }

                    resolve({ idToken, email, sub });
                }
            } catch {
                // Cross-origin error while popup is on the IdP domain — expected, ignore
            }
        }, 500);

        // Timeout after 5 minutes
        setTimeout(() => {
            clearInterval(pollInterval);
            if (!popup.closed) popup.close();
            if (!settled) {
                settled = true;
                reject(new Error('Sign-in timed out after 5 minutes.'));
            }
        }, 5 * 60 * 1000);
    });
};

/**
 * Fetches the OIDC discovery document from an issuer URI.
 * Returns the authorization_endpoint and other metadata.
 */
export const fetchOidcDiscovery = async (issuerUri: string): Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
    [key: string]: any;
}> => {
    const url = `${issuerUri.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch OIDC discovery document from ${url}: ${response.statusText}`);
    }
    return response.json();
};

export interface WifConfig {
    userProject: string;
    poolId: string;
    providerId: string;
    subjectToken: string;
    subjectTokenType: string;
}

/**
 * Exchanges an external IdP token for a Google Cloud STS access token
 * via the Security Token Service (Workforce Identity Federation).
 */
export const exchangeStsToken = async (wifConfig: WifConfig): Promise<{ access_token: string; expires_in: number; token_type: string }> => {
    const audience = `//iam.googleapis.com/locations/global/workforcePools/${wifConfig.poolId}/providers/${wifConfig.providerId}`;

    const stsBody = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token_type: wifConfig.subjectTokenType,
        subject_token: wifConfig.subjectToken,
        options: JSON.stringify({ userProject: wifConfig.userProject }),
    });

    const response = await fetch('https://sts.googleapis.com/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: stsBody.toString(),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error_description: response.statusText }));
        throw new Error(`STS Token Exchange failed: ${errorData.error_description || errorData.error || response.statusText}`);
    }

    return response.json();
};

/**
 * Queries a Data Store using a custom access token (e.g. from WIF exchange)
 * instead of the default gapi OAuth session.
 */




const getLocationFromResourceName = (name: string): string => {
    const match = name.match(/locations\/([a-zA-Z0-9-]+)\//);
    return match ? match[1] : 'global';
};





export const listReasoningEngines = async (config: Config, pageToken?: string, pageSize: number = 200) => {
    const location = config.reasoningEngineLocation || 'us-central1';
    let url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${config.projectId}/locations/${location}/reasoningEngines?pageSize=${pageSize}`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    return gapiRequest<{ reasoningEngines: ReasoningEngine[], nextPageToken?: string }>(url, 'GET', config.projectId);
};

export const getReasoningEngine = async (name: string, config: Config) => {
    const location = name.split('/')[3];
    const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${name}`;
    return gapiRequest<ReasoningEngine>(url, 'GET', config.projectId);
};







// --- Cloud Run Services ---




// --- GCS ---






// --- Cloud Build ---





// --- BigQuery ---






// --- Logging ---




// --- Dialogflow CX ---




// --- IAM Helper for Agents ---

export const getAgentIamPolicy = async (name: string, config: Config) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/${name}:getIamPolicy`;
    return gapiRequest<any>(url, 'GET', config.projectId);
};

export const setAgentIamPolicy = async (name: string, policy: any, config: Config, suppressErrorLog: boolean = false) => {
    const baseUrl = getDiscoveryEngineUrl(config.appLocation);
    const url = `${baseUrl}/${DISCOVERY_API_VERSION}/${name}:setIamPolicy`;
    return gapiRequest<any>(url, 'POST', config.projectId, undefined, { policy }, undefined, suppressErrorLog);
};



// --- Compute Engine ---




// --- Assistant Export/Metrics ---




export const downloadGcsObject = async (bucketInfo: string, objectName: string, accessToken: string) => {
    // API: GET https://storage.googleapis.com/storage/v1/b/{bucket}/o/{object}?alt=media
    const bucketArray = bucketInfo.split('/');
    const bucketName = bucketArray[bucketArray.length - 1]; // ensure we just have the name
    const url = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(objectName)}?alt=media`;

    // Using standard fetch because `gapiRequest` natively expects JSON and might try to parse non-json or fail
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to download object: ${response.status} - ${errText}`);
    }

    return response.blob();
};







// --- Notebooks ---

export const listNotebooks = async (config: Config) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    // API: v1alpha/projects/{projectsId}/locations/{locationsId}/notebooks:listRecentlyViewed
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/notebooks:listRecentlyViewed`;
    return gapiRequest<any>(url, 'GET', projectId, undefined, undefined, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const getNotebook = async (config: Config, notebookId: string) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    // API: v1alpha/projects/{projectsId}/locations/{locationsId}/notebooks/{notebookId}
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/notebooks/${notebookId}`;
    return gapiRequest<any>(url, 'GET', projectId, undefined, undefined, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const getNotebookSource = async (config: Config, notebookId: string, sourceId: string) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    // API: v1alpha/projects/{project}/locations/{location}/notebooks/{notebookId}/sources/{sourceId}
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/notebooks/${notebookId}/sources/${sourceId}`;
    return gapiRequest<any>(url, 'GET', projectId, undefined, undefined, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const createNotebook = async (config: Config, payload: any) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    // API: v1alpha/projects/{project}/locations/{location}/notebooks
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/notebooks`;
    return gapiRequest<any>(url, 'POST', projectId, undefined, payload, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

export const batchCreateNotebookSources = async (config: Config, notebookId: string, requests: any[]) => {
    const { projectId, appLocation } = config;
    const baseUrl = getDiscoveryEngineUrl(appLocation);
    // API: v1alpha/projects/{project}/locations/{location}/notebooks/{notebookId}/sources:batchCreate
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${appLocation}/notebooks/${notebookId}/sources:batchCreate`;
    const payload = { userContents: requests };
    return gapiRequest<any>(url, 'POST', projectId, undefined, payload, config.accessToken ? { 'Authorization': `Bearer ${config.accessToken}` } : undefined);
};

// Workforce Identity Pools
export const validateWorkforcePool = async (poolName: string, config: Config) => {
    // poolName should be full resource name: locations/{location}/workforcePools/{pool_id}
    // API endpoint: https://iam.googleapis.com/v1/{name}
    const url = `https://iam.googleapis.com/v1/${poolName}`;
    return gapiRequest<any>(url, 'GET', config.projectId);
};

// --- License Management ---















// --- Cloud Monitoring ---


// --- Prompt Chips (Canned Queries) ---





export const getUserInfo = async (accessToken: string) => {
    const url = 'https://www.googleapis.com/oauth2/v3/userinfo';
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch user info: ${response.statusText}`);
    }
    return response.json();
};

const VALID_LOCATIONS = new Set([
  'global', 'us', 'eu', 'us-central1', 'us-east1', 'us-east4', 'us-west1',
  'europe-west1', 'europe-west3', 'europe-west9', 'asia-east1', 'asia-northeast1'
]);

const validateConfigParams = (params: any) => {
  const { projectId, appLocation, collectionId, appId, assistantId } = params;

  if (projectId && !/^[a-z0-9-]+$/i.test(projectId)) {
    throw new Error('Invalid projectId format (alphanumeric and hyphens only)');
  }
  if (appLocation && !VALID_LOCATIONS.has(appLocation)) {
    throw new Error('Invalid or unapproved appLocation');
  }
  if (collectionId && !/^[a-z0-9-_]+$/i.test(collectionId)) {
    throw new Error('Invalid collectionId format');
  }
  if (appId && !/^[a-z0-9-_]+$/i.test(appId)) {
    throw new Error('Invalid appId format');
  }
  if (assistantId && !/^[a-z0-9-_]+$/i.test(assistantId)) {
    throw new Error('Invalid assistantId format');
  }
};

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: Promise<R>[] = [];
  const executing = new Set<Promise<any>>();
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


export const restoreAgentsServerSide = async (
    restoreConfig: Config,
    agents: Agent[],
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {},
    sourceConfig: any = null,
    logLevel: string = 'INFO'
) => {
  const { projectId, appLocation, collectionId = 'default_collection', appId, assistantId = 'default_assistant', accessToken } = restoreConfig;

  if (!projectId || !appLocation || !collectionId || !appId || !assistantId) {
    throw new Error('Missing target configuration parameters');
  }

  validateConfigParams({ projectId, appLocation, collectionId, appId, assistantId });
  if (sourceConfig) {
    validateConfigParams({
      projectId: sourceConfig.projectId,
      appLocation: sourceConfig.appLocation,
      collectionId: sourceConfig.collectionId,
      appId: sourceConfig.appId,
      assistantId: sourceConfig.assistantId
    });
  }

  const logs: string[] = [];
  const addLog = (msg: string) => {
    const formatted = `[${new Date().toISOString()}] ${msg}`;
    logs.push(formatted);
    console.log(formatted);
  };

  try {
    addLog(`Starting client-side restore of ${agents.length} agent(s)...`);
    const baseUrl = getDiscoveryEngineUrl(appLocation);

    // Step A: List existing target agents to detect duplicates
    const existingAgents: any[] = [];
    let pageToken: string | undefined = undefined;
    try {
      do {
        let url = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants/${assistantId}/agents?pageSize=200`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const res = await gapiRequest<any>(url, 'GET', projectId, undefined, undefined, undefined, false, accessToken);
        existingAgents.push(...(res.agents || []));
        pageToken = res.nextPageToken;
      } while (pageToken);
      addLog(`Target project check: Found ${existingAgents.length} existing agent(s).`);
    } catch (e: any) {
      addLog(`Warning: Failed to list existing target agents for duplication check: ${e.message}`);
    }

    // Step B: Helper to build payloads
    const buildPayload = (currentAgent: any) => {
      const finalStarterPrompts = (currentAgent.starterPrompts || [])
        .map((p: any) => p.text ? p.text.trim() : '')
        .filter((text: string) => text)
        .map((text: string) => ({ text }));

      let restoredDisplayName = currentAgent.displayName;
      if (currentAgent.dataStoreConnections && currentAgent.dataStoreConnections.length > 0) {
        restoredDisplayName = `[Replace] ${restoredDisplayName}`;
      }

      const payload: any = {
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
        const seenDataStores = new Set<string>();
        payload.dataStoreConnections = rewrittenConnections.filter((conn) => {
          if (conn.dataStore) {
            if (seenDataStores.has(conn.dataStore)) return false;
            seenDataStores.add(conn.dataStore);
          }
          return true;
        });
      }

      // Remap authorizations
      const rewriteAuth = (authName: string) => {
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

          // Remap collection & datastore references inside definition payload safely
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
    await mapConcurrent(agents, 10, async (agent: any) => {
      const originalAgentId = agent.name.split('/').pop();
      addLog(`Preparing to restore agent: ${agent.displayName} (original ID: ${originalAgentId})`);

      const createPayload = buildPayload(agent);
      let targetAgentName = '';
      let targetAgentId = '';

      try {
        const targetId = agent.targetId || undefined;
        let createUrl = `${baseUrl}/${DISCOVERY_API_VERSION}/projects/${projectId}/locations/${appLocation}/collections/${collectionId}/engines/${appId}/assistants/${assistantId}/agents`;
        if (targetId) {
          createUrl += `?agentId=${targetId}`;
        }

        const newAgent = await gapiRequest<any>(createUrl, 'POST', projectId, undefined, createPayload, undefined, false, accessToken);
        targetAgentName = newAgent.name;
        targetAgentId = targetAgentName.split('/').pop() || '';
        addLog(`CREATED: Agent '${agent.displayName}' created with new ID '${targetAgentId}'.`);

        // Restore IAM Policy
        if (agent.iamPolicy && agent.iamPolicy.bindings) {
          const hasAgentUser = agent.iamPolicy.bindings.some((b: any) => b.role === 'roles/discoveryengine.agentUser');
          if (hasAgentUser) {
            try {
              const currentPolicy = await gapiRequest<any>(`${baseUrl}/${DISCOVERY_API_VERSION}/${targetAgentName}:getIamPolicy`, 'GET', projectId, undefined, undefined, undefined, true, accessToken);
              
              const mappedBindings = agent.iamPolicy.bindings.map((b: any) => {
                if (b.role === 'roles/discoveryengine.agentOwner') {
                  return { ...b, role: 'roles/discoveryengine.agentEditor' };
                }
                return b;
              });

              const mergedBindings = currentPolicy.bindings ? [...currentPolicy.bindings] : [];
              mappedBindings.forEach((backupBinding: any) => {
                const existingBinding = mergedBindings.find((b: any) => b.role === backupBinding.role);
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

              await gapiRequest<any>(`${baseUrl}/${DISCOVERY_API_VERSION}/${targetAgentName}:setIamPolicy`, 'POST', projectId, undefined, { policy: payloadPolicy }, undefined, false, accessToken);
              addLog(`IAM policy restored for agent: ${targetAgentId}`);
            } catch (iamErr: any) {
              addLog(`Warning: Failed to apply IAM policy for agent ${targetAgentId}: ${iamErr.message}`);
            }
          }
        }
      } catch (err: any) {
        addLog(`Failed to restore agent ${agent.displayName}: ${err.message}`);
      }
    });

    addLog('Restore processing completed.');
    return { success: true, logs };
  } catch (err: any) {
    addLog(`Critical restore failure: ${err.message}`);
    return { success: false, logs, error: err.message };
  }
};
