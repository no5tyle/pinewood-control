/*
  Starts the Pinewood API.

  Data is kept in Firestore and sign-ins are qstored accounts (Firebase Authentication), in the Google
  Cloud project Cloud Run runs in. With FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST set
  (npm run dev), it uses the Firebase emulators instead.
*/
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createApp } from "./app.js";
import { FirebaseTokenAuth } from "./server/auth.js";
import { corsOrigins, port } from "./server/config.js";
import { FirestoreDb } from "./server/store/db.js";

const firebase = initializeApp(process.env.GCLOUD_PROJECT ? { projectId: process.env.GCLOUD_PROJECT } : undefined);
const firestore = getFirestore(firebase);
firestore.settings({ ignoreUndefinedProperties: true });

const { httpServer, io } = createApp({ db: new FirestoreDb(firestore), auth: new FirebaseTokenAuth(getAuth(firebase)), corsOrigins });

httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

process.on("SIGTERM", () => {
  void io.close();
  httpServer.close(() => process.exit(0));
});
