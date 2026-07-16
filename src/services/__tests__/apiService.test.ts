import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock gapiService so no real gapi initialization is needed ─────────────────
vi.mock('../gapiService', () => ({ getGapiClient: vi.fn() }));

import { getGapiClient } from '../gapiService';
import {
  setDebugLogger, gapiRequest,
  getProjectNumber, getProject, validateEnabledApis, batchEnableApis,
  getServiceUsageOperation, checkServiceAccountPermissions,
  listServiceAccounts, listWorkloadIdentityPools, listWorkloadIdentityProviders,
  getServiceAccountIamPolicy, getProjectIamPolicy, setProjectIamPolicy,
  getDataset, updateDatasetAccess, createLoggingSink, getLoggingSink, listLoggingSinks,
  listResources, createCollection, updateCollection,
  getDiscoveryOperation, listOperations, listDiscoverySessions,
  getDiscoveryAnswer, createDiscoverySession, getDiscoverySession,
  getVertexAiOperation,
  getEngine, createEngine, updateEngine, getEngineIamPolicy, setEngineIamPolicy,
  getWidgetConfig, updateWidgetConfig, getAclConfig, updateAclConfig,
  getWorkforcePoolProviders, getWorkforcePoolProviderScimTenants,
  getAssistant, updateAssistant, createAssistant,
  getAgent, getAgentView, createAgent, updateAgent,
  disableAgent, enableAgent, shareAgent, deleteResource,
  getDataStore, createDataStore, updateDataStore, deleteDataStore,
  getDataConnector, listDocuments, searchDocuments, queryDataStore,
  fetchWorkforceProviderConfig,
  fetchOidcDiscovery, exchangeStsToken, queryDataStoreWithToken,
  signInWithOidcPopup,
  getDocument, importDocuments,
  listAuthorizations, getAuthorization, createAuthorization,
  updateAuthorization, deleteAuthorization,
  listReasoningEngines, getReasoningEngine, createReasoningEngine,
  deleteReasoningEngine, getReasoningEngineSession,
  listReasoningEngineSessions, deleteReasoningEngineSession,
  streamChat, streamQueryReasoningEngine, generateVertexContent,
  listCloudRunServices, getCloudRunService, deleteCloudRunService,
  listBuckets, listGcsObjects, deleteGcsObject,
  getGcsObjectContent, uploadFileToGcs,
  createCloudBuild, listCloudBuilds, getCloudBuild,
  listBigQueryDatasets, createBigQueryDataset,
  listBigQueryTables, createBigQueryTable, runBigQueryQuery,
  fetchViolationLogs, fetchConnectorLogs, fetchLastRunLog,
  listDialogflowAgents, deleteDialogflowAgent,
  getAgentIamPolicy, setAgentIamPolicy,
  listGlobalForwardingRules, listManagedSslCertificates,
  exportAnalyticsMetrics, getAgentEngineToolLatencies,
  listUserStoreLicenses, downloadGcsObject,
  revokeUserLicenses, assignUserLicenses, deleteUserLicenses,
  registerA2aAgent, fetchA2aAgentCard, invokeA2aAgent,
  listNotebooks, getNotebook, getNotebookSource,
  createNotebook, batchCreateNotebookSources,
  validateWorkforcePool,
  listBillingAccounts, testBillingAccountPermissions,
  listBillingAccountLicenseConfigs, listLicenseConfigs,
  listLicenseConfigsUsageStats, listUserLicenses, getLicenseConfig,
  distributeLicense, probeProjectLicense, retractLicense,
  checkServiceEnabled, enableService,
} from '../apiService';

// ── Shared mock infrastructure ─────────────────────────────────────────────────
const mockRequest  = vi.fn();
const mockGetToken = vi.fn().mockReturnValue({ access_token: 'mock-token' });
const mockClient   = { request: mockRequest, getToken: mockGetToken };

const CFG = {
  projectId: 'test-project',
  appLocation: 'us-central1',
  collectionId: 'test-collection',
  appId: 'test-app',
  assistantId: 'test-assistant',
};

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      chunks.forEach(c => ctrl.enqueue(enc.encode(c)));
      ctrl.close();
    },
  });
}

function makeStreamResponse(chunks: string[], ok = true): Response {
  return { ok, status: ok ? 200 : 500, body: makeStream(chunks),
    text: () => Promise.resolve('error'), json: () => Promise.resolve({}) } as unknown as Response;
}

beforeEach(() => {
  vi.mocked(getGapiClient).mockResolvedValue(mockClient);
  mockRequest.mockResolvedValue({ result: {} });
  mockGetToken.mockReturnValue({ access_token: 'mock-token' });
  setDebugLogger(null);
});

afterEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════════
// gapiRequest + setDebugLogger
// ═══════════════════════════════════════════════════════════════════════════════
describe('gapiRequest core', () => {
  it('returns result on success', async () => {
    mockRequest.mockResolvedValue({ result: { foo: 'bar' } });
    expect(await gapiRequest<{foo:string}>('/test', 'GET')).toEqual({ foo: 'bar' });
  });

  it('adds X-Goog-User-Project when projectId provided', async () => {
    await gapiRequest('/test', 'GET', 'my-proj');
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ 'X-Goog-User-Project': 'my-proj' }),
    }));
  });

  it('adds Authorization from getToken()', async () => {
    await gapiRequest('/test', 'GET');
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ 'Authorization': 'Bearer mock-token' }),
    }));
  });

  it('uses explicit accessToken over getToken()', async () => {
    await gapiRequest('/test', 'GET', undefined, undefined, undefined, undefined, false, 'custom-tok');
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ 'Authorization': 'Bearer custom-tok' }),
    }));
  });

  it('does not overwrite pre-set Authorization header', async () => {
    await gapiRequest('/test', 'GET', undefined, undefined, undefined, { 'Authorization': 'Bearer preset' });
    expect(mockRequest.mock.calls[0][0].headers['Authorization']).toBe('Bearer preset');
  });

  it('skips Authorization when no token available', async () => {
    mockGetToken.mockReturnValue(null);
    await gapiRequest('/test', 'GET');
    expect(mockRequest.mock.calls[0][0].headers['Authorization']).toBeUndefined();
  });

  it('adds Content-Type for POST with body', async () => {
    await gapiRequest('/t', 'POST', undefined, undefined, { x: 1 });
    expect(mockRequest.mock.calls[0][0].headers['Content-Type']).toBe('application/json');
  });

  it('adds Content-Type for PATCH with body', async () => {
    await gapiRequest('/t', 'PATCH', undefined, undefined, { x: 1 });
    expect(mockRequest.mock.calls[0][0].headers['Content-Type']).toBe('application/json');
  });

  it('adds Content-Type for PUT with body', async () => {
    await gapiRequest('/t', 'PUT', undefined, undefined, { x: 1 });
    expect(mockRequest.mock.calls[0][0].headers['Content-Type']).toBe('application/json');
  });

  it('does not override pre-set Content-Type', async () => {
    await gapiRequest('/t', 'POST', undefined, undefined, { x:1 }, { 'Content-Type': 'text/plain' });
    expect(mockRequest.mock.calls[0][0].headers['Content-Type']).toBe('text/plain');
  });

  it('does not add Content-Type for GET with body', async () => {
    await gapiRequest('/t', 'GET', undefined, undefined, { x: 1 });
    expect(mockRequest.mock.calls[0][0].headers['Content-Type']).toBeUndefined();
  });

  it('calls debugLogger when set', async () => {
    const logger = vi.fn();
    setDebugLogger(logger);
    await gapiRequest('/t', 'POST', 'proj', undefined, { x: 1 });
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', url: '/t' }));
  });

  it('debugLogger uses gcloud placeholder for token', async () => {
    const logger = vi.fn();
    setDebugLogger(logger);
    await gapiRequest('/t', 'GET', 'proj');
    expect(logger.mock.calls[0][0].curlCommand).toContain('gcloud auth print-access-token');
  });

  it('debugLogger still fires when no token', async () => {
    mockGetToken.mockReturnValue(null);
    const logger = vi.fn();
    setDebugLogger(logger);
    await gapiRequest('/t', 'GET');
    expect(logger).toHaveBeenCalled();
  });

  // Error extraction branches
  it('throws from result.error.message', async () => {
    mockRequest.mockRejectedValue({ result: { error: { message: 'API Error' } } });
    await expect(gapiRequest('/t')).rejects.toThrow('API Error');
  });

  it('throws from error.message', async () => {
    mockRequest.mockRejectedValue({ message: 'Plain Error' });
    await expect(gapiRequest('/t')).rejects.toThrow('Plain Error');
  });

  it('throws by stringifying error.result', async () => {
    mockRequest.mockRejectedValue({ result: { code: 403 } });
    await expect(gapiRequest('/t')).rejects.toThrow();
  });

  it('throws by stringifying plain object', async () => {
    mockRequest.mockRejectedValue({ weird: 'object' });
    await expect(gapiRequest('/t')).rejects.toThrow();
  });

  it('throws with string error', async () => {
    mockRequest.mockRejectedValue('string-error');
    await expect(gapiRequest('/t')).rejects.toThrow('string-error');
  });

  it('suppresses console.error with suppressErrorLog=true', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRequest.mockRejectedValue({ message: 'err' });
    await expect(gapiRequest('/t', 'GET', undefined, undefined, undefined, undefined, true)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logs to console.error by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRequest.mockRejectedValue({ message: 'err' });
    await expect(gapiRequest('/t')).rejects.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Project & IAM
// ═══════════════════════════════════════════════════════════════════════════════
describe('Project & IAM', () => {
  it('getProjectNumber', async () => {
    mockRequest.mockResolvedValue({ result: { projectNumber: '123' } });
    expect(await getProjectNumber('p')).toBe('123');
  });

  it('getProject non-numeric → passes projectId as header', async () => {
    mockRequest.mockResolvedValue({ result: { projectId: 'pid', projectNumber: '9', name: 'N' } });
    const r = await getProject('pid');
    expect(r.projectId).toBe('pid');
    expect(mockRequest.mock.calls[0][0].headers['X-Goog-User-Project']).toBe('pid');
  });

  it('getProject numeric → no X-Goog-User-Project', async () => {
    mockRequest.mockResolvedValue({ result: { projectId: 'pid', projectNumber: '9', name: 'N' } });
    await getProject('9');
    expect(mockRequest.mock.calls[0][0].headers['X-Goog-User-Project']).toBeUndefined();
  });

  it('validateEnabledApis splits enabled/disabled', async () => {
    mockRequest.mockResolvedValue({ result: { services: [
      { config: { name: 'discoveryengine.googleapis.com' } },
    ]}});
    const { enabled, disabled } = await validateEnabledApis('p');
    expect(enabled).toContain('discoveryengine.googleapis.com');
    expect(disabled).toContain('run.googleapis.com');
  });

  it('validateEnabledApis handles empty services', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    const { enabled, disabled } = await validateEnabledApis('p');
    expect(enabled).toHaveLength(0);
    expect(disabled.length).toBeGreaterThan(0);
  });

  it('batchEnableApis', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op/1' } });
    expect(await batchEnableApis('p', ['storage.googleapis.com'])).toEqual({ name: 'op/1' });
  });

  it('getServiceUsageOperation', async () => {
    mockRequest.mockResolvedValue({ result: { done: true } });
    expect(await getServiceUsageOperation('ops/1')).toEqual({ done: true });
  });

  it('checkServiceAccountPermissions hasAll=true', async () => {
    mockRequest.mockResolvedValue({ result: { permissions: ['a', 'b'] } });
    const r = await checkServiceAccountPermissions('p', 'sa', ['a', 'b']);
    expect(r.hasAll).toBe(true);
    expect(r.missing).toHaveLength(0);
  });

  it('checkServiceAccountPermissions hasAll=false', async () => {
    mockRequest.mockResolvedValue({ result: { permissions: ['a'] } });
    const r = await checkServiceAccountPermissions('p', 'sa', ['a', 'b']);
    expect(r.hasAll).toBe(false);
    expect(r.missing).toContain('b');
  });

  it('listServiceAccounts single page', async () => {
    mockRequest.mockResolvedValue({ result: { accounts: [{ name: 'sa1' }] } });
    expect((await listServiceAccounts('p'))).toHaveLength(1);
  });

  it('listServiceAccounts paginated', async () => {
    mockRequest
      .mockResolvedValueOnce({ result: { accounts: [{ name: 'sa1' }], nextPageToken: 'tok' } })
      .mockResolvedValueOnce({ result: { accounts: [{ name: 'sa2' }] } });
    expect((await listServiceAccounts('p'))).toHaveLength(2);
  });

  it('listWorkloadIdentityPools filters DELETED', async () => {
    mockRequest.mockResolvedValue({ result: { workforcePools: [
      { name: 'p1', state: 'ACTIVE' }, { name: 'p2', state: 'DELETED' },
    ]}});
    const pools = await listWorkloadIdentityPools('proj');
    expect(pools).toHaveLength(1);
    expect(pools[0].name).toBe('p1');
  });

  it('listWorkloadIdentityPools paginated', async () => {
    mockRequest
      .mockResolvedValueOnce({ result: { workforcePools: [{ name: 'p1', state: 'ACTIVE' }], nextPageToken: 't' } })
      .mockResolvedValueOnce({ result: { workforcePools: [{ name: 'p2', state: 'ACTIVE' }] } });
    expect((await listWorkloadIdentityPools('proj'))).toHaveLength(2);
  });

  it('listWorkloadIdentityProviders filters DELETED', async () => {
    mockRequest.mockResolvedValue({ result: { workforcePoolProviders: [
      { state: 'ACTIVE' }, { state: 'DELETED' }
    ]}});
    expect((await listWorkloadIdentityProviders('locations/global/workforcePools/pool', 'p'))).toHaveLength(1);
  });

  it('getServiceAccountIamPolicy', async () => {
    mockRequest.mockResolvedValue({ result: { bindings: [] } });
    expect(await getServiceAccountIamPolicy('sa@p.iam', 'p')).toEqual({ bindings: [] });
  });

  it('getProjectIamPolicy', async () => {
    mockRequest.mockResolvedValue({ result: { version: 3 } });
    expect(await getProjectIamPolicy('p')).toEqual({ version: 3 });
  });

  it('setProjectIamPolicy', async () => {
    mockRequest.mockResolvedValue({ result: { version: 3 } });
    expect(await setProjectIamPolicy('p', { version: 3 })).toEqual({ version: 3 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BigQuery & Logging Sinks
// ═══════════════════════════════════════════════════════════════════════════════
describe('BigQuery & Logging Sinks', () => {
  it('getDataset', async () => {
    mockRequest.mockResolvedValue({ result: { datasetId: 'ds1' } });
    expect(await getDataset('p', 'ds1')).toEqual({ datasetId: 'ds1' });
  });
  it('updateDatasetAccess', async () => {
    mockRequest.mockResolvedValue({ result: { ok: true } });
    expect(await updateDatasetAccess('p', 'ds', [])).toEqual({ ok: true });
  });
  it('createLoggingSink', async () => {
    mockRequest.mockResolvedValue({ result: { name: 's1' } });
    expect(await createLoggingSink('p', 's1', 'bq://...', '')).toEqual({ name: 's1' });
  });
  it('getLoggingSink', async () => {
    mockRequest.mockResolvedValue({ result: { name: 's1' } });
    expect(await getLoggingSink('p', 's1')).toEqual({ name: 's1' });
  });
  it('listLoggingSinks', async () => {
    mockRequest.mockResolvedValue({ result: { sinks: [] } });
    expect(await listLoggingSinks('p')).toEqual({ sinks: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Discovery Engine Resources
// ═══════════════════════════════════════════════════════════════════════════════
describe('Discovery Engine Resources', () => {
  const cases: Array<[Parameters<typeof listResources>[0], string]> = [
    ['collections', '/collections'],
    ['engines',     '/engines'],
    ['assistants',  '/assistants'],
    ['agents',      '/agents'],
    ['dataStores',  '/dataStores'],
  ];

  cases.forEach(([type, pathFragment]) => {
    it(`listResources - ${type}`, async () => {
      mockRequest.mockResolvedValue({ result: {} });
      await listResources(type, CFG);
      expect(mockRequest.mock.calls[0][0].path).toContain(pathFragment);
    });
  });

  it('listResources global → base URL without location prefix', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await listResources('collections', { ...CFG, appLocation: 'global' });
    expect(mockRequest.mock.calls[0][0].path).toContain('https://discoveryengine.googleapis.com');
  });

  it('listResources non-global → location prefix URL', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await listResources('collections', { ...CFG, appLocation: 'us-central1' });
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-discoveryengine.googleapis.com');
  });

  it('listResources with pageToken', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await listResources('collections', CFG, 'pt1');
    expect(mockRequest.mock.calls[0][0].path).toContain('pageToken=pt1');
  });

  it('listResources with config.accessToken sets custom Authorization', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await listResources('collections', { ...CFG, accessToken: 'cfg-token' });
    expect(mockRequest.mock.calls[0][0].headers['Authorization']).toBe('Bearer cfg-token');
  });

  it('createCollection', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    expect(await createCollection('c1', {}, CFG)).toEqual({ name: 'op' });
  });

  it('updateCollection', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateCollection('projects/p/cols/c', {}, ['displayName'], CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('updateMask=displayName');
  });

  it('getDiscoveryOperation', async () => {
    mockRequest.mockResolvedValue({ result: { done: true } });
    expect(await getDiscoveryOperation('operations/op1', CFG)).toEqual({ done: true });
  });

  it('listOperations without filter', async () => {
    mockRequest.mockResolvedValue({ result: { operations: [] } });
    await listOperations(CFG);
    expect(mockRequest.mock.calls[0][0].path).not.toContain('filter=');
  });

  it('listOperations with filter', async () => {
    mockRequest.mockResolvedValue({ result: { operations: [] } });
    await listOperations(CFG, 'done=true');
    expect(mockRequest.mock.calls[0][0].path).toContain('filter=');
  });

  it('listDiscoverySessions without pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { sessions: [] } });
    await listDiscoverySessions(CFG);
    expect(mockRequest.mock.calls[0][0].path).not.toContain('pageToken');
  });

  it('listDiscoverySessions with pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { sessions: [] } });
    await listDiscoverySessions(CFG, 'pt1');
    expect(mockRequest.mock.calls[0][0].path).toContain('pageToken=pt1');
  });

  it('getDiscoveryAnswer', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'ans/1' } });
    expect(await getDiscoveryAnswer('projects/p/answers/a1', CFG)).toEqual({ name: 'ans/1' });
  });

  it('createDiscoverySession with all fields', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'sess/s1' } });
    await createDiscoverySession({
      userPseudoId: 'u1', turns: [], state: 'IN_PROGRESS', startTime: '2024-01-01T00:00:00Z',
    } as any, CFG);
    expect(mockRequest.mock.calls[0][0].body).toMatchObject({ user_pseudo_id: 'u1', state: 'IN_PROGRESS' });
  });

  it('createDiscoverySession minimal (no optional fields)', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'sess/s1' } });
    await createDiscoverySession({} as any, CFG);
    expect(mockRequest.mock.calls[0][0].body.user_pseudo_id).toBeUndefined();
  });

  it('getDiscoverySession', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'sess/1' } });
    expect(await getDiscoverySession('projects/p/sess/1', CFG)).toEqual({ name: 'sess/1' });
  });

  it('getVertexAiOperation uses location from name', async () => {
    mockRequest.mockResolvedValue({ result: { done: true } });
    await getVertexAiOperation('projects/p/locations/us-east1/operations/op1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('us-east1-aiplatform');
  });

  it('getVertexAiOperation falls back to reasoningEngineLocation', async () => {
    mockRequest.mockResolvedValue({ result: { done: true } });
    await getVertexAiOperation('operations/op1', { ...CFG, reasoningEngineLocation: 'europe-west4' });
    expect(mockRequest.mock.calls[0][0].path).toContain('europe-west4-aiplatform');
  });

  it('getVertexAiOperation falls back to us-central1', async () => {
    mockRequest.mockResolvedValue({ result: { done: true } });
    await getVertexAiOperation('operations/op1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-aiplatform');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Engines
// ═══════════════════════════════════════════════════════════════════════════════
describe('Engines', () => {
  const consoleSpy = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('getEngine full resource name', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'e1' } });
    const spy = consoleSpy();
    expect(await getEngine('projects/p/locations/l/collections/c/engines/e1', CFG)).toEqual({ name: 'e1' });
    spy.mockRestore();
  });

  it('getEngine short name → constructs path', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'e1' } });
    const spy = consoleSpy();
    await getEngine('e1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('/engines/e1');
    spy.mockRestore();
  });

  it('getEngine with accessToken', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'e1' } });
    const spy = consoleSpy();
    await getEngine('e1', { ...CFG, accessToken: 'at' });
    expect(mockRequest.mock.calls[0][0].headers['Authorization']).toBe('Bearer at');
    spy.mockRestore();
  });

  it('createEngine', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    expect(await createEngine('e1', {}, CFG)).toEqual({ name: 'op' });
  });

  it('updateEngine full name', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateEngine('projects/p/locations/l/collections/c/engines/e1', {}, ['displayName'], CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('projects/p/locations/l');
  });

  it('updateEngine short name', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateEngine('e1', {}, ['displayName'], CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('/engines/e1');
  });

  it('getEngineIamPolicy full name', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await getEngineIamPolicy('projects/p/locations/l/collections/c/engines/e1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain(':getIamPolicy');
  });

  it('getEngineIamPolicy short name', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await getEngineIamPolicy('e1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('/engines/e1:getIamPolicy');
  });

  it('setEngineIamPolicy full name', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await setEngineIamPolicy('projects/p/locations/l/collections/c/engines/e1', {}, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain(':setIamPolicy');
  });

  it('setEngineIamPolicy short name', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await setEngineIamPolicy('e1', {}, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('/engines/e1:setIamPolicy');
  });

  it('getWidgetConfig', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'wc' } });
    expect(await getWidgetConfig('engines/e1', CFG)).toEqual({ name: 'wc' });
    expect(mockRequest.mock.calls[0][0].path).toContain('widgetConfigs/default_search_widget_config');
  });

  it('updateWidgetConfig', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateWidgetConfig('engines/e1', {}, ['accessSettings'], CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('updateMask=accessSettings');
  });

  it('getAclConfig', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'acl' } });
    expect(await getAclConfig(CFG)).toEqual({ name: 'acl' });
  });

  it('updateAclConfig', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateAclConfig({}, ['idpConfig'], CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('updateMask=idpConfig');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WIF helpers
// ═══════════════════════════════════════════════════════════════════════════════
describe('WIF helpers', () => {
  it('getWorkforcePoolProviders success', async () => {
    mockRequest.mockResolvedValue({ result: { workforcePoolProviders: [{}] } });
    expect((await getWorkforcePoolProviders('locations/global/workforcePools/p', CFG)).workforcePoolProviders).toHaveLength(1);
  });

  it('getWorkforcePoolProviders empty pool name returns empty', async () => {
    expect(await getWorkforcePoolProviders('', CFG)).toEqual({ workforcePoolProviders: [] });
  });

  it('getWorkforcePoolProviders error returns empty', async () => {
    mockRequest.mockRejectedValue(new Error('403'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getWorkforcePoolProviders('locations/global/workforcePools/p', CFG)).toEqual({ workforcePoolProviders: [] });
    spy.mockRestore();
  });

  it('getWorkforcePoolProviderScimTenants success', async () => {
    mockRequest.mockResolvedValue({ result: { workforcePoolProviderScimTenants: [] } });
    expect(await getWorkforcePoolProviderScimTenants('providers/pr', CFG)).toEqual({ workforcePoolProviderScimTenants: [] });
  });

  it('getWorkforcePoolProviderScimTenants error returns empty', async () => {
    mockRequest.mockRejectedValue(new Error('403'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getWorkforcePoolProviderScimTenants('providers/pr', CFG)).toEqual({ workforcePoolProviderScimTenants: [] });
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Assistants
// ═══════════════════════════════════════════════════════════════════════════════
describe('Assistants', () => {
  it('getAssistant', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'a1' } });
    expect(await getAssistant('projects/p/assistants/a1', CFG)).toEqual({ name: 'a1' });
  });
  it('updateAssistant', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateAssistant('assistants/a1', { displayName: 'A' }, ['displayName'], CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('updateMask=displayName');
  });
  it('createAssistant', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    expect(await createAssistant('a1', {}, CFG)).toEqual({ name: 'op' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Agents
// ═══════════════════════════════════════════════════════════════════════════════
describe('Agents', () => {
  it('getAgent', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'ag1' } });
    expect(await getAgent('agents/ag1', CFG)).toEqual({ name: 'ag1' });
  });
  it('getAgentView (suppresses error log)', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'ag1' } });
    expect(await getAgentView('agents/ag1', CFG)).toEqual({ name: 'ag1' });
  });
  it('createAgent without agentId', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await createAgent({}, CFG);
    expect(mockRequest.mock.calls[0][0].path).not.toContain('agentId=');
  });
  it('createAgent with agentId', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await createAgent({}, CFG, 'myAgent');
    expect(mockRequest.mock.calls[0][0].path).toContain('agentId=myAgent');
  });

  it('updateAgent with all payload fields builds updateMask', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    const payload = {
      displayName: 'A', description: 'D', icon: 'i', starterPrompts: [],
      adkAgentDefinition: {}, a2aAgentDefinition: {}, authorizations: [], authorizationConfig: {},
    };
    await updateAgent({ name: 'agents/ag1' } as any, payload, CFG);
    const path: string = mockRequest.mock.calls[0][0].path;
    expect(path).toContain('display_name');
    expect(path).toContain('a2a_agent_definition');
  });

  it('updateAgent with empty payload has empty updateMask', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateAgent({ name: 'agents/ag1' } as any, {}, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('updateMask=');
  });

  it('disableAgent calls disable then getAgent', async () => {
    mockRequest
      .mockResolvedValueOnce({ result: {} })
      .mockResolvedValueOnce({ result: { name: 'ag1', state: 'DISABLED' } });
    expect((await disableAgent('agents/ag1', CFG)).state).toBe('DISABLED');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('enableAgent calls enable then getAgent', async () => {
    mockRequest
      .mockResolvedValueOnce({ result: {} })
      .mockResolvedValueOnce({ result: { name: 'ag1', state: 'ENABLED' } });
    expect((await enableAgent('agents/ag1', CFG)).state).toBe('ENABLED');
  });

  it('shareAgent strips /assistants/default_assistant', async () => {
    mockRequest
      .mockResolvedValueOnce({ result: {} })
      .mockResolvedValueOnce({ result: { name: 'ag1' } });
    await shareAgent('projects/p/collections/c/engines/e/assistants/default_assistant/agents/ag1', CFG);
    expect(mockRequest.mock.calls[0][0].path).not.toContain('/assistants/default_assistant');
  });

  it('deleteResource uses DELETE', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteResource('projects/p/agents/ag1', CFG);
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Data Stores
// ═══════════════════════════════════════════════════════════════════════════════
describe('Data Stores', () => {
  it('getDataStore', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'ds1' } });
    expect(await getDataStore('dataStores/ds1', CFG)).toEqual({ name: 'ds1' });
  });
  it('createDataStore', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await createDataStore('ds1', {}, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('dataStoreId=ds1');
  });
  it('updateDataStore', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateDataStore('dataStores/ds1', { displayName: 'D' }, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('updateMask=displayName');
  });
  it('deleteDataStore', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteDataStore('dataStores/ds1', CFG);
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
  it('getDataConnector', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'dc' } });
    expect(await getDataConnector(CFG)).toEqual({ name: 'dc' });
  });
  it('listDocuments', async () => {
    mockRequest.mockResolvedValue({ result: { documents: [] } });
    expect(await listDocuments('dataStores/ds1', CFG)).toEqual({ documents: [] });
  });
  it('searchDocuments default query', async () => {
    mockRequest.mockResolvedValue({ result: { results: [] } });
    await searchDocuments('dataStores/ds1', CFG);
    expect(mockRequest.mock.calls[0][0].body.query).toBe('*');
  });
  it('searchDocuments custom query', async () => {
    mockRequest.mockResolvedValue({ result: { results: [] } });
    await searchDocuments('dataStores/ds1', CFG, 'hello');
    expect(mockRequest.mock.calls[0][0].body.query).toBe('hello');
  });
  it('queryDataStore without pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { results: [] } });
    await queryDataStore('dataStores/ds1', CFG, 'q');
    expect(mockRequest.mock.calls[0][0].body.pageToken).toBeUndefined();
  });
  it('queryDataStore with pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { results: [] } });
    await queryDataStore('dataStores/ds1', CFG, 'q', 5, 'pt1');
    expect(mockRequest.mock.calls[0][0].body.pageToken).toBe('pt1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Documents & Authorizations
// ═══════════════════════════════════════════════════════════════════════════════
describe('Documents & Authorizations', () => {
  it('getDocument', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'doc1' } });
    expect(await getDocument('dataStores/ds1/documents/d1', CFG)).toEqual({ name: 'doc1' });
  });
  it('importDocuments', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    expect(await importDocuments('dataStores/ds1', ['gs://b/f'], 'b', CFG)).toEqual({ name: 'op' });
  });
  it('listAuthorizations without pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { authorizations: [] } });
    await listAuthorizations(CFG);
    expect(mockRequest.mock.calls[0][0].path).not.toContain('pageToken');
  });
  it('listAuthorizations with pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { authorizations: [] } });
    await listAuthorizations(CFG, 'pt1');
    expect(mockRequest.mock.calls[0][0].path).toContain('pageToken=pt1');
  });
  it('getAuthorization uses location from name', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'a1' } });
    await getAuthorization('projects/p/locations/global/authorizations/a1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('discoveryengine.googleapis.com');
  });
  it('createAuthorization', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'a1' } });
    expect(await createAuthorization('a1', {}, CFG)).toEqual({ name: 'a1' });
  });
  it('updateAuthorization', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await updateAuthorization('projects/p/locations/global/authorizations/a1', {}, ['displayName'], CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('updateMask=displayName');
  });
  it('deleteAuthorization full resource name', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteAuthorization('projects/p/locations/global/authorizations/a1', CFG);
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
  it('deleteAuthorization short name constructs URL', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteAuthorization('a1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('/authorizations/a1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Reasoning Engines
// ═══════════════════════════════════════════════════════════════════════════════
describe('Reasoning Engines', () => {
  it('listReasoningEngines with reasoningEngineLocation', async () => {
    mockRequest.mockResolvedValue({ result: { reasoningEngines: [] } });
    await listReasoningEngines({ ...CFG, reasoningEngineLocation: 'us-central1' });
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-aiplatform');
  });
  it('listReasoningEngines falls back to us-central1', async () => {
    mockRequest.mockResolvedValue({ result: { reasoningEngines: [] } });
    await listReasoningEngines(CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-aiplatform');
  });
  it('listReasoningEngines with pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { reasoningEngines: [] } });
    await listReasoningEngines(CFG, 'pt1');
    expect(mockRequest.mock.calls[0][0].path).toContain('pageToken=pt1');
  });
  it('getReasoningEngine', async () => {
    mockRequest.mockResolvedValue({ result: { name: 're1' } });
    expect(await getReasoningEngine('projects/p/locations/us-central1/reasoningEngines/re1', CFG)).toEqual({ name: 're1' });
  });
  it('createReasoningEngine', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    expect(await createReasoningEngine(CFG, { displayName: 'RE1' })).toEqual({ name: 'op' });
  });
  it('deleteReasoningEngine adds force=true', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteReasoningEngine('projects/p/locations/us-central1/reasoningEngines/re1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('force=true');
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
  it('getReasoningEngineSession', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'sess1' } });
    expect(await getReasoningEngineSession('projects/p/locations/us-central1/reasoningEngines/re1/sessions/s1', CFG)).toEqual({ name: 'sess1' });
  });
  it('listReasoningEngineSessions', async () => {
    mockRequest.mockResolvedValue({ result: { sessions: [] } });
    expect(await listReasoningEngineSessions('projects/p/locations/us-central1/reasoningEngines/re1', CFG)).toEqual({ sessions: [] });
  });
  it('deleteReasoningEngineSession', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteReasoningEngineSession('projects/p/locations/us-central1/reasoningEngines/re1/sessions/s1', CFG);
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cloud Run, GCS, Cloud Build, BigQuery, Logging, Dialogflow, IAM helpers
// ═══════════════════════════════════════════════════════════════════════════════
describe('Cloud Run', () => {
  it('listCloudRunServices', async () => {
    mockRequest.mockResolvedValue({ result: { services: [] } });
    expect(await listCloudRunServices(CFG, 'us-central1')).toEqual({ services: [] });
  });
  it('getCloudRunService extracts region', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'svc' } });
    await getCloudRunService('projects/p/locations/us-central1/services/s1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-run.googleapis.com');
  });
  it('deleteCloudRunService uses DELETE', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteCloudRunService('projects/p/locations/us-central1/services/s1', CFG);
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
});

