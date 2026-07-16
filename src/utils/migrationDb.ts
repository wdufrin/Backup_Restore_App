const DB_NAME = 'agentspace_migration_db';
const DB_VERSION = 1;
const STORE_NAME = 'migration_store';
const PAYLOAD_KEY = 'active_payload';

export interface MigrationPayload {
  data: any;
  timestamp: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getOrCreateCryptoKey(): Promise<CryptoKey | null> {
  if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
    return null;
  }
  const sessionKey = 'agentspace_db_key';
  const savedKeyBase64 = sessionStorage.getItem(sessionKey);
  
  if (savedKeyBase64) {
    try {
      const rawKey = base64ToArrayBuffer(savedKeyBase64);
      return await window.crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM' },
        true,
        ['encrypt', 'decrypt']
      );
    } catch (err) {
      console.warn('Failed to import crypto key from session, regenerating...', err);
    }
  }
  
  try {
    const key = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const exported = await window.crypto.subtle.exportKey('raw', key);
    const base64 = arrayBufferToBase64(exported);
    sessionStorage.setItem(sessionKey, base64);
    return key;
  } catch (err) {
    console.warn('Failed to generate crypto key.', err);
    return null;
  }
}

async function encryptData(data: any): Promise<any> {
  const key = await getOrCreateCryptoKey();
  if (!key) return data; // Fallback to plain text if Web Crypto is not supported

  try {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );
    return {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv.buffer),
      encrypted: true
    };
  } catch (err) {
    console.warn('Encryption failed, storing as plain text.', err);
    return data;
  }
}

async function decryptData(encrypted: any): Promise<any> {
  if (!encrypted || !encrypted.encrypted) {
    return encrypted; // Plain text fallback
  }

  const key = await getOrCreateCryptoKey();
  if (!key) {
    throw new Error('Web Crypto API key not available for decryption.');
  }

  const iv = base64ToArrayBuffer(encrypted.iv);
  const ciphertext = base64ToArrayBuffer(encrypted.ciphertext);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function saveMigrationPayload(data: any): Promise<void> {
  const encrypted = await encryptData(data);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const payload: MigrationPayload = {
      data: encrypted,
      timestamp: new Date().toISOString()
    };
    const request = store.put(payload, PAYLOAD_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getMigrationPayload(): Promise<MigrationPayload | null> {
  try {
    const db = await openDb();
    const payloadRecord = await new Promise<MigrationPayload | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(PAYLOAD_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });

    if (payloadRecord && payloadRecord.data) {
      try {
        const decryptedData = await decryptData(payloadRecord.data);
        return {
          data: decryptedData,
          timestamp: payloadRecord.timestamp
        };
      } catch (decErr) {
        console.warn('Failed to decrypt cached migration payload. Key may have expired.', decErr);
        return null;
      }
    }
    return null;
  } catch (err) {
    console.warn('IndexedDB is not available or could not be initialized.', err);
    return null;
  }
}

export async function clearMigrationPayload(): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(PAYLOAD_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('Failed to clear IndexedDB migration payload.', err);
  }
}
