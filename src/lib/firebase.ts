import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getAnalytics, isSupported, Analytics } from "firebase/analytics";
import { 
  getAuth, 
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
  signOut, 
  onAuthStateChanged,
  Auth
} from "firebase/auth";
import { 
  getFirestore, 
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  CACHE_SIZE_UNLIMITED,
  setLogLevel,
  collection, 
  addDoc, 
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  doc,
  query, 
  where,
  orderBy, 
  limit,
  onSnapshot, 
  serverTimestamp,
  increment,
  getDocFromCache,
  getDocsFromCache,
  getDocFromServer,
  getDocsFromServer,
  deleteField,
  Firestore,
  CollectionReference
} from "firebase/firestore";
import { 
  getStorage, 
  ref, 
  uploadBytes, 
  uploadString, 
  getDownloadURL,
  FirebaseStorage
} from "firebase/storage";

// Configuración de Firebase conectada al nuevo proyecto "hental"
export const firebaseConfig: Record<string, string> | null = {
  apiKey: "AIzaSyCY10VgOgBHgn17_nsKqcTKAwqMEn6SBCA",
  authDomain: "hental.firebaseapp.com",
  projectId: "hental",
  storageBucket: "hental.firebasestorage.app",
  messagingSenderId: "783751572137",
  appId: "1:783751572137:web:d5c48f47b597b028c557b8",
  measurementId: "G-5JNYSPJMYC"
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig &&
  firebaseConfig.apiKey &&
  firebaseConfig.projectId
);

let app: FirebaseApp | null = null;
let analyticsInstance: Analytics | null = null;
let authInstance: Auth | null = null;
let firestoreDb: Firestore | null = null;
let storageInstance: FirebaseStorage | null = null;
let comentariosCol: CollectionReference | null = null;
let googleProviderInstance: GoogleAuthProvider | null = null;

if (isFirebaseConfigured && firebaseConfig) {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

  if (typeof window !== "undefined") {
    isSupported().then((supported) => {
      if (supported && app) {
        analyticsInstance = getAnalytics(app);
      }
    }).catch(() => {});
  }

  authInstance = getAuth(app);

  const firestoreDatabaseId = "(default)";
  let canUseIndexedDb = false;
  try {
    canUseIndexedDb = typeof window !== "undefined" && "indexedDB" in window && window.indexedDB !== null;
  } catch {
    canUseIndexedDb = false;
  }

  try {
    firestoreDb = initializeFirestore(app, {
      localCache: canUseIndexedDb
        ? persistentLocalCache({
            tabManager: persistentMultipleTabManager(),
            cacheSizeBytes: CACHE_SIZE_UNLIMITED
          })
        : memoryLocalCache(),
      experimentalAutoDetectLongPolling: true,
      ignoreUndefinedProperties: true
    }, firestoreDatabaseId);
    setLogLevel('silent');
  } catch {
    try {
      firestoreDb = initializeFirestore(app, {
        localCache: memoryLocalCache(),
        experimentalAutoDetectLongPolling: true,
        ignoreUndefinedProperties: true
      }, firestoreDatabaseId);
      setLogLevel('silent');
    } catch {
      try {
        firestoreDb = getFirestore(app, firestoreDatabaseId);
        setLogLevel('silent');
      } catch {
        firestoreDb = null;
      }
    }
  }

  if (firestoreDb) {
    comentariosCol = collection(firestoreDb, "comentariosGlobales");
  }

  storageInstance = getStorage(app);
  googleProviderInstance = new GoogleAuthProvider();
  googleProviderInstance.setCustomParameters({ prompt: 'select_account' });
}

export const analytics = analyticsInstance;
export const auth = authInstance as Auth;
export const db = firestoreDb as Firestore;
export const comentariosCollection = comentariosCol as CollectionReference;
export const storage = storageInstance as FirebaseStorage;
export const googleProvider = googleProviderInstance as GoogleAuthProvider;

let persistencePromise: Promise<void> | null = null;

export const configureAuthPersistence = async () => {
  if (!authInstance) return;
  if (persistencePromise) return persistencePromise;

  persistencePromise = (async () => {
    if (!authInstance) return;
    try {
      await setPersistence(authInstance, browserLocalPersistence);
    } catch {
      try {
        await setPersistence(authInstance, browserSessionPersistence);
      } catch {
        try {
          await setPersistence(authInstance, inMemoryPersistence);
        } catch {
          // Graceful fallback
        }
      }
    }
  })();

  return persistencePromise;
};

async function testConnection(): Promise<void> {
  if (!isFirebaseConfigured || typeof window === "undefined" || !firestoreDb) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  try {
    await getDocFromServer(doc(firestoreDb, "test", "connection"));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("the client is offline") &&
      (typeof navigator === "undefined" || navigator.onLine !== false)
    ) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

export const firebaseConnectionReady: Promise<void> = isFirebaseConfigured
  ? (configureAuthPersistence().catch(() => {}), testConnection())
  : Promise.resolve();

export {
  ref,
  uploadBytes,
  uploadString,
  getDownloadURL,
  collection,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
  signOut, 
  onAuthStateChanged,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  increment,
  getDocFromCache,
  getDocsFromCache,
  getDocFromServer,
  getDocsFromServer,
  deleteField
};

export interface CommentItem {
  id: string;
  userId: string;
  userName: string;
  userEmail?: string;
  userPhoto?: string;
  text: string;
  createdAt: any;
  parentId?: string | null;
  animeId?: string | null;
  animeTitle?: string | null;
  hidden?: boolean;
}