describe('GCS', () => {
  it('listBuckets', async () => {
    mockRequest.mockResolvedValue({ result: { items: [] } });
    expect(await listBuckets('p')).toEqual({ items: [] });
  });
  it('listGcsObjects with prefix', async () => {
    mockRequest.mockResolvedValue({ result: { items: [] } });
    await listGcsObjects('bucket', 'prefix/', 'p');
    expect(mockRequest.mock.calls[0][0].path).toContain('prefix=');
  });
  it('listGcsObjects without prefix', async () => {
    mockRequest.mockResolvedValue({ result: { items: [] } });
    await listGcsObjects('bucket', '', 'p');
    expect(mockRequest.mock.calls[0][0].path).not.toContain('prefix=');
  });
  it('deleteGcsObject uses DELETE', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteGcsObject('bucket', 'obj.json', 'p');
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
  it('getGcsObjectContent calls client.request directly', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ body: '{"data":1}' });
    const r = await getGcsObjectContent('bucket', 'obj.json', 'p');
    expect(r).toBe('{"data":1}');
    mockClient.request = mockRequest;
  });
  it('getGcsObjectContent stringifies non-string body', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ body: { data: 1 } });
    const r = await getGcsObjectContent('bucket', 'obj.json', 'p');
    expect(r).toContain('"data"');
    mockClient.request = mockRequest;
  });
});

