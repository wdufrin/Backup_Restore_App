import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock gapiService so no real gapi initialization is needed ─────────────────
vi.mock('../gapiService', () => ({ getGapiClient: vi.fn() }));

import { getGapiClient } from '../gapiService';
import {
  batchCreateNotebookSources,
  batchEnableApis,
  checkServiceAccountPermissions,
  createAgent,
  createAssistant,
  createCollection,
  createDataStore,
  createDiscoverySession,
  createEngine,
  createLoggingSink,
  createNotebook,
  deleteDataStore,
  deleteResource,
  disableAgent,
  downloadGcsObject,
  enableAgent,
  exchangeStsToken,
  fetchOidcDiscovery,
  fetchWorkforceProviderConfig,
  gapiRequest,
  getAclConfig,
  getAgent,
  getAgentIamPolicy,
  getAgentView,
  getAssistant,
  getDataConnector,
  getDataStore,
  getDataset,
  getDiscoveryAnswer,
  getDiscoveryOperation,
  getDiscoverySession,
  getEngine,
  getEngineIamPolicy,
  getLoggingSink,
  getNotebook,
  getNotebookSource,
  getProject,
  getProjectIamPolicy,
  getProjectNumber,
  getReasoningEngine,
  getServiceAccountIamPolicy,
  getServiceUsageOperation,
  getUserInfo,
  getVertexAiOperation,
  getWidgetConfig,
  getWorkforcePoolProviderScimTenants,
  getWorkforcePoolProviders,
  listDiscoverySessions,
  listDocuments,
  listLoggingSinks,
  listNotebooks,
  listOperations,
  listReasoningEngines,
  listResources,
  listServiceAccounts,
  listWorkloadIdentityPools,
  listWorkloadIdentityProviders,
  queryDataStore,
  restoreAgentsServerSide,
  searchDocuments,
  setAgentIamPolicy,
  setDebugLogger,
  setEngineIamPolicy,
  setProjectIamPolicy,
  shareAgent,
  signInWithOidcPopup,
  updateAclConfig,
  updateAgent,
  updateAssistant,
  updateCollection,
  updateDataStore,
  updateDatasetAccess,
  updateEngine,
  updateWidgetConfig,
  validateEnabledApis,
  validateWorkforcePool
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
  });

// ═══════════════════════════════════════════════════════════════════════════════
// Cloud Run, GCS, Cloud Build, BigQuery, Logging, Dialogflow, IAM helpers
// ═══════════════════════════════════════════════════════════════════════════════
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

describe('A2A & Notebooks', () => {
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

  it('signInWithOidcPopup throws when popup blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(signInWithOidcPopup('https://idp/auth', 'clientId', 'https://app/callback')).rejects.toThrow('Popup was blocked');
  });

  });

// ═══════════════════════════════════════════════════════════════════════════════
// streamChat
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// streamQueryReasoningEngine
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// generateVertexContent
// ═══════════════════════════════════════════════════════════════════════════════
