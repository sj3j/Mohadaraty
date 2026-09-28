import type { Request, Response } from 'express';
import admin from 'firebase-admin';

// In-memory cache for the allowed reactions to prevent reading Firestore on every request
let cachedAllowedReactions: string[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute

export const handleAnnouncementReact = async (req: Request, res: Response) => {
  try {
    const { emoji } = req.body;
    const postId = req.params.postId;
    // Security: Use uid from the verified token, never from the body
    const uid = (req as any).user?.uid;
    
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized: Missing user ID" });
    }
    
    if (!emoji || !postId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const db = admin.firestore();
    
    // Security: Validate the post exists
    const postRef = db.collection('announcements').doc(postId);
    const postSnap = await postRef.get();
    if (!postSnap.exists) {
      return res.status(404).json({ error: "Announcement not found" });
    }

    // Determine the true action securely on the backend to avoid race conditions
    const postData = postSnap.data() || {};
    const currentReactions = postData.reactions?.[emoji] || [];
    const serverHasReacted = currentReactions.includes(uid);

    // Only validate emoji allowlist if ADDING a reaction
    // (users should always be able to remove their own reaction even if the emoji was removed from allowed list)
    if (!serverHasReacted) {
      const now = Date.now();
      if (!cachedAllowedReactions || now - cacheTimestamp > CACHE_TTL_MS) {
        const settingsSnap = await db.collection('settings').doc('announcements').get();
        const data = settingsSnap.data();
        
        // Fallback to a sensible default if the doc is missing or the list is empty
        if (data && Array.isArray(data.allowedReactions) && data.allowedReactions.length > 0) {
          cachedAllowedReactions = data.allowedReactions;
        } else {
          cachedAllowedReactions = ['👍', '❤️', '👏', '🎉'];
        }
        cacheTimestamp = now;
      }
      
      if (!cachedAllowedReactions.includes(emoji)) {
        return res.status(400).json({ error: "Invalid reaction emoji" });
      }
    }
    
    // Write using the Admin SDK (supported syntax, bypassing firestore.rules)
    await postRef.set({
      reactions: {
        [emoji]: serverHasReacted 
          ? admin.firestore.FieldValue.arrayRemove(uid) 
          : admin.firestore.FieldValue.arrayUnion(uid)
      }
    }, { merge: true });
    
    return res.json({ success: true });
  } catch (error) {
    console.error("Failed to react to announcement:", error);
    return res.status(500).json({ error: "Failed to react" });
  }
};
