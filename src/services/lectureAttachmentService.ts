import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { auth, db, storage } from '../lib/firebase';
import { LectureAttachment } from '../types/lectureAttachment.types';
import { UserProfile } from '../types';
import { compressImage } from '../lib/imageCompressor';
import { canManage } from '../lib/permissions';

export interface UploadAttachmentOptions {
  lectureId: string;
  lectureTitle?: string;
  lectureNumber?: number;
  stageId: string;
  subjectId?: string;
  subjectName?: string;
  subjectNameAr?: string;
  file: File;
  title?: string;
  isAnonymous: boolean;
  user: UserProfile;
  onProgress?: (percent: number) => void;
}

export function safeTimestampMillis(val: any): number {
  if (!val) return 0;
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val === 'number') return val;
  if (val.seconds) return val.seconds * 1000 + (val.nanoseconds ? Math.floor(val.nanoseconds / 1e6) : 0);
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Fetch attachments for a specific lecture.
 * - Normal students query approved attachments, plus their own pending attachments.
 * - Staff query all attachments directly.
 * This guarantees 100% compliance with Firestore rules ("rules are not filters") and prevents permission errors.
 */
export async function getLectureAttachments(
  lectureId: string,
  currentUser?: UserProfile | null
): Promise<LectureAttachment[]> {
  try {
    const isStaff =
      currentUser &&
      (currentUser.role === 'admin' ||
        currentUser.role === 'moderator' ||
        Boolean(currentUser.isMasterAdmin) ||
        canManage(currentUser, 'manageLectures'));

    const resultsMap = new Map<string, LectureAttachment>();

    if (isStaff) {
      // Staff can query all attachments directly
      const q = query(
        collection(db, 'lecture_attachments'),
        where('lectureId', '==', lectureId)
      );
      const snap = await getDocs(q);
      snap.forEach((d) => {
        resultsMap.set(d.id, { id: d.id, ...(d.data() as Omit<LectureAttachment, 'id'>) });
      });
    } else {
      // Regular students:
      // 1. Query approved attachments (100% compliant with Firestore read rules)
      const approvedQuery = query(
        collection(db, 'lecture_attachments'),
        where('lectureId', '==', lectureId),
        where('status', '==', 'approved')
      );
      const approvedSnap = await getDocs(approvedQuery);
      approvedSnap.forEach((d) => {
        resultsMap.set(d.id, { id: d.id, ...(d.data() as Omit<LectureAttachment, 'id'>) });
      });

      // 2. If student is authenticated, also query their own pending uploads
      const studentUid = auth.currentUser?.uid || currentUser?.uid;
      if (studentUid) {
        try {
          const myPendingQuery = query(
            collection(db, 'lecture_attachments'),
            where('lectureId', '==', lectureId),
            where('uploadedBy', '==', studentUid),
            where('status', '==', 'pending')
          );
          const myPendingSnap = await getDocs(myPendingQuery);
          myPendingSnap.forEach((d) => {
            resultsMap.set(d.id, { id: d.id, ...(d.data() as Omit<LectureAttachment, 'id'>) });
          });
        } catch (pendingErr) {
          console.warn('[lectureAttachmentService] Failed to fetch own pending uploads:', pendingErr);
        }
      }
    }

    const results = Array.from(resultsMap.values());

    // Sort in memory by createdAt descending with safe timestamp parsing
    results.sort((a, b) => {
      const timeA = safeTimestampMillis(a.createdAt);
      const timeB = safeTimestampMillis(b.createdAt);
      return timeB - timeA;
    });

    return results;
  } catch (err) {
    console.error('[lectureAttachmentService] Failed to get lecture attachments:', err);
    return [];
  }
}

/**
 * Fetch all pending attachments for a stage (for representative / admin review).
 */