describe('Cloud Build', () => {
  it('createCloudBuild', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    expect(await createCloudBuild('p', {})).toEqual({ name: 'op' });
    spy.mockRestore();
  });
  it('listCloudBuilds without filter', async () => {
    mockRequest.mockResolvedValue({ result: { builds: [] } });
    await listCloudBuilds('p');
    expect(mockRequest.mock.calls[0][0].path).not.toContain('?filter');
  });
  it('listCloudBuilds with filter', async () => {
    mockRequest.mockResolvedValue({ result: { builds: [] } });
    await listCloudBuilds('p', 'status=SUCCESS');
    expect(mockRequest.mock.calls[0][0].path).toContain('filter=');
  });
  it('getCloudBuild', async () => {
    mockRequest.mockResolvedValue({ result: { id: 'b1' } });
    expect(await getCloudBuild('p', 'b1')).toEqual({ id: 'b1' });
  });
});

describe('BigQuery', () => {
  it('listBigQueryDatasets', async () => {
    mockRequest.mockResolvedValue({ result: { datasets: [] } });
    expect(await listBigQueryDatasets('p')).toEqual({ datasets: [] });
  });
  it('createBigQueryDataset default location', async () => {
    mockRequest.mockResolvedValue({ result: { id: 'ds1' } });
    await createBigQueryDataset('p', 'ds1');
    expect(mockRequest.mock.calls[0][0].body.location).toBe('US');
  });
  it('createBigQueryDataset custom location', async () => {
    mockRequest.mockResolvedValue({ result: { id: 'ds1' } });
    await createBigQueryDataset('p', 'ds1', 'EU');
    expect(mockRequest.mock.calls[0][0].body.location).toBe('EU');
  });
  it('listBigQueryTables', async () => {
    mockRequest.mockResolvedValue({ result: { tables: [] } });
    expect(await listBigQueryTables('p', 'ds1')).toEqual({ tables: [] });
  });
  it('createBigQueryTable', async () => {
    mockRequest.mockResolvedValue({ result: { id: 't1' } });
    expect(await createBigQueryTable('p', 'ds1', 't1')).toEqual({ id: 't1' });
  });
  it('runBigQueryQuery', async () => {
    mockRequest.mockResolvedValue({ result: { rows: [] } });
    expect(await runBigQueryQuery('p', 'SELECT 1')).toEqual({ rows: [] });
  });
});

