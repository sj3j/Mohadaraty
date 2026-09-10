import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { startNewSeason } from "./shared/seasonReset.js";
import { runSeasonRollover, resolveCurrentPhase, syncPhaseMirror, loadCalendar } from "./shared/seasonRollover.js";
import { submitProgression, ProgressionError } from "./shared/progressionSubmit.js";
import { verifyGoogleIdentity, resolveGoogleLogin, GoogleLoginError } from "./shared/googleLogin.js";
import {
  resolveStudentLogin,
  resolveSessionUid,
  studentForToken,
  passwordMatches,
  LoginError,
} from "./shared/studentLookup.js";
import { nameKeyFor } from "./shared/rosterIdentity.js";
import { resetStudentPassword, StudentAdminError } from "./shared/studentAdmin.js";
import {
  requestAccountDeletion,
  cancelAccountDeletion,
  reviewDeletionRequest,
  DeletionError,
} from "./shared/accountDeletion.js";
import {
  changeOwnPassword,
  setOwnExamCode,
  linkGoogleAccount,
  unlinkGoogleAccount,
  accountSummary,
  SelfServiceError,
} from "./shared/accountSelfService.js";
import { createSignupRequest, reviewSignupRequest, SignupError } from "./shared/signupRequest.js";
import { deleteUserAccount, mergeUserAccounts } from "./shared/adminUsers.js";
import { planYearWipe, runYearWipe, exportYear, YearWipeError } from "./shared/yearWipe.js";
import { createSimosanHandlers } from "./shared/simosanApi.js";
import { createMcqHandlers } from "./shared/mcqApi.js";
import { MASTER_ADMIN_EMAILS, isMasterAdminEmail } from "./shared/masterAdmins.js";
import { summariseYear } from "./shared/yearSummary.js";
import { deleteWipedFiles } from "./shared/yearWipeFiles.js";
import { OAuth2Client } from "google-auth-library";
import { activeDaysBetween, addDays, isLiveDay, finalTermOf } from "./shared/academicCalendar.js";
import {
  loadZainCashConfig,
  initTransaction,
  verifyGatewayToken,
  resolveAppOrigin,
  successUrlFor,
  failureUrlFor,
  tagOrderId,
} from "./shared/zaincash.js";
import {
  PLAN_CONFIG,
  activateSubscription,
  settleZainCashPayment,
  findLiveZainCashPayment,
  NotifyFn,
  SubscriptionCtx,
} from "./shared/subscriptions.js";

dotenv.config();

// Initialize Firebase Admin for FCM
if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PROJECT_ID) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log("Firebase Admin initialized for Push Notifications.");
  } catch (error) {
    console.error("Firebase Admin initialization error:", error);
  }
}

