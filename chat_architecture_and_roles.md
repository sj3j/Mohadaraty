# Chat Architecture & Roles Documentation

This document outlines the architecture, data structures, and role-based access logic for the `ChatScreen` component in the React application. It also provides discussion points and questions intended for backend/cloud code evaluation.

## 1. Core Architecture
The chat system is a real-time React component (`ChatScreen.tsx`) connected directly to Firebase Firestore. 
* **Real-time Listener**: Uses Firestore `onSnapshot` to listen to the `chat_messages` collection, ordered by `createdAt` descending, limited to the 50 most recent messages initially.
* **Optimistic UI**: When a user sends a message, it is instantly appended to the local React state (`messages` array) before waiting for the Firestore `setDoc` network request to complete. This gives the illusion of instant delivery.
* **Pagination**: A load more function fetches older messages from cache or server using Firestore `query` with `startAfter` cursors.

## 2. Roles & Permissions

The component implements strict UI-level role checks based on the `user` object.

### Student (Default User)
* **Send Restrictions**: Can only send messages if `settings.isChatOpen` is `true`.
* **Attachment Restrictions**: Cannot send files if `settings.allowAttachments` is `false`.
* **Anonymity**: Can toggle an `isAnonymous` flag to send messages as "Anonymous" (renders without name/avatar).

### Moderator / Admin
* **Definition**: `(user?.role === "admin" || user?.role === "moderator") && user?.permissions?.manageChat !== false`.
* **Privileges**: 
  * Can send messages even when the chat is visually "closed" (`settings.isChatOpen === false`).
  * Can bypass attachment restrictions.
  * Has access to the Admin Settings Panel (gear icon) to toggle global chat status, clear all messages, and manage pinned messages.
  * Can delete **any** message in the chat.

### Master Admin
* **Definition**: Hardcoded email whitelist. The list lives in
  `shared/masterAdmins.ts` and is repeated only where an import is impossible
  (`firestore.rules`, `storage.rules`, `functions/index.js`, the `.mjs`
  scripts); `npm run test:masters` fails if those copies drift.
* **Privileges**: 
  * Inherits all Admin/Moderator privileges.
  * **Anonymity Override**: Can click on anonymous messages to reveal the actual sender's email/ID (which is secretly stored in the document payload).

## 3. Data Models (Firestore)

### `chat_messages` (Collection)
* `id`: Document ID
* `text`: String content of the message
* `senderId` / `senderEmail` / `senderName`: Information about the sender
* `isAnonymous`: Boolean indicating if the message is anonymous
* `reactions`: Object containing arrays of user emails who reacted (e.g., `like: []`, `heart: []`).
* `createdAt`: Timestamp
* `fileUrl` / `fileName` / `fileType`: Optional attachment metadata
* `embeddedItem`: Optional metadata for linked lectures/announcements
* `replyTo`: Optional reference to a parent message

### `chat_settings/config` (Document)
* `isChatOpen`: Boolean flag for global chat open/close state.
* `allowAttachments`: Boolean flag controlling Student file uploads.
* `pinnedMessage`: Object holding a globally pinned message.

## 4. Recent Issues & Speed Unification
* **The "Slow Speed" Issue**: Previously, Students were subjected to a local state "cooldown" timer which delayed sending and caused perceived sluggishness compared to Admins (who bypassed the cooldown). 
* **The Fix**: The client-side cooldown logic was removed, and the Optimistic UI update (`setMessages` before network call) was unified so it applies interchangeably to both students and admins, making message sending visually instantaneous for everyone.

---

## 5. Discussion Questions for Cloud Code / Backend Architecture

*You can use the following questions to ask your Cloud Code/Backend assistant for structural improvements:*

1. **Backend Rate Limiting vs. Client Cooldowns:**
   * "Since we removed the client-side cooldown timer in React to fix UI delays, how can we implement a secure, low-latency rate limit (e.g., 1 message per 3 seconds per student) using Cloud Functions, Firestore Security Rules, or Cloud Redis without slowing down the initial write?"
2. **Optimistic UI Data Integrity:**
   * "Our React client uses Optimistic UI updates. If a Firestore security rule blocks a write (e.g., due to an undetected rate limit or payload size), what is the best pattern to handle the `catch` block and gracefully revert the optimistic message in the UI without causing layout jumping?"
3. **Role Validation Security:**
   * "Currently, "Master Admin" and "Moderator" are checked via client-side object fields and hardcoded arrays. How can we migrate these roles to Firebase Custom Claims so that Firestore Security Rules can robustly block unauthorized message deletions or global chat status changes?"
4. **Anonymous Message Security:**
   * "Anonymous messages currently store the `senderEmail` in the document payload, relying on the React UI to hide it unless the user is a Master Admin. How can we reorganize the database schema so that normal students cannot use the browser's network tab or Firestore SDK to inspect the payload and find the email of the anonymous sender?"
5. **Chat Archiving & Cleanup:**
   * "The `chat_messages` collection grows infinitely. We have a 'Clear All Messages' front-end function that loops and deletes documents in batches of 500. How can we shift this to a reliable background Cloud Function or Scheduled job to prevent client-side hanging when there are tens of thousands of messages?"
