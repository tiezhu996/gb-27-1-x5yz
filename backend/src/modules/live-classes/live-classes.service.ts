import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LiveClass, LiveClassStatus } from '../../common/entities/live-class.entity';
import { LiveRoomService } from './live-room.service';

@Injectable()
export class LiveClassesService {
  constructor(
    @InjectRepository(LiveClass)
    private readonly liveClassRepository: Repository<LiveClass>,
    private readonly liveRoomService: LiveRoomService,
  ) {}

  async findAll() {
    return this.liveClassRepository.find({
      relations: ['course', 'teacher'],
      order: { scheduledStartTime: 'DESC' },
    });
  }

  async findOne(id: string) {
    let liveClass = await this.liveClassRepository.findOne({
      where: { id },
      relations: ['course', 'teacher'],
    });
    if (!liveClass) {
      // 课程目录跳转过来的是课时 ID，兼容按课时查找直播课堂
      liveClass = await this.liveClassRepository.findOne({
        where: { lessonId: id },
        relations: ['course', 'teacher'],
      });
    }
    if (!liveClass) {
      throw new NotFoundException('直播课堂不存在');
    }
    return liveClass;
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

  async endLive(userId: string, id: string) {
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

    // 通知房间内所有人直播已结束，并清空在线状态
    await this.liveRoomService.closeRoom(id);
    return saved;
  }

  async getParticipants(id: string) {
    const liveClass = await this.findOne(id);
    return {
      ...this.liveRoomService.getRoomState(liveClass.id),
      maxParticipants: liveClass.maxParticipants,
    };
  }
}
