import type { UserProfile } from '../types';

export type AttachmentStatus = 'approved' | 'pending';

export type AttachmentFileType = 'image' | 'pdf';

export interface LectureAttachment {
  id: string;
  lectureId: string;
  lectureTitle?: string;
  lectureNumber?: number;
  stageId: string;
  courseId?: string;
  subjectId?: string;
  subjectName?: string;
  subjectNameAr?: string;
  url: string;
  storagePath: string;
  title?: string;
  uploadedBy: string;
  uploaderName: string;
  uploaderRole?: UserProfile['role'];
  isAnonymous: boolean;
  status: AttachmentStatus;
  isFree?: boolean;
  fileType?: AttachmentFileType;
  thumbnailUrl?: string;
  aspectRatio?: number;
  createdAt: any;
  reviewedAt?: any;
  reviewedBy?: string;
  rejectionReason?: string;
  width?: number;
  height?: number;
  size: number;
}