export async function getPendingAttachmentsForStage(stageId: string): Promise<LectureAttachment[]> {
  try {
    const q = query(
      collection(db, 'lecture_attachments'),
      where('stageId', '==', stageId),
      where('status', '==', 'pending')
    );
    const snap = await getDocs(q);
    const results: LectureAttachment[] = [];
    snap.forEach((d) => {
      results.push({ id: d.id, ...(d.data() as Omit<LectureAttachment, 'id'>) });
    });

    results.sort((a, b) => {
      const timeA = safeTimestampMillis(a.createdAt);
      const timeB = safeTimestampMillis(b.createdAt);
      return timeB - timeA;
    });

    return results;
  } catch (err) {
    console.error('[lectureAttachmentService] Failed to get pending attachments:', err);
    return [];
  }
}

/**
 * Upload a new lecture attachment with smart client-side compression.
 */
export async function uploadAttachment({
  lectureId,
  lectureTitle,
  lectureNumber,
  stageId,
  subjectId,
  subjectName,
  subjectNameAr,
  file,
  title,
  isAnonymous,
  user,
  onProgress,
}: UploadAttachmentOptions): Promise<LectureAttachment> {
  const currentUid = auth.currentUser?.uid || user.uid;
  if (!currentUid) {
    throw new Error('User is not authenticated');
  }

  // 1. Client-side image compression
  const { file: compressedFile, width, height } = await compressImage(file, 2048, 0.85);

  // 2. Determine upload destination in Storage
  const cleanStageId = (stageId || user.stageId || 'general').trim();
  const extension = compressedFile.name.split('.').pop() || 'jpg';
  const fileName = `${currentUid}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${extension}`;
  const storagePath = `lecture_attachments/${cleanStageId}/${lectureId}/${fileName}`;
  const fileRef = ref(storage, storagePath);

  // 3. Upload to Firebase Storage with progress tracking
  await new Promise<void>((resolve, reject) => {
    const uploadTask = uploadBytesResumable(fileRef, compressedFile, {
      contentType: compressedFile.type,
      customMetadata: {
        uploaderUid: currentUid,
        lectureId,
        stageId: cleanStageId,
      },
    });

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        if (onProgress && snapshot.totalBytes > 0) {
          const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
          onProgress(progress);
        }
      },
      (error) => reject(error),
      () => resolve()
    );
  });

  const url = await getDownloadURL(fileRef);

  // 4. Determine status: staff uploads are auto-approved; students are pending
  const isStaff =
    user.role === 'admin' ||
    user.role === 'moderator' ||
    Boolean(user.isMasterAdmin) ||
    canManage(user, 'manageLectures');
  const status: 'approved' | 'pending' = isStaff ? 'approved' : 'pending';

  // 5. Save metadata to Firestore
  const attachmentData: Omit<LectureAttachment, 'id'> = {
    lectureId,
    lectureTitle: (lectureTitle || '').trim(),
    lectureNumber: typeof lectureNumber === 'number' ? lectureNumber : undefined,
    stageId: cleanStageId,
    subjectId: subjectId || '',
    subjectName: (subjectName || '').trim() || undefined,
    subjectNameAr: (subjectNameAr || subjectName || '').trim() || undefined,
    url,
    storagePath,
    title: (title || '').trim(),
    uploadedBy: currentUid,
    uploaderName: user.name || 'طالب',
    uploaderRole: user.role,
    isAnonymous: Boolean(isAnonymous),
    status,
    createdAt: serverTimestamp(),
    width,
    height,
    size: compressedFile.size,
  };

  const docRef = await addDoc(collection(db, 'lecture_attachments'), attachmentData);

  // 6. If student submission, create an adminAlert for representatives
  if (status === 'pending') {
    try {
      await addDoc(collection(db, 'adminAlerts'), {
        type: 'lecture_attachment_pending',
        stageId: cleanStageId,
        lectureId,
        lectureTitle: (lectureTitle || '').trim(),
        lectureNumber: typeof lectureNumber === 'number' ? lectureNumber : null,
        subjectId: subjectId || '',
        subjectName: (subjectName || '').trim(),
        subjectNameAr: (subjectNameAr || subjectName || '').trim(),
        studentName: user.name || 'طالب',
        attachmentTitle: (title || '').trim(),
        reason: (title || 'صورة مرفقة جديدة').trim(),
        createdAt: serverTimestamp(),
      });
    } catch (e) {
      console.warn('[lectureAttachmentService] Could not write admin alert:', e);
    }
  }

  return {
    id: docRef.id,
    ...attachmentData,
  };
}

