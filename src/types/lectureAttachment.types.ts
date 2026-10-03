export type AttachmentStatus = 'approved' | 'pending';

export interface LectureAttachment {
  id: string;
  lectureId: string;
  lectureTitle?: string;
  lectureNumber?: number;
  stageId: string;
  subjectId?: string;
  subjectName?: string;
  subjectNameAr?: string;
  url: string;
  storagePath: string;
  title?: string;
  uploadedBy: string;
  uploaderName: string;
  uploaderRole?: 'admin' | 'moderator' | 'support' | 'student' | 'observer';
  isAnonymous: boolean;
  status: AttachmentStatus;
  createdAt: any;
  reviewedAt?: any;
  reviewedBy?: string;
  rejectionReason?: string;
  width?: number;
  height?: number;
  size: number;
}
