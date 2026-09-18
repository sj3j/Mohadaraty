import { db, auth } from '../lib/firebase';
import { doc, writeBatch, collection, serverTimestamp, getDocs, query, where, getDoc } from 'firebase/firestore';
import { GradeBatch, MatchedResult } from '../types/grades.types';

/**
 * The denormalized subject block that rides alongside `material`.
 *
 * Grades call the subject `material` for historical reasons, so the pair is
 * `materialName`/`materialNameAr` rather than `subjectName` - see
 * SubjectTaggedDoc in shared/subjectSlug.ts, which reads both.
 *
 * It is written because a student's grade tabs span every stage they have been
 * promoted through, while `useStageSubjects` only ever loads the CURRENT stage.
 * Without the name on the document, last year's subjects cannot be named at all.
 */
export interface SubjectDenorm {
  materialName?: string;
  materialNameAr?: string;
  courseId?: string;
}

/**
 * Copies the denormalized block onto a document being written.
 *
 * A mutator rather than a spread because every document here is assembled with
 * `if (x) doc.x = x`: Firestore rejects `undefined` fields outright, and an
 * empty string would overwrite a good label when a batch is edited.
 */
const applyMaterialMeta = (target: any, meta?: SubjectDenorm) => {
  if (!meta) return;
  if (meta.materialName) target.materialName = meta.materialName;
  if (meta.materialNameAr) target.materialNameAr = meta.materialNameAr;
  if (meta.courseId) target.courseId = meta.courseId;
};

