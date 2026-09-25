import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LiveClass } from '../../common/entities/live-class.entity';
import { CourseEnrollment } from '../../common/entities/course-enrollment.entity';
import { LiveClassesController } from './live-classes.controller';
import { LiveClassesService } from './live-classes.service';
import { LiveRoomService } from './live-room.service';

@Module({
  imports: [TypeOrmModule.forFeature([LiveClass, CourseEnrollment])],
  controllers: [LiveClassesController],
  providers: [LiveClassesService, LiveRoomService],
  exports: [LiveRoomService],
})
export class LiveClassesModule {}