// Initialize Cloudflare R2 Client
let s3Client: S3Client | null = null;
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCESS_KEY && process.env.CLOUDFLARE_SECRET_KEY) {
  s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY,
      secretAccessKey: process.env.CLOUDFLARE_SECRET_KEY,
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(express.json());
// Capacitor serves the bundled app from https://localhost (Android) and
// capacitor://localhost (iOS), so every /api call from the native build is a
// cross-origin request. Without these headers the WebView blocks them all and
// the app looks broken with no HTTP status to debug from.
//
// Bearer-token auth survives this; cookie auth would not, which is why the API
// stays token-based. No credentials are allowed, so the allowlist is safe.
const NATIVE_ORIGINS = new Set([
  "https://localhost",
  "capacitor://localhost",
  "http://localhost",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && NATIVE_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-cron-secret");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});
  // ZainCash posts the webhook as JSON, but their own sample registers both
  // parsers. Without this a form-encoded delivery reads as an empty body and
  // we would answer 400 to every retry forever.
  app.use(express.urlencoded({ extended: true }));

  // REMOVED: the Telegraf echo bot.
  //
  // It replied to DMs with their own text and wrote nothing anywhere - but it
  // called bot.launch(), which LONG-POLLS. Telegram delivers updates to exactly
  // one consumer per token, so every `npm run dev` silently stole the update
  // stream from the mirror bot in bot/. Telegram work lives there now.

  // --- Middleware ---
  const verifyAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      (req as any).user = decodedToken;
      next();
    } catch (error) {
      console.error('Token verification failed:', error);
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
  };

  // Google sign-in accepts a Firebase token (web popup) or a raw Google OAuth
// token (native plugin). The two need different verifiers, so the OAuth client
// is built once here. google-auth-library was already a dependency.
const GOOGLE_WEB_CLIENT_ID =
  process.env.GOOGLE_WEB_CLIENT_ID ||
  "449403914422-jhmo0djasbes2584jg3ue8dcv48cd62i.apps.googleusercontent.com";
const googleOAuthClient = new OAuth2Client(GOOGLE_WEB_CLIENT_ID);

// The list itself lives in shared/masterAdmins.ts so api/index.ts, the client
// and this file cannot drift. A master admin bypasses the stage checks below;
// firestore.rules repeats the same addresses because rules cannot import.

/**
 * The stage the caller is allowed to act on, as decided by the server.
 *
 * Attached to the request by verifyAdmin so routes never have to trust a
 * stageId from the body. `null` managedStageId on a non-master caller means
 * "assigned to no stage", which every stage-scoped route below treats as
 * "may act on nothing" - the same posture firestore.rules takes.
 */
type CallerStage = {
  isMasterAdmin: boolean;
  /**
   * Cross-stage without being the master admin. Every `staff.managedStageId`
   * comparison below has to admit this flag too, or a support caller is pinned
   * to the stage they used to represent - the field is retained on promotion as
   * a home stage and is deliberately NOT a scope.
   */
  isSupport: boolean;
  role: string;
  managedStageId: string | null;
  /** What they were ticked for in إدارة المساعدين. Absent means DENIED for a
   *  support caller, matching canManage() in src/lib/permissions.ts. */
  permissions: Record<string, boolean>;
};

/** Support holds a capability only when it is explicitly true. */
const staffCan = (staff: CallerStage, capability: string): boolean =>
  staff.isMasterAdmin || (staff.isSupport && staff.permissions[capability] === true);

const SUPPORT_NOT_GRANTED = 'Your support account is not granted this.';

const callerStage = (req: express.Request): CallerStage =>
  (req as any).staff
  || { isMasterAdmin: false, isSupport: false, role: '', managedStageId: null, permissions: {} };

const verifyAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const db = admin.firestore();
      const email = (user.email || '').toLowerCase();
      const isMaster = isMasterAdminEmail(email);

      const userDoc = await db.collection('users').doc(user.uid).get();

      if (!userDoc.exists && !isMaster) {
        return res.status(403).json({ error: 'Forbidden: User not found' });
      }

      const data = userDoc.data() || {};
      const role = data.role;
      // 'support' belongs in this list or EVERY admin route 403s for the role.
      if (!isMaster && role !== 'admin' && role !== 'moderator'
          && role !== 'support' && role !== 'master_admin') {
        return res.status(403).json({ error: 'Forbidden: Requires admin privileges' });
      }

      (req as any).staff = {
        isMasterAdmin: isMaster || role === 'master_admin' || data.isMasterAdmin === true,
        isSupport: role === 'support',
        role: role || 'admin',
        managedStageId: data.managedStageId || null,
        permissions: (data.permissions || {}) as Record<string, boolean>,
      } satisfies CallerStage;

      next();
    } catch (error) {
      console.error('Role verification failed:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };

  // --- API Routes ---
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Bootstrap admin permissions
  app.post("/api/bootstrap-admin", verifyAuth, async (req, res) => {
    const user = (req as any).user;
    if (!user || (!user.email)) return res.status(401).json({ error: 'Unauthorized' });

    if (!isMasterAdminEmail(user.email)) {
        return res.status(403).json({ error: 'Not an admin email' });
    }

    try {
      const db = admin.firestore();
      const emailLower = user.email.toLowerCase();
      
      const adminDoc = await db.collection('allowed_admins').doc(emailLower).get();
      if (!adminDoc.exists) {
        await db.collection('allowed_admins').doc(emailLower).set({
          email: emailLower,
          role: 'admin',
          name: 'Master Admin'
        }, { merge: true });
        console.log(`Bootstrapped allowed_admins for ${emailLower}`);
      }

      if (user.role !== 'master_admin') {
        await admin.auth().setCustomUserClaims(user.uid, { role: 'master_admin' });
        console.log(`Bootstrapped custom claims for ${emailLower}`);
      } else {
        console.log(`Custom claims already bootstrapped for ${emailLower}`);
      }
      
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to bootstrap admin:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Generate Presigned URL for Cloudflare R2 Upload
  app.get("/api/get-upload-url", verifyAuth, verifyAdmin, async (req, res) => {
    if (!s3Client) {
      return res.status(500).json({ error: "Cloudflare R2 is not configured on the server." });
    }

    try {
      const { filename, contentType } = req.query;
      if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: "Filename is required" });
      }

      const bucketName = process.env.R2_BUCKET_NAME || "lecture-audio";
      const publicUrlBase = process.env.R2_PUBLIC_URL || "";
      
      // Sanitize filename and add timestamp to prevent overwrites
      const safeFileName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const objectKey = `records/${Date.now()}_${safeFileName}`;

      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        ContentType: (contentType as string) || "application/octet-stream",
      });

      // URL expires in 1 hour
      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      
      // Format public URL
      const publicUrl = publicUrlBase.endsWith('/') 
        ? `${publicUrlBase}${objectKey}` 
        : `${publicUrlBase}/${objectKey}`;

      res.json({ uploadUrl, publicUrl, objectKey });
    } catch (error) {
      console.error("Error generating presigned URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  // Admin Logs API
  app.post("/api/admin-logs", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const db = admin.firestore();
      const user = (req as any).user;
      const { action, details, targetId } = req.body;

      if (!action || !details) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      await db.collection('adminLogs').add({
        adminId: user.uid,
        adminName: user.name || user.email || 'Unknown',
        adminEmail: user.email || 'unknown@example.com',
        action,
        details,
        targetId: targetId || null,
        // Which stage the acting representative manages, so the master admin
        // can tell whose action a log line records. Production already stored
        // this; the dev server dropped it, so the two disagreed on shape.
        stageId: callerStage(req).managedStageId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({ success: true });
    } catch (error) {
      console.error("Failed to add admin log:", error);
      return res.status(500).json({ error: "Failed to log action" });
    }
  });

  app.get("/api/admin-logs", verifyAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const isMasterAdmin = isMasterAdminEmail(user.email) || user.role === 'master_admin';
      
      if (!isMasterAdmin) {
        return res.status(403).json({ error: "Forbidden: Requires master admin privileges" });
      }

      const limitCount = parseInt(req.query.limit as string) || 100;
      const db = admin.firestore();
      
      const snapshot = await db.collection('adminLogs')
        .orderBy('timestamp', 'desc')
        .limit(limitCount)
        .get();

      const logs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp ? doc.data().timestamp.toMillis() : Date.now()
      }));

      return res.json({ logs });
    } catch (error) {
      console.error("Failed to read admin logs:", error);
      return res.status(500).json({ error: "Failed to read logs" });
    }
  });

  // Bundle chat messages
  app.post("/api/admin/create-chat-bundle", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const db = admin.firestore();
      const bundle = db.bundle('chat-bundle');
      const yesterday = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
      
      const oldMessagesQuery = db.collection('chat_messages')
                                 .where('timestamp', '<=', yesterday)
                                 .orderBy('timestamp', 'desc');
  
      const querySnapshot = await oldMessagesQuery.get();
      
      if (querySnapshot.empty) {
        return res.status(200).json({ message: 'No old messages to bundle' });
      }
  
      bundle.add('chat-bundle-query', querySnapshot);
      const bundleBuffer = await bundle.build();
  
      let publicUrl = '';
      
      if (s3Client && process.env.R2_BUCKET_NAME) {
        // Upload to R2
        const objectKey = 'bundles/chat-bundle.bundle';
        const command = new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: objectKey,
          ContentType: 'application/octet-stream',
          Body: bundleBuffer
        });
        await s3Client.send(command);
        const publicUrlBase = process.env.R2_PUBLIC_URL || "";
        publicUrl = publicUrlBase.endsWith('/') 
          ? `${publicUrlBase}${objectKey}` 
          : `${publicUrlBase}/${objectKey}`;
      } else {
        // Fallback to Firebase Storage
        const bucketName = process.env.FIREBASE_STORAGE_BUCKET || (process.env.FIREBASE_PROJECT_ID + '.appspot.com');
        const bucket = admin.storage().bucket(bucketName);
        const file = bucket.file('bundles/chat-bundle.bundle');
        
        await file.save(bundleBuffer, {
          metadata: {
            contentType: 'application/octet-stream',
            cacheControl: 'public, max-age=3600'
          }
        });
    
        try {
          await file.makePublic();
          publicUrl = file.publicUrl();
        } catch (e) {
          console.warn('Could not make file public (possibly uniform bucket access). Generating signed URL instead.', e);
          const urls = await file.getSignedUrl({
            action: 'read',
            expires: '01-01-2099'
          });
          publicUrl = urls[0];
        }
      }

      // Save the bundle link to Firestore config
      await db.collection('chat_settings').doc('config').set({
        latestBundleUrl: publicUrl,
        bundleCreatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      res.status(200).json({ message: 'Bundle created successfully', url: publicUrl });
    } catch (err) {
      console.error('Bundle error:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Send FCM Notification
  app.post("/api/notify", verifyAuth, verifyAdmin, async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      const { title, body, topic = "all" } = req.body;
      
      if (!title || !body) {
        return res.status(400).json({ error: "Title and body are required." });
      }

      const message = {
        notification: {
          title,
          body,
        },
        topic: topic,
      };

      const response = await admin.messaging().send(message);
      res.json({ success: true, messageId: response });
    } catch (error) {
      console.error("Error sending FCM notification:", error);
      res.status(500).json({ error: "Failed to send notification" });
    }
  });

  // Copies stage assignment from the whitelist collections (`students` /
  // `allowed_admins`) onto the `users` document.
  //
  // This has to happen server-side: firestore.rules only lets a student write
  // their own `stageId` during progression season, so a client-side merge would
  // be rejected with permission-denied. Running it on every login also
  // self-heals accounts that predate the multi-stage rollout.
  const syncUserStage = async (
    db: FirebaseFirestore.Firestore,
    uid: string,
    source: { stageId?: string | null; managedStageId?: string | null } | undefined,
  ) => {
    if (!uid || !source) return;
    try {
      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) return; // created client-side on first login with stageId already set

      const current = userSnap.data() || {};
      const patch: Record<string, unknown> = {};

      if (source.stageId && current.stageId !== source.stageId) {
        patch.stageId = source.stageId;
      }
      if (source.managedStageId && current.managedStageId !== source.managedStageId) {
        patch.managedStageId = source.managedStageId;
      }

      if (Object.keys(patch).length > 0) {
        await userRef.update(patch);
        console.log(`Synced stage fields for ${uid}:`, patch);
      }
    } catch (err) {
      // Never block a login on this.
      console.error("Failed to sync user stage:", err);
    }
  };

  // Student Login
  //
  // Accepts an email, a login code ("D4-01234") or a name. Resolution lives in
  // shared/studentLookup.ts so this route and its api/index.ts twin cannot
  // drift again - they already had, on the uid this very route mints under.
  //
  // `identifier` is the field; `email` is still read because installed builds
  // in the field send that name and update on their own schedule.
  app.post("/api/login", async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }
    try {
      const identifier = req.body?.identifier ?? req.body?.email;
      const password = req.body?.password;

      if (!identifier || !password) {
        return res.status(400).json({ error: "Email and password are required." });
      }

      const db = admin.firestore();
      const student = await resolveStudentLogin(db, identifier, password);

      // The uid is the resolved student - never the typed string. Minting under
      // what the user typed is what created the duplicate-account mess the
      // admin merge tool exists to clean up, and with name login it would key
      // an identity by a raw Arabic name.
      const { uid, emailClaim } = await resolveSessionUid(
        db, student, (u, source) => syncUserStage(db, u, source),
      );

      const customToken = await admin.auth().createCustomToken(uid, { email: emailClaim });

      console.log(`Login OK for ${student.id} (uid ${uid})`);
      res.json({ token: customToken, studentId: student.id });
    } catch (error: any) {
      if (error instanceof LoginError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });



  // --- Self-service signup, approved by the stage representative -------------
  // Public, but creates NO usable account: login is gated on students/{email},
  // so a pending request cannot get in. Never log req.body here - it carries the
  // plaintext password until createSignupRequest hashes it.
  app.post("/api/signup/request", async (req, res) => {
    try {
      const db = admin.firestore();
      const prepared = await createSignupRequest(
        db,
        admin.firestore.FieldValue as any,
        (plain: string) => bcrypt.hash(plain, 10),
        req.body || {},
      );
      return res.json({ success: true, email: prepared.email, status: "pending" });
    } catch (error: any) {
      if (error instanceof SignupError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Signup request failed:", error?.message || error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // The stages a signup form can choose from. Public so the form works before
  // the applicant has any credentials, and deliberately minimal - ids and names
  // only, plus the group structure needed to validate their choice.
  app.get("/api/signup/stages", async (req, res) => {
    try {
      const db = admin.firestore();
      const snap = await db.collection("stages").orderBy("order", "asc").get();
      return res.json({
        stages: snap.docs.map(d => {
          const s = d.data() as any;
          return {
            id: s.id || d.id,
            nameAr: s.nameAr || null,
            nameEn: s.nameEn || null,
            order: s.order ?? 0,
            groupConfig: s.groupConfig || null,
          };
        }),
      });
    } catch (error) {
      console.error("Signup stages failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/admin/signup/:email/:action", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const db = admin.firestore();
      const user = (req as any).user;
      const action = req.params.action;
      if (action !== "approve" && action !== "reject") {
        return res.status(400).json({ error: "Unknown action" });
      }

      const reviewerDoc = await db.collection("users").doc(user.uid).get();
      const reviewer = reviewerDoc.data() || {};
      const isMaster = isMasterAdminEmail(user.email);

      const result = await reviewSignupRequest(db, admin.firestore.FieldValue as any, {
        email: req.params.email,
        approve: action === "approve",
        reviewerUid: user.uid,
        reviewerStageId: reviewer.managedStageId || null,
        isMasterAdmin: isMaster,
        reason: req.body?.reason,
      });
      return res.json({ success: true, ...result });
    } catch (error: any) {
      if (error instanceof SignupError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Signup review failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/google-login", express.json(), async (req, res) => {
    try {
      const { idToken, googleIdToken } = req.body || {};
      const db = admin.firestore();

      const identity = await verifyGoogleIdentity({
        adminAuth: admin.auth(),
        oauthClient: googleOAuthClient,
        audience: GOOGLE_WEB_CLIENT_ID,
        idToken,
        googleIdToken,
      });

      const result = await resolveGoogleLogin(db, admin.auth(), identity, {
        masterAdminEmails: [...MASTER_ADMIN_EMAILS],
        fallbackUid: identity.email,
        syncUserStage: (uid, source) => syncUserStage(db, uid, source),
      });

      // studentId is the students/ document id the server resolved to - which
      // for a roster account that linked a Gmail is NOT the address Google
      // asserted. The client needs it for its own whitelist lookups.
      res.json({ token: result.customToken, studentId: result.email });
    } catch (error: any) {
      if (error instanceof GoogleLoginError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Google login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Account deletion -------------------------------------------------------
  //
  // Google Play requires an app with accounts to offer deletion in-app AND from
  // a public web page. This is the request half; shared/accountDeletion.ts
  // explains what a purge actually removes and what the institution keeps.

  app.post("/api/me/deletion-request", verifyAuth, async (req, res) => {
    try {
      const db = admin.firestore();
      const token = (req as any).user;
      const student = await studentForToken(db, token);

      const result = await requestAccountDeletion(db, admin.firestore.FieldValue, {
        uid: token.uid,
        studentId: student.id,
        name: student.data.name || '',
        stageId: student.data.stageId || null,
        reason: (req.body || {}).reason,
      });

      res.json({ ok: true, uid: result.uid, status: 'pending' });
    } catch (error: any) {
      if (error instanceof DeletionError || error instanceof LoginError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Deletion request error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/me/deletion-request", verifyAuth, async (req, res) => {
    try {
      const db = admin.firestore();
      const snap = await db.collection('deletion_requests').doc((req as any).user.uid).get();
      res.json(snap.exists ? { status: snap.data()?.status || null } : { status: null });
    } catch (error: any) {
      console.error("Deletion request read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/me/deletion-request", verifyAuth, async (req, res) => {
    try {
      const db = admin.firestore();
      await cancelAccountDeletion(db, (req as any).user.uid);
      res.json({ ok: true });
    } catch (error: any) {
      if (error instanceof DeletionError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Deletion cancel error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // The review queue. Scoped to the caller's stage, like every other roster
  // surface - a representative reviews only their own cohort.
  app.get("/api/admin/deletion-requests", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const db = admin.firestore();
      const staff = callerStage(req);
      let query = db.collection('deletion_requests').where('status', '==', 'pending');
      // staffCan, not isMasterAdmin: support reaches every stage, but only when
      // ticked for it. Falling through to the managedStageId branch would scope a
      // promoted representative to the stage they used to represent, which is a
      // home stage and not a scope.
      if (!staffCan(staff, 'manageStudents')) {
        if (staff.isSupport) return res.status(403).json({ error: SUPPORT_NOT_GRANTED });
        if (!staff.managedStageId) return res.json({ requests: [] });
        query = query.where('stageId', '==', staff.managedStageId);
      }
      const snap = await query.get();
      res.json({
        requests: snap.docs.map((d: any) => ({ id: d.id, ...d.data(), reason: d.data().reason || '' })),
      });
    } catch (error: any) {
      console.error("Deletion queue error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/admin/deletion-requests/:uid/:action", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { uid, action } = req.params;
      if (action !== 'approve' && action !== 'reject') {
        return res.status(400).json({ error: "Unknown action." });
      }

      const db = admin.firestore();
      const result = await reviewDeletionRequest(db, admin.auth(), admin.firestore.FieldValue, {
        uid,
        approve: action === 'approve',
        reviewerUid: (req as any).user.uid,
        staff: callerStage(req),
        reason: (req.body || {}).reason,
      });

      res.json({ ok: true, ...result });
    } catch (error: any) {
      if (error instanceof DeletionError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Deletion review error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Account self-service --------------------------------------------------
  //
  // A student changing their own password, exam code, or linked Google account.
  // All three write `students/{id}`, which firestore.rules makes admin-only, so
  // none of it is reachable from the client SDK - which is the point.
  //
  // Every handler resolves the target document from the VERIFIED token and
  // never from a body field, so one student can never reach another's record.
  // The logic itself lives in shared/accountSelfService.ts so the two API
  // surfaces cannot drift.

  /** Turns a SelfServiceError / LoginError into its response, else a 500. */
  const sendSelfServiceError = (res: any, error: any, label: string) => {
    if (error instanceof SelfServiceError || error instanceof LoginError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error(`${label} error:`, error);
    return res.status(500).json({ error: "Internal server error" });
  };

  // What the settings page renders: login code, linked address, whether the
  // password is still the generated one. Never includes the hash.
  app.get("/api/me/account", verifyAuth, async (req, res) => {
    try {
      const db = admin.firestore();
      const student = await studentForToken(db, (req as any).user);
      res.json(accountSummary(student));
    } catch (error: any) {
      sendSelfServiceError(res, error, "Account summary");
    }
  });

  app.post("/api/me/password", verifyAuth, async (req, res) => {
    try {
      const db = admin.firestore();
      const result = await changeOwnPassword(db, (req as any).user, req.body || {});
      res.json({ ok: true, studentId: result.studentId });
    } catch (error: any) {
      sendSelfServiceError(res, error, "Change password");
    }
  });

  app.post("/api/me/exam-code", verifyAuth, async (req, res) => {
    try {
      const db = admin.firestore();
      const result = await setOwnExamCode(db, (req as any).user, req.body || {});
      res.json({ ok: true, examCode: result.examCode });
    } catch (error: any) {
      sendSelfServiceError(res, error, "Set exam code");
    }
  });

  // Linking is gated on verifyGoogleIdentity, which refuses a token whose email
  // is not verified. That check is the entire guard: without it a student could
  // claim a classmate's address and Google login would then hand them the
  // classmate's account.
  app.post("/api/me/link-google", verifyAuth, async (req, res) => {
    try {
      const { idToken, googleIdToken } = req.body || {};
      const db = admin.firestore();

      const identity = await verifyGoogleIdentity({
        adminAuth: admin.auth(),
        oauthClient: googleOAuthClient,
        audience: GOOGLE_WEB_CLIENT_ID,
        idToken,
        googleIdToken,
      });

      const result = await linkGoogleAccount(
        db, (req as any).user, identity, admin.firestore.FieldValue,
      );

      // A fresh token for the SAME session. On native the Google plugin signs out
      // of the Firebase layer as a side effect, so the client re-establishes with
      // this rather than discovering it has been logged out by linking.
      const token = await admin.auth().createCustomToken((req as any).user.uid, {
        email: result.studentId,
      });

      res.json({
        ok: true, token,
        googleEmail: result.googleEmail, alreadyOwned: result.alreadyOwned,
      });
    } catch (error: any) {
      if (error instanceof GoogleLoginError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      sendSelfServiceError(res, error, "Link Google");
    }
  });

  app.delete("/api/me/link-google", verifyAuth, async (req, res) => {
    try {
      const db = admin.firestore();
      await unlinkGoogleAccount(db, (req as any).user, admin.firestore.FieldValue);
      res.json({ ok: true });
    } catch (error: any) {
      sendSelfServiceError(res, error, "Unlink Google");
    }
  });

  app.post("/api/admin/students", verifyAuth, verifyAdmin, async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      const { name, email, password, examCode, stageId, subgroup } = req.body;
      
      if (!name || !email || !password || !examCode) {
        return res.status(400).json({ error: "All fields are required." });
      }

      // The stage is the SERVER's decision, not the caller's. This route used to
      // take req.body.stageId verbatim, so a stage-1 representative could plant a
      // student in stage 5 - and syncUserStage then copied that onto the user doc
      // at login, granting them another stage's content.
      const staff = callerStage(req);
      let effectiveStage: string | null;
      if (staffCan(staff, 'manageStudents')) {
        // Cross-stage, so the stage must be stated rather than inferred. A
        // support account's own managedStageId is a home stage and is NOT the
        // right default here - silently filing students under it would be the
        // same class of bug as trusting req.body.stageId.
        effectiveStage = stageId || null;
        if (!effectiveStage) {
          return res.status(400).json({ error: "stageId is required." });
        }
      } else if (staff.isSupport) {
        return res.status(403).json({ error: SUPPORT_NOT_GRANTED });
      } else {
        if (!staff.managedStageId) {
          return res.status(403).json({ error: "You are not assigned to a stage." });
        }
        if (stageId && stageId !== staff.managedStageId) {
          return res.status(403).json({ error: "You may only add students to your own stage." });
        }
        effectiveStage = staff.managedStageId;
      }

      const db = admin.firestore();
      const emailLower = email.toLowerCase();

      const studentRef = db.collection('students').doc(emailLower);
      const studentDoc = await studentRef.get();

      if (studentDoc.exists) {
        return res.status(400).json({ error: "Student already exists." });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      await studentRef.set({
        name,
        // Every path that writes `name` must write nameKey too - /api/login
        // queries it, and a student without one cannot sign in by name.
        nameKey: nameKeyFor(name),
        email: emailLower,
        password: hashedPassword,
        examCode,
        isActive: true,
        // Carried onto the users doc at login by syncUserStage. Without it the
        // student resolves to no stage and sees unfiltered content.
        stageId: effectiveStage,
        ...(subgroup ? { subgroup } : {}),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Create student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin Get Students
  app.get("/api/admin/students", verifyAuth, verifyAdmin, async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      // Scoped to the caller's stage. This was an unfiltered scan of the whole
      // students collection, so every representative saw every stage's roster
      // (names, emails and exam codes) - and the projection dropped stageId, so
      // the client could not even have filtered it back down.
      const staff = callerStage(req);
      const db = admin.firestore();
      let studentsQuery: FirebaseFirestore.Query = db.collection('students');
      if (!staffCan(staff, 'manageStudents')) {
        if (staff.isSupport) return res.status(403).json({ error: SUPPORT_NOT_GRANTED });
        if (!staff.managedStageId) return res.json({ students: [] });
        studentsQuery = studentsQuery.where('stageId', '==', staff.managedStageId);
      }
      const snapshot = await studentsQuery.get();

      const students = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name,
          email: data.email,
          examCode: data.examCode,
          isActive: data.isActive,
          stageId: data.stageId ?? null,
          subgroup: data.subgroup ?? null,
          createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now()
        };
      });

      res.json({ students });
    } catch (error) {
      console.error("Get students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin Toggle Student Status
  app.patch("/api/admin/students/:email/toggle", verifyAuth, verifyAdmin, async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      const { email } = req.params;
      const { isActive } = req.body;
      
      const db = admin.firestore();
      await db.collection('students').doc(email).update({
        isActive
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Toggle student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin Delete Student
  app.delete("/api/admin/students/:email", verifyAuth, verifyAdmin, async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      const { email } = req.params;
      
      const db = admin.firestore();
      await db.collection('students').doc(email).delete();

      res.json({ success: true });
    } catch (error) {
      console.error("Delete student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin Delete All Students
  app.delete("/api/admin/students", verifyAuth, verifyAdmin, async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      // Scoped to the caller's own stage. This deleted the ENTIRE students
      // collection across all five stages on the strength of role == 'admin',
      // so one representative could wipe the whole university's whitelist.
      const staff = callerStage(req);
      const db = admin.firestore();
      let victims: FirebaseFirestore.Query = db.collection('students');
      // Unscoped, this deletes every stage's whitelist. Support reaches that far
      // only when ticked for manageStudents - the capability is the whole guard.
      if (!staffCan(staff, 'manageStudents')) {
        if (staff.isSupport) return res.status(403).json({ error: SUPPORT_NOT_GRANTED });
        if (!staff.managedStageId) {
          return res.status(403).json({ error: "You are not assigned to a stage." });
        }
        victims = victims.where('stageId', '==', staff.managedStageId);
      }
      const snapshot = await victims.get();

      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      res.json({ success: true, deleted: snapshot.size });
    } catch (error) {
      console.error("Delete all students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin Edit Student
  app.put("/api/admin/students/:email", verifyAuth, verifyAdmin, async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      const { email } = req.params;
      const { newEmail, name, password, examCode } = req.body;
      
      const db = admin.firestore();
      const oldEmailLower = email.toLowerCase();
      const newEmailLower = newEmail ? newEmail.toLowerCase() : oldEmailLower;

      const studentRef = db.collection('students').doc(oldEmailLower);
      const studentDoc = await studentRef.get();

      if (!studentDoc.exists) {
        return res.status(404).json({ error: "Student not found" });
      }

      const resolvedName = name || studentDoc.data()?.name;
      const updateData: any = {
        name: resolvedName,
        // Kept in step with `name`, or name login stops finding them.
        nameKey: nameKeyFor(resolvedName || ''),
        examCode: examCode || studentDoc.data()?.examCode,
      };

      if (password) {
        updateData.password = await bcrypt.hash(password, 10);
      }

      if (newEmailLower !== oldEmailLower) {
        // Check if new email already exists
        const newStudentDoc = await db.collection('students').doc(newEmailLower).get();
        if (newStudentDoc.exists) {
          return res.status(400).json({ error: "New email already exists" });
        }
        
        updateData.email = newEmailLower;
        updateData.isActive = studentDoc.data()?.isActive;
        updateData.createdAt = studentDoc.data()?.createdAt;

        await db.collection('students').doc(newEmailLower).set(updateData);
        await studentRef.delete();
      } else {
        await studentRef.update(updateData);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Edit student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Re-issue one student's password.
  //
  // Unlike every other student write the admin UI makes, this one goes through
  // the API rather than the SDK, which is what lets the stage authority apply
  // at all - the Admin SDK bypasses firestore.rules, so resetStudentPassword
  // re-checks the boundary by hand.
  app.post("/api/admin/students/:email/reset-password", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const db = admin.firestore();
      const studentId = decodeURIComponent(req.params.email);
      const result = await resetStudentPassword(db, studentId, callerStage(req));
      res.json(result);
    } catch (error: any) {
      if (error instanceof StudentAdminError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Reset student password error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // REMOVED: POST /api/admin/announcements, DELETE /api/admin/announcements/:id
  // and DELETE /api/admin/records/:id. See the matching note in api/index.ts -
  // all three were unauthenticated, trusted the body for authorship, and never
  // stamped stageId. Nothing in src/ calls them.

  // Admin Delete User Account Permanently
  app.delete("/api/admin/users/:uid", verifyAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const isMasterAdmin = isMasterAdminEmail(user.email) || user.role === 'master_admin';

      if (!isMasterAdmin) {
        return res.status(403).json({ error: "Forbidden: Requires master admin privileges to delete Auth accounts" });
      }

      if (!admin.apps.length) {
        return res.status(500).json({ error: "Firebase Admin is not configured." });
      }

      const { uid } = req.params;
      await deleteUserAccount(admin.firestore(), admin.auth(), uid);

      res.json({ success: true });
    } catch (error) {
      console.error("Delete user account error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin Merge User Accounts
  app.post("/api/admin/users/merge", verifyAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const isMasterAdmin = isMasterAdminEmail(user.email) || user.role === 'master_admin';

      if (!isMasterAdmin) {
        return res.status(403).json({ error: "Forbidden: Requires master admin privileges" });
      }

      if (!admin.apps.length) {
        return res.status(500).json({ error: "Firebase Admin is not configured." });
      }

      const { primaryUid, secondaryUid } = req.body;
      const keepUid = primaryUid || req.body.keepUid;
      const deleteUid = secondaryUid || req.body.deleteUid;

      if (!keepUid || !deleteUid) {
        return res.status(400).json({ error: "primaryUid and secondaryUid are required" });
      }
      if (keepUid === deleteUid) {
        return res.status(400).json({ error: "primaryUid and secondaryUid must differ" });
      }

      await mergeUserAccounts(admin.firestore(), admin.auth(), keepUid, deleteUid);

      res.json({ success: true });
    } catch (error) {
      console.error("Merge user accounts error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Check Whitelist (used by client to bypass security rules)
  app.post("/api/check-whitelist", async (req, res) => {
    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin is not configured." });
    }

    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ error: "Email is required." });
      }

      const db = admin.firestore();
      const emailLower = email.toLowerCase();
      
      // Check allowed_admins first
      const adminDoc = await db.collection('allowed_admins').doc(emailLower).get();
      if (adminDoc.exists) {
        const adminData = adminDoc.data();
        return res.json({ 
          exists: true, 
          data: { 
            name: adminData?.role === 'moderator' ? 'Moderator' : 'Admin', 
            email: emailLower, 
            isActive: true, 
            role: adminData?.role || 'admin' 
          } 
        });
      }

      // Check users collection for existing admin/moderator role
      const usersSnapshot = await db.collection('users').where('email', '==', emailLower).get();
      if (!usersSnapshot.empty) {
        const userData = usersSnapshot.docs[0].data();
        if (userData.role === 'admin' || userData.role === 'moderator') {
          return res.json({ 
            exists: true, 
            data: { 
              name: userData.name, 
              email: emailLower, 
              isActive: true, 
              role: userData.role 
            } 
          });
        }
      }

      // Check students collection
      const studentDoc = await db.collection('students').doc(emailLower).get();

      if (!studentDoc.exists) {
        return res.json({ exists: false });
      }

      const studentData = studentDoc.data();
      
      // We don't send the password back to the client
      const safeData = {
        name: studentData?.name,
        email: studentData?.email,
        examCode: studentData?.examCode,
        isActive: studentData?.isActive,
        createdAt: studentData?.createdAt?.toMillis ? studentData.createdAt.toMillis() : Date.now()
      };

      res.json({ exists: true, data: safeData });
    } catch (error) {
      console.error("Check whitelist error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Streak System Backend ---
  
  const getIraqDateAndHour = () => {
    // using Intl.DateTimeFormat to reliably get hour and date in Asia/Baghdad
    const now = new Date();
    // get time in Iraq, guaranteeing 0-23 hours
    const str = now.toLocaleString("en-GB", { timeZone: "Asia/Baghdad", hourCycle: "h23" });
    // form: '28/04/2026, 15:30:00'
    const [datePart, timePart] = str.split(', ');
    const [day, month, year] = datePart.split('/');
    const [hour] = timePart.split(':');
    
    return {
      year: parseInt(year),
      month: parseInt(month),
      day: parseInt(day),
      hour: parseInt(hour)
    };
  };

  const getEffectiveDateString = (gracePeriodHours: number = 2) => {
    const { year, month, day, hour } = getIraqDateAndHour();
    // GRACE PERIOD: 00:00 to <gracePeriodHours>:59AM will be counted as previous day
    // We get the actual date
    let effectiveDate = new Date(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T12:00:00Z`);
    
    if (hour >= 0 && hour < gracePeriodHours) {
      effectiveDate.setDate(effectiveDate.getDate() - 1);
    }
    
    const ey = effectiveDate.getUTCFullYear();
    const em = effectiveDate.getUTCMonth() + 1;
    const ed = effectiveDate.getUTCDate();
    
    return `${ey}-${em.toString().padStart(2, '0')}-${ed.toString().padStart(2, '0')}`;
  };

  app.post("/api/record-activity", verifyAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const db = admin.firestore();
      
      // Whether streaks count today is derived from the academic calendar, not
      // from a stored flag, so a break pauses the app whether or not the nightly
      // rollover ever ran. Resolved against the day being CREDITED (grace period
      // applied), so the gate and the streak arithmetic always agree on the date.
      const settingsSnap = await db.collection('app_settings').doc('streak').get();
      const graceHours = settingsSnap.exists ? (settingsSnap.data()?.gracePeriodHours ?? 2) : 2;
      const { calendar, phase } = await resolveCurrentPhase(db, getEffectiveDateString(graceHours));
      if (phase.isPaused) {
        return res.json({
          success: true,
          vacationMode: true,
          phase: phase.phase,
          resumesOn: phase.nextStart,
          message: "The competition is paused for the break. Streaks are frozen.",
        });
      }

      const userRef = db.collection('users').doc(user.uid);
      
      const txResult = await db.runTransaction(async (t) => {
        const appSettingsDoc = await t.get(db.collection('app_settings').doc('streak'));
        const gracePeriodHours = appSettingsDoc.exists ? (appSettingsDoc.data()?.gracePeriodHours ?? 2) : 2;
        
        const effectiveDate = getEffectiveDateString(gracePeriodHours);
        const historyId = `${user.uid}_${effectiveDate}`;
        const historyRef = db.collection('streak_history').doc(historyId);
        const pendingDocRef = db.collection('pending_streak_resets').doc(user.uid);
        
        const userDoc = await t.get(userRef);
        const historyDoc = await t.get(historyRef);
        const pendingDoc = await t.get(pendingDocRef);
        
        if (!userDoc.exists) {
          throw new Error("User not found");
        }
        
        // If already recorded today, just update lastActiveAt
        if (historyDoc.exists) {
          if (historyDoc.data()?.freezeUsed === true) {
             t.update(historyRef, { freezeUsed: false });
          }
          t.update(userRef, { lastActiveAt: admin.firestore.FieldValue.serverTimestamp() });
          return { freezeUsed: false };
        }

        const data = userDoc.data()!;
        let streakCount = data.streakCount || 0;
        let longestStreak = data.longestStreak || 0;
        // Declared inside the transaction, not outside: a retried transaction has
        // to recompute this, or a replay reports a freeze that did not happen.
        let hasUsedFreeze = false;
        let freezeTokens = data.freezeTokens ?? 1; // Default 1
        const lastActiveDate = data.lastActiveDate; // format 'YYYY-MM-DD'
        
        let processedLastDate = lastActiveDate;
        if (processedLastDate && processedLastDate.includes("T")) {
          processedLastDate = processedLastDate.split("T")[0];
        }

        if (!processedLastDate) {
          streakCount = 1;
        } else {
          // Paused days are not misses: a student active on the last live day
          // before a break and again on the first day of the new term is one
          // day apart. Without this every student loses their streak across a
          // break the rollover failed to archive.
          const daysDiff = activeDaysBetween(calendar, processedLastDate, effectiveDate);

          if (daysDiff === 1) {
            streakCount += 1;
          } else if (daysDiff > 1) {
            const missedDays = daysDiff - 1;

            if (freezeTokens >= missedDays) {
              freezeTokens -= missedDays;
              streakCount += 1; // It continues from before + effectively covers gap
              hasUsedFreeze = true;

              // Log the missed LIVE days as frozen. Walking raw calendar days
              // here would mark break days as covered by a freeze token.
              let gapDate = processedLastDate;
              for (let stamped = 0; stamped < missedDays; ) {
                gapDate = addDays(gapDate, 1);
                if (gapDate >= effectiveDate) break;
                if (!isLiveDay(calendar, gapDate)) continue;
                stamped++;

                const gapHistoryRef = db.collection('streak_history').doc(`${user.uid}_${gapDate}`);
                t.set(gapHistoryRef, {
                  userId: user.uid,
                  date: gapDate,
                  wasActive: true,
                  freezeUsed: true,
                  timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
              }
            } else {
              const previousStreak = streakCount;
              streakCount = 1; // It's lost IMMEDIATELY.

              let canCreatePending = false;
              if (!data.hasPendingStreakReset) {
                  canCreatePending = true;
              } else if (pendingDoc.exists) {
                  const data = pendingDoc.data();
                  if (data && data.expiresAt) {
                      const exp = data.expiresAt.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
                      if (exp < new Date()) canCreatePending = true;
                  }
              } else {
                  canCreatePending = true; // flag is true but doc doesn't exist
              }

              if (canCreatePending) {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 7);

                t.set(pendingDocRef, {
                   userId: user.uid,
                   email: user.email || '',
                   name: data.name || '',
                   missedDays: missedDays,
                   streakAtRisk: previousStreak,
                   dateRecorded: effectiveDate,
                   expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
                   createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
              }
              data.hasPendingStreakReset = true; // Mark locally
            }
          }
        }
        
        longestStreak = Math.max(longestStreak, streakCount);
        // Per-season peak (longestStreak) is zeroed by startNewSeason; this one is
        // not, and is what the profile's "الأطول" reads.
        const bestStreakAllTime = Math.max(data.bestStreakAllTime || 0, streakCount);

        const updateData: any = {
          streakCount,
          longestStreak,
          bestStreakAllTime,
          freezeTokens,
          lastActiveDate: effectiveDate,
          lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        if (data.hasPendingStreakReset) {
           updateData.hasPendingStreakReset = true;
        }

        t.update(userRef, updateData);
        
        t.set(historyRef, {
          userId: user.uid,
          date: effectiveDate,
          wasActive: true,
          freezeUsed: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return { freezeUsed: hasUsedFreeze };
      });
      
      const updatedUser = await userRef.get();
      // Reported from the transaction. This used to read
      // `freezeTokens < (freezeTokens ?? 1)` off the post-commit document - the
      // same value compared to itself, so the client was told `false` every time
      // even when a shield had just been spent.
      res.json({ success: true, streakCount: updatedUser.data()?.streakCount, freezeUsed: txResult?.freezeUsed === true });
    } catch (error) {
      console.error("Error recording activity:", error);
      res.status(500).json({ error: "Failed to record activity" });
    }
  });

  app.get("/api/streak-history/:uid", verifyAuth, async (req, res) => {
    try {
      const authUser = (req as any).user;
      const targetUid = req.params.uid;
      
      const db = admin.firestore();
      
      // Admins and moderators can view anyone's streak history. Users can only view their own.
      if (authUser.uid !== targetUid) {
         const userDoc = await db.collection('users').doc(authUser.uid).get();
         const role = userDoc.data()?.role;
         if (role !== 'admin' && role !== 'moderator') {
            return res.status(403).json({ error: 'Forbidden' });
         }
      }

      const snapshot = await db.collection('streak_history')
        .where('userId', '==', targetUid)
        .get();
        
      const history = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          ...data,
          timestamp: data.timestamp?.toDate() ? data.timestamp.toDate().toISOString() : new Date().toISOString()
        };
      });
      
      res.json({ history });
    } catch (error) {
      console.error("Error fetching streak history:", error);
      res.status(500).json({ error: "Failed to fetch streak history" });
    }
  });


  // Year-end wipe. Empties every stage's content so the next year starts clean,
  // keeping the question bank. The single most destructive endpoint in the app, so
  // it is master-admin only on top of verifyAdmin, refuses a year label that does
  // not match the live calendar, and refuses to run before the final season has
  // been archived. POST { yearLabel, dryRun? }.
  app.post("/api/admin/wipe-year", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const adminUser = (req as any).user;
      if (!isMasterAdminEmail(adminUser.email)) {
        return res.status(403).json({ error: "Master Admin only" });
      }

      const db = admin.firestore();
      const calendar = await loadCalendar(db);
      const { yearLabel, dryRun, exportOnly } = req.body || {};

      // Export with no deletion. Deliberately its own branch ABOVE the wipe path,
      // so a snapshot can never fall through into a delete: it archives the year
      // into contentArchives and returns, leaving every document in place. This is
      // what the "export only" button calls, and it is safe to run repeatedly.
      if (exportOnly) {
        const label = yearLabel || calendar.yearLabel;
        const plan = await planYearWipe(db, {
          yearLabel: label,
          r2PublicUrl: process.env.R2_PUBLIC_URL || "",
        });
        const { documentsExported } = await exportYear(db, admin.firestore.FieldValue as any, {
          yearLabel: label,
          performedBy: adminUser.uid,
          plan,
        });
        return res.json({
          success: true, exportOnly: true, yearLabel: label,
          documentsExported, counts: plan.counts, files: plan.files.length,
        });
      }

      // A dry run is what the confirmation dialog is built from - it must never
      // write anything, so it is answered before any of the wipe path is entered.
      if (dryRun) {
        const plan = await planYearWipe(db, {
          yearLabel: yearLabel || calendar.yearLabel,
          r2PublicUrl: process.env.R2_PUBLIC_URL || "",
        });
        return res.json({ success: true, dryRun: true, calendarYearLabel: calendar.yearLabel, plan });
      }

      const finalTerm = finalTermOf(calendar);
      const { plan, wipe, summarised, documentsExported } = await runYearWipe(
        db,
        admin.firestore.FieldValue as any,
        {
          yearLabel,
          performedBy: adminUser.uid,
          r2PublicUrl: process.env.R2_PUBLIC_URL || "",
          calendarYearLabel: calendar.yearLabel,
          finalTermId: finalTerm ? finalTerm.id : null,
          summarise: (yl: string) => summariseYear(db, admin.firestore.FieldValue as any, { yearLabel: yl }),
        },
      );

      // Files last: Firestore is snapshotted into contentArchives first, so a
      // failure here leaves the documents recoverable. Failures are reported, not
      // thrown - the wipe itself has already committed.
      const files = await deleteWipedFiles(plan.files, {
        s3: s3Client,
        DeleteObjectCommand,
        r2Bucket: process.env.R2_BUCKET_NAME || "lecture-audio",
        storageBucket: admin.storage ? admin.storage().bucket() : null,
      });

      return res.json({ success: true, summarised, documentsExported, ...wipe, files });
    } catch (error: any) {
      if (error instanceof YearWipeError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Year wipe error:", error);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  app.post("/api/admin/time-freeze", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const db = admin.firestore();
      const appSettingsDoc = await db.collection('app_settings').doc('streak').get();
      const gracePeriodHours = appSettingsDoc.exists ? (appSettingsDoc.data()?.gracePeriodHours ?? 2) : 2;
      const effectiveDate = getEffectiveDateString(gracePeriodHours);
      
      const d = new Date(`${effectiveDate}T12:00:00Z`);
      d.setDate(d.getDate() - 1);
      const yMonth = d.getUTCMonth() + 1;
      const yDay = d.getUTCDate();
      const yesterdayStr = `${d.getUTCFullYear()}-${yMonth.toString().padStart(2, '0')}-${yDay.toString().padStart(2, '0')}`;

      const usersRef = db.collection('users');
      const snapshot = await usersRef.get();
      
      const batches = [];
      let currentBatch = db.batch();
      let countInBatch = 0;
      let totalUpdated = 0;
      
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.streakCount > 0) {
          let processedLastDate = data.lastActiveDate;
          if (processedLastDate && typeof processedLastDate === 'string' && processedLastDate.includes("T")) {
            processedLastDate = processedLastDate.split("T")[0];
          }
          
          if (!processedLastDate || processedLastDate < yesterdayStr) {
            currentBatch.update(doc.ref, { lastActiveDate: yesterdayStr });
            countInBatch++;
            totalUpdated++;
            
            if (countInBatch >= 400) {
              batches.push(currentBatch.commit());
              currentBatch = db.batch();
              countInBatch = 0;
            }
          }
        }
      });
      
      if (countInBatch > 0) {
        batches.push(currentBatch.commit());
      }
      
      await Promise.all(batches);
      
      res.json({ success: true, count: totalUpdated });
    } catch (e) {
      console.error("Error freezing time", e);
      res.status(500).json({ error: "Error freezing time" });
    }
  });

  app.post("/api/admin/grant-freeze-global", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const db = admin.firestore();
      const usersRef = db.collection('users');
      const snapshot = await usersRef.get();
      
      const batches = [];
      let currentBatch = db.batch();
      let count = 0;
      let countInBatch = 0;
      
      snapshot.forEach(doc => {
        currentBatch.update(doc.ref, { freezeTokens: 3 });
        count++;
        countInBatch++;
        
        if (countInBatch >= 400) {
          batches.push(currentBatch.commit());
          currentBatch = db.batch();
          countInBatch = 0;
        }
      });
      
      if (countInBatch > 0) {
        batches.push(currentBatch.commit());
      }
      
      await Promise.all(batches);
      
      res.json({ success: true, count });
    } catch (e) {
      console.error("Error granting global freeze tokens", e);
      res.status(500).json({ error: "Error granting global freeze tokens" });
    }
  });

  app.post("/api/admin/grant-freeze", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { userUid, amount } = req.body;
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userUid);
      
      await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        if (!doc.exists) throw new Error("Not found");
        const currentTokens = doc.data()?.freezeTokens ?? 1;
        const newTokens = Math.min(currentTokens + amount, 3);
        
        t.update(userRef, { freezeTokens: newTokens });
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Error granting freeze token" });
    }
  });

  app.post("/api/admin/resolve-pending-streak", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { userUid, action } = req.body;
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userUid);
      const pendingRef = db.collection('pending_streak_resets').doc(userUid);
  
      await db.runTransaction(async (t) => {
        const pendingDoc = await t.get(pendingRef);
        if (!pendingDoc.exists) throw new Error("Pending streak reset not found");
  
        const pendingData = pendingDoc.data();
        const userDoc = await t.get(userRef);
        const currentTokens = userDoc.exists ? (userDoc.data()?.freezeTokens || 0) : 0;

        if (action === 'reset') {
          // It was already reset when the opportunity was created. Just clean up.
          t.update(userRef, {
            hasPendingStreakReset: admin.firestore.FieldValue.delete()
          });

        } else if (action === 'forgive') {
          let newStreakCount = userDoc.exists ? (userDoc.data()?.streakCount || 0) : 0;

          if (pendingData && pendingData.dateRecorded && pendingData.missedDays) {
            const missedDays = pendingData.missedDays;
            const streakAtRisk = pendingData.streakAtRisk || 0;
            
            // Add the restored streak to their current progress
            newStreakCount += streakAtRisk;
            
            let d = new Date(`${pendingData.dateRecorded}T12:00:00Z`);
            for (let i = 0; i < missedDays; i++) {
              d.setDate(d.getDate() - 1);
              const gapY = d.getUTCFullYear();
              const gapM = d.getUTCMonth() + 1;
              const gapD = d.getUTCDate();
              const gapDateStr = `${gapY}-${gapM.toString().padStart(2, '0')}-${gapD.toString().padStart(2, '0')}`;
              
              const gapHistoryRef = db.collection('streak_history').doc(`${userUid}_${gapDateStr}`);
              t.set(gapHistoryRef, {
                userId: userUid,
                date: gapDateStr,
                wasActive: true,
                freezeUsed: true,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          }

          const longestStreak = Math.max(userDoc.data()?.longestStreak || 0, newStreakCount);

          t.update(userRef, {
            streakCount: newStreakCount,
            longestStreak,
            bestStreakAllTime: Math.max(userDoc.data()?.bestStreakAllTime || 0, newStreakCount),
            hasPendingStreakReset: admin.firestore.FieldValue.delete()
          });
        } else {
          throw new Error("Invalid action");
        }
        t.delete(pendingRef);
      });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error resolving pending streak", error);
      res.status(500).json({ error: error.message || "Error resolving pending streak" });
    }
  });

  app.post("/api/admin/streak-recovery", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { userUid, studentEmail, newStreak, reason } = req.body;
      const db = admin.firestore();
      
      const adminUser = (req as any).user;
      const userRef = db.collection('users').doc(userUid);
      
      await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        if (!doc.exists) throw new Error("Not found");
        const oldStreak = doc.data()?.streakCount || 0;
        
        t.update(userRef, {
          streakCount: newStreak,
          longestStreak: Math.max(doc.data()?.longestStreak || 0, newStreak),
          bestStreakAllTime: Math.max(doc.data()?.bestStreakAllTime || 0, newStreak)
        });
        
        const recoveryRef = db.collection('streak_recoveries').doc();
        t.set(recoveryRef, {
          studentEmail,
          userId: userUid,
          oldStreak,
          newStreak,
          reason,
          recoveredBy: adminUser.email,
          recoveredAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      
      try {
        const updatedUser = await userRef.get();
        const fcmToken = updatedUser.data()?.fcmToken;
        if (fcmToken) {
          const message = {
            notification: {
              title: "🔥 تم استرجاع الستريك!",
              body: "قام الإداري باسترجاع الستريك الخاص بك بنجاح. استمر في التألق!"
            },
            data: {
              type: "streak_recovery"
            },
            token: fcmToken
          };
          await admin.messaging().send(message);
        }
      } catch (notifyErr) {
        console.error("Failed to send streak recovery notification", notifyErr);
      }

      res.json({ success: true });
    } catch (e) {
      console.error("Streak recovery error:", e);
      res.status(500).json({ error: "Error recovering streak" });
    }
  });

  app.post("/api/admin/fix-calendar", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { userUid } = req.body;
      const db = admin.firestore();
      
      const today = new Date();
      const datesToCheck: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth() + 1;
        const day = d.getUTCDate();
        const dateStr = `${y}-${m.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
        datesToCheck.push(dateStr);
      }

      let fixedCount = 0;
      await db.runTransaction(async (t) => {
        const userRef = db.collection('users').doc(userUid);
        
        datesToCheck.reverse(); // oldest to newest
        
        for (const dateStr of datesToCheck) {
          const docRef = db.collection('streak_history').doc(`${userUid}_${dateStr}`);
          const docSnap = await t.get(docRef);
          if (!docSnap.exists) {
            t.set(docRef, {
              userId: userUid,
              date: dateStr,
              wasActive: true,
              freezeUsed: true,
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            fixedCount++;
          }
        }
      });
      res.json({ success: true, fixedCount });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: e.message || "Error" });
    }
  });


  // Ends the current season: archives BOTH boards into each student's profile
  // with their final rank, zeroes the live boards, and starts the new season.

  // Records a student's end-of-year result and moves them if they passed.
  //
  // Server-side because syncUserStage copies students/{email}.stageId onto the
  // user doc at every login - a client-only write is reverted at next sign-in -
  // and because students/ is admin-write-only. The round is recomputed from the
  // calendar rather than trusted, so nobody can skip ahead and promote early.
  app.post("/api/progression/submit", verifyAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const { round, answer, tahmeelSubjects } = req.body || {};
      const db = admin.firestore();
      const calendar = await loadCalendar(db);

      const result = await submitProgression(db, admin.firestore.FieldValue as any, calendar, {
        uid: user.uid,
        round,
        answer,
        tahmeelSubjects: Array.isArray(tahmeelSubjects) ? tahmeelSubjects : [],
      });

      return res.json({ success: true, ...result });
    } catch (error: any) {
      if (error instanceof ProgressionError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Progression submit error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/admin/start-new-season", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { seasonName } = req.body;
      const adminUser = (req as any).user;

      if (!isMasterAdminEmail(adminUser.email)) {
        return res.status(403).json({ error: "Master Admin only" });
      }
      if (!seasonName || !String(seasonName).trim()) {
        return res.status(400).json({ error: "Season name required" });
      }

      const result = await startNewSeason(
        admin.firestore(),
        admin.firestore.FieldValue as any,
        { seasonName: String(seasonName).trim(), performedBy: adminUser.uid },
      );

      // Whether the app is live afterwards is the calendar's call, not this
      // button's - ending a season during a break must leave the break in place.
      const phase = await syncPhaseMirror(admin.firestore(), admin.firestore.FieldValue as any);

      return res.json({ success: true, ...result, phase: phase.phase, isPaused: phase.isPaused });
    } catch (error: any) {
      console.error("Start new season error:", error);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  // Closes any season whose term has ended and syncs the phase mirror. Safe to
  // call repeatedly - archiving is guarded per term by seasonClosedFor.
  const seasonRolloverHandler = async (req: any, res: any) => {
    // Fails closed, unlike the notification cron: this endpoint archives and
    // zeroes both leaderboards. With no secret configured it stays shut, and the
    // overdue-season warning in the calendar modal makes that visible.
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error("Season rollover blocked: CRON_SECRET is not configured.");
      return res.status(401).send("Cron secret not configured");
    }
    const header = req.headers['x-cron-secret'];
    const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (header !== secret && bearer !== secret) {
      return res.status(403).send("Forbidden");
    }

    try {
      const result = await runSeasonRollover(
        admin.firestore(),
        admin.firestore.FieldValue as any,
        { performedBy: 'cron' },
      );
      if (result.archived) {
        console.log(`Season rollover archived ${result.archived} as ${result.seasonId}`);
      }
      return res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Season rollover error:", error);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  };

  // Vercel Cron issues a GET; POST is kept for manual curl and for parity with
  // the other cron endpoint.
  app.get("/api/cron/season-rollover", seasonRolloverHandler);
  app.post("/api/cron/season-rollover", seasonRolloverHandler);

  // Manual fallback for the settings modal, so a missed cron is one click to fix.
  app.post("/api/admin/run-season-rollover", verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const adminUser = (req as any).user;
      if (!isMasterAdminEmail(adminUser.email)) {
        return res.status(403).json({ error: "Master Admin only" });
      }

      const result = await runSeasonRollover(
        admin.firestore(),
        admin.firestore.FieldValue as any,
        { performedBy: adminUser.uid },
      );
      return res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Manual season rollover error:", error);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  app.post("/api/cron/streak-warnings", async (req, res) => {
    // Requires some secret header to prevent abuse in production
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
      return res.status(403).send("Forbidden");
    }
    
    // In Egypt 10 PM. Find users whose lastActiveDate is NOT today's effectiveDate
    // and send them an FCM notification. Because querying exactly this might be tricky, we can fetch users and filter.
    try {
      const db = admin.firestore();
      const effectiveDate = getEffectiveDateString();
      
      // Just getting all users who have FCM tokens
      const usersSnap = await db.collection('users').where('fcmToken', '!=', null).get();
      
      const tokens: string[] = [];
      usersSnap.forEach(doc => {
        const data = doc.data();
        if (data.lastActiveDate !== effectiveDate && data.fcmToken) {
          tokens.push(data.fcmToken);
        }
      });
      
      if (tokens.length > 0) {
        const message = {
          notification: {
            title: "لا تنسَ نشاطك اليومي 🔥",
            body: "ستريكك في خطر! افتح التطبيق الآن لتحافظ عليه.",
          },
          tokens: tokens,
        };
        await admin.messaging().sendEachForMulticast(message);
      }
      
      res.json({ success: true, notifiedCount: tokens.length });
    } catch (e) {
      console.error("Cron streak warnings error", e);
      res.status(500).json({ error: "Error sending warnings" });
    }
  });

  // ===================================================================
  // SUBSCRIPTION ENDPOINTS
  // ===================================================================

  /** Send a subscription FCM notification. Injected into the shared helpers. */
  const notifySubscription: NotifyFn = async (userId, event, plan) => {
    try {
      const db = admin.firestore();
      const tokenDoc = await db.collection('fcm_tokens').doc(userId).get();
      if (!tokenDoc.exists || !tokenDoc.data()?.token) return;
      const token = tokenDoc.data()!.token;

      const titles: Record<string, string> = {
        activated: 'تم تفعيل الاشتراك! ✅',
        expired: 'انتهى اشتراكك ⏰',
        approved: 'تمت الموافقة على الدفع ✅',
        rejected: 'تم رفض طلب الدفع ❌',
      };

      const bodies: Record<string, string> = {
        activated: 'تم تفعيل اشتراكك بنجاح. يمكنك الآن الوصول إلى جميع ميزات الأسئلة.',
        expired: 'انتهت صلاحية اشتراكك. جدّد الآن للاستمرار في استخدام ميزات الأسئلة.',
        approved: 'تمت الموافقة على دفعتك عبر سوبر كي. تم تفعيل اشتراكك.',
        rejected: 'تم رفض طلب الدفع الخاص بك. تواصل مع الدعم لمزيد من المعلومات.',
      };

      await admin.messaging().send({
        token,
        notification: {
          title: titles[event] || 'محاضراتي',
          body: bodies[event] || '',
        },
        data: { type: 'subscription', event, ...(plan ? { plan } : {}) },
      });
    } catch (err) {
      console.error('FCM notification error:', err);
    }
  };

  /** Context handed to the shared subscription helpers. */
  const subCtx = (): SubscriptionCtx => ({
    db: admin.firestore(),
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
    notify: notifySubscription,
  });

  // --- ZainCash v2: Initiate Payment ---
  app.post('/api/zaincash/init', verifyAuth, async (req, res) => {
    try {
      const { plan, lang } = req.body;
      const user = (req as any).user;
      const config = PLAN_CONFIG[plan];

      if (!config) {
        return res.status(400).json({ error: 'Invalid plan' });
      }

      let cfg;
      let origin;
      try {
        cfg = loadZainCashConfig();
        origin = resolveAppOrigin();
      } catch (e: any) {
        console.error('ZainCash config error:', e.message);
        return res.status(500).json({ error: 'ZainCash not configured' });
      }

      const db = admin.firestore();

      // Reuse a payment that is still live rather than opening a second one.
      // ZainCash refuses to settle while another transaction is open on the
      // same wallet, and a transaction lives about fifteen minutes — so a
      // customer who backs out of the gateway page and retries would otherwise
      // lock themselves out of both, with the refusal shown on ZainCash's page
      // where we never see it.
      const live = await findLiveZainCashPayment(subCtx(), cfg, user.uid);
      if (live) {
        if (live.plan === plan) {
          // The ordinary retry. Same link, nothing created.
          return res.json({
            redirectUrl: live.redirectUrl,
            subscriptionId: live.subscriptionId,
            reused: true,
          });
        }
        // A different plan. Reusing would charge the old plan's price, and a
        // new transaction is exactly what the gateway rejects.
        return res.status(409).json({
          code: 'payment_in_progress',
          error: 'A payment is already in progress',
          pendingPlan: live.plan,
          pendingAmount: live.amount,
          minutesLeft: live.minutesLeft,
          redirectUrl: live.redirectUrl,
        });
      }

      // Reuse the wallet number from this customer's last successful payment.
      // Absent on a first payment, in which case the gateway prompts for it.
      const userDoc = await db.collection('users').doc(user.uid).get();
      const customerPhone = userDoc.data()?.zaincashMsisdn as string | undefined;

      // Unique per attempt: the gateway's idempotency and reconciliation key.
      const externalReferenceId = crypto.randomUUID();

      const subRef = await db.collection('subscriptions').add({
        userId: user.uid,
        userEmail: user.email || '',
        userName: userDoc.data()?.name || '',
        plan,
        status: 'pending',
        paymentMethod: 'zaincash',
        amount: config.price,
        externalReferenceId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      try {
        const result = await initTransaction(cfg, {
          externalReferenceId,
          orderId: tagOrderId(subRef.id),
          amount: config.price,
          language: lang === 'en' ? 'en' : 'ar',
          successUrl: successUrlFor(origin),
          failureUrl: failureUrlFor(origin),
          customerPhone,
        });

        // redirectUrl is kept so a retry can be handed this same live payment.
        // The spec forbids reconstructing it, so storing it is the only way to
        // resume one.
        await subRef.update({
          transactionId: result.transactionId,
          expiryTime: result.expiryTime || null,
          redirectUrl: result.redirectUrl,
        });

        // Points at the payment now in flight. Server-written only — a client
        // that could clear it could mint duplicate transactions at will.
        await db
          .collection('users')
          .doc(user.uid)
          .update({ pendingZainCashRef: subRef.id })
          .catch(() => undefined);

        // Always the gateway's own URL — the spec forbids constructing it.
        return res.json({ redirectUrl: result.redirectUrl, subscriptionId: subRef.id });
      } catch (err: any) {
        await subRef.delete().catch(() => undefined);
        console.error('ZainCash init error:', err?.httpStatus, err?.body || err?.message);
        return res.status(400).json({ error: 'ZainCash initiation failed' });
      }
    } catch (error) {
      console.error('ZainCash init error:', error);
      res.status(500).json({ error: 'Payment initiation failed' });
    }
  });

  /**
   * Shared handler for both redirect targets.
   *
   * The gateway returns the customer by browser GET with ?token=<JWT>. The JWT
   * is verified, but access is granted only on what the Inquiry API reports —
   * this request reaches us through the customer's browser.
   */
  const handleZainCashRedirect = async (req: express.Request, res: express.Response) => {
    const back = (status: string, extra = '') =>
      res.redirect(`/?payment=${status}${extra}`);

    const token = req.query?.token as string | undefined;
    if (!token) return back('error', '&reason=missing_token');

    let cfg;
    try {
      cfg = loadZainCashConfig();
    } catch (e: any) {
      console.error('ZainCash config error:', e.message);
      return back('error', '&reason=not_configured');
    }

    try {
      const event = verifyGatewayToken(cfg, token);
      const result = await settleZainCashPayment(subCtx(), cfg, event, 'redirect');

      switch (result.outcome) {
        case 'activated':
        case 'already_settled':
        case 'duplicate_event':
          return back('success');
        case 'still_pending':
          return back('pending');
        case 'amount_mismatch':
          return back('error', '&reason=amount_mismatch');
        case 'reference_mismatch':
          return back('error', '&reason=reference_mismatch');
        default:
          return back('failed', `&reason=${result.status || result.outcome}`);
      }
    } catch (err) {
      console.error('ZainCash redirect error:', err);
      return back('error', '&reason=invalid_token');
    }
  };

  app.get('/api/zaincash/success', handleZainCashRedirect);
  app.get('/api/zaincash/failure', handleZainCashRedirect);

  /**
   * ZainCash webhook — the spec's preferred source of truth.
   *
   * Registered by ZainCash's business team, must be a different URL from the
   * redirect targets, and does not fire in the test environment. Always answers
   * 200 on a token we accepted, so the gateway does not retry a settled payment.
   */
  app.post('/api/zaincash/webhook', async (req, res) => {
    const token = req.body?.webhook_token;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Missing webhook_token' });
    }

    let cfg;
    try {
      cfg = loadZainCashConfig();
    } catch (e: any) {
      console.error('ZainCash config error:', e.message);
      return res.status(500).json({ success: false, message: 'Not configured' });
    }

    try {
      const event = verifyGatewayToken(cfg, token);
      const result = await settleZainCashPayment(subCtx(), cfg, event, 'webhook');
      console.log(`[ZainCash] webhook ${event.eventId} -> ${result.outcome}`);
      return res.status(200).json({ success: true });
    } catch (err: any) {
      if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, message: 'Invalid token' });
      }
      console.error('ZainCash webhook error:', err);
      return res.status(500).json({ success: false });
    }
  });

  // --- Admin: Grant free subscription ---
  app.post('/api/subscriptions/grant', verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { userId, plan, notes } = req.body;
      const adminUser = (req as any).user;
      const config = PLAN_CONFIG[plan];

      if (!userId || !config) {
        return res.status(400).json({ error: 'Invalid userId or plan' });
      }

      const db = admin.firestore();

      const userDoc = await db.collection('users').doc(userId).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userData = userDoc.data()!;
      const subRef = await db.collection('subscriptions').add({
        userId,
        userEmail: userData.email || '',
        userName: userData.name || '',
        plan,
        status: 'pending', // activated immediately below
        paymentMethod: 'admin_grant',
        amount: 0,
        notes: notes || 'Admin grant',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await activateSubscription(subCtx(), subRef.id, userId, plan, adminUser.uid);

      res.json({ success: true, subscriptionId: subRef.id });
    } catch (error) {
      console.error('Grant subscription error:', error);
      res.status(500).json({ error: 'Failed to grant subscription' });
    }
  });

  // --- Admin: Approve pending SuperKey subscription ---
  app.post('/api/subscriptions/:id/approve', verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const adminUser = (req as any).user;
      const db = admin.firestore();

      const subDoc = await db.collection('subscriptions').doc(id).get();
      if (!subDoc.exists) return res.status(404).json({ error: 'Subscription not found' });

      const subData = subDoc.data()!;
      if (subData.status !== 'pending') {
        return res.status(400).json({ error: 'Subscription is not pending' });
      }

      await activateSubscription(subCtx(), id, subData.userId, subData.plan, adminUser.uid);
      await notifySubscription(subData.userId, 'approved', subData.plan);

      res.json({ success: true });
    } catch (error) {
      console.error('Approve subscription error:', error);
      res.status(500).json({ error: 'Failed to approve subscription' });
    }
  });

  // --- Admin: Reject pending subscription ---
  app.post('/api/subscriptions/:id/reject', verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const db = admin.firestore();

      const subDoc = await db.collection('subscriptions').doc(id).get();
      if (!subDoc.exists) return res.status(404).json({ error: 'Subscription not found' });

      const subData = subDoc.data()!;
      if (subData.status !== 'pending') {
        return res.status(400).json({ error: 'Subscription is not pending' });
      }

      await db.collection('subscriptions').doc(id).update({
        status: 'cancelled',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        notes: 'Rejected by admin',
      });

      await notifySubscription(subData.userId, 'rejected');

      res.json({ success: true });
    } catch (error) {
      console.error('Reject subscription error:', error);
      res.status(500).json({ error: 'Failed to reject subscription' });
    }
  });

  // --- Admin: Extend subscription ---
  app.post('/api/subscriptions/:id/extend', verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { days } = req.body;
      const db = admin.firestore();

      if (!days || days <= 0 || days > 365) {
        return res.status(400).json({ error: 'Invalid days (1-365)' });
      }

      const subDoc = await db.collection('subscriptions').doc(id).get();
      if (!subDoc.exists) return res.status(404).json({ error: 'Subscription not found' });

      const subData = subDoc.data()!;
      if (subData.status !== 'active') {
        return res.status(400).json({ error: 'Can only extend active subscriptions' });
      }

      const currentEnd = subData.endDate?.toDate() || new Date();
      const newEnd = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000);

      await db.collection('subscriptions').doc(id).update({
        endDate: admin.firestore.Timestamp.fromDate(newEnd),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('users').doc(subData.userId).update({
        subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd),
      });

      res.json({ success: true, newEndDate: newEnd.toISOString() });
    } catch (error) {
      console.error('Extend subscription error:', error);
      res.status(500).json({ error: 'Failed to extend subscription' });
    }
  });

  // --- Admin: Cancel subscription ---
  app.post('/api/subscriptions/:id/cancel', verifyAuth, verifyAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const db = admin.firestore();

      const subDoc = await db.collection('subscriptions').doc(id).get();
      if (!subDoc.exists) return res.status(404).json({ error: 'Subscription not found' });

      const subData = subDoc.data()!;

      await db.collection('subscriptions').doc(id).update({
        status: 'cancelled',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('users').doc(subData.userId).update({
        isSubscribed: false,
        subscriptionEnd: null,
        subscriptionPlan: null,
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Cancel subscription error:', error);
      res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  });

  /* ---------------------------------------------------------------- *
   * Simosan — AI lecture tutor
   *
   * Handlers live in shared/simosanApi.ts and are mounted identically in
   * api/index.ts. Keep these four lines in step across both files.
   * ---------------------------------------------------------------- */
  const simosan = createSimosanHandlers({ admin });
  app.post("/api/ai/ask", verifyAuth, simosan.ask);
  app.get("/api/ai/state", verifyAuth, simosan.state);
  app.get("/api/ai/admin/stats", verifyAuth, verifyAdmin, simosan.adminStats);
  app.patch("/api/ai/admin/settings", verifyAuth, verifyAdmin, simosan.adminSettings);

  /* MCQ generation. Staff-only, on the free-tier key - see
   * shared/mcqGeneration.ts for why it is a second key. Mirrored in api/index.ts. */
  const mcq = createMcqHandlers({ admin });
  app.post("/api/mcq/generate", verifyAuth, verifyAdmin, mcq.generate);
  app.post("/api/mcq/request", verifyAuth, mcq.request);
  app.post("/api/mcq/extract", verifyAuth, verifyAdmin, mcq.extract);
  app.post("/api/mcq/modify", verifyAuth, verifyAdmin, mcq.modify);

  // --- Vite Middleware for Development / Static Serving for Production ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