export async function confirmDegreeBatchClient(
  examName: string,
  confirmedResults: MatchedResult[],
  maxDegree?: number | string,
  material?: string,
  existingBatchId?: string,
  allStudentIds?: string[],
  stageId?: string,
  yearLabel?: string,
  materialMeta?: SubjectDenorm
) {
  const user = auth.currentUser;
  if (!user) throw new Error("يجب تسجيل الدخول");

  if (!examName || !Array.isArray(confirmedResults)) {
    throw new Error('بيانات غير صالحة');
  }

  if (existingBatchId) {
    // Deliberately NOT swallowed any more. undoDegreeBatch deletes the previous
    // degree documents in atomic writeBatches, so one rules denial fails a whole
    // chunk - and carrying on regardless wrote the new batch over a half-removed
    // one, orphaning degree docs whose batchId no longer lists them. Nothing
    // surfaced that to anyone. A batch that is simply already gone is fine and
    // is the one case still tolerated.
    await undoDegreeBatch(existingBatchId, { missingIsOk: true });
  }

  const batchId = existingBatchId || `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const examId = `exam_${batchId}`;
  
  let saved = 0;
  let failed = 0;
  const processedStudentIds = new Set<string>();

  let passRate: number | undefined;
  if (maxDegree && !isNaN(Number(maxDegree))) {
    const maxNum = Number(maxDegree);
    const passedCount = confirmedResults.filter(r => {
      if (!r.matchedUserId) return false;
      const degNum = Number(r.degree);
      return !isNaN(degNum) && (degNum / maxNum) >= 0.5;
    }).length;
    const totalMatched = confirmedResults.filter(r => r.matchedUserId).length;
    if (totalMatched > 0) {
      passRate = (passedCount / totalMatched) * 100;
    }
  }

  const chunkSize = 400; // Safe chunk size limit for Firestore batches
  
  try {
    // Collect all data to write
    const recordsToWrite: { studentId: string, degree: string | number }[] = [];

    // 1. Add students from the file
    for (const result of confirmedResults) {
      if (result.matchedUserId) {
        processedStudentIds.add(result.matchedUserId);
        
        let finalDegree: string | number = result.degree;
        if (finalDegree === '' || finalDegree === null || finalDegree === undefined || String(finalDegree).trim() === '') {
           finalDegree = 'درجة محجوبة';
        }
        
        recordsToWrite.push({ studentId: result.matchedUserId, degree: finalDegree });
      } else {
        failed++;
      }
    }

    // 2. Add students not in the file (if allStudentIds is provided)
    if (allStudentIds && allStudentIds.length > 0) {
      for (const sId of allStudentIds) {
        if (!processedStudentIds.has(sId)) {
          processedStudentIds.add(sId);
          recordsToWrite.push({ studentId: sId, degree: 'ما متكوّز أو اسمك مو بالملف' });
        }
      }
    }

    const studentIdsArr = Array.from(processedStudentIds);

    for (let i = 0; i < recordsToWrite.length; i += chunkSize) {
      const chunk = recordsToWrite.slice(i, i + chunkSize);
      const firestoreBatch = writeBatch(db);
      
      for (const record of chunk) {
        const degreeRef = doc(db, `degrees/${record.studentId}/exams/${examId}`);
        const degreeData: any = {
          examName,
          degree: record.degree,
          batchId: batchId,
          stageId, // Add this for filtering degrees by stage
          createdAt: serverTimestamp()
        };
        if (maxDegree) degreeData.maxDegree = maxDegree;
        if (material) degreeData.material = material;
        applyMaterialMeta(degreeData, materialMeta);
        if (passRate !== undefined) degreeData.passRate = passRate;
        if (yearLabel) degreeData.yearLabel = yearLabel;

        firestoreBatch.set(degreeRef, degreeData);
        if (confirmedResults.some(r => r.matchedUserId === record.studentId)) {
           saved++;
        }
      }
      
      // On the last chunk, attach the main degreeBatches manifest
      if (i + chunkSize >= recordsToWrite.length) {
        const batchRef = doc(db, 'degreeBatches', batchId);
        const batchDocData: any = {
          id: batchId,
          examName,
          createdAt: serverTimestamp(),
          createdBy: user.uid,
          status: 'confirmed',
          studentIds: studentIdsArr,
          stageId,
          stats: {
            totalRows: confirmedResults.length,
            // saved here tracks matched in the file
            matched: saved,
            unmatched: failed
          }
        };
        if (maxDegree) batchDocData.maxDegree = maxDegree;
        if (material) batchDocData.material = material;
        applyMaterialMeta(batchDocData, materialMeta);
        if (passRate !== undefined) batchDocData.passRate = passRate;
        if (yearLabel) batchDocData.yearLabel = yearLabel;
        firestoreBatch.set(batchRef, batchDocData);
      }

      await firestoreBatch.commit();
    }

    // Handle empty batches (e.g. if we have zero records)
    if (recordsToWrite.length === 0) {
      const firestoreBatch = writeBatch(db);
      const batchRef = doc(db, 'degreeBatches', batchId);
      const emptyBatchData: any = {
        id: batchId,
        examName,
        createdAt: serverTimestamp(),
        createdBy: user.uid,
        status: 'confirmed',
        studentIds: [],
        stageId,
        stats: {
          totalRows: 0,
          matched: 0,
          unmatched: 0
        }
      };
      if (maxDegree) emptyBatchData.maxDegree = maxDegree;
      if (material) emptyBatchData.material = material;
      applyMaterialMeta(emptyBatchData, materialMeta);
      if (passRate !== undefined) emptyBatchData.passRate = passRate;
      if (yearLabel) emptyBatchData.yearLabel = yearLabel;
      firestoreBatch.set(batchRef, emptyBatchData);
      await firestoreBatch.commit();
    }

    return { saved, failed, batchId };
  } catch (err: any) {
    console.error("Firestore Client Batch Error:", err);
    throw new Error(err.message || "حدث خطأ أثناء حفظ درجات الطلاب");
  }
}

export async function patchDegreeBatchClient(
  batchId: string,
  updates: MatchedResult[]
) {
  const user = auth.currentUser;
  if (!user) throw new Error("يجب تسجيل الدخول");
  
  if (!updates || updates.length === 0) return;

  const batchRef = doc(db, 'degreeBatches', batchId);
  const batchSnap = await getDoc(batchRef);
  if (!batchSnap.exists()) throw new Error("الكشف غير موجود");

  const batchData = batchSnap.data();

  // An appeal can add a student who was not in the original file, and the write
  // below CREATES their degree document. firestore.rules requires a new degree
  // to name a stage, so a batch that predates the stage rollout cannot grow new
  // rows - repairing existing ones is still fine.
  //
  // Checked here so this surfaces as an explanation rather than as a raw
  // permission-denied from deep inside a writeBatch.
  if (!batchData.stageId) {
    throw new Error(
      'هذا الكشف قديم ولا يحمل مرحلة. شغّل scripts/backfillDegreeYears.ts لتثبيت المرحلة قبل إضافة طلاب جدد إليه.',
    );
  }

  const examId = `exam_${batchId}`;
  
  const existingStudentIds = new Set<string>(batchData.studentIds || []);
  
  let validUpdates = 0;
  
  const chunkSize = 400;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    const firestoreBatch = writeBatch(db);
    
    for (const update of chunk) {
      if (update.matchedUserId) {
        let finalDegree: string | number = update.degree;
        if (finalDegree === '' || finalDegree === null || finalDegree === undefined || String(finalDegree).trim() === '') {
           finalDegree = 'درجة محجوبة';
        }
        
        const degreeRef = doc(db, `degrees/${update.matchedUserId}/exams/${examId}`);
        // The batch's own classification has to ride along. This path also
        // CREATES documents - an appeal adds a student who was not in the
        // original file - and one written without stageId/yearLabel belongs to
        // no stage tab and no year heading, so it would surface under whichever
        // stage the reader happens to be on.
        const patch: any = {
          examName: batchData.examName,
          degree: finalDegree,
          batchId: batchId || '',
          material: batchData.material || '',
          maxDegree: batchData.maxDegree || '',
          updatedAt: serverTimestamp(),
        };
        if (batchData.stageId) patch.stageId = batchData.stageId;
        // Carries the subject NAME forward too, not just the slug. This path
        // creates documents (an appeal adds a student who was not in the file),
        // and one written with only `material` cannot be named once the student
        // is promoted past this stage.
        applyMaterialMeta(patch, {
          materialName: batchData.materialName,
          materialNameAr: batchData.materialNameAr,
          courseId: batchData.courseId,
        });
        if (batchData.yearLabel) patch.yearLabel = batchData.yearLabel;
        if (typeof batchData.passRate === 'number') patch.passRate = batchData.passRate;
        firestoreBatch.set(degreeRef, patch, { merge: true });
        
        existingStudentIds.add(update.matchedUserId);
        validUpdates++;
      }
    }
    
    await firestoreBatch.commit();
  }

  // Update the batch manifest
  const studentIdsArr = Array.from(existingStudentIds);
  await writeBatch(db).update(batchRef, {
    studentIds: studentIdsArr,
    'stats.totalRows': studentIdsArr.length,
    'stats.matched': studentIdsArr.length, // assuming all valid in records 
  }).commit();
  
  return validUpdates;
}

export async function undoDegreeBatch(
  batchId: string,
  opts?: { missingIsOk?: boolean },
) {
  const user = auth.currentUser;
  if (!user) throw new Error("يجب تسجيل الدخول");

  const batchRef = doc(db, 'degreeBatches', batchId);
  const batchSnap = await getDoc(batchRef);
  
  if (!batchSnap.exists()) {
    // Nothing to undo is not a failure when we are only clearing the way for a
    // re-upload; it IS one when the user asked to undo a specific batch.
    if (opts?.missingIsOk) return;
    throw new Error("السجل غير موجود");
  }

  const studentIds = batchSnap.data().studentIds || [];
  const examId = `exam_${batchId}`;

  const chunkSize = 400;
  for (let i = 0; i < studentIds.length; i += chunkSize) {
    const chunk = studentIds.slice(i, i + chunkSize);
    const firestoreBatch = writeBatch(db);
    
    for (const studentId of chunk) {
      const degreeRef = doc(db, `degrees/${studentId}/exams/${examId}`);
      firestoreBatch.delete(degreeRef);
    }
    
    await firestoreBatch.commit();
  }

  // Delete the batch doc itself in a final operation
  const finalBatch = writeBatch(db);
  finalBatch.delete(batchRef);
  await finalBatch.commit();
}