describe('Logging', () => {
  it('fetchViolationLogs', async () => {
    mockRequest.mockResolvedValue({ result: { entries: [] } });
    expect(await fetchViolationLogs(CFG)).toEqual({ entries: [] });
  });
  it('fetchViolationLogs with custom filter', async () => {
    mockRequest.mockResolvedValue({ result: { entries: [] } });
    await fetchViolationLogs(CFG, 'severity=ERROR');
    expect(mockRequest.mock.calls[0][0].body.filter).toContain('severity=ERROR');
  });
  it('fetchConnectorLogs', async () => {
    mockRequest.mockResolvedValue({ result: { entries: [] } });
    expect(await fetchConnectorLogs(CFG, 'projects/p/locations/l/collections/c/dataConnector')).toEqual({ entries: [] });
  });
  it('fetchLastRunLog', async () => {
    mockRequest.mockResolvedValue({ result: { entries: [] } });
    expect(await fetchLastRunLog(CFG, 'my-service')).toEqual({ entries: [] });
  });
});

describe('Dialogflow CX', () => {
  it('listDialogflowAgents uses reasoningEngineLocation', async () => {
    mockRequest.mockResolvedValue({ result: { agents: [] } });
    await listDialogflowAgents({ ...CFG, reasoningEngineLocation: 'us-central1' });
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-dialogflow.googleapis.com');
  });
  it('listDialogflowAgents falls back to us-central1', async () => {
    mockRequest.mockResolvedValue({ result: { agents: [] } });
    await listDialogflowAgents(CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-dialogflow.googleapis.com');
  });
  it('deleteDialogflowAgent uses DELETE', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteDialogflowAgent('projects/p/locations/us-central1/agents/a1', CFG);
    expect(mockRequest.mock.calls[0][0].method).toBe('DELETE');
  });
});