/**
 * Approve a pending attachment.
 */
export async function approveAttachment(
  attachment: LectureAttachment,
  reviewerUser: UserProfile
): Promise<void> {
  const docRef = doc(db, 'lecture_attachments', attachment.id);
  await updateDoc(docRef, {
    status: 'approved',
    reviewedAt: serverTimestamp(),
    reviewedBy: reviewerUser.uid,
  });

  // Notify student
  try {
    const lectureContext = attachment.lectureTitle ? ` في محاضرة (${attachment.lectureTitle})` : '';
    await addDoc(collection(db, 'systemNotifications'), {
      userId: attachment.uploadedBy,
      title: 'تم قبول المرفق 🎉',
      body: `تمت الموافقة على المرفق الذي شاركته (${attachment.title || 'صورة المحاضرة'})${lectureContext} وأصبح متاحاً لجميع الطلاب. شكراً لمساهمتك!`,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn('[lectureAttachmentService] Could not notify student of approval:', e);
  }
}

/**
 * Reject a pending attachment: permanently delete storage file and record, and notify the student with the reason.
 */
export async function rejectAttachment(
  attachment: LectureAttachment,
  reason: string,
  reviewerUser: UserProfile
): Promise<void> {
  // 1. Delete from Storage
  try {
    const fileRef = ref(storage, attachment.storagePath);
    await deleteObject(fileRef);
  } catch (e) {
    console.warn('[lectureAttachmentService] Storage file delete failed or already deleted:', e);
  }

  // 2. Delete from Firestore
  const docRef = doc(db, 'lecture_attachments', attachment.id);
  await deleteDoc(docRef);

  // 3. Notify student with reason
  try {
    const lectureContext = attachment.lectureTitle ? ` في محاضرة (${attachment.lectureTitle})` : '';
    await addDoc(collection(db, 'systemNotifications'), {
      userId: attachment.uploadedBy,
      title: 'مراجعة المرفق',
      body: reason
        ? `تعذر قبول المرفق (${attachment.title || 'صورة المحاضرة'})${lectureContext}. سبب الرفض: ${reason}`
        : `تعذر قبول المرفق (${attachment.title || 'صورة المحاضرة'})${lectureContext}.`,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn('[lectureAttachmentService] Could not notify student of rejection:', e);
  }
}

/**
 * Delete an attachment (either by its owner or by a representative).
 */
export async function deleteAttachment(attachment: LectureAttachment): Promise<void> {
  // 1. Delete from Storage
  try {
    const fileRef = ref(storage, attachment.storagePath);
    await deleteObject(fileRef);
  } catch (e) {
    console.warn('[lectureAttachmentService] Storage file delete failed or already deleted:', e);
  }

  // 2. Delete from Firestore
  const docRef = doc(db, 'lecture_attachments', attachment.id);
  await deleteDoc(docRef);
}

/**
 * Count approved attachments uploaded by a student for a specific course/subject.
 * Used for the community contributor rule: 5 approved uploads unlocks all attachments for that course.
 */
export async function getStudentApprovedCourseAttachmentsCount(
  userId: string,
  courseKey?: string | null
): Promise<number> {
  if (!userId || !courseKey) return 0;
  try {
    const q = query(
      collection(db, 'lecture_attachments'),
      where('uploadedBy', '==', userId),
      where('status', '==', 'approved')
    );
    const snap = await getDocs(q);
    let count = 0;
    snap.forEach((d) => {
      const data = d.data();
      if (
        data.subjectId === courseKey ||
        (data as any).category === courseKey ||
        (!data.subjectId && !(data as any).category)
      ) {
        count++;
      }
    });
    return count;
  } catch (err) {
    console.warn('[lectureAttachmentService] Failed to count approved course attachments:', err);
    return 0;
  }
}
