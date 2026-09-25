import { UserRole } from './user';

export enum LiveClassStatus {
  SCHEDULED = 'scheduled',
  LIVE = 'live',
  ENDED = 'ended',
}

export interface LiveClass {
  id: string;
  title: string;
  courseId: string;
  lessonId: string;
  teacherId: string;
  status: LiveClassStatus;
  maxParticipants: number;
  currentParticipants: number;
  scheduledStartTime?: Date;
  actualStartTime?: Date;
  endTime?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OnlineUser {
  userId: string;
  userName: string;
  role: UserRole;
  joinedAt: Date;
}

export interface PresenceSnapshot {
  liveClassId: string;
  onlineCount: number;
  studentCount: number;
  maxParticipants: number;
  users: OnlineUser[];
}

export type JoinErrorCode =
  | 'unauthorized'
  | 'class_not_found'
  | 'forbidden'
  | 'not_enrolled'
  | 'not_live'
  | 'class_full';
