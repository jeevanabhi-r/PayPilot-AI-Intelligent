import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getDb } from './firebase';

export async function saveFirebaseUserProfile(user, name, email) {
  const db = await getDb();
  await setDoc(doc(db, 'users', user.uid), {
    displayName: name,
    email,
    preferences: { budget: '', categories: [] },
    createdAt: serverTimestamp(),
  }, { merge: true });
}
