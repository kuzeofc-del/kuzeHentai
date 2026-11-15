// Suppress known Firestore backend connection retry spam when Firestore database is not yet provisioned in Firebase Console
if (typeof window !== 'undefined') {
  const filterFirestoreLog = (orig: (...args: any[]) => void) => (...args: any[]) => {
    const text = args.map(a => typeof a === 'object' ? (a?.message || JSON.stringify(a)) : String(a)).join(' ');
    if (
      text.includes('@firebase/firestore') && 
      (text.includes('NOT_FOUND') || text.includes('Listen') || text.includes('Could not reach Cloud Firestore backend') || text.includes('GrpcConnection'))
    ) {
      return;
    }
    orig.apply(console, args);
  };
  console.warn = filterFirestoreLog(console.warn);
  console.error = filterFirestoreLog(console.error);
}

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined') {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
  try {
    if ('indexedDB' in window && window.indexedDB && typeof window.indexedDB.deleteDatabase === 'function') {
      const deleteReq = window.indexedDB.deleteDatabase('kh_portadas_cache_v1');
      deleteReq.onerror = () => {};
      deleteReq.onblocked = () => {};
    }
  } catch {
    // Ignore cleanup errors in restricted environments
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
