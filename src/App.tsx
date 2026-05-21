import { useState, useEffect, useCallback, useRef } from 'react';
import BackupPage from './BackupPage';
import { initGapiClient } from './services/gapiService';
import * as api from './services/apiService';
import './App.css';

const GOOGLE_CLIENT_ID = '180054373655-2b600fnjissdmll4ipj2ndhr0i2h03fj.apps.googleusercontent.com';

declare global {
    interface Window {
        google: any;
    }
}

function App() {
  const [accessToken, setAccessToken] = useState<string>(() => sessionStorage.getItem('agentspace-accessToken') || '');
  const [projectNumber, setProjectNumber] = useState<string>('');
  const [userProfile, setUserProfile] = useState<{ name: string, email: string, picture: string } | null>(null);
  const [isGapiReady, setIsGapiReady] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [wifConfig, setWifConfig] = useState(() => {
    const saved = localStorage.getItem('agentspace-wifConfig');
    return saved ? JSON.parse(saved) : {
      userProject: '',
      poolId: '',
      providerId: '',
      clientId: '',
      authEndpoint: '',
      redirectUri: '',
    };
  });
  const [isWifModalOpen, setIsWifModalOpen] = useState(false);
  const tokenClient = useRef<any>(null);

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
      if (window.google && window.google.accounts && GOOGLE_CLIENT_ID) {
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/dialogflow',
          callback: (tokenResponse: any) => {
            if (tokenResponse && tokenResponse.access_token) {
              handleSetAccessToken(tokenResponse.access_token);
              
              // Fetch user profile
              fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
              })
              .then(res => res.json())
              .then(data => {
                setUserProfile({
                  name: data.name,
                  email: data.email,
                  picture: data.picture
                });
              })
              .catch(e => console.error("Failed to fetch user profile", e));
            }
          },
        });
      }
    };
    document.body.appendChild(script);
  }, [handleSetAccessToken]);

  const handleGoogleSignIn = () => {
    if (tokenClient.current) {
      tokenClient.current.requestAccessToken();
    }
  };

  const handleEntraSignIn = async () => {
    try {
      const authorizationEndpoint = wifConfig.authEndpoint;
      const clientId = wifConfig.clientId;
      const redirectUri = wifConfig.redirectUri;

      console.log("Starting Entra ID sign in...");
      const { idToken, email } = await api.signInWithOidcPopup(authorizationEndpoint, clientId, redirectUri);
      console.log("Received ID Token from Entra ID, exchanging for STS token...");

      const wifConfigForExchange = {
        userProject: wifConfig.userProject,
        poolId: wifConfig.poolId,
        providerId: wifConfig.providerId,
        subjectToken: idToken,
        subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
      };

      const stsResponse = await api.exchangeStsToken(wifConfigForExchange);
      console.log("STS Token Exchange successful!");
      
      handleSetAccessToken(stsResponse.access_token);
      
      setUserProfile({
        name: email?.split('@')[0] || 'Entra User',
        email: email || '',
        picture: ''
      });
      
    } catch (err: any) {
      console.error("Entra ID Sign-in failed", err);
      alert(`Sign-in failed: ${err.message}`);
    }
  };

  const handleSignOut = () => {
    setAccessToken('');
    setUserProfile(null);
    sessionStorage.removeItem('agentspace-accessToken');
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col font-sans">
      <header className="bg-white border-b border-gray-200 p-4 flex justify-between items-center h-14 flex-shrink-0 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold text-xl">A</div>
            <span className="text-lg font-semibold text-gray-900">Gemini Enterprise</span>
            <span className="text-gray-400">|</span>
            <span className="text-lg text-gray-600">Backup & Recovery</span>
          </div>
        </div>
        <div className="flex items-center gap-6 flex-shrink-0">
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
              <button onClick={handleGoogleSignIn} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm">Sign In with Google</button>
              <button onClick={handleEntraSignIn} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm">Sign In with Entra ID</button>
            </div>
          )}
        </div>
      </header>

      <div className="bg-white border-b border-gray-200 px-6 py-2 flex items-center text-sm text-gray-700">
        <span className="font-medium mr-1">Active Project:</span>
        <div className="relative flex items-center cursor-pointer hover:text-gray-900" onClick={() => setIsSettingsOpen(true)}>
          <span>{projectNumber || ''}</span>
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 p-6 overflow-y-auto">
          {accessToken && isGapiReady ? (
            <BackupPage 
              accessToken={accessToken} 
              projectNumber={projectNumber} 
              setProjectNumber={(num) => {
                setProjectNumber(num);
                sessionStorage.setItem('agentspace-projectNumber', num);
              }} 
              userEmail={userProfile?.email || ''}
              isSettingsOpen={isSettingsOpen}
              onCloseSettings={() => setIsSettingsOpen(false)}
              poolId={wifConfig.poolId}
            />
          ) : (
            <div className="flex flex-col items-center justify-center mt-20">
              <p className="text-gray-600 mb-4">Please sign in to access backup and restore functions.</p>
              <div className="flex gap-2 items-center">
                <button onClick={handleGoogleSignIn} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm">Sign In with Google</button>
                <button onClick={handleEntraSignIn} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm">Sign In with Entra ID</button>
                <button onClick={() => setIsWifModalOpen(true)} className="p-2 bg-gray-100 hover:bg-gray-200 rounded-full shadow-md transition-colors" title="WIF Configuration">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
      {isWifModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-lg max-w-md w-full flex flex-col border border-gray-200 p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">WIF Configuration</h2>
              <button onClick={() => setIsWifModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">User Project</label>
                <input type="text" value={wifConfig.userProject} onChange={(e) => setWifConfig({...wifConfig, userProject: e.target.value})} className="w-full border border-gray-300 rounded-md p-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Pool ID</label>
                <input type="text" value={wifConfig.poolId} onChange={(e) => setWifConfig({...wifConfig, poolId: e.target.value})} className="w-full border border-gray-300 rounded-md p-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Provider ID</label>
                <input type="text" value={wifConfig.providerId} onChange={(e) => setWifConfig({...wifConfig, providerId: e.target.value})} className="w-full border border-gray-300 rounded-md p-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
                <input type="text" value={wifConfig.clientId} onChange={(e) => setWifConfig({...wifConfig, clientId: e.target.value})} className="w-full border border-gray-300 rounded-md p-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Auth Endpoint</label>
                <input type="text" value={wifConfig.authEndpoint} onChange={(e) => setWifConfig({...wifConfig, authEndpoint: e.target.value})} className="w-full border border-gray-300 rounded-md p-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Redirect URI</label>
                <input type="text" value={wifConfig.redirectUri} onChange={(e) => setWifConfig({...wifConfig, redirectUri: e.target.value})} className="w-full border border-gray-300 rounded-md p-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end mt-6">
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
      )}
    </div>
  );
}

export default App;