describe('Agent IAM helpers', () => {
  it('getAgentIamPolicy', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await getAgentIamPolicy('agents/ag1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain(':getIamPolicy');
  });
  it('setAgentIamPolicy', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await setAgentIamPolicy('agents/ag1', {}, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain(':setIamPolicy');
  });
  it('setAgentIamPolicy with suppressErrorLog=true', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await setAgentIamPolicy('agents/ag1', {}, CFG, true);
    // Simply verify it doesn't throw
  });
});

describe('Compute Engine', () => {
  it('listGlobalForwardingRules', async () => {
    mockRequest.mockResolvedValue({ result: { items: [] } });
    expect(await listGlobalForwardingRules('p')).toEqual({ items: [] });
  });
  it('listManagedSslCertificates', async () => {
    mockRequest.mockResolvedValue({ result: { items: [] } });
    expect(await listManagedSslCertificates('p')).toEqual({ items: [] });
  });
});

describe('Analytics & License Management', () => {
  it('exportAnalyticsMetrics', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    expect(await exportAnalyticsMetrics(CFG, 'ds1', 't1')).toEqual({ name: 'op' });
  });
  it('getAgentEngineToolLatencies engine_id filter', async () => {
    mockRequest.mockResolvedValue({ result: { timeSeries: [] } });
    await getAgentEngineToolLatencies(CFG, 'engine-1', '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', 'engine_id');
    expect(mockRequest.mock.calls[0][0].path).toContain('engine_id');
  });
  it('getAgentEngineToolLatencies tool_id filter', async () => {
    mockRequest.mockResolvedValue({ result: { timeSeries: [] } });
    await getAgentEngineToolLatencies(CFG, 'tool-1', '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', 'tool_id');
    expect(mockRequest.mock.calls[0][0].path).toContain('tool_id');
  });
  it('listUserStoreLicenses with filter and pageToken', async () => {
    mockRequest.mockResolvedValue({ result: { userLicenses: [] } });
    await listUserStoreLicenses(CFG, 'store1', 'assigned=true', 'pt1');
    expect(mockRequest.mock.calls[0][0].path).toContain('filter=');
    expect(mockRequest.mock.calls[0][0].path).toContain('pageToken=');
  });
  it('revokeUserLicenses', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await revokeUserLicenses(CFG, 'store1', ['user@example.com']);
    expect(mockRequest.mock.calls[0][0].body.inlineSource.userLicenses[0].userPrincipal).toBe('user@example.com');
  });
  it('assignUserLicenses', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await assignUserLicenses(CFG, 'store1', ['user@example.com'], 'projects/p/licenseConfigs/lc1');
    expect(mockRequest.mock.calls[0][0].body.inlineSource.userLicenses[0].licenseConfig).toBe('projects/p/licenseConfigs/lc1');
  });
  it('deleteUserLicenses', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await deleteUserLicenses(CFG, 'store1', ['user@example.com']);
    expect(mockRequest.mock.calls[0][0].body.deleteUnassignedUserLicenses).toBe(true);
  });
});

