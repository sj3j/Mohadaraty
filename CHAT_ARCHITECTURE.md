# Chat Architecture & Role Management

## System Overview
The chat architecture is built on a full-stack Firebase evented design. This leverages a seamless synchronization between **Firebase Authentication Custom Claims**, **Firestore Security Rules**, and **Cloud Functions**. Our goal is to guarantee extreme real-time read performance while rigorously shifting trust logic from client to server.

---

## 1. Role Verification & Persistence
The architecture centers around a single source of truth for authorization: **JWT Custom Claims**. The client-side bypasses have been completely removed, preventing trivial script-injections or reverse-engineering of privileged email routes.

### Role Synchronization Flow
When any user document `users/{uid}` is written to or created, a background Cloud Function (`syncRole`) fires via `onDocumentWritten`.
1. It validates the data and determines if the email matches the immutable system master credentials (`master_admin`), or inherits the document's assigned `admin`, `moderator`, or `student` role.
2. It executes `admin.auth().setCustomUserClaims(uid, { role, manageChat })`.
3. Following this, the user's secure Auth context possesses `.token.role`.

### Client Context Consumption
On the client side (`App.tsx`), `onAuthStateChanged` performs `await firebaseUser.getIdTokenResult()` returning the `claim` object. The overarching state (`user.isMasterAdmin`) is hydrated purely from this claim, cascading permissions cleanly downward without secondary database pinging.

---

## 2. Real-Time Write Logic & Client Separation
To optimize costs while maximizing anti-spam measures, write logic splits between Administrative Write and Standard (Student) Write.

### Admin/Moderator Writes
- **Action**: Native synchronous Firestore operations (`setDoc`, `updateDoc`, `deleteDoc`).
- **Cost**: Near 0 latency. 
- **Security Check**: Enforced directly at the database door.
  ```javascript
  function isModerator() {
    return isAuthenticated() && request.auth.token.role == 'moderator';
  }
  function isAdmin() {
    return isAuthenticated() && request.auth.token.role == 'admin';
  }
  ```

### Student Writes (Rate-Limited Server Route)
Students cannot write directly to `/chat_messages/`.
- **Action**: The client routes through a Firebase v2 Callable endpoint (`httpsCallable('sendMessage')`). 
- **Optimistic UI Component**: To maintain real-time responsiveness mirroring direct-writes, the UI renders immediately into the message stack with a temporary key.
- **Server Safety Check**: The server verifies the `lastMessageAt` timestamp against `now`, enforcing a 3000ms cooldown. 
- **Rollback**: If the server rejects the request (rate threshold breached), the client catches the rejected request and modifies the Optimistic message status to a failed state.

---

## 3. Data Sensitivity: Anonymous Posting Core
A central function of the platform is safe anonymous communication over chat. Sending `anonymous: true` strips the sender ID entirely from the client view list, but requires tracking for accountability.

### Segregated Subcollection Pattern
To solve this, public messaging paths and private metrics paths are split:
- If a message is marked as anonymous (`isAnonymous: true`), both the Cloud Function endpoint and Admin Batch logic strip the email from the payload.
- In atomic lockstep (Batch Write), the actual identities are written to a restricted deep path: `chat_messages/{docId}/private/sender`.
- The rules prevent reads for everything except `master_admin`:
  ```javascript
  match /chat_messages/{messageId} {
      match /private/{docId} {
          allow read: if isMasterAdmin();
          allow write: if isAuthenticated();
      }
  }
  ```

---

## 4. Background Chron Jobs
Finally, high-volume real-time chat inevitably degrades client render speeds. A background scheduled pipeline automatically pulls stale messages.
- **Trigger**: `onSchedule('every 24 hours')` 
- **Logic**: Moves documents older than 30 days securely into a `/chat_archive` path.
- **Optimization Strategy**: Batched sets (400 limit to respect Firestore transaction ceilings).

---

## 5. Data Models (Firestore)

Merged here from the former `chat_architecture_and_roles.md`, which was deleted: its
remaining sections were a list of backend design questions that this document is the
answer to, and its role table predated both the `moderator` split and the cross-stage
`support` role. `src/lib/permissions.ts` is the source of truth for who may do what.

### `chat_messages` (Collection)
* `id`: Document ID
* `text`: String content of the message
* `senderId` / `senderName`: Information about the sender. **`senderEmail` is NOT here for
  an anonymous message** - it is split into the restricted `private/sender` subcollection
  described in §3, which is what makes anonymity a property rather than a label.
* `isAnonymous`: Boolean indicating if the message is anonymous
* `reactions`: Object containing arrays of user emails who reacted (e.g. `like: []`, `heart: []`)
* `createdAt`: Timestamp
* `fileUrl` / `fileName` / `fileType`: Optional attachment metadata
* `embeddedItem`: Optional metadata for linked lectures/announcements
* `replyTo`: Optional reference to a parent message

### `chat_settings/config` (Document)
* `isChatOpen`: Boolean flag for global chat open/close state
* `allowAttachments`: Boolean flag controlling Student file uploads
* `pinnedMessage`: Object holding a globally pinned message

### Send latency
Students used to carry a client-side cooldown timer that admins bypassed, which read as the
chat being slow for students specifically. The cooldown is gone and the optimistic update
(`setMessages` before the network call) now applies to both, so sending is visually
instantaneous for everyone. Rate limiting lives on the server route instead (§2).
