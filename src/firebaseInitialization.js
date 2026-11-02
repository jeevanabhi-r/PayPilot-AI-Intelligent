export function getOrInitializeApp(sdk, config) {
  const defaultApp = sdk.getApps().find((app) => app.name === '[DEFAULT]');
  return defaultApp || sdk.initializeApp(config);
}

export function createFirestoreLoader(app, loadFirestore = () => import('firebase/firestore')) {
  let firestorePromise;

  return function getFirestoreInstance() {
    if (!firestorePromise) {
      firestorePromise = loadFirestore()
        .then(({ getFirestore }) => getFirestore(app))
        .catch((error) => {
          firestorePromise = undefined;
          throw error;
        });
    }
    return firestorePromise;
  };
}
