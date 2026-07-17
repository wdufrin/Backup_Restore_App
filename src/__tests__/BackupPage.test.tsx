import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BackupPage from '../BackupPage';
import * as api from '../services/apiService';

// Mock localStorage and sessionStorage
const createMockStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: any) => { store[key] = (value ?? '').toString(); }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    length: 0,
    key: vi.fn(),
  };
};

const mockLocalStorage = createMockStorage();
const mockSessionStorage = createMockStorage();

Object.defineProperty(window, 'localStorage', { value: mockLocalStorage, writable: true });
Object.defineProperty(window, 'sessionStorage', { value: mockSessionStorage, writable: true });

// Mock all apiService exports
vi.mock('../services/apiService', () => {
  return {
    listResources: vi.fn(() => Promise.resolve({ agents: [], engines: [] })),
    getAgentView: vi.fn(() => Promise.resolve({ agentView: {} })),
    getAgentIamPolicy: vi.fn(() => Promise.resolve({ bindings: [] })),
    listNotebooks: vi.fn(() => Promise.resolve({ notebooks: [] })),
    getNotebook: vi.fn(() => Promise.resolve({ sources: [] })),
    getNotebookSource: vi.fn(() => Promise.resolve({})),
    getUserInfo: vi.fn(() => Promise.resolve({ sub: '123' })),
    listReasoningEngines: vi.fn(() => Promise.resolve({ reasoningEngines: [] })),
    createNotebook: vi.fn(() => Promise.resolve({ name: 'projects/test/locations/global/notebooks/new-nb-1' })),
  };
});

// Mock URL helper methods for file downloads in tests
if (typeof window !== 'undefined') {
  window.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  window.URL.revokeObjectURL = vi.fn();
}

