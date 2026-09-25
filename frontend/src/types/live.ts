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

export interface LiveParticipant {
  userId: string;
  name: string;
  role: 'teacher' | 'student';
  joinedAt: string;
}

export enum JoinLiveErrorCode {
  NOT_FOUND = 'NOT_FOUND',
  NOT_STARTED = 'NOT_STARTED',
  ENDED = 'ENDED',
  NOT_ENROLLED = 'NOT_ENROLLED',
  FULL = 'FULL',
  UNAUTHORIZED = 'UNAUTHORIZED',
}

export interface JoinLiveResult {
  ok: boolean;
  code?: JoinLiveErrorCode;
  message?: string;
  role?: 'teacher' | 'student';
  count?: number;
  maxParticipants?: number;
  participants?: LiveParticipant[];
}
