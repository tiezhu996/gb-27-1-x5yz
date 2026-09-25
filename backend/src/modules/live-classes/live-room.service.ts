import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server } from 'socket.io';
import { LiveClass, LiveClassStatus } from '../../common/entities/live-class.entity';
import { CourseEnrollment } from '../../common/entities/course-enrollment.entity';
import { User } from '../../common/entities/user.entity';

export enum JoinLiveErrorCode {
  NOT_FOUND = 'NOT_FOUND',
  NOT_STARTED = 'NOT_STARTED',
  ENDED = 'ENDED',
  NOT_ENROLLED = 'NOT_ENROLLED',
  FULL = 'FULL',
}

export interface LiveParticipant {
  userId: string;
  name: string;
  role: 'teacher' | 'student';
  joinedAt: Date;
}

interface RoomMember extends LiveParticipant {
  socketIds: Set<string>;
}

export interface LiveRoomState {
  /** 在线学生数（教师不占名额） */
  count: number;
  participants: LiveParticipant[];
}

export interface JoinLiveSuccess extends LiveRoomState {
  ok: true;
  role: 'teacher' | 'student';
  /** 是否为该用户首次进入（重连/换浏览器时为 false，不重复占座） */
  isNewMember: boolean;
  maxParticipants: number;
}

export interface JoinLiveFailure {
  ok: false;
  code: JoinLiveErrorCode;
  message: string;
}

@Injectable()
export class LiveRoomService implements OnModuleInit {
  private readonly logger = new Logger(LiveRoomService.name);

  private server: Server | null = null;

  /** roomId -> userId -> member */
  private readonly rooms = new Map<string, Map<string, RoomMember>>();
  /** socketId -> { roomId, userId }，断线时按连接反查 */
  private readonly socketIndex = new Map<string, { roomId: string; userId: string }>();

  constructor(
    @InjectRepository(LiveClass)
    private readonly liveClassRepository: Repository<LiveClass>,
    @InjectRepository(CourseEnrollment)
    private readonly enrollmentRepository: Repository<CourseEnrollment>,
  ) {}

  async onModuleInit() {
    // 服务重启后内存中的在线状态已丢失，清掉数据库里残留的人数，避免名额被永久占用
    await this.liveClassRepository.update({}, { currentParticipants: 0 });
  }

  setServer(server: Server) {
    this.server = server;
  }

  async join(roomId: string, user: User, socketId: string): Promise<JoinLiveSuccess | JoinLiveFailure> {
    const liveClass = await this.liveClassRepository.findOne({ where: { id: roomId } });
    if (!liveClass) {
      return { ok: false, code: JoinLiveErrorCode.NOT_FOUND, message: '直播课堂不存在' };
    }

    // 教师进入自己的课堂不受开播状态/报名/名额限制，也不占学生名额
    const isTeacher = liveClass.teacherId === user.id;
    let room = this.rooms.get(roomId);
    const existing = room?.get(user.id);

    if (!isTeacher) {
      if (liveClass.status === LiveClassStatus.SCHEDULED) {
        return { ok: false, code: JoinLiveErrorCode.NOT_STARTED, message: '直播尚未开始，开播后才能进入' };
      }
      if (liveClass.status === LiveClassStatus.ENDED) {
        return { ok: false, code: JoinLiveErrorCode.ENDED, message: '直播已结束' };
      }
      const enrollment = await this.enrollmentRepository.findOne({
        where: { studentId: user.id, courseId: liveClass.courseId },
      });
      if (!enrollment) {
        return { ok: false, code: JoinLiveErrorCode.NOT_ENROLLED, message: '只有报名该课程的学生才能进入课堂' };
      }
      // 容量检查与占位之间没有 await，并发进入不会穿透名额上限；
      // 已在课堂内的学生（重连/换浏览器）不重复占座，直接放行
      if (!existing && this.getStudentCount(roomId) >= liveClass.maxParticipants) {
        return { ok: false, code: JoinLiveErrorCode.FULL, message: '课堂已满，请稍后再试' };
      }
    }

    if (!room) {
      room = new Map<string, RoomMember>();
      this.rooms.set(roomId, room);
    }

    let member = room.get(user.id);
    const isNewMember = !member;
    if (!member) {
      member = {
        userId: user.id,
        name: user.name,
        role: isTeacher ? 'teacher' : 'student',
        joinedAt: new Date(),
        socketIds: new Set<string>(),
      };
      room.set(user.id, member);
    }
    member.socketIds.add(socketId);
    this.socketIndex.set(socketId, { roomId, userId: user.id });

    if (isNewMember) {
      await this.persistCount(roomId);
      this.broadcastState(roomId);
    }

    return {
      ok: true,
      role: member.role,
      isNewMember,
      maxParticipants: liveClass.maxParticipants,
      ...this.getRoomState(roomId),
    };
  }

  /**
   * 按连接移除成员（断线或主动离开都会走到这里）。
   * 同一用户可能有多个连接，全部断开才算真正离开并空出名额。
   */
  leaveBySocket(socketId: string): { roomId: string; member: LiveParticipant; fullyLeft: boolean } | null {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;
    this.socketIndex.delete(socketId);

    const room = this.rooms.get(ref.roomId);
    const member = room?.get(ref.userId);
    if (!room || !member) return null;

    member.socketIds.delete(socketId);
    if (member.socketIds.size > 0) {
      return { roomId: ref.roomId, member, fullyLeft: false };
    }

    room.delete(ref.userId);
    if (room.size === 0) {
      this.rooms.delete(ref.roomId);
    }

    void this.persistCount(ref.roomId);
    this.broadcastState(ref.roomId);
    return { roomId: ref.roomId, member, fullyLeft: true };
  }

  isInRoom(roomId: string, userId: string): boolean {
    return this.rooms.get(roomId)?.has(userId) ?? false;
  }

  getRoomState(roomId: string): LiveRoomState {
    const room = this.rooms.get(roomId);
    const participants: LiveParticipant[] = [];
    room?.forEach((member) => {
      participants.push({
        userId: member.userId,
        name: member.name,
        role: member.role,
        joinedAt: member.joinedAt,
      });
    });
    participants.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    return { count: this.getStudentCount(roomId), participants };
  }

  /** 课堂结束：通知房间内所有人并清空在线状态，人数归零 */
  async closeRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.forEach((member) => {
        member.socketIds.forEach((socketId) => this.socketIndex.delete(socketId));
      });
      this.rooms.delete(roomId);
    }
    this.server?.to(roomId).emit('liveEnded', { roomId });
    await this.persistCount(roomId);
  }

  private getStudentCount(roomId: string): number {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    let count = 0;
    room.forEach((member) => {
      if (member.role === 'student') count += 1;
    });
    return count;
  }

  private async persistCount(roomId: string) {
    try {
      await this.liveClassRepository.update({ id: roomId }, { currentParticipants: this.getStudentCount(roomId) });
    } catch (error) {
      this.logger.error(`同步课堂 ${roomId} 在线人数失败`, error);
    }
  }

  private broadcastState(roomId: string) {
    if (!this.server) return;
    this.server.to(roomId).emit('participantsUpdate', {
      roomId,
      ...this.getRoomState(roomId),
    });
  }
}