describe('BackupPage Component - Env, Inputs & Outputs', () => {
  const mockProps = {
    accessToken: 'test-access-token',
    projectNumber: '123456789',
    setProjectNumber: vi.fn(),
    userEmail: 'test-user@google.com',
    isSettingsOpen: false,
    onCloseSettings: vi.fn(),
    poolId: '',
    featureFlags: { 
      idpChangeEnabled: true,
      enableGoogleIdp: true,
      enableWifIdp: true,
      enableOktaIdp: true
    },
    setFeatureFlags: vi.fn(),
    googleClientId: 'mock-client-id',
    setGoogleClientId: vi.fn(),
    wifConfigState: {},
    setWifConfigState: vi.fn(),
    oktaConfigState: {},
    setOktaConfigState: vi.fn(),
    sourceIdp: 'Google',
    setSourceIdp: vi.fn(),
    targetIdp: 'Google',
    setTargetIdp: vi.fn(),
    userSub: 'test-sub',
    googleUserProject: 'test-google-user-project',
    setGoogleUserProject: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('correctly loads and merges environment variable configuration overrides', async () => {
    window.history.pushState({}, '', '?admin=true');

    // Override defaults via runtimeConfig prop
    const runtimeConfig = {
      VITE_SOURCE_PROJECT: 'runtime-source-project',
      VITE_TARGET_PROJECT: 'runtime-target-project',
      VITE_SOURCE_LOCATION: 'us-central1',
      VITE_BYPASS_OWNER_FILTER: 'true',
    };

    const { container } = render(<BackupPage {...mockProps} runtimeConfig={runtimeConfig} />);

    // Switch to Admin View
    const adminTab = screen.getByRole('button', { name: /Admin View/i });
    fireEvent.click(adminTab);

    // Verify localStorage or component state reflects runtimeConfig overrides
    const textInputs = container.querySelectorAll('input[type="text"]');
    // textInputs[0] is Source Project ID
    // textInputs[2] is Target Project ID
    const sourceProjectVal = (textInputs[0] as HTMLInputElement).value;
    const targetProjectVal = (textInputs[2] as HTMLInputElement).value;

    expect(sourceProjectVal).toBe('runtime-source-project');
    expect(targetProjectVal).toBe('runtime-target-project');
  });

  it('correctly toggles migrate agents and migrate notebooks states', async () => {
    window.history.pushState({}, '', '?admin=true');
    render(<BackupPage {...mockProps} />);

    // Switch to Admin View
    const adminTab = screen.getByRole('button', { name: /Admin View/i });
    fireEvent.click(adminTab);

    // In BackupPage, Admin view toggles govern these settings.
    // Let's toggle the settings checkboxes in the view.
    const agentsCheckbox = screen.getByLabelText(/Migrate Agents/i) as HTMLInputElement;
    const notebooksCheckbox = screen.getByLabelText(/Migrate Notebooks/i) as HTMLInputElement;

    expect(agentsCheckbox.checked).toBe(true);
    expect(notebooksCheckbox.checked).toBe(true);

    // Toggle Agents off
    fireEvent.click(agentsCheckbox);
    expect(agentsCheckbox.checked).toBe(false);

    // Click Save to persist changes to localStorage
    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    fireEvent.click(saveBtn);

    // Verify localStorage updates
    expect(window.localStorage.getItem('agentspace-shouldMigrateAgents')).toBe('false');
  });

  it('generates a valid Backup JSON payload matching the expected output format', async () => {
    window.history.pushState({}, '', '?admin=false');
    // Setup Mock APIs returns
    vi.mocked(api.listResources).mockResolvedValue({
      agents: [
        {
          name: 'projects/test-project/locations/global/agents/agent-1',
          displayName: 'Test Agent 1',
        },
      ],
    });
    vi.mocked(api.getAgentView).mockResolvedValue({
      agentView: {
        agentType: 'Low Code',
      },
    });
    vi.mocked(api.getAgentIamPolicy).mockResolvedValue({
      bindings: [],
    });
    vi.mocked(api.listNotebooks).mockResolvedValue({
      notebooks: [],
    });
    vi.mocked(api.getUserInfo).mockResolvedValue({
      sub: '109283749283749283',
    });

    const runtimeConfig = {
      VITE_SOURCE_PROJECT: 'test-source',
      VITE_TARGET_PROJECT: 'test-target',
    };

    render(<BackupPage {...mockProps} runtimeConfig={runtimeConfig} />);

    // Confirm step 1 connectors checklist
    const checkStep1 = screen.getByLabelText(/I have authenticated all required connectors/i);
    fireEvent.click(checkStep1);

    // Run Backup My Data trigger
    const backupButton = screen.getByRole('button', { name: /Backup My Data/i });
    fireEvent.click(backupButton);

    // Confirm inside the interactive modal
    await waitFor(() => {
      expect(screen.getByText(/Select Items to Backup/i)).toBeInTheDocument();
    });

    // Select all items in modal (since mock agent is optional and not auto-checked)
    const selectAllBtn = screen.getByRole('button', { name: /^Select All$/i });
    
    // Use userEvent for real browser interaction simulation to trigger state updates
    const user = userEvent.setup();
    await user.click(selectAllBtn);

    const confirmButton = await screen.findByRole('button', { name: /Backup 1 Item\(s\)/i });
    fireEvent.click(confirmButton);

    // Intercept created file download to verify output JSON format
    await waitFor(() => {
      expect(window.URL.createObjectURL).toHaveBeenCalled();
    });

    // Check payload data matching schema
    const mockBlob = vi.mocked(window.URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(mockBlob).toBeDefined();

    const reader = new FileReader();
    const payloadPromise = new Promise<any>((resolve) => {
      reader.onload = () => resolve(JSON.parse(reader.result as string));
    });
    reader.readAsText(mockBlob);

    const payload = await payloadPromise;
    expect(payload.type).toBe('UserBackup');
    expect(payload.userEmail).toBe('test-user@google.com');
    expect(payload.agents).toBeDefined();
    expect(payload.agents.length).toBe(1);
    expect(payload.agents[0].displayName).toBe('Test Agent 1');
  });

  it('correctly parses a backup JSON payload and executes the Restore flow', async () => {
    window.history.pushState({}, '', '?admin=false');
    // Setup Mock target list response and creation mock
    vi.mocked(api.listNotebooks).mockResolvedValue({ notebooks: [] });
    vi.mocked(api.createNotebook).mockResolvedValue({ name: 'projects/test/locations/global/notebooks/new-nb-1' });

    const runtimeConfig = {
      VITE_SOURCE_PROJECT: 'test-source',
      VITE_TARGET_PROJECT: 'test-target',
    };

    const { container } = render(<BackupPage {...mockProps} runtimeConfig={runtimeConfig} />);

    // Step 1 check connectors checkbox
    const checkStep1 = screen.getByLabelText(/I have authenticated all required connectors/i);
    fireEvent.click(checkStep1);

    // Mock Backup JSON data
    const backupData = {
      type: 'UserBackup',
      userEmail: 'test-user@google.com',
      createdAt: new Date().toISOString(),
      agents: [],
      notebooks: [
        {
          name: 'projects/s/locations/g/notebooks/nb-1',
          title: 'My Notebook 1',
          metadata: { someMeta: true },
          sources: []
        }
      ]
    };

    const file = new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    // Simulate file select
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Wait for FileReader asynchronous callback to log file load completion
    await waitFor(() => {
      expect(screen.getByText(/File selected: backup.json/i)).toBeInTheDocument();
    });

    // Click "Restore My Data" button
    const restoreBtn = await screen.findByRole('button', { name: /Restore My Data/i });
    fireEvent.click(restoreBtn);

    // Check modal appears with notebooks
    await waitFor(() => {
      expect(screen.getByText(/Select Items to Restore/i)).toBeInTheDocument();
    });

    // Check notebooks in modal list
    expect(screen.getByText(/My Notebook 1/i)).toBeInTheDocument();

    // Click restore confirmation button
    const confirmRestoreBtn = screen.getByRole('button', { name: /Restore 1 Item\(s\)/i });
    fireEvent.click(confirmRestoreBtn);

    // Verify it called createNotebook API with payload
    await waitFor(() => {
      expect(api.createNotebook).toHaveBeenCalledWith(
        expect.any(Object), // targetConfig
        expect.objectContaining({ title: 'My Notebook 1' })
      );
    });
  });
});