describe('A2A & Notebooks', () => {
  it('registerA2aAgent delegates to createAgent', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await registerA2aAgent(CFG, 'ag1', { displayName: 'A' });
    expect(mockRequest.mock.calls[0][0].path).toContain('agentId=ag1');
  });
  it('listNotebooks', async () => {
    mockRequest.mockResolvedValue({ result: { notebooks: [] } });
    expect(await listNotebooks(CFG)).toEqual({ notebooks: [] });
  });
  it('getNotebook', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'nb1' } });
    expect(await getNotebook(CFG, 'nb1')).toEqual({ name: 'nb1' });
  });
  it('getNotebookSource', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'src1' } });
    expect(await getNotebookSource(CFG, 'nb1', 'src1')).toEqual({ name: 'src1' });
  });
  it('createNotebook', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'nb1' } });
    expect(await createNotebook(CFG, { displayName: 'NB1' })).toEqual({ name: 'nb1' });
  });
  it('batchCreateNotebookSources', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await batchCreateNotebookSources(CFG, 'nb1', [{ content: 'text' }]);
    expect(mockRequest.mock.calls[0][0].path).toContain('sources:batchCreate');
  });
  it('validateWorkforcePool', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'pool1' } });
    expect(await validateWorkforcePool('locations/global/workforcePools/p1', CFG)).toEqual({ name: 'pool1' });
  });
});

