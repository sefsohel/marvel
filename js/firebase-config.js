// Firebase web configuration (these values identify the project; they are not secrets).
// Access control is enforced by Firestore Security Rules, NOT by this file.
export const firebaseConfig = {
    apiKey: "AIzaSyD6Pvx-E5YvP9sDrYXoT7ZzoR3NBnJeEO4",
    authDomain: "cloud-storage-6a7e1.firebaseapp.com",
    projectId: "cloud-storage-6a7e1",
    storageBucket: "cloud-storage-6a7e1.firebasestorage.app",
    messagingSenderId: "818557067287",
    appId: "1:818557067287:web:0e6c5ad71752f5cc863c52"
  };


export const COLLECTION_CURRENT = "cardTemplates";
export const COLLECTION_VERSIONS = "cardTemplateVersions";
// Firestore documents are limited to 1 MiB; keep headroom for the other fields.
export const MAX_HTML_BYTES = 900000;
