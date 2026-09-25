import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LiveClass, LiveClassStatus } from '../../common/entities/live-class.entity';
import { CourseEnrollment } from '../../common/entities/course-enrollment.entity';
import { User, UserRole } from '../../common/entities/user.entity';

export type JoinErrorCode =
  | 'class_not_found'
  | 'forbidden'
  | 'not_enrolled'
  | 'not_live'
  | 'class_full';

export interface OnlineUserInfo {
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
  users: OnlineUserInfo[];
}

export type AdmitResult =
  | { ok: true; rejoined: boolean; presence: PresenceSnapshot }
  | { ok: false; code: JoinErrorCode; message: string };

interface OnlineUser extends OnlineUserInfo {
  socketIds: Set<string>;
}

interface RoomPresence {
  users: Map<string, OnlineUser>;
  maxParticipants: number;
}

interface SocketRef {
  liveClassId: string;
  userId: string;
}

export interface ReleaseResult {
  liveClassId: string;
  removedUser: OnlineUserInfo;
  presence: PresenceSnapshot;
}

@Injectable()
export class LiveClassesService {
  private readonly logger = new Logger(LiveClassesService.name);

  /** liveClassId -> 房间在线状态（以 userId 为单位） */
  private readonly rooms = new Map<string, RoomPresence>();
  /** socketId -> 所在房间/用户，用于掉线时快速回收名额 */
  private readonly socketIndex = new Map<string, SocketRef>();

