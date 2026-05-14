import React, { useState, useEffect, useCallback, useRef } from 'react';
import BackupPage from './BackupPage';
import { initGapiClient } from './services/gapiService';
import './App.css';

const GOOGLE_CLIENT_ID = '180054373655-2b600fnjissdmll4ipj2ndhr0i2h03fj.apps.googleusercontent.com';

declare global {
    interface Window {
        google: any;
    }
}

function App() {
  const [accessToken, setAccessToken] = useState<string>(() => sessionStorage.getItem('agentspace-accessToken') || '');
  const [projectNumber, setProjectNumber] = useState<string>(() => sessionStorage.getItem('agentspace-projectNumber') || '');
  const [userProfile, setUserProfile] = useState<{ name: string, email: string, picture: string } | null>(null);
  const [isGapiReady, setIsGapiReady] = useState(false);
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
            <button onClick={handleGoogleSignIn} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm">Sign In with Google</button>
          )}
        </div>
      </header>

      <div className="bg-white border-b border-gray-200 px-6 py-2 flex items-center text-sm text-gray-700">
        <span className="font-medium mr-1">Active Project:</span>
        <div className="relative flex items-center cursor-pointer hover:text-gray-900">
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
            />
          ) : (
            <div className="flex flex-col items-center justify-center mt-20">
              <p className="text-gray-600 mb-4">Please sign in to access backup and restore functions.</p>
              <button onClick={handleGoogleSignIn} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-semibold text-white transition-colors shadow-sm">Sign In</button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
