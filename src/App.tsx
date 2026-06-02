import { useState, useEffect, useCallback, useRef } from 'react';
import BackupPage from './BackupPage';
import { initGapiClient } from './services/gapiService';
import * as api from './services/apiService';
import './App.css';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

declare global {
    interface Window {
        google: any;
    }
}

function App() {
  const isAdminModeEnabled = 
    import.meta.env.VITE_ENABLE_ADMIN_MODE === 'true' || 
    new URLSearchParams(window.location.search).get('admin') === 'true';
  const sourceIdp = import.meta.env.VITE_SOURCE_IDP || 'Google';
  const targetIdp = import.meta.env.VITE_TARGET_IDP || 'Google';

  const [featureFlags, setFeatureFlags] = useState(() => {
    const saved = localStorage.getItem('agentspace-featureFlags');
    return saved ? JSON.parse(saved) : {
      idpChangeEnabled: import.meta.env.VITE_IDP_CHANGE_ENABLED === 'true',
      enableGoogleIdp: import.meta.env.VITE_ENABLE_GOOGLE_IDP !== 'false',
      enableWifIdp: import.meta.env.VITE_ENABLE_WIF_IDP === 'true',
    };
  });

  const [googleClientId, setGoogleClientId] = useState(() => {
    return localStorage.getItem('agentspace-googleClientId') || import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
  });

  const isIdpChangeEnabled = featureFlags.idpChangeEnabled;
  const enableGoogleIdp = featureFlags.enableGoogleIdp;
  const enableWifIdp = featureFlags.enableWifIdp;

  const [accessToken, setAccessToken] = useState<string>(() => sessionStorage.getItem('agentspace-accessToken') || '');
  const [sourceToken, setSourceToken] = useState<string>(() => sessionStorage.getItem('agentspace-sourceToken') || '');
  const [targetToken, setTargetToken] = useState<string>(() => sessionStorage.getItem('agentspace-targetToken') || '');
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('theme');
    return saved === 'dark';
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);
  const [projectNumber, setProjectNumber] = useState<string>('');
  const [userProfile, setUserProfile] = useState<{ name: string, email: string, picture: string, sub?: string } | null>(() => {
    const saved = sessionStorage.getItem('agentspace-userProfile');
    return saved ? JSON.parse(saved) : null;
  });
  const [isGapiReady, setIsGapiReady] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [wifConfig, setWifConfig] = useState(() => {
    const saved = localStorage.getItem('agentspace-wifConfig');
    return saved ? JSON.parse(saved) : {
      userProject: import.meta.env.VITE_WIF_USER_PROJECT || '',
      poolId: import.meta.env.VITE_WIF_POOL_ID || '',
      providerId: import.meta.env.VITE_WIF_PROVIDER_ID || '',
      clientId: import.meta.env.VITE_WIF_CLIENT_ID || '',
      authEndpoint: import.meta.env.VITE_WIF_AUTH_ENDPOINT || '',
      redirectUri: import.meta.env.VITE_WIF_REDIRECT_URI || '',
    };
  });
  const [isWifModalOpen, setIsWifModalOpen] = useState(false);
  const tokenClient = useRef<any>(null);

  const handleResetWifConfig = () => {
    localStorage.removeItem('agentspace-wifConfig');
    setWifConfig({
      userProject: import.meta.env.VITE_WIF_USER_PROJECT || '',
      poolId: import.meta.env.VITE_WIF_POOL_ID || '',
      providerId: import.meta.env.VITE_WIF_PROVIDER_ID || '',
      clientId: import.meta.env.VITE_WIF_CLIENT_ID || '',
      authEndpoint: import.meta.env.VITE_WIF_AUTH_ENDPOINT || '',
      redirectUri: import.meta.env.VITE_WIF_REDIRECT_URI || '',
    });
  };

  const handleSetAccessToken = useCallback((token: string) => {
    const trimmedToken = token.trim();
    setAccessToken(trimmedToken);
    sessionStorage.setItem('agentspace-accessToken', trimmedToken);
    
    if (trimmedToken) {
      initGapiClient(trimmedToken)
        .then(() => {
          console.log("Google API Client Initialized Successfully.");
          setIsGapiReady(true);
        })
        .catch((err: any) => {
          console.error("GAPI initialization failed", err);
        });
    }
  }, []);

  useEffect(() => {
    // Load Google Identity Services script
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google && window.google.accounts && googleClientId) {
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
          client_id: googleClientId,
          scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/dialogflow',
          callback: (tokenResponse: any) => {
            if (tokenResponse && tokenResponse.access_token) {
              const token = tokenResponse.access_token;
              if (isIdpChangeEnabled) {
                if (sourceIdp === 'Google') {
                  setSourceToken(token);
                  sessionStorage.setItem('agentspace-sourceToken', token);
                }
                if (targetIdp === 'Google') {
                  setTargetToken(token);
                  sessionStorage.setItem('agentspace-targetToken', token);
                }
                handleSetAccessToken(token);
              } else {
                handleSetAccessToken(token);
              }
              
              // Fetch user profile
              fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
              })
              .then(res => res.json())
              .then(data => {
                const profile = {
                  name: data.name,
                  email: data.email,
                  picture: data.picture
                };
                setUserProfile(profile);
                sessionStorage.setItem('agentspace-userProfile', JSON.stringify(profile));
              })
              .catch(e => console.error("Failed to fetch user profile", e));
            }
          },
        });
      }
    };
    document.body.appendChild(script);
  }, [handleSetAccessToken, googleClientId, isIdpChangeEnabled, sourceIdp, targetIdp]);

  const handleGoogleSignIn = () => {
    if (tokenClient.current) {
      tokenClient.current.requestAccessToken();
    }
  };

  const handleWifSignIn = async () => {
    try {
      const authorizationEndpoint = wifConfig.authEndpoint;
      const clientId = wifConfig.clientId;
      const redirectUri = wifConfig.redirectUri;

      console.log("Starting WiF sign in...");
      const { idToken, email, sub } = await api.signInWithOidcPopup(authorizationEndpoint, clientId, redirectUri);
      console.log("Received ID Token from WiF, exchanging for STS token...");

      const wifConfigForExchange = {
        userProject: wifConfig.userProject,
        poolId: wifConfig.poolId,
        providerId: wifConfig.providerId,
        subjectToken: idToken,
        subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
      };

      const stsResponse = await api.exchangeStsToken(wifConfigForExchange);
      console.log("STS Token Exchange successful!");
      
      const token = stsResponse.access_token;
      if (isIdpChangeEnabled) {
        if (sourceIdp === 'WiF') {
          setSourceToken(token);
          sessionStorage.setItem('agentspace-sourceToken', token);
        }
        if (targetIdp === 'WiF') {
          setTargetToken(token);
          sessionStorage.setItem('agentspace-targetToken', token);
        }
        handleSetAccessToken(token);
      } else {
        handleSetAccessToken(token);
      }
      
      const profile = {
        name: email?.split('@')[0] || 'WiF User',
        email: email || '',
        picture: '',
        sub: sub || ''
      };
      setUserProfile(profile);
      sessionStorage.setItem('agentspace-userProfile', JSON.stringify(profile));
      
    } catch (err: any) {
      console.error("WiF Sign-in failed", err);
      alert(`Sign-in failed: ${err.message}`);
    }
  };

  const handleSignOut = () => {
    setAccessToken('');
    setUserProfile(null);
    sessionStorage.removeItem('agentspace-accessToken');
    sessionStorage.removeItem('agentspace-userProfile');
  };

  const exportWifConfig = () => {
    const jsonStr = JSON.stringify(wifConfig, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wif_config__${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const importWifConfig = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        setWifConfig(json);
        localStorage.setItem('agentspace-wifConfig', JSON.stringify(json));
        alert(`WIF configuration imported successfully from ${file.name}`);
      } catch (err: any) {
        alert(`Error importing WIF configuration: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 text-gray-900 dark:text-slate-200 flex flex-col font-sans">
      <header className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 p-4 flex justify-between items-center h-14 flex-shrink-0 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold text-xl">A</div>
            <span className="text-lg font-semibold text-gray-900 dark:text-white">Gemini Enterprise</span>
            <span className="text-gray-400">|</span>
            <span className="text-lg text-gray-600 dark:text-gray-400">Backup & Recovery</span>
          </div>
        </div>
        <div className="flex items-center gap-6 flex-shrink-0">
          <button 
            onClick={() => setDarkMode(!darkMode)} 
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors" 
            title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {darkMode ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 9H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M12 5a7 7 0 100 14 7 7 0 000-14z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          <button className="text-gray-500 hover:text-gray-700 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          {accessToken ? (
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-pink-600 rounded-full flex items-center justify-center text-white font-bold shadow-sm">
                {userProfile?.name?.[0] || 'W'}
              </div>
              <div className="flex flex-col text-left">
                <span className="text-sm font-semibold text-gray-900">{userProfile?.name || 'William Dufrin'}</span>
                <span className="text-xs text-gray-500">{userProfile?.email || 'admin@wdufrin.altostrat.com'}</span>
              </div>
              <button onClick={handleSignOut} className="ml-2 text-xs text-red-400 hover:text-red-300 font-medium">Sign Out</button>
            </div>
          ) : (
            <div className="flex gap-2">
              {enableGoogleIdp && (
                <button 
                  onClick={handleGoogleSignIn} 
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm"
                >
                  {isIdpChangeEnabled ? `Sign In to ${sourceIdp === 'Google' ? 'Source' : 'Target'} (Google)` : 'Sign In with Google'}
                </button>
              )}
              {enableWifIdp && (
                <button 
                  onClick={handleWifSignIn} 
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm"
                >
                  {isIdpChangeEnabled ? `Sign In to ${sourceIdp === 'WiF' ? 'Source' : 'Target'} (WiF)` : 'Sign In with WiF'}
                </button>
              )}
            </div>
          )}
        </div>
      </header>



      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 p-6 overflow-y-auto">
          {accessToken && isGapiReady ? (
            <BackupPage 
              accessToken={accessToken} 
              sourceToken={sourceToken}
              targetToken={targetToken}
              onGoogleSignIn={handleGoogleSignIn}
              onWifSignIn={handleWifSignIn} 
              onSignOut={handleSignOut}
              projectNumber={projectNumber} 
              setProjectNumber={(num) => {
                setProjectNumber(num);
                sessionStorage.setItem('agentspace-projectNumber', num);
              }} 
              userEmail={userProfile?.email || ''}
              userSub={userProfile?.sub || ''}
              isSettingsOpen={isSettingsOpen}
              onCloseSettings={() => setIsSettingsOpen(false)}
              poolId={wifConfig.poolId}
              featureFlags={featureFlags}
              setFeatureFlags={setFeatureFlags}
              googleClientId={googleClientId}
              setGoogleClientId={setGoogleClientId}
              wifConfigState={wifConfig}
              setWifConfigState={setWifConfig}
            />
          ) : (
            <div className="flex flex-col items-center justify-center mt-20">
              <p className="text-gray-600 mb-4">Please sign in to access backup and restore functions.</p>
              <div className="flex gap-2 items-center">
                {enableGoogleIdp && (
                  <button 
                    onClick={handleGoogleSignIn} 
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm"
                  >
                    {isIdpChangeEnabled ? `Sign In to ${sourceIdp === 'Google' ? 'Source' : 'Target'} (Google)` : 'Sign In with Google'}
                  </button>
                )}
                {enableWifIdp && (
                  <button 
                    onClick={handleWifSignIn} 
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm"
                  >
                    {isIdpChangeEnabled ? `Sign In to ${sourceIdp === 'WiF' ? 'Source' : 'Target'} (WiF)` : 'Sign In with WiF'}
                  </button>
                )}
                {isAdminModeEnabled && (
                  <button onClick={() => setIsWifModalOpen(true)} className="p-2 bg-gray-100 hover:bg-gray-200 rounded-full shadow-md transition-colors" title="WIF Configuration">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
      {isWifModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-lg max-w-md w-full flex flex-col border border-gray-200 dark:border-slate-700 p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">WIF Configuration</h2>
              <button onClick={() => setIsWifModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">User Project</label>
                <input type="text" value={wifConfig.userProject} onChange={(e) => setWifConfig({...wifConfig, userProject: e.target.value})} className="w-full border border-gray-300 dark:border-slate-600 rounded-md p-2 text-sm bg-white dark:bg-slate-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Pool ID</label>
                <input type="text" value={wifConfig.poolId} onChange={(e) => setWifConfig({...wifConfig, poolId: e.target.value})} className="w-full border border-gray-300 dark:border-slate-600 rounded-md p-2 text-sm bg-white dark:bg-slate-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Provider ID</label>
                <input type="text" value={wifConfig.providerId} onChange={(e) => setWifConfig({...wifConfig, providerId: e.target.value})} className="w-full border border-gray-300 dark:border-slate-600 rounded-md p-2 text-sm bg-white dark:bg-slate-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Client ID</label>
                <input type="text" value={wifConfig.clientId} onChange={(e) => setWifConfig({...wifConfig, clientId: e.target.value})} className="w-full border border-gray-300 dark:border-slate-600 rounded-md p-2 text-sm bg-white dark:bg-slate-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Auth Endpoint</label>
                <input type="text" value={wifConfig.authEndpoint} onChange={(e) => setWifConfig({...wifConfig, authEndpoint: e.target.value})} className="w-full border border-gray-300 dark:border-slate-600 rounded-md p-2 text-sm bg-white dark:bg-slate-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Redirect URI</label>
                <input type="text" value={wifConfig.redirectUri} onChange={(e) => setWifConfig({...wifConfig, redirectUri: e.target.value})} className="w-full border border-gray-300 dark:border-slate-600 rounded-md p-2 text-sm bg-white dark:bg-slate-900 dark:text-white" />
              </div>
            </div>
            <div className="flex justify-between mt-6">
              <div className="flex gap-2">
                <button 
                  onClick={exportWifConfig} 
                  className="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-xs font-semibold rounded-lg"
                >
                  Export
                </button>
                <label className="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-xs font-semibold rounded-lg cursor-pointer">
                  Import
                  <input type="file" accept=".json" onChange={importWifConfig} className="hidden" />
                </label>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={handleResetWifConfig} 
                  className="px-4 py-2 bg-gray-500 hover:bg-gray-600 text-white text-sm font-semibold rounded-lg"
                >
                  Reset
                </button>
                <button 
                  onClick={() => {
                    localStorage.setItem('agentspace-wifConfig', JSON.stringify(wifConfig));
                    setIsWifModalOpen(false);
                  }} 
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
