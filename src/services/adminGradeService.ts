import { db, auth } from '../lib/firebase';
import { doc, writeBatch, collection, serverTimestamp, getDocs, query, where, getDoc } from 'firebase/firestore';
import { GradeBatch, MatchedResult } from '../types/grades.types';

export async function confirmDegreeBatchClient(
  examName: string,
  confirmedResults: MatchedResult[],
  maxDegree?: number | string,
  material?: string,
  existingBatchId?: string,
  allStudentIds?: string[],
  stageId?: string,
  yearLabel?: string
) {
  const user = auth.currentUser;
  if (!user) throw new Error("يجب تسجيل الدخول");

  if (!examName || !Array.isArray(confirmedResults)) {
    throw new Error('بيانات غير صالحة');
  }

  if (existingBatchId) {
    try {
      await undoDegreeBatch(existingBatchId);
    } catch (e) {
      console.warn("Failed to undo previous batch during update", e);
    }
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

export async function undoDegreeBatch(batchId: string) {
  const user = auth.currentUser;
  if (!user) throw new Error("يجب تسجيل الدخول");

  const batchRef = doc(db, 'degreeBatches', batchId);
  const batchSnap = await getDoc(batchRef);
  
  if (!batchSnap.exists()) throw new Error("السجل غير موجود");

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