describe('Billing & License Configs', () => {
  it('listBillingAccounts', async () => {
    mockRequest.mockResolvedValue({ result: { billingAccounts: [] } });
    expect(await listBillingAccounts(CFG)).toEqual({ billingAccounts: [] });
  });
  it('testBillingAccountPermissions (suppressErrorLog=true)', async () => {
    mockRequest.mockResolvedValue({ result: { permissions: [] } });
    expect(await testBillingAccountPermissions('ba1', CFG)).toEqual({ permissions: [] });
  });
  it('listBillingAccountLicenseConfigs', async () => {
    mockRequest.mockResolvedValue({ result: { billingAccountLicenseConfigs: [] } });
    expect(await listBillingAccountLicenseConfigs('ba1', CFG)).toEqual({ billingAccountLicenseConfigs: [] });
  });
  it('listLicenseConfigs', async () => {
    mockRequest.mockResolvedValue({ result: { licenseConfigs: [] } });
    expect(await listLicenseConfigs(CFG)).toEqual({ licenseConfigs: [] });
  });
  it('listLicenseConfigsUsageStats default userStoreId', async () => {
    mockRequest.mockResolvedValue({ result: { licenseConfigUsageStats: [] } });
    await listLicenseConfigsUsageStats(CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('default_user_store');
  });
  it('listUserLicenses', async () => {
    mockRequest.mockResolvedValue({ result: { userLicenses: [] } });
    expect(await listUserLicenses(CFG)).toEqual({ userLicenses: [] });
  });
  it('getLicenseConfig uses location from resource name', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'lc1' } });
    await getLicenseConfig('projects/p/locations/us-central1/licenseConfigs/lc1', CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain('us-central1-discoveryengine');
  });
  it('distributeLicense', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await distributeLicense('ba1', 'balc1', { projectNumber: '9', location: 'us-central1', licenseCount: 5 }, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain(':distributeLicenseConfig');
  });
  it('probeProjectLicense without projectLicenseConfigId', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await probeProjectLicense('ba1', 'balc1', '9', CFG);
    expect(mockRequest.mock.calls[0][0].body.licenseCount).toBe(0);
  });
  it('probeProjectLicense with projectLicenseConfigId', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await probeProjectLicense('ba1', 'balc1', '9', CFG, 'projects/p/licenseConfigs/lc1');
    expect(mockRequest.mock.calls[0][0].body.licenseConfigId).toBe('projects/p/licenseConfigs/lc1');
  });
  it('retractLicense uses location from licenseConfig', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'op' } });
    await retractLicense('ba1', 'balc1', { licenseConfig: 'projects/p/locations/us-central1/licenseConfigs/lc1', licenseCount: 2 }, CFG);
    expect(mockRequest.mock.calls[0][0].path).toContain(':retractLicenseConfig');
  });
  it('checkServiceEnabled returns true when ENABLED', async () => {
    mockRequest.mockResolvedValue({ result: { state: 'ENABLED' } });
    expect(await checkServiceEnabled('p', 'storage.googleapis.com')).toBe(true);
  });
  it('checkServiceEnabled returns false when DISABLED', async () => {
    mockRequest.mockResolvedValue({ result: { state: 'DISABLED' } });
    expect(await checkServiceEnabled('p', 'storage.googleapis.com')).toBe(false);
  });
  it('checkServiceEnabled returns false on error', async () => {
    mockRequest.mockRejectedValue(new Error('403'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkServiceEnabled('p', 'storage.googleapis.com')).toBe(false);
    spy.mockRestore();
  });
  it('enableService', async () => {
    mockRequest.mockResolvedValue({ result: {} });
    await enableService('p', 'storage.googleapis.com');
    expect(mockRequest.mock.calls[0][0].path).toContain(':enable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fetch-based APIs
// ═══════════════════════════════════════════════════════════════════════════════
describe('fetch-based APIs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('fetchWorkforceProviderConfig calls gapiRequest', async () => {
    mockRequest.mockResolvedValue({ result: { name: 'prov' } });
    const r = await fetchWorkforceProviderConfig('pool1', 'prov1');
    expect(r).toEqual({ name: 'prov' });
    expect(mockRequest.mock.calls[0][0].path).toContain('workforcePools/pool1/providers/prov1');
  });

  it('fetchOidcDiscovery success', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authorization_endpoint: 'https://idp/auth', token_endpoint: 'https://idp/token', issuer: 'https://idp' }),
    } as any);
    const r = await fetchOidcDiscovery('https://idp');
    expect(r.authorization_endpoint).toBe('https://idp/auth');
    expect(fetchSpy).toHaveBeenCalledWith('https://idp/.well-known/openid-configuration');
  });

  it('fetchOidcDiscovery strips trailing slash', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ authorization_endpoint: 'a', token_endpoint: 'b', issuer: 'c' }) } as any);
    await fetchOidcDiscovery('https://idp/');
    expect(fetchSpy).toHaveBeenCalledWith('https://idp/.well-known/openid-configuration');
  });

  it('fetchOidcDiscovery throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, statusText: 'Not Found' } as any);
    await expect(fetchOidcDiscovery('https://idp')).rejects.toThrow('Failed to fetch OIDC discovery document');
  });

  it('exchangeStsToken success', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ access_token: 'sts', expires_in: 3600, token_type: 'Bearer' }) } as any);
    const r = await exchangeStsToken({ userProject: 'p', poolId: 'pool', providerId: 'prov', subjectToken: 'id', subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token' });
    expect(r.access_token).toBe('sts');
  });

  it('exchangeStsToken throws with error_description', async () => {
    fetchSpy.mockResolvedValue({ ok: false, statusText: 'Unauth', json: () => Promise.resolve({ error_description: 'Bad token' }) } as any);
    await expect(exchangeStsToken({ userProject: 'p', poolId: 'pool', providerId: 'prov', subjectToken: 'bad', subjectTokenType: 'urn:...' })).rejects.toThrow('Bad token');
  });

  it('exchangeStsToken throws with error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, statusText: 'Unauth', json: () => Promise.resolve({ error: 'invalid_request' }) } as any);
    await expect(exchangeStsToken({ userProject: 'p', poolId: 'p', providerId: 'p', subjectToken: 'b', subjectTokenType: 'u' })).rejects.toThrow('STS Token Exchange failed');
  });

  it('queryDataStoreWithToken success', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [], totalSize: 0 }) } as any);
    const r = await queryDataStoreWithToken('dataStores/ds1', 'us-central1', 'p', 'tok', 'q');
    expect(r).toEqual({ results: [], totalSize: 0 });
    expect(fetchSpy.mock.calls[0][0]).toContain('us-central1-discoveryengine');
  });

  it('queryDataStoreWithToken throws with error.message', async () => {
    fetchSpy.mockResolvedValue({ ok: false, statusText: 'Forbidden', json: () => Promise.resolve({ error: { message: 'Access denied' } }) } as any);
    await expect(queryDataStoreWithToken('ds', 'us-central1', 'p', 't', 'q')).rejects.toThrow('Access denied');
  });

  it('queryDataStoreWithToken throws with statusText fallback', async () => {
    fetchSpy.mockResolvedValue({ ok: false, statusText: 'Forbidden', json: () => Promise.resolve({}) } as any);
    await expect(queryDataStoreWithToken('ds', 'us-central1', 'p', 't', 'q')).rejects.toThrow('Forbidden');
  });

  it('signInWithOidcPopup throws when popup blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(signInWithOidcPopup('https://idp/auth', 'clientId', 'https://app/callback')).rejects.toThrow('Popup was blocked');
  });

  it('fetchA2aAgentCard success', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ name: 'agent' }) } as any);
    const r = await fetchA2aAgentCard('https://agent.example', 'token');
    expect(r).toEqual({ name: 'agent' });
  });

  it('fetchA2aAgentCard throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('Not Found') } as any);
    await expect(fetchA2aAgentCard('https://agent.example', 'token')).rejects.toThrow('A2A Discovery Error');
  });

  it('invokeA2aAgent success', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ result: 'ok' }) } as any);
    const r = await invokeA2aAgent('https://agent.example/', 'hello', 'token');
    expect(r).toEqual({ result: 'ok' });
    expect(fetchSpy.mock.calls[0][0]).toContain('/invoke');
  });

  it('invokeA2aAgent throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('Err') } as any);
    await expect(invokeA2aAgent('https://agent.example', 'hello', 'token')).rejects.toThrow('A2A Invocation Error');
  });

  it('uploadFileToGcs success', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ name: 'obj' }) } as any);
    const blob = new Blob(['data'], { type: 'text/plain' });
    const r = await uploadFileToGcs('bucket', 'obj.txt', blob, 'p');
    expect(r).toEqual({ name: 'obj' });
  });

  it('uploadFileToGcs throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') } as any);
    const blob = new Blob(['data']);
    await expect(uploadFileToGcs('bucket', 'obj.txt', blob, 'p')).rejects.toThrow('GCS Upload Failed');
  });

  it('downloadGcsObject success returns blob', async () => {
    const mockBlob = new Blob(['bytes']);
    fetchSpy.mockResolvedValue({ ok: true, blob: () => Promise.resolve(mockBlob) } as any);
    const r = await downloadGcsObject('gs://bucket', 'obj.bin', 'token');
    expect(r).toBe(mockBlob);
  });

  it('downloadGcsObject throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('Not Found') } as any);
    await expect(downloadGcsObject('gs://bucket', 'obj.bin', 'token')).rejects.toThrow('Failed to download object');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// streamChat
// ═══════════════════════════════════════════════════════════════════════════════
describe('streamChat', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', text: () => Promise.resolve('Err') } as any);
    await expect(streamChat(null, 'hi', null, CFG, 'tok', vi.fn())).rejects.toThrow('Chat API Error');
  });

  it('parses brace-balanced JSON and calls onChunk', async () => {
    const chunk = JSON.stringify({ answer: { text: 'Hello' } });
    fetchSpy.mockResolvedValue(makeStreamResponse([chunk]));
    const onChunk = vi.fn();
    await streamChat(null, 'hi', null, CFG, 'tok', onChunk);
    expect(onChunk).toHaveBeenCalledWith({ answer: { text: 'Hello' } });
  });

  it('handles null reader gracefully', async () => {
    fetchSpy.mockResolvedValue({ ok: true, body: null } as any);
    await expect(streamChat(null, 'hi', null, CFG, 'tok', vi.fn())).resolves.toBeUndefined();
  });

  it('includes sessionId in body', async () => {
    fetchSpy.mockResolvedValue(makeStreamResponse([]));
    await streamChat(null, 'hi', 'sess1', CFG, 'tok', vi.fn());
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.session).toBe('sess1');
  });

  it('omits session when null', async () => {
    fetchSpy.mockResolvedValue(makeStreamResponse([]));
    await streamChat(null, 'hi', null, CFG, 'tok', vi.fn());
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.session).toBeUndefined();
  });

  it('includes toolsSpec when provided', async () => {
    fetchSpy.mockResolvedValue(makeStreamResponse([]));
    await streamChat(null, 'hi', null, CFG, 'tok', vi.fn(), { tools: [] });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.toolsSpec).toEqual({ tools: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// streamQueryReasoningEngine
// ═══════════════════════════════════════════════════════════════════════════════
describe('streamQueryReasoningEngine', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', text: () => Promise.resolve('Forbidden') } as any);
    await expect(streamQueryReasoningEngine('projects/p/locations/us-central1/reasoningEngines/re1', 'q', 'u', CFG, 'tok', vi.fn())).rejects.toThrow('Reasoning Engine Stream API Error');
  });

  it('parses NDJSON lines and calls onChunk', async () => {
    const l1 = JSON.stringify({ output: 'chunk1' });
    const l2 = JSON.stringify({ output: 'chunk2' });
    fetchSpy.mockResolvedValue({ ok: true, body: makeStream([`${l1}\n${l2}\n`]) } as any);
    const onChunk = vi.fn();
    await streamQueryReasoningEngine('projects/p/locations/us-central1/reasoningEngines/re1', 'q', 'u', CFG, 'tok', onChunk);
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  it('handles null reader gracefully', async () => {
    fetchSpy.mockResolvedValue({ ok: true, body: null } as any);
    await expect(streamQueryReasoningEngine('projects/p/locations/us-central1/reasoningEngines/re1', 'q', 'u', CFG, 'tok', vi.fn())).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// generateVertexContent
// ═══════════════════════════════════════════════════════════════════════════════
describe('generateVertexContent', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') } as any);
    await expect(generateVertexContent(CFG, 'hello')).rejects.toThrow('Vertex AI Error');
  });

  it('extracts and returns text from stream', async () => {
    const jsonChunk = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello World' }] } }] });
    fetchSpy.mockResolvedValue(makeStreamResponse([jsonChunk]));
    const result = await generateVertexContent(CFG, 'hello');
    expect(result).toBe('Hello World');
  });

  it('handles null reader and returns empty string', async () => {
    fetchSpy.mockResolvedValue({ ok: true, body: null } as any);
    expect(await generateVertexContent(CFG, 'hello')).toBe('');
  });

  it('uses custom model when specified', async () => {
    fetchSpy.mockResolvedValue(makeStreamResponse([]));
    await generateVertexContent(CFG, 'hello', 'gemini-2.5-pro');
    expect(fetchSpy.mock.calls[0][0]).toContain('gemini-2.5-pro');
  });
});