  constructor(
    @InjectRepository(LiveClass)
    private readonly liveClassRepository: Repository<LiveClass>,
    @InjectRepository(CourseEnrollment)
    private readonly enrollmentRepository: Repository<CourseEnrollment>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async findAll() {
    return this.liveClassRepository.find({
      relations: ['course', 'teacher'],
      order: { scheduledStartTime: 'DESC' },
    });
  }

  async findOne(id: string) {
    const liveClass = await this.liveClassRepository.findOne({
      where: { id },
      relations: ['course', 'teacher'],
    });
    if (!liveClass) {
      throw new NotFoundException('直播课堂不存在');
    }
    return liveClass;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async create(userId: string, data: Partial<LiveClass>) {
    const liveClass = this.liveClassRepository.create({
      ...data,
      teacherId: userId,
      status: LiveClassStatus.SCHEDULED,
    });
    return this.liveClassRepository.save(liveClass);
  }

  async startLive(userId: string, id: string) {
    const liveClass = await this.liveClassRepository.findOne({ where: { id } });
    if (!liveClass) {
      throw new NotFoundException('直播课堂不存在');
    }
    if (liveClass.teacherId !== userId) {
      throw new ForbiddenException('无权操作此直播');
    }

    liveClass.status = LiveClassStatus.LIVE;
    liveClass.actualStartTime = new Date();
    return this.liveClassRepository.save(liveClass);
  }

  async endLive(userId: string, id: string): Promise<{ liveClass: LiveClass; kickedSocketIds: string[] }> {
    const liveClass = await this.liveClassRepository.findOne({ where: { id } });
    if (!liveClass) {
      throw new NotFoundException('直播课堂不存在');
    }
    if (liveClass.teacherId !== userId) {
      throw new ForbiddenException('无权操作此直播');
    }

    liveClass.status = LiveClassStatus.ENDED;
    liveClass.endTime = new Date();
    liveClass.currentParticipants = 0;
    const saved = await this.liveClassRepository.save(liveClass);

    // 课堂结束：清空房间，所有人的位置立即释放，人数归零
    // （网关拿到 kickedSocketIds 后广播结束并断开连接）
    const kickedSocketIds = this.clearRoom(id);

    return { liveClass: saved, kickedSocketIds };
  }

  /**
   * 进入课堂的唯一准入入口：
   * - 仅本课堂教师 / 已报名该课程的学生可进入
   * - 学生只能在开播后进入，满员拒绝
   * - 同一 userId 的多个 socket（换浏览器、断网重连）只占一个位置
   */
  async admit(liveClassId: string, socketId: string, user: User): Promise<AdmitResult> {
    const liveClass = await this.liveClassRepository.findOne({ where: { id: liveClassId } });
    if (!liveClass) {
      return { ok: false, code: 'class_not_found', message: '直播课堂不存在' };
    }

    const isTeacher = user.id === liveClass.teacherId;

    let enrollment: CourseEnrollment | null = null;
    if (!isTeacher) {
      enrollment = await this.enrollmentRepository.findOne({
        where: { studentId: user.id, courseId: liveClass.courseId },
      });
      if (!enrollment) {
        return { ok: false, code: 'forbidden', message: '你没有报名这门课程，无法进入直播间' };
      }
      if (liveClass.status !== LiveClassStatus.LIVE) {
        return { ok: false, code: 'not_live', message: '直播尚未开始' };
      }
    }

    // 以下为同步段落：Node 单线程内不会与其他 admit 交错，容量判定 + 占位是原子的
    let room = this.rooms.get(liveClassId);
    if (!room) {
      room = { users: new Map(), maxParticipants: liveClass.maxParticipants };
      this.rooms.set(liveClassId, room);
    }

    const existing = room.users.get(user.id);
    if (existing) {
      // 同一用户换浏览器 / 断网重连：挂接新 socket，不重复占名额
      existing.socketIds.add(socketId);
      this.socketIndex.set(socketId, { liveClassId, userId: user.id });
      return { ok: true, rejoined: true, presence: this.buildSnapshot(liveClassId, room) };
    }

    if (!isTeacher) {
      const studentCount = this.countStudents(room);
      if (studentCount >= liveClass.maxParticipants) {
        return { ok: false, code: 'class_full', message: '课堂已满，请稍后再试' };
      }
    }

    room.users.set(user.id, {
      userId: user.id,
      userName: user.name,
      role: isTeacher ? UserRole.TEACHER : user.role,
      joinedAt: new Date(),
      socketIds: new Set([socketId]),
    });
    this.socketIndex.set(socketId, { liveClassId, userId: user.id });

    if (!isTeacher) {
      void this.persistStudentCount(liveClassId);
    }

    return { ok: true, rejoined: false, presence: this.buildSnapshot(liveClassId, room) };
  }

  /**
   * 回收一个 socket 占用的位置。
   * 只有该用户最后一个连接断开（关闭页面 / 掉线）时才真正释放名额；
   * 多标签页、重连重叠期间不会误删。
   */
  release(socketId: string): ReleaseResult | null {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return null;

    this.socketIndex.delete(socketId);
    const room = this.rooms.get(ref.liveClassId);
    if (!room) return null;

    const onlineUser = room.users.get(ref.userId);
    if (!onlineUser) return null;

    onlineUser.socketIds.delete(socketId);
    if (onlineUser.socketIds.size > 0) {
      // 该用户还有其他在线连接，名额保留
      return null;
    }

    const wasStudent = onlineUser.role === UserRole.STUDENT;
    const removedUser: OnlineUserInfo = {
      userId: onlineUser.userId,
      userName: onlineUser.userName,
      role: onlineUser.role,
      joinedAt: onlineUser.joinedAt,
    };

    room.users.delete(ref.userId);
    const presence = this.buildSnapshot(ref.liveClassId, room);

    if (room.users.size === 0) {
      this.rooms.delete(ref.liveClassId);
    }
    if (wasStudent) {
      void this.persistStudentCount(ref.liveClassId);
    }

    return { liveClassId: ref.liveClassId, removedUser, presence };
  }

  /** 供网关在课堂结束时广播的空名单快照 */
  buildEmptyPresence(liveClassId: string, maxParticipants: number): PresenceSnapshot {
    return {
      liveClassId,
      onlineCount: 0,
      studentCount: 0,
      maxParticipants,
      users: [],
    };
  }

  getPresence(liveClassId: string): PresenceSnapshot | null {
    const room = this.rooms.get(liveClassId);
    if (!room) return null;
    return this.buildSnapshot(liveClassId, room);
  }

  /** 课堂结束时清空房间，返回所有受影响的 socket 连接 */
  private clearRoom(liveClassId: string): string[] {
    const room = this.rooms.get(liveClassId);
    if (!room) return [];

    const socketIds: string[] = [];
    for (const onlineUser of room.users.values()) {
      socketIds.push(...onlineUser.socketIds);
    }
    for (const socketId of socketIds) {
      this.socketIndex.delete(socketId);
    }
    this.rooms.delete(liveClassId);
    return socketIds;
  }

  private countStudents(room: RoomPresence): number {
    let count = 0;
    for (const onlineUser of room.users.values()) {
      if (onlineUser.role === UserRole.STUDENT) count += 1;
    }
    return count;
  }

  private buildSnapshot(liveClassId: string, room: RoomPresence): PresenceSnapshot {
    const users: OnlineUserInfo[] = [];
    let studentCount = 0;
    for (const onlineUser of room.users.values()) {
      if (onlineUser.role === UserRole.STUDENT) studentCount += 1;
      users.push({
        userId: onlineUser.userId,
        userName: onlineUser.userName,
        role: onlineUser.role,
        joinedAt: onlineUser.joinedAt,
      });
    }
    return {
      liveClassId,
      onlineCount: users.length,
      studentCount,
      maxParticipants: room.maxParticipants,
      users,
    };
  }

  private async persistStudentCount(liveClassId: string): Promise<void> {
    const room = this.rooms.get(liveClassId);
    const count = room ? this.countStudents(room) : 0;
    try {
      await this.liveClassRepository.update(liveClassId, { currentParticipants: count });
    } catch (err) {
      this.logger.error(`持久化在线人数失败 (liveClass=${liveClassId})`, err as Error);
    }
  }
}
